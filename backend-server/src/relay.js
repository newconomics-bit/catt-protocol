/**
 * CATT Protocol — Gasless relay / chain adapter (PRD 3.2 "Gasless transaction",
 * PRD 6.2 "Mining Loop").
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The Judge (`signer.js`) issues an EIP-712 signature over a mining claim, and
 * `MiningClaimer.claimReward` settles it on-chain. `user` inside the signature
 * is deliberately independent of `msg.sender`, so a THIRD PARTY can broadcast
 * the claim and pay only the gas. That third party is this module: the mobile
 * app never holds MATIC, never needs an RPC endpoint, and never builds a
 * transaction — it POSTs the claim it received from `/api/submit` and the
 * backend sponsors the gas.
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT PART OF `server.js`
 * -------------------------------------------------------
 * Testability. `server.js` is a judge: it sequences other people's decisions.
 * This module is the only thing in the backend that touches a chain, so it is
 * the only thing that would need a real provider to be exercised. Everything
 * here is therefore built around INJECTION: the provider, the signing wallet,
 * the contract address, the chain id, the store and the logger are all
 * parameters. A test can hand in a tiny duck-typed stub and assert the exact
 * calldata the relayer would broadcast with no network, no node and no key.
 *
 * THE MINIMAL ABI
 * ---------------
 * `MINING_CLAIMER_ABI` is written by hand on purpose. The compiled artifact
 * under `smart-contracts/artifacts` is NOT imported: that would couple the
 * backend to the contracts build output (it may not exist in a deployment
 * image, and a rebuild would silently change the backend's encoding). The
 * fragment below lists exactly the members this module needs and nothing else,
 * which keeps the contract surface the backend can possibly call auditable at
 * a glance. `claimReward`'s parameter order is SIGNIFICANT and matches the
 * contract's own declaration.
 *
 * SECRET SAFETY (PRD Section 5, Rule 2)
 * ------------------------------------
 * - The relayer key is never stored, returned, logged or interpolated into an
 *   error message. `createRelayServiceFromEnv` reads it, hands it to
 *   `ethers.Wallet`, and keeps only the object.
 * - Log lines carry PUBLIC values only: transaction hash, the relayer address,
 *   the claimer address, the user address and the nonce. A whole transaction
 *   object is never logged, because a `TransactionRequest`/`TransactionResponse`
 *   can carry signer-adjacent material and unbounded node data.
 * - Errors thrown out of this module carry a stable `.code` and a SHORT,
 *   sanitized `.reason`. The original error is attached as a non-enumerable
 *   `cause` for the server-side logger and is never part of the message, so a
 *   stack trace, an RPC URL, a node error dump or an environment value cannot
 *   reach an HTTP response by accident.
 */

const { ethers } = require("ethers");

const signer = require("../signer");

/**
 * The MINIMAL human-readable ABI fragment for `MiningClaimer`.
 *
 * `claimReward` is the one and only state-changing call the relayer makes, and
 * the other four are read-only accessors used to introspect a deployment
 * (`signer()` is how the relay route learns who is allowed to attest;
 * `owner()`, `cattToken()` and `stakingManager()` exist for operational
 * introspection and are deliberately not used by any code path here).
 *
 * NOTE ON ERROR DECODING: custom errors (`ClaimExpired`, `ClaimAlreadyUsed`,
 * `ClaimSignatureInvalid`, ...) are intentionally NOT part of this fragment.
 * Decoding one therefore cannot be relied upon — `ethers` populates
 * `error.revert.name` only when it knows the selector — so `_decodeRevert`
 * below tries, in order: a provider-supplied `revert.name`, a provider-supplied
 * `revert.signature`, a best-effort parse through this interface, then the
 * raw `reason` string, and finally a fixed `"execution reverted"`. Adding the
 * contract's error definitions here would make that name resolution exact, and
 * is the one-line change to make if a reason ever needs to be more precise.
 *
 * @type {ReadonlyArray<string>}
 */
const MINING_CLAIMER_ABI = Object.freeze([
  "function claimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline,bytes signature)",
  "function signer() view returns (address)",
  "function owner() view returns (address)",
  "function cattToken() view returns (address)",
  "function stakingManager() view returns (address)",
]);

/**
 * Every stable, machine-readable error code this module can produce. These
 * strings are part of the backend's public contract with the mobile app and
 * with `server.js`; they are frozen and never renamed.
 *
 * @type {Readonly<Record<string, string>>}
 */
const RELAY_ERRORS = Object.freeze({
  /** No provider / wallet / claimer address / chain id: nothing to broadcast with. */
  NOT_CONFIGURED: "RELAY_NOT_CONFIGURED",
  /** The request body is not a well-formed claim. */
  INVALID_CLAIM: "INVALID_CLAIM",
  /** The signature does not recover to the expected signer over the received digest. */
  SIGNATURE_INVALID: "RELAY_SIGNATURE_INVALID",
  /** The transaction was broadcast and MINED but REVERTED. The nonce stays relayable. */
  TX_REVERTED: "RELAY_TX_REVERTED",
  /** The transaction could not be broadcast or mined at all (RPC failure, revert on estimateGas, ...). */
  TX_FAILED: "RELAY_TX_FAILED",
});

/** Longest a human-readable revert reason may be before it is truncated. */
const MAX_REASON_LENGTH = 160;

/** 2^256 - 1. uint256 values above this cannot be encoded and are rejected early. */
const MAX_UINT256 = (1n << 256n) - 1n;

/** 0x-prefixed 65-byte signature. */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/** A decimal, non-negative integer in string or number form (never a float). */
const DECIMAL_PATTERN = /^\d+$/;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds a relay error with a stable `.code` and an optional sanitized
 * `.reason`, keeping the original error as a NON-ENUMERABLE `cause`.
 *
 * `cause` is non-enumerable on purpose: `JSON.stringify(err)` and a careless
 * `Object.assign({}, err)` in a log formatter must not be able to drag the
 * underlying ethers error — which can contain the RPC URL, the full
 * transaction and node-side detail — out of the error and into a response.
 *
 * @param {string} code One of `RELAY_ERRORS`.
 * @param {string} message Short, secret-free message.
 * @param {Object} [extra] Additional own properties (e.g. `{ reason }`).
 * @param {Error} [cause] Original error, for server-side logging only.
 * @returns {Error} The typed error.
 */
function _relayError(code, message, extra, cause) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  if (cause) Object.defineProperty(err, "cause", { value: cause, enumerable: false, configurable: true });
  return err;
}

/**
 * Truncates and strips a human-readable reason so it is safe to hand back to a
 * client. Removes anything that looks like a secret (a 32-byte hex blob, i.e.
 * what a private key looks like), collapses whitespace and clips the length.
 *
 * @param {*} reason Candidate reason.
 * @returns {string} A short, sanitized string; `"execution reverted"` if empty.
 */
function _sanitizeReason(reason) {
  if (typeof reason !== "string") return "execution reverted";
  let out = reason;
  // Anything 0x + 64 hex chars or more is a key-shaped value; drop it whole.
  out = out.replace(/0x[0-9a-fA-F]{64,}/g, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  if (out === "") return "execution reverted";
  if (out.length > MAX_REASON_LENGTH) out = `${out.slice(0, MAX_REASON_LENGTH - 1)}…`;
  return out;
}

/**
 * Best-effort recovery of a REVERT reason from a chain error.
 *
 * Resolution order, most specific first:
 *   1. `err.revert.name`      — ethers already decoded a custom error.
 *   2. `err.revert.signature` — same, when only the signature is available.
 *   3. `iface.parseError(data)` — a direct attempt through the contract
 *      interface, using `err.data` (bytes, or the first entry when the provider
 *      reports a list of blobs).
 *   4. `err.reason`          — the provider's human-readable reason, unless it
 *      is the unhelpful "unknown custom error" placeholder.
 *   5. `"execution reverted"`.
 *
 * @param {Error} err The thrown error.
 * @param {ethers.Interface} [iface] Contract interface, when one exists.
 * @returns {string} A short, sanitized reason.
 */
function _decodeRevert(err, iface) {
  if (!err) return "execution reverted";

  if (err.revert && typeof err.revert === "object") {
    if (typeof err.revert.name === "string" && err.revert.name !== "") {
      return _sanitizeReason(err.revert.name);
    }
    if (typeof err.revert.signature === "string" && err.revert.signature !== "") {
      return _sanitizeReason(err.revert.signature);
    }
  }

  let data = err.data !== undefined ? err.data : err.revert && err.revert.data;
  if (Array.isArray(data)) data = data[0];
  if (iface && typeof data === "string" && data.length >= 10 && data.startsWith("0x")) {
    try {
      const parsed = iface.parseError(data);
      if (parsed && parsed.name) return _sanitizeReason(parsed.name);
    } catch (parseFailure) {
      /* the ABI does not know this error; fall through to the string paths */
    }
  }

  if (typeof err.reason === "string" && err.reason.trim() !== "" && !/unknown custom error/i.test(err.reason)) {
    return _sanitizeReason(err.reason);
  }

  return "execution reverted";
}

/**
 * Classifies a thrown chain error into a typed relay failure.
 *
 * A transaction that reverted (whether the revert surfaced at gas estimation,
 * at send time, or as a mined receipt with `status === 0`) is
 * `RELAY_TX_REVERTED`, and the caller MUST treat that as "the nonce is still
 * relayable" — nothing was paid, so nothing was consumed. Anything else
 * (network failure, bad RPC, missing gas funds) is `RELAY_TX_FAILED`: we do
 * not know whether the transaction will land later, so the caller must not
 * assume the nonce is free, but the error is equally not the contract's
 * opinion.
 *
 * @param {Error} err The thrown error.
 * @param {ethers.Interface} [iface] Contract interface, when one exists.
 * @returns {Error} A typed error carrying `.code` and `.reason`.
 */
function _toRelayError(err, iface) {
  const message = typeof err === "object" && err !== null && typeof err.message === "string" ? err.message : "";

  // ethers marks a mined-but-failed transaction with status 0 on the error's
  // receipt, and a pre-flight revert with CALL_EXCEPTION/UNPREDICTABLE_GAS.
  const receipt = err && typeof err === "object" ? err.receipt : undefined;
  if (receipt && receipt.status === 0) {
    return _reverted(err, iface);
  }

  if (
    err &&
    typeof err === "object" &&
    (err.code === "CALL_EXCEPTION" ||
      err.code === "UNPREDICTABLE_GAS_LIMIT" ||
      err.code === "REPLACEMENT_UNDERPRICED" ||
      /execution reverted|reverted with/i.test(message) ||
      (err.revert !== undefined && err.revert !== null))
  ) {
    return _reverted(err, iface);
  }

  return _relayError(RELAY_ERRORS.TX_FAILED, "relay: transaction could not be broadcast", { reason: _sanitizeReason(message) }, err);
}

/**
 * Builds the canonical `RELAY_TX_REVERTED` error: the sanitized reason is in
 * BOTH `.reason` and the message, so a log line, an HTTP body and a stack trace
 * all carry the same short explanation without any of them having to reach into
 * the underlying ethers error.
 *
 * @param {Error} err The underlying error.
 * @param {ethers.Interface} [iface] Contract interface, when one exists.
 * @returns {Error} The typed revert error.
 */
function _reverted(err, iface) {
  const reason = _decodeRevert(err, iface);
  return _relayError(RELAY_ERRORS.TX_REVERTED, `relay: transaction reverted (${reason})`, { reason }, err);
}

/* -------------------------------------------------------------------------- */
/* Claim shape validation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Validates and normalises one field of a claim.
 *
 * @param {*} value Candidate value.
 * @param {string} field Field name, for the error message.
 * @param {function(*): boolean} check Predicate that must hold.
 * @returns {*} The value, unchanged.
 * @throws {Error} `INVALID_CLAIM` when the check fails.
 */
function _require(value, field, check) {
  if (value === undefined || value === null || !check(value)) {
    throw _relayError(RELAY_ERRORS.INVALID_CLAIM, `relay: claim field \`${field}\` is missing or malformed`);
  }
  return value;
}

/**
 * True for a non-negative integer expressible as bigint: a bigint, an integer
 * `number`, or a decimal string. Floats, `NaN`, booleans, empty strings and
 * negative values are rejected — the struct fields are `uint256`, and a
 * negative or fractional amount is not a request the contract could ever
 * settle, so accepting it would only produce a wasted gas spend.
 *
 * @param {*} value Candidate.
 * @returns {boolean}
 */
function isIntegerish(value) {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_UINT256;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  if (typeof value === "string") return DECIMAL_PATTERN.test(value.trim());
  return false;
}

/**
 * Validates the SHAPE of a claim payload and returns it normalised.
 *
 * This is deliberately separate from `validateClaimPayload`: shape first
 * (cheap, no crypto, no I/O), signature second (cryptography), chain third
 * (money). Splitting them is what lets the HTTP layer answer 400 for garbage
 * without touching a provider or a key.
 *
 * `reward`, `staminaCost`, `nonce` and `deadline` are returned as decimal
 * STRINGS, which is what `ethers` encodes identically to bigints and what the
 * signature was computed over in `signer.js`, so normalisation cannot change a
 * digest.
 *
 * @param {Object} payload `{ user, reward, staminaCost, nonce, deadline, signature }`.
 * @returns {{ user: string, reward: string, staminaCost: string, nonce: string, deadline: string, signature: string }}
 * @throws {Error} `INVALID_CLAIM` for any malformed or missing field.
 */
function normalizeClaimPayload(payload) {
  const body = payload && typeof payload === "object" ? payload : {};

  const user = _require(body.user, "user", (v) => typeof v === "string" && ethers.isAddress(v));
  const reward = _require(body.reward, "reward", isIntegerish);
  const staminaCost = _require(body.staminaCost, "staminaCost", isIntegerish);
  const nonce = _require(body.nonce, "nonce", isIntegerish);
  const deadline = _require(body.deadline, "deadline", isIntegerish);
  const signature = _require(body.signature, "signature", (v) => typeof v === "string" && SIGNATURE_PATTERN.test(v));

  return {
    user,
    reward: BigInt(reward).toString(),
    staminaCost: BigInt(staminaCost).toString(),
    nonce: BigInt(nonce).toString(),
    deadline: BigInt(deadline).toString(),
    signature,
  };
}

/* -------------------------------------------------------------------------- */
/* validateClaimPayload — the defense-in-depth check                          */
/* -------------------------------------------------------------------------- */

/**
 * Re-derives the EIP-712 digest from the claim AS RECEIVED and recovers the
 * signer of the submitted signature.
 *
 * THE CRITICAL PROPERTY: the digest is rebuilt from the fields the caller sent,
 * never from a server-side record of what was issued. Every one of `reward`,
 * `staminaCost`, `nonce`, `deadline` and `user` is an element of the struct
 * hash, so changing ANY of them changes the digest, and a signature produced
 * over the original digest then recovers to a DIFFERENT address (garbage, with
 * overwhelming probability). That is what makes this check able to stand alone:
 * it does not need to know what the Judge issued in order to reject a claim
 * whose fields were altered in flight.
 *
 * This is defense in depth, not the primary gate. The contract itself rebuilds
 * the same digest and rejects a mismatch with `ClaimSignatureInvalid`, so a
 * bypass here would at worst spend the relayer's gas on a reverting call. It
 * matters because it is FREE: it turns an attacker's bad request into a 400
 * instead of a 502 and a sponsored transaction.
 *
 * @param {Object} params
 * @param {string} params.user Recipient address that may claim.
 * @param {string|number|bigint} params.reward Reward in 18-decimal base units.
 * @param {string|number|bigint} params.staminaCost Stamina cost.
 * @param {string|number|bigint} params.nonce Per-user claim nonce.
 * @param {string|number|bigint} params.deadline Unix seconds.
 * @param {string} params.signature 65-byte 0x-prefixed ECDSA signature.
 * @param {number|string} params.chainId EVM chain id for the domain.
 * @param {string} params.claimerAddress Deployed MiningClaimer (the verifying contract).
 * @param {string} [params.expectedSigner] When provided, the recovered signer must equal it.
 * @returns {{ digest: string, recoveredSigner: string }}
 * @throws {Error} `INVALID_CLAIM` for a malformed payload, `RELAY_SIGNATURE_INVALID`
 *   when the signature does not recover, or when it recovers to a different signer.
 */
function validateClaimPayload({
  user,
  reward,
  staminaCost,
  nonce,
  deadline,
  signature,
  chainId,
  claimerAddress,
  expectedSigner,
} = {}) {
  const claim = normalizeClaimPayload({ user, reward, staminaCost, nonce, deadline, signature });

  if (chainId === undefined || chainId === null || chainId === "") {
    throw _relayError(RELAY_ERRORS.NOT_CONFIGURED, "relay: chainId is not configured");
  }
  if (typeof claimerAddress !== "string" || !ethers.isAddress(claimerAddress)) {
    throw _relayError(RELAY_ERRORS.NOT_CONFIGURED, "relay: claimer address is not configured");
  }

  // Reuse the Judge's own encoder. Never re-implement EIP-712 here: two
  // encoders is how a signature becomes unverifiable on-chain.
  const digest = signer.claimDigest({
    chainId: Number(chainId),
    verifyingContract: claimerAddress,
    claim: {
      user: claim.user,
      reward: claim.reward,
      staminaCost: claim.staminaCost,
      nonce: claim.nonce,
      deadline: claim.deadline,
    },
  });

  let recoveredSigner;
  try {
    recoveredSigner = ethers.recoverAddress(digest, claim.signature);
  } catch (err) {
    throw _relayError(
      RELAY_ERRORS.SIGNATURE_INVALID,
      "relay: signature does not recover to an address",
      undefined,
      err
    );
  }

  if (
    typeof expectedSigner === "string" &&
    ethers.isAddress(expectedSigner) &&
    recoveredSigner.toLowerCase() !== expectedSigner.toLowerCase()
  ) {
    throw _relayError(
      RELAY_ERRORS.SIGNATURE_INVALID,
      "relay: signature was not issued by the claimer's configured signer"
    );
  }

  return { digest, recoveredSigner };
}

/* -------------------------------------------------------------------------- */
/* createRelayService                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the chain adapter.
 *
 * Everything is injected. `wallet` is the object that signs; when it is not
 * supplied it is derived from `provider.getSigner()`, which is the correct
 * behaviour for a node with an unlocked/derived account and is what lets a
 * deployment sponsor gas without a raw key in the environment.
 *
 * @param {Object} params
 * @param {Object} [params.provider] ethers provider (or a stub with `getSigner`).
 * @param {Object} [params.wallet] Signer object; defaults to `provider.getSigner()`.
 * @param {string} [params.claimerAddress] Deployed MiningClaimer address.
 * @param {number|string} [params.chainId] EVM chain id.
 * @param {Object} [params.store] Storage interface (see ./storage.js); used for
 *   optional bookkeeping and never for secrets.
 * @param {Console|Object} [params.logger] Log sink; defaults to `console`.
 *   Receives PUBLIC values only.
 * @returns {{
 *   isConfigured: function(): boolean,
 *   submitClaim: function(Object): Promise<Object>,
 *   validateClaimPayload: function(Object): Object,
 *   relayerAddress: function(): string|null,
 *   getRelayerAddress: function(): Promise<string|null>,
 *   getExpectedSigner: function(): Promise<string|null>,
 *   abi: ReadonlyArray<string>
 * }} The relay service.
 */
function createRelayService({ provider, wallet, claimerAddress, chainId, store, logger } = {}) {
  const log = logger || console;

  /** Memoised result of resolving the gas-sponsoring signer. */
  let resolvedWallet;
  let resolvedWalletResolved = false;

  /**
   * Resolves the signing wallet once: the injected wallet if there is one,
   * otherwise `provider.getSigner()`.
   *
   * @returns {Promise<Object|null>} The wallet, or `null` if unavailable.
   */
  async function _resolveWallet() {
    if (resolvedWalletResolved) return resolvedWallet;
    resolvedWalletResolved = true;
    if (wallet) {
      resolvedWallet = wallet;
    } else if (provider && typeof provider.getSigner === "function") {
      try {
        resolvedWallet = await provider.getSigner();
      } catch (err) {
        resolvedWallet = null;
      }
    } else {
      resolvedWallet = null;
    }
    return resolvedWallet;
  }

  /**
   * True only when a provider, a gas-sponsoring wallet, a claimer address and
   * a chain id are ALL present.
   *
   * A wallet counts as present when it was injected OR the provider can hand
   * one out; nothing else counts, and in particular a bare claimer address is
   * not enough — without a wallet there is no key to pay gas with, and
   * pretending otherwise would make a deployment advertise a gasless flow it
   * cannot serve.
   *
   * @returns {boolean}
   */
  function isConfigured() {
    const hasProvider = Boolean(provider);
    const hasWallet = Boolean(wallet) || Boolean(provider && typeof provider.getSigner === "function");
    const hasClaimer = typeof claimerAddress === "string" && ethers.isAddress(claimerAddress);
    const hasChainId = chainId !== undefined && chainId !== null && chainId !== "";
    return hasProvider && hasWallet && hasClaimer && hasChainId;
  }

  /**
   * The relayer's PUBLIC address if it is synchronously knowable, else `null`.
   *
   * @returns {string|null}
   */
  function relayerAddress() {
    if (wallet && typeof wallet.address === "string") return wallet.address;
    return null;
  }

  /**
   * The relayer's public address, resolving a provider-derived signer if
   * necessary. Never returns key material.
   *
   * @returns {Promise<string|null>}
   */
  async function getRelayerAddress() {
    const active = await _resolveWallet();
    if (!active) return null;
    if (typeof active.address === "string") return active.address;
    if (typeof active.getAddress === "function") {
      try {
        return await active.getAddress();
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  /**
   * Reads the `signer` role currently configured on-chain, i.e. the address
   * whose EIP-712 signatures the claimer will accept.
   *
   * Returns `null` — never throws — when the chain is unreachable or the role
   * cannot be read. The caller decides what an unknown signer means (the HTTP
   * layer treats it as "cannot compare", and relies on the contract's own
   * check); swallowing it here keeps an RPC blip from becoming a 500.
   *
   * @returns {Promise<string|null>}
   */
  async function getExpectedSigner() {
    if (typeof claimerAddress !== "string" || !ethers.isAddress(claimerAddress)) return null;
    const active = await _resolveWallet();
    try {
      const readOnly = active
        ? new ethers.Contract(claimerAddress, MINING_CLAIMER_ABI, active)
        : new ethers.Contract(claimerAddress, MINING_CLAIMER_ABI, provider);
      return await readOnly.signer();
    } catch (err) {
      return null;
    }
  }

  /**
   * The service-bound form of {@link validateClaimPayload}: the chain id and
   * claimer address come from this service's configuration, so a caller can
   * never accidentally validate a claim against a different domain separator.
   *
   * Deliberately an arrow assigned to a DIFFERENTLY NAMED const rather than a
   * method named `validateClaimPayload`: a same-named function declaration
   * inside `createRelayService` would shadow the module-level function it calls
   * and recurse until the stack blew. The exported property name is unchanged.
   *
   * @param {Object} payload Claim fields plus optional `expectedSigner`.
   * @returns {{ digest: string, recoveredSigner: string }}
   */
  const validateClaimPayloadForThisService = (payload) =>
    validateClaimPayload({ ...payload, chainId, claimerAddress });

  /**
   * Broadcasts one signed claim and waits for it to be mined.
   *
   * Argument order matters and is fixed: `claimReward(user, reward,
   * staminaCost, nonce, deadline, signature)` exactly as the contract declares
   * it. The values are passed through `BigInt`/string untouched, so what the
   * relayer broadcasts is byte-for-byte what the Judge signed.
   *
   * On success returns `{ txHash, status, blockNumber, from, to, gasUsed }`
   * with bigints rendered as decimal strings (JSON-safe). On failure it throws
   * a typed error (`RELAY_TX_REVERTED` / `RELAY_TX_FAILED`) and never returns
   * a partially-settled result.
   *
   * @param {Object} params
   * @param {string} params.user Recipient address.
   * @param {string|number|bigint} params.reward Reward in 18-decimal base units.
   * @param {string|number|bigint} params.staminaCost Stamina cost.
   * @param {string|number|bigint} params.nonce Per-user claim nonce.
   * @param {string|number|bigint} params.deadline Unix seconds.
   * @param {string} params.signature 65-byte 0x-prefixed ECDSA signature.
   * @returns {Promise<{ txHash: string, status: number, blockNumber: number, from: string, to: string, gasUsed: string }>}
   * @throws {Error} `INVALID_CLAIM`, `RELAY_NOT_CONFIGURED`, `RELAY_TX_REVERTED` or `RELAY_TX_FAILED`.
   */
  async function submitClaim({ user, reward, staminaCost, nonce, deadline, signature } = {}) {
    const claim = normalizeClaimPayload({ user, reward, staminaCost, nonce, deadline, signature });

    if (!isConfigured()) {
      throw _relayError(RELAY_ERRORS.NOT_CONFIGURED, "relay: relay is not configured");
    }
    const active = await _resolveWallet();
    if (!active) {
      throw _relayError(RELAY_ERRORS.NOT_CONFIGURED, "relay: no gas-sponsoring wallet is available");
    }

    const contract = new ethers.Contract(claimerAddress, MINING_CLAIMER_ABI, active);

    let txResponse;
    try {
      txResponse = await contract.claimReward(
        claim.user,
        claim.reward,
        claim.staminaCost,
        claim.nonce,
        claim.deadline,
        claim.signature
      );
    } catch (err) {
      throw _toRelayError(err, contract.interface);
    }

    let receipt;
    try {
      receipt = await txResponse.wait();
    } catch (err) {
      throw _toRelayError(err, contract.interface);
    }

    if (!receipt || receipt.status === 0) {
      throw _reverted(null, contract.interface);
    }

    const txHash = txResponse.hash || receipt.hash || null;
    const blockNumber = receipt.blockNumber !== undefined ? Number(receipt.blockNumber) : null;

    // PUBLIC values only: a hash and some addresses. The transaction object is
    // never logged — it carries node data we neither need nor want to persist.
    if (log && typeof log.info === "function") {
      log.info("catt-relay: relayed mining claim", {
        txHash,
        relayer: relayerAddress() || (await getRelayerAddress()),
        claimer: claimerAddress,
        user: claim.user,
        nonce: claim.nonce,
        blockNumber,
      });
    }

    return {
      txHash,
      status: receipt.status,
      blockNumber,
      from: receipt.from ?? null,
      to: receipt.to ?? null,
      gasUsed: receipt.gasUsed !== undefined && receipt.gasUsed !== null ? BigInt(receipt.gasUsed).toString() : null,
    };
  }

  return {
    isConfigured,
    submitClaim,
    validateClaimPayload: validateClaimPayloadForThisService,
    relayerAddress,
    getRelayerAddress,
    getExpectedSigner,
    abi: MINING_CLAIMER_ABI,
    /** Exposed for callers that want to record relay activity on the store. */
    store: store || null,
  };
}

/* -------------------------------------------------------------------------- */
/* createRelayServiceFromEnv                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds a relay service from the process environment.
 *
 * Configuration is ALL of `RPC_URL` (a provider), `RELAYER_PRIVATE_KEY` (a
 * gas-sponsoring wallet), `CHAIN_ID` and `MINING_CLAIMER_ADDRESS`. If any of
 * them is absent the resulting service reports `isConfigured() === false` and
 * the HTTP layer answers `503 RELAY_NOT_CONFIGURED`, which is the honest
 * signal for the app to fall back to submitting the transaction itself.
 *
 * The key is read here, handed to `ethers.Wallet`, and never stored on this
 * module, returned, or logged. When `RELAYER_PRIVATE_KEY` is present but
 * `RPC_URL` is not there is nothing to broadcast through, so no wallet is
 * built at all and the service stays unconfigured rather than half-working.
 *
 * @param {Object} [params]
 * @param {number|string} [params.chainId] Overrides `CHAIN_ID`.
 * @param {string} [params.claimerAddress] Overrides `MINING_CLAIMER_ADDRESS`.
 * @param {Object} [params.provider] Overrides `RPC_URL` (used by tests).
 * @param {Object} [params.wallet] Overrides the environment-derived wallet.
 * @param {Object} [params.store] Storage interface.
 * @param {Console|Object} [params.logger] Log sink; defaults to `console`.
 * @returns {Object} A relay service.
 */
function createRelayServiceFromEnv({ chainId, claimerAddress, provider, wallet, store, logger } = {}) {
  const env = process.env || {};
  const rpcUrl = typeof env.RPC_URL === "string" && env.RPC_URL.trim() !== "" ? env.RPC_URL.trim() : "";
  const relayerKey =
    typeof env.RELAYER_PRIVATE_KEY === "string" && env.RELAYER_PRIVATE_KEY.trim() !== ""
      ? env.RELAYER_PRIVATE_KEY.trim()
      : "";

  const resolvedChainId = chainId !== undefined && chainId !== null && chainId !== "" ? chainId : env.CHAIN_ID;
  const resolvedClaimer =
    claimerAddress !== undefined && claimerAddress !== null && claimerAddress !== ""
      ? claimerAddress
      : env.MINING_CLAIMER_ADDRESS;

  const resolvedProvider = provider || (rpcUrl !== "" ? new ethers.JsonRpcProvider(rpcUrl) : null);

  let resolvedWallet = wallet || null;
  if (!resolvedWallet && resolvedProvider && relayerKey !== "") {
    try {
      resolvedWallet = new ethers.Wallet(relayerKey, resolvedProvider);
    } catch (err) {
      // A malformed key is a misconfiguration, not a crash: the service stays
      // unconfigured and the reason never mentions the value.
      resolvedWallet = null;
    }
  }

  return createRelayService({
    provider: resolvedProvider,
    wallet: resolvedWallet,
    claimerAddress: resolvedClaimer,
    chainId: resolvedChainId,
    store,
    logger,
  });
}

module.exports = {
  MINING_CLAIMER_ABI,
  RELAY_ERRORS,
  createRelayService,
  createRelayServiceFromEnv,
  isIntegerish,
  normalizeClaimPayload,
  validateClaimPayload,
};