/**
 * CATT Protocol — Gasless relay tests (PRD 3.2 "Gasless transaction").
 *
 * NO test framework dependency. Node's built-in `node:test` runner plus
 * `node:assert/strict`, the app bound to an ephemeral port via `listen(0)`, and
 * the global `fetch` to drive it — exactly the pattern `server.test.js` uses.
 * No supertest, no jest, no chain-faking library.
 *
 * THE POINT OF THIS FILE: the relay is the only part of the backend that talks
 * to a chain, so it is the only part that would normally need a real node to be
 * tested. Every chain interaction here runs against a SMALL LOCAL STUB:
 *
 *   - `createStubSigner()` is a duck-typed wallet. `ethers.Contract` only
 *     requires `sendTransaction` on its runner, so a plain object is a complete
 *     substitute, and it captures the RAW CALLDATA — which is what lets these
 *     tests assert the exact `claimReward` argument list and order rather than
 *     "it was called somehow".
 *   - `createFakeProvider()` is the smallest provider surface a real
 *     `ethers.Wallet` needs, for the two places a genuine key must be in play:
 *     the `provider.getSigner()` derivation path, and the secret-safety proof
 *     that a revert carrying a real key inside the wallet still leaks nothing.
 *
 * TEST HYGIENE:
 *   - Throwaway keys via `ethers.Wallet.createRandom()`, created per file or per
 *     test and never written to disk or into `process.env` (except in the two
 *     tests that deliberately exercise the env-built service, which restore
 *     `process.env` afterwards).
 *   - A fresh app AND a fresh store per test, because the store holds per-user
 *     nonce counters and the relay's once-only bookkeeping.
 *   - The relayer wallet and the judge/signer wallet are always DIFFERENT
 *     wallets: the relayer sponsors gas and attests to nothing, and a bug that
 *     conflated the two roles would pass unnoticed if they shared a key.
 */

const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const content = require("../src/content");
const signer = require("../signer");
const relay = require("../src/relay");
const { createApp, ERRORS } = require("../src/server");
const { createMemoryStore, STORAGE_METHODS } = require("../src/storage");

const { MINING_CLAIMER_ABI, RELAY_ERRORS, createRelayService, createRelayServiceFromEnv, validateClaimPayload } =
  relay;

/* -------------------------------------------------------------------------- */
/* Fixed test configuration                                                    */
/* -------------------------------------------------------------------------- */

/** The backend Judge's key. It signs claims; it is NOT the relayer. */
const judgeWallet = ethers.Wallet.createRandom();

/** The gas sponsor. A different wallet on purpose. */
const relayerWallet = ethers.Wallet.createRandom();

/** A third wallet, for "signed by somebody else" cases. */
const strangerWallet = ethers.Wallet.createRandom();

const CHAIN_ID = 31337;
/** Checksummed, deterministic, and never any of the three wallets above. */
const CLAIMER_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

/** Obviously fake users. */
const USER_A = "0x" + "11".repeat(20);
const USER_B = "0x" + "22".repeat(20);

const GENEROUS_TYPING_MS = 40_000;
const MISSION_ID = "mission-1";
const MISSION = content.getMission(MISSION_ID);
const ARTICLE = content.getArticle(MISSION.articleId);

/** Fake transaction hash for the stub chain. */
const FAKE_TX_HASH = "0x" + "ab".repeat(32);

/** A valid claim payload, freshly signed by the Judge on demand. */
function signedClaim(overrides = {}, signingWallet = judgeWallet) {
  const claim = {
    user: USER_A,
    reward: MISSION.reward,
    // The WIRE form. `MISSION.staminaCost` is a plain integer count of unitless
    // stamina POINTS (StakingManager.sol); a claim payload is decimal text, which
    // is exactly what `toUintString` produces for it on the way out.
    staminaCost: String(MISSION.staminaCost),
    nonce: "1",
    deadline: String(Math.floor(Date.now() / 1000) + 600),
    ...overrides,
  };
  const { signature } = signer.signClaim({
    privateKey: signingWallet.privateKey,
    chainId: CHAIN_ID,
    verifyingContract: CLAIMER_ADDRESS,
    ...claim,
  });
  return { ...claim, signature };
}

/* -------------------------------------------------------------------------- */
/* Chain stubs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A receipt shaped enough for `ethers`' `ContractTransactionReceipt`.
 *
 * @param {Object} [opts]
 * @param {number} [opts.status] 1 = mined successfully, 0 = mined but reverted.
 * @param {string} [opts.hash] Transaction hash.
 * @param {string} [opts.from] Sender.
 * @returns {Object} Receipt.
 */
function fakeReceipt({ status = 1, hash = FAKE_TX_HASH, from = relayerWallet.address } = {}) {
  return {
    status,
    hash,
    blockNumber: 42,
    gasUsed: 21000n,
    gasLimit: 30000n,
    from,
    to: CLAIMER_ADDRESS,
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    index: 0,
    blockHash: "0x" + "cd".repeat(32),
    type: 2,
    blobGasUsed: 0n,
    cumulativeGasUsed: 21000n,
    effectiveGasPrice: 1n,
    transactionIndex: 0,
  };
}

/**
 * A duck-typed signer/wallet plus the raw calldata it was asked to broadcast.
 *
 * `ethers.Contract` needs only `sendTransaction` on its runner, so this object
 * is a complete stand-in for a funded wallet — and because it sees the
 * transaction BEFORE it is signed or sent, it is the only place in the test
 * suite that can prove the exact calldata the relayer built.
 *
 * @param {Object} [opts]
 * @param {string} [opts.address] Relayer address to advertise.
 * @param {Object} [opts.receipt] Receipt to resolve `wait()` with.
 * @param {function(Object): Promise<Object>} [opts.onSend] Replaces `sendTransaction`.
 * @param {string} [opts.claimSigner] Value `provider.call` returns for `signer()`.
 * @returns {{ wallet: Object, provider: Object, sent: Array<Object> }}
 */
function createStubSigner({ address = relayerWallet.address, receipt, onSend, claimSigner = judgeWallet.address, callError } = {}) {
  const sent = [];
  const iface = new ethers.Interface(MINING_CLAIMER_ABI);

  const provider = {
    async call(tx) {
      if (callError) throw callError;
      // Only `signer()` is ever read on-chain, and its result is encoded
      // through the real interface so the decoded value is checksummed.
      return iface.encodeFunctionResult("signer", [claimSigner]);
    },
    async estimateGas() {
      return 30000n;
    },
    async waitForTransaction() {
      return receipt || fakeReceipt({ from: address });
    },
    async getTransactionReceipt() {
      return receipt || fakeReceipt({ from: address });
    },
    async getTransaction(hash) {
      return { hash };
    },
    async resolveName(name) {
      return name;
    },
  };

  const wallet = {
    address,
    provider,
    async getAddress() {
      return address;
    },
    async sendTransaction(tx) {
      sent.push(tx);
      if (onSend) return onSend(tx);
      return { hash: FAKE_TX_HASH, from: address, to: tx.to };
    },
  };

  return { wallet, provider, sent };
}

/**
 * The smallest provider a REAL `ethers.Wallet` accepts, so that a genuine key
 * can sit inside the wallet the relay uses (the secret-safety path).
 *
 * @param {Object} [opts]
 * @param {Error} [opts.estimateGasError] Thrown by `estimateGas`, i.e. a revert.
 * @returns {Object} A provider stub.
 */
function createFakeProvider({ estimateGasError } = {}) {
  return {
    async resolveName(name) {
      return name;
    },
    async getTransactionCount() {
      return 7;
    },
    async getBlockNumber() {
      return 5;
    },
    async getNetwork() {
      return { chainId: BigInt(CHAIN_ID), name: "catt-fake" };
    },
    resolveProperties(props) {
      return props;
    },
    async getFeeData() {
      return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasPrice: 1n };
    },
    async estimateGas() {
      if (estimateGasError) throw estimateGasError;
      return 30000n;
    },
    async broadcastTransaction() {
      throw new Error("broadcastTransaction must not be reached in this test");
    },
  };
}

/** A revert error shaped the way a node reports one during gas estimation. */
function revertError(name = "ClaimExpired") {
  const err = new Error(`execution reverted: ${name}`);
  err.code = "UNPREDICTABLE_GAS_LIMIT";
  err.revert = { name, signature: `${name}(uint256,uint256)`, args: [1n, 2n] };
  return err;
}

/** A logger that records EVERY argument handed to it, on every level. */
function recordingLogger() {
  const records = [];
  const push = (level) => (...args) => {
    records.push({ level, args });
  };
  return {
    records,
    log: push("log"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  };
}

/** Asserts a thrown value is a typed relay error with `code`. */
function assertRelayCode(fn, expectedCode, message) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, `${message}: expected an Error to be thrown`);
  assert.equal(caught.code, expectedCode, `${message}: expected .code ${expectedCode}, got ${caught.code}`);
  return caught;
}

/* -------------------------------------------------------------------------- */
/* Fixtures for the HTTP end-to-end test                                       */
/* -------------------------------------------------------------------------- */

/** A realistic HUMAN telemetry stream: drifting temperature, no repeated touch. */
function humanTelemetry(count = 25, startTs = 1_760_000_000_000) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: startTs + i * 5000,
      // gcd(7, 81) === 1, so every temperature below is distinct.
      batteryTempC: 26 + ((i * 7) % 81) / 10,
      // gcd(37, 260) === 1 and gcd(53, 420) === 1, so no touch pair repeats.
      touch: { x: 40 + ((i * 37) % 260), y: 90 + ((i * 53) % 420) },
      scrollDelta: [120, -45, 310, -260, 0, 175, -95, 60][i % 8],
    });
  }
  return samples;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

let liveServers = [];
let currentStore;
let baseUrl;

/** Closes servers and force-releases undici's keep-alive sockets. */
async function closeAllServers() {
  const servers = liveServers;
  liveServers = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
}

/**
 * Boots a fresh app on an ephemeral port.
 *
 * @param {Object} [options]
 * @param {Object} [options.relayService] Relay service to inject.
 * @param {Object} [options.store] Store override.
 * @param {Object} [options.logger] Logger override.
 * @param {string} [options.expectedSigner] Override for the expected signer.
 * @param {string} [options.privateKey] Judge key; defaults to the throwaway one.
 * @returns {Promise<{ baseUrl: string, store: Object, logger: Object }>}
 */
async function boot(options = {}) {
  const logger = options.logger || recordingLogger();
  const store = options.store || createMemoryStore();
  const app = createApp({
    store,
    logger,
    chainId: CHAIN_ID,
    verifyingContract: CLAIMER_ADDRESS,
    privateKey: options.privateKey === null ? undefined : options.privateKey || judgeWallet.privateKey,
    relayService: options.relayService,
    expectedSigner: options.expectedSigner === null ? undefined : options.expectedSigner || judgeWallet.address,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  const { port } = server.address();
  // `currentStore` always tracks the store of the CURRENTLY booted app, so a
  // test that re-boots with its own relay service cannot accidentally assert
  // against the previous app's (or the previous app's own) store.
  currentStore = store;
  return { baseUrl: `http://127.0.0.1:${port}`, store, logger };
}

after(async () => {
  await closeAllServers();
});

beforeEach(async () => {
  await closeAllServers();
  const booted = await boot({ relayService: createRelayService({}) });
  currentStore = booted.store;
  baseUrl = booted.baseUrl;
});

/** Issues a request and returns status, parsed body and the RAW text. */
async function http(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    body = undefined;
  }
  return { status: res.status, body, raw };
}

/** JSON POST helper. */
function postJson(path, payload) {
  return http(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/* ========================================================================== */
/* 1. The ABI                                                                 */
/* ========================================================================== */

test("MINING_CLAIMER_ABI is a minimal, frozen, hand-written fragment", () => {
  assert.ok(Array.isArray(MINING_CLAIMER_ABI));
  assert.ok(Object.isFrozen(MINING_CLAIMER_ABI));
  assert.deepEqual(
    [...MINING_CLAIMER_ABI].sort(),
    [
      "function cattToken() view returns (address)",
      "function claimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline,bytes signature)",
      "function owner() view returns (address)",
      "function signer() view returns (address)",
      "function stakingManager() view returns (address)",
    ].sort(),
    "the ABI must contain exactly the five members the relay needs"
  );

  // It parses, and claimReward has the contract's exact parameter order.
  const iface = new ethers.Interface(MINING_CLAIMER_ABI);
  const fragment = iface.getFunction("claimReward");
  assert.deepEqual(
    fragment.inputs.map((input) => `${input.name}:${input.type}`),
    ["user:address", "reward:uint256", "staminaCost:uint256", "nonce:uint256", "deadline:uint256", "signature:bytes"]
  );
  assert.equal(ethers.isAddress(CLAIMER_ADDRESS), true);
});

/* ========================================================================== */
/* 2. validateClaimPayload — happy path                                       */
/* ========================================================================== */

test("validateClaimPayload accepts a genuine Judge signature and returns its digest", () => {
  const claim = signedClaim();
  const { digest, recoveredSigner } = validateClaimPayload({
    ...claim,
    chainId: CHAIN_ID,
    claimerAddress: CLAIMER_ADDRESS,
  });

  assert.equal(recoveredSigner, judgeWallet.address, "must recover the Judge's address");
  // Independently recomputed, exactly as MiningClaimer.hashClaim would.
  const recomputed = signer.claimDigest({
    chainId: CHAIN_ID,
    verifyingContract: CLAIMER_ADDRESS,
    claim: {
      user: claim.user,
      reward: claim.reward,
      staminaCost: claim.staminaCost,
      nonce: claim.nonce,
      deadline: claim.deadline,
    },
  });
  assert.equal(digest, recomputed, "the digest must equal an independent signer.claimDigest");
  assert.equal(digest, ethers.TypedDataEncoder.hash({ name: "CATT Protocol", version: "1", chainId: CHAIN_ID, verifyingContract: CLAIMER_ADDRESS }, signer.CLAIM_REWARD_TYPES, claim));
  assert.equal(ethers.recoverAddress(digest, claim.signature), judgeWallet.address);
});

test("validateClaimPayload accepts bigint, decimal-string and numeric fields alike", () => {
  const claim = signedClaim();
  const result = validateClaimPayload({
    user: claim.user,
    reward: BigInt(claim.reward),
    staminaCost: BigInt(claim.staminaCost),
    nonce: Number(claim.nonce),
    deadline: Number(claim.deadline),
    signature: claim.signature,
    chainId: CHAIN_ID,
    claimerAddress: CLAIMER_ADDRESS,
  });
  assert.equal(result.recoveredSigner, judgeWallet.address);
});

test("validateClaimPayload rejects a valid signature when the expected signer differs", () => {
  const claim = signedClaim();
  assertRelayCode(
    () =>
      validateClaimPayload({
        ...claim,
        chainId: CHAIN_ID,
        claimerAddress: CLAIMER_ADDRESS,
        expectedSigner: strangerWallet.address,
      }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "expected-signer mismatch"
  );
});

test("validateClaimPayload rejects a signature issued against a different chain or claimer", () => {
  const claim = signedClaim();
  // Right signature, wrong domain: the digest differs, so nothing recovers.
  assertRelayCode(
    () =>
      validateClaimPayload({
        ...claim,
        chainId: 11155111,
        claimerAddress: CLAIMER_ADDRESS,
        expectedSigner: judgeWallet.address,
      }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "wrong chainId"
  );
  assertRelayCode(
    () =>
      validateClaimPayload({
        ...claim,
        chainId: CHAIN_ID,
        claimerAddress: "0x" + "77".repeat(20),
        expectedSigner: judgeWallet.address,
      }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "wrong claimer address"
  );
});

/* ========================================================================== */
/* 3. Defense in depth — every tampered field                                 */
/* ========================================================================== */

test("TAMPERED reward is rejected with RELAY_SIGNATURE_INVALID", () => {
  const claim = signedClaim();
  const tampered = { ...claim, reward: (BigInt(claim.reward) * 2n).toString() };
  assertRelayCode(
    () => validateClaimPayload({ ...tampered, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "tampered reward"
  );
});

test("TAMPERED staminaCost is rejected with RELAY_SIGNATURE_INVALID", () => {
  const claim = signedClaim();
  const tampered = { ...claim, staminaCost: "0" };
  assertRelayCode(
    () => validateClaimPayload({ ...tampered, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "tampered staminaCost"
  );
});

test("TAMPERED nonce is rejected with RELAY_SIGNATURE_INVALID", () => {
  const claim = signedClaim();
  const tampered = { ...claim, nonce: "99" };
  assertRelayCode(
    () => validateClaimPayload({ ...tampered, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "tampered nonce"
  );
});

test("TAMPERED deadline is rejected with RELAY_SIGNATURE_INVALID", () => {
  const claim = signedClaim();
  const tampered = { ...claim, deadline: String(Number(claim.deadline) + 86_400) };
  assertRelayCode(
    () => validateClaimPayload({ ...tampered, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "tampered deadline"
  );
});

test("TAMPERED user (a signature for A must not validate as B) is rejected", () => {
  const claim = signedClaim({ user: USER_A });
  const tampered = { ...claim, user: USER_B };
  assertRelayCode(
    () => validateClaimPayload({ ...tampered, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "tampered user"
  );
  // And the untampered payload for A still validates, so the rejection above is
  // about the digest change and nothing else.
  assert.equal(
    validateClaimPayload({ ...claim, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS }).recoveredSigner,
    judgeWallet.address
  );
});

test("a signature from an UNRELATED key is rejected with RELAY_SIGNATURE_INVALID", () => {
  const claim = signedClaim({}, strangerWallet);
  assert.equal(ethers.recoverAddress(
    signer.claimDigest({ chainId: CHAIN_ID, verifyingContract: CLAIMER_ADDRESS, claim }),
    claim.signature
  ), strangerWallet.address, "the signature really is from the stranger");
  assertRelayCode(
    () => validateClaimPayload({ ...claim, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, expectedSigner: judgeWallet.address }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "unrelated signing key"
  );
});

test("without an expected signer, a tampered payload still recovers to a DIFFERENT address", () => {
  // `expectedSigner` is optional by design: when the caller has not told us who
  // the claimer trusts, we cannot compare, and inventing a rejection would be a
  // guess. What is NOT optional is the digest: it is rebuilt from the fields AS
  // RECEIVED, so a tampered field cannot recover to the Judge. This test asserts
  // that property directly — it is the whole point of rebuilding the digest
  // instead of looking up what the server issued.
  const claim = signedClaim();
  const tampered = { ...claim, reward: (BigInt(claim.reward) * 2n).toString() };
  const { digest, recoveredSigner } = validateClaimPayload({
    ...tampered,
    chainId: CHAIN_ID,
    claimerAddress: CLAIMER_ADDRESS,
  });
  assert.notEqual(recoveredSigner, judgeWallet.address, "the tampered digest must not recover to the Judge");
  assert.equal(
    digest,
    signer.claimDigest({ chainId: CHAIN_ID, verifyingContract: CLAIMER_ADDRESS, claim: tampered }),
    "the digest really is a function of the received fields"
  );
  // Supplying the expected signer is what turns that difference into a rejection.
  assertRelayCode(
    () =>
      validateClaimPayload({
        ...tampered,
        chainId: CHAIN_ID,
        claimerAddress: CLAIMER_ADDRESS,
        expectedSigner: judgeWallet.address,
      }),
    RELAY_ERRORS.SIGNATURE_INVALID,
    "same payload, expected signer known"
  );
});

/* ========================================================================== */
/* 4. Malformed payloads                                                      */
/* ========================================================================== */

test("malformed payloads are rejected with INVALID_CLAIM", () => {
  const claim = signedClaim();
  const malformed = [
    ["64-byte signature", { ...claim, signature: "0x" + "22".repeat(64) }],
    ["64-byte signature, no 0x", { ...claim, signature: "22".repeat(65) }],
    ["non-hex signature", { ...claim, signature: "0x" + "zz".repeat(65) }],
    ["empty signature", { ...claim, signature: "" }],
    ["signature missing", { ...claim, signature: undefined }],
    ["garbage address", { ...claim, user: "not-an-address" }],
    ["truncated address", { ...claim, user: "0x1111" }],
    ["user missing", { ...claim, user: undefined }],
    ["reward missing", { ...claim, reward: undefined }],
    ["reward not numeric", { ...claim, reward: "twelve" }],
    ["reward negative", { ...claim, reward: "-1" }],
    ["reward fractional", { ...claim, reward: 1.5 }],
    ["nonce missing", { ...claim, nonce: undefined }],
    ["nonce a boolean", { ...claim, nonce: true }],
    ["deadline missing", { ...claim, deadline: undefined }],
    ["staminaCost missing", { ...claim, staminaCost: undefined }],
    ["empty body", {}],
    ["no payload at all", undefined],
  ];
  for (const [label, payload] of malformed) {
    assertRelayCode(
      () => validateClaimPayload({ ...payload, chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS }),
      RELAY_ERRORS.INVALID_CLAIM,
      label
    );
  }
});

test("validateClaimPayload reports a misconfigured relay rather than a bad claim", () => {
  const claim = signedClaim();
  assertRelayCode(
    () => validateClaimPayload({ ...claim, chainId: undefined, claimerAddress: CLAIMER_ADDRESS }),
    RELAY_ERRORS.NOT_CONFIGURED,
    "missing chainId"
  );
  assertRelayCode(
    () => validateClaimPayload({ ...claim, chainId: CHAIN_ID, claimerAddress: "nope" }),
    RELAY_ERRORS.NOT_CONFIGURED,
    "bad claimer address"
  );
});

/* ========================================================================== */
/* 5. isConfigured                                                             */
/* ========================================================================== */

test("isConfigured is true only when provider, wallet, claimer and chainId are all present", () => {
  const { wallet, provider } = createStubSigner();
  assert.equal(createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID }).isConfigured(), true);
  assert.equal(createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS }).isConfigured(), false, "no chainId");
  assert.equal(createRelayService({ wallet, provider, chainId: CHAIN_ID }).isConfigured(), false, "no claimer");
  assert.equal(createRelayService({ wallet, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID }).isConfigured(), false, "no provider");
  assert.equal(createRelayService({ provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID }).isConfigured(), false, "provider cannot produce a wallet");
  assert.equal(createRelayService({}).isConfigured(), false, "nothing configured");
  // A bogus claimer address is not a claimer.
  assert.equal(createRelayService({ wallet, provider, claimerAddress: "0xdead", chainId: CHAIN_ID }).isConfigured(), false);
});

test("the wallet defaults to provider.getSigner() when none is injected", async () => {
  const { wallet, provider } = createStubSigner();
  const service = createRelayService({ provider: { getSigner: async () => wallet }, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  assert.equal(service.isConfigured(), true);
  assert.equal(await service.getRelayerAddress(), relayerWallet.address);
  assert.equal(service.relayerAddress(), null, "not synchronously knowable");

  const result = await service.submitClaim(signedClaim());
  assert.equal(result.txHash, FAKE_TX_HASH);
});

test("a provider that cannot produce a signer leaves the relay unconfigured, not crashing", async () => {
  const service = createRelayService({
    provider: { getSigner: async () => { throw new Error("no accounts"); } },
    claimerAddress: CLAIMER_ADDRESS,
    chainId: CHAIN_ID,
  });
  assert.equal(service.isConfigured(), true, "a provider that exposes getSigner counts as wallet-capable");
  assert.equal(await service.getRelayerAddress(), null);
  // Async, so it cannot go through the synchronous assertRelayCode helper.
  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "submitClaim with no resolvable wallet must throw");
  assert.equal(caught.code, RELAY_ERRORS.NOT_CONFIGURED);
});

test("submitClaim refuses to run on an unconfigured relay", async () => {
  const service = createRelayService({});
  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.NOT_CONFIGURED);
});

test("getExpectedSigner reads the claimer's signer() role from the chain", async () => {
  const { wallet, provider } = createStubSigner({ claimSigner: judgeWallet.address });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  assert.equal(await service.getExpectedSigner(), judgeWallet.address);

  // Unreachable chain: null, never a throw.
  const brokenStubs = createStubSigner({ callError: new Error("rpc down") });
  const broken = createRelayService({
    wallet: brokenStubs.wallet,
    provider: brokenStubs.provider,
    claimerAddress: CLAIMER_ADDRESS,
    chainId: CHAIN_ID,
  });
  assert.equal(await broken.getExpectedSigner(), null);
  assert.equal(await createRelayService({}).getExpectedSigner(), null);
});

/* ========================================================================== */
/* 6. submitClaim — argument order against an injected fake                   */
/* ========================================================================== */

test("submitClaim calls claimReward with the exact arguments, in the exact order", async () => {
  const logger = recordingLogger();
  const { wallet, provider, sent } = createStubSigner();
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID, logger });

  const claim = signedClaim({ nonce: "7" });
  const result = await service.submitClaim(claim);

  // The captured calldata is the ground truth: decode it and compare by value
  // and position, and check the selector is claimReward's.
  assert.equal(sent.length, 1, "exactly one transaction must be broadcast");
  const iface = new ethers.Interface(MINING_CLAIMER_ABI);
  assert.equal(sent[0].data.slice(0, 10), iface.getFunction("claimReward").selector);
  assert.equal(sent[0].to, CLAIMER_ADDRESS, "the transaction must target the claimer");

  const decoded = iface.decodeFunctionData("claimReward", sent[0].data);
  assert.deepEqual(
    [...decoded].map(String),
    [claim.user, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, claim.signature],
    "claimReward(user, reward, staminaCost, nonce, deadline, signature) — order is significant"
  );

  assert.deepEqual(result, {
    txHash: FAKE_TX_HASH,
    status: 1,
    blockNumber: 42,
    from: relayerWallet.address,
    to: CLAIMER_ADDRESS,
    gasUsed: "21000",
  });

  // The log line carries the hash and addresses, and nothing else of note.
  const infoCalls = logger.records.filter((r) => r.level === "info");
  assert.equal(infoCalls.length, 1);
  const logged = infoCalls[0].args[1];
  assert.equal(logged.txHash, FAKE_TX_HASH);
  assert.equal(logged.claimer, CLAIMER_ADDRESS);
  assert.equal(logged.user, claim.user);
  assert.equal(logged.nonce, claim.nonce);
  assert.equal(logged.relayer, relayerWallet.address);
  assert.equal("data" in logged, false, "the transaction payload must not be logged");
});

test("submitClaim bigints and numeric strings are encoded identically", async () => {
  const { wallet, provider, sent } = createStubSigner();
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  const claim = signedClaim();
  await service.submitClaim({ ...claim, reward: BigInt(claim.reward), nonce: Number(claim.nonce) });
  const decoded = new ethers.Interface(MINING_CLAIMER_ABI).decodeFunctionData("claimReward", sent[0].data);
  assert.deepEqual([...decoded].map(String), [claim.user, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, claim.signature]);
});

test("submitClaim validates the payload before touching the chain", async () => {
  const { wallet, provider, sent } = createStubSigner();
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  let caught;
  try {
    await service.submitClaim({ user: "nope" });
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.INVALID_CLAIM);
  assert.equal(sent.length, 0, "nothing may be broadcast for a malformed claim");
});

/* ========================================================================== */
/* 7. submitClaim — reverts and failures                                      */
/* ========================================================================== */

test("a reverting transaction surfaces as RELAY_TX_REVERTED with a clean, short reason", async () => {
  const logger = recordingLogger();
  const { wallet, provider } = createStubSigner({ onSend: async () => { throw revertError("ClaimAlreadyUsed"); } });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID, logger });

  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.TX_REVERTED);
  assert.equal(caught.reason, "ClaimAlreadyUsed", "the custom error name is recovered");
  assert.ok(caught.message.includes("ClaimAlreadyUsed"), "the message carries the short reason");
  assert.ok(caught.message.length < 200, "the message must stay short");
  assert.equal(caught.message.includes("    at "), false, "no stack frame in the message");
  assert.equal(caught.message.includes("\n"), false, "no newline in the message");
  // The original error survives for the server-side logger, but invisibly.
  assert.ok(caught.cause, "the underlying error is kept as a cause");
  assert.equal(JSON.stringify(caught).includes("UNPREDICTABLE_GAS_LIMIT"), false, "JSON of the error is clean");
});

test("a receipt with status 0 is reported as RELAY_TX_REVERTED", async () => {
  const { wallet, provider } = createStubSigner({ receipt: fakeReceipt({ status: 0 }) });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.TX_REVERTED);
  assert.equal(caught.reason, "execution reverted");
});

test("a revert reason that looks like a key is redacted", async () => {
  const leak = `execution reverted (${relayerWallet.privateKey})`;
  const { wallet, provider } = createStubSigner({ onSend: async () => { throw revertError(leak); } });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.TX_REVERTED);
  assert.equal(caught.reason.includes(relayerWallet.privateKey), false, "a key-shaped value must be redacted");
  assert.ok(caught.reason.includes("[redacted]"));
});

test("a non-revert broadcast failure is RELAY_TX_FAILED, not RELAY_TX_REVERTED", async () => {
  const { wallet, provider } = createStubSigner({
    onSend: async () => {
      const err = new Error("could not coalesce error (insufficient funds for gas)");
      err.code = "INSUFFICIENT_FUNDS";
      throw err;
    },
  });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  let caught;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, RELAY_ERRORS.TX_FAILED);
  assert.ok(caught.reason.length > 0);
});

/* ========================================================================== */
/* 8. HTTP: POST /api/relay                                                   */
/* ========================================================================== */

test("POST /api/relay is 503 RELAY_NOT_CONFIGURED when no relayer is deployed", async () => {
  const claim = signedClaim();
  const res = await postJson("/api/relay", claim);
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: ERRORS.RELAY_NOT_CONFIGURED });
});

test("POST /api/relay is 400 INVALID_CLAIM for a malformed body", async () => {
  ({ baseUrl } = await boot({ relayService: configuredRelay().service }));
  // Built by MUTATING a genuinely signed claim rather than by re-signing it:
  // an un-signable amount (e.g. "twelve") must still be expressible on the wire,
  // because that is exactly what a hostile client would send.
  const valid = signedClaim();
  const { signature, ...withoutSignature } = valid;
  const { reward, ...withoutReward } = valid;
  const { user, ...withoutUser } = valid;
  const bad = [
    ["empty body", {}],
    ["no signature", withoutSignature],
    ["64-byte signature", { ...valid, signature: "0x" + "22".repeat(64) }],
    ["non-hex signature", { ...valid, signature: "0x" + "zz".repeat(65) }],
    ["garbage address", { ...valid, user: "not-an-address" }],
    ["no reward", withoutReward],
    ["no user", withoutUser],
    ["non-numeric reward", { ...valid, reward: "twelve" }],
    ["negative reward", { ...valid, reward: "-1" }],
    ["fractional nonce", { ...valid, nonce: 1.5 }],
    ["boolean nonce", { ...valid, nonce: true }],
    ["null fields", { ...valid, reward: null, deadline: null }],
  ];
  for (const [label, payload] of bad) {
    const res = await postJson("/api/relay", payload);
    assert.equal(res.status, 400, `expected 400 for ${label}`);
    assert.deepEqual(res.body, { error: ERRORS.INVALID_CLAIM }, label);
  }
});

test("POST /api/relay is 400 RELAY_CLAIM_EXPIRED for a deadline in the past", async () => {
  ({ baseUrl } = await boot({ relayService: configuredRelay().service }));
  // A genuinely signed claim whose deadline has already elapsed.
  const claim = signedClaim({ deadline: String(Math.floor(Date.now() / 1000) - 5) });
  const res = await postJson("/api/relay", claim);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: ERRORS.RELAY_CLAIM_EXPIRED });
});

test("POST /api/relay is 400 RELAY_SIGNATURE_INVALID for a tampered payload", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service }));
  const claim = signedClaim();

  const cases = [
    ["reward", { ...claim, reward: (BigInt(claim.reward) * 3n).toString() }],
    ["staminaCost", { ...claim, staminaCost: "0" }],
    ["nonce", { ...claim, nonce: "77" }],
    ["deadline", { ...claim, deadline: String(Number(claim.deadline) + 3600) }],
    ["user", { ...claim, user: USER_B }],
  ];
  for (const [field, payload] of cases) {
    const res = await postJson("/api/relay", payload);
    assert.equal(res.status, 400, `tampered ${field} must be a 400`);
    assert.deepEqual(res.body, { error: ERRORS.RELAY_SIGNATURE_INVALID }, `tampered ${field} code`);
  }
  assert.equal(relayStub.stubs.sent.length, 0, "no tampered claim may reach the chain");

  // A signature from an unrelated key, likewise.
  const stranger = signedClaim({}, strangerWallet);
  const res = await postJson("/api/relay", stranger);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: ERRORS.RELAY_SIGNATURE_INVALID });
  assert.equal(relayStub.stubs.sent.length, 0);
});

test("POST /api/relay is 400 RELAY_SIGNATURE_INVALID when the on-chain signer differs", async () => {
  // Configured service whose chain says a DIFFERENT address is the signer.
  const { wallet, provider, sent } = createStubSigner({ claimSigner: strangerWallet.address });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  ({ baseUrl } = await boot({ relayService: service, expectedSigner: null }));

  const res = await postJson("/api/relay", signedClaim());
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: ERRORS.RELAY_SIGNATURE_INVALID });
  assert.equal(sent.length, 0);
});

test("POST /api/relay is 200 and broadcasts the claim when everything agrees", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service }));
  const claim = signedClaim({ nonce: "5" });

  const res = await postJson("/api/relay", claim);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    txHash: FAKE_TX_HASH,
    status: 1,
    relayer: relayerWallet.address,
    user: USER_A,
    nonce: "5",
  });

  // The chain stub really received the claim, argument for argument.
  const decoded = new ethers.Interface(MINING_CLAIMER_ABI).decodeFunctionData(
    "claimReward",
    relayStub.stubs.sent[0].data
  );
  assert.deepEqual(
    [...decoded].map(String),
    [claim.user, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, claim.signature]
  );

  // And the nonce is now marked relayed.
  const record = await currentStore.getIssuedClaim(USER_A, "5");
  assert.equal(record.relayerTxHash, FAKE_TX_HASH);
});

test("POST /api/relay is 409 RELAY_ALREADY_RELAYED on a second submission of the same nonce", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service }));
  const claim = signedClaim({ nonce: "9" });

  const first = await postJson("/api/relay", claim);
  assert.equal(first.status, 200);

  const second = await postJson("/api/relay", claim);
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: ERRORS.RELAY_ALREADY_RELAYED });
  assert.equal(relayStub.stubs.sent.length, 1, "the retry must not broadcast a second transaction");
});

test("POST /api/relay is 400 RELAY_CLAIM_MISMATCH when the issuance record disagrees", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service }));

  // The Judge issued this exact nonce for a DIFFERENT reward.
  await currentStore.recordIssuedClaim({
    userAddress: USER_A,
    nonce: 4,
    sessionId: "s-mismatch",
    digest: "0x" + "00".repeat(32),
    reward: "7770000000000000000",
    staminaCost: MISSION.staminaCost,
    deadline: Math.floor(Date.now() / 1000) + 600,
    signature: "0x" + "33".repeat(65),
  });

  const res = await postJson("/api/relay", signedClaim({ nonce: "4" }));
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: ERRORS.RELAY_CLAIM_MISMATCH });
  assert.equal(relayStub.stubs.sent.length, 0);

  // A mismatching deadline is caught the same way.
  await currentStore.recordIssuedClaim({
    userAddress: USER_A,
    nonce: 5,
    sessionId: "s-mismatch",
    digest: "0x" + "00".repeat(32),
    reward: MISSION.reward,
    staminaCost: MISSION.staminaCost,
    deadline: Math.floor(Date.now() / 1000) + 60,
    signature: "0x" + "33".repeat(65),
  });
  const deadlineCase = await postJson("/api/relay", signedClaim({ nonce: "5" }));
  assert.equal(deadlineCase.status, 400);
  assert.deepEqual(deadlineCase.body, { error: ERRORS.RELAY_CLAIM_MISMATCH });
});

test("POST /api/relay allows a valid signature for a nonce this backend never issued", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service }));

  // No issuance record exists for nonce 4242 — e.g. a sibling Judge instance or
  // a different client. The signature is the authority, so it is relayed.
  assert.equal(await currentStore.getIssuedClaim(USER_B, 4242), undefined);
  const res = await postJson("/api/relay", signedClaim({ user: USER_B, nonce: "4242" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.nonce, "4242");
  assert.equal(relayStub.stubs.sent.length, 1);
});

test("POST /api/relay is 502 RELAY_TX_REVERTED and leaves the nonce relayable", async () => {
  const { wallet, provider, sent } = createStubSigner({ onSend: async () => { throw revertError("ClaimAlreadyUsed"); } });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  ({ baseUrl } = await boot({ relayService: service, store: currentStore }));

  const claim = signedClaim({ nonce: "12" });
  const res = await postJson("/api/relay", claim);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, ERRORS.RELAY_TX_REVERTED);
  assert.equal(res.body.reason, "ClaimAlreadyUsed", "a short, sanitized reason is returned");
  assert.equal(res.raw.includes("    at "), false, "no stack trace in the response");
  assert.equal(sent.length, 1, "the transaction WAS attempted");

  // Nothing was paid, so the nonce must still be relayable.
  const record = await currentStore.getIssuedClaim(USER_A, "12");
  assert.equal(record, undefined, "a reverted claim must not create a relay record");

  // Retrying is therefore possible: a second attempt goes through the whole
  // route again rather than short-circuiting with a 409.
  const second = await postJson("/api/relay", claim);
  assert.equal(second.status, 502, "still reverting, but not blocked as already-relayed");
  assert.equal(sent.length, 2);
});

test("POST /api/relay is 502 RELAY_TX_FAILED when the broadcast cannot even be attempted", async () => {
  const { wallet, provider } = createStubSigner({
    onSend: async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:8545");
      err.code = "SERVER_ERROR";
      throw err;
    },
  });
  const service = createRelayService({ wallet, provider, claimerAddress: CLAIMER_ADDRESS, chainId: CHAIN_ID });
  ({ baseUrl } = await boot({ relayService: service }));

  const res = await postJson("/api/relay", signedClaim());
  assert.equal(res.status, 502);
  assert.equal(res.body.error, ERRORS.RELAY_TX_FAILED);
  assert.equal(res.raw.includes("    at "), false);
});

test("POST /api/relay with a non-JSON body is 400, never 500", async () => {
  ({ baseUrl } = await boot({ relayService: configuredRelay().service }));
  const res = await http("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{{{",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, ERRORS.INVALID_JSON);
});

/* ========================================================================== */
/* 9. HTTP: GET /api/relay/status                                             */
/* ========================================================================== */

test("GET /api/relay/status reports configured:false with no relayer", async () => {
  const res = await http("/api/relay/status");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { configured: false, relayer: null });
});

test("GET /api/relay/status reports configured:true with the relayer's PUBLIC address", async () => {
  ({ baseUrl } = await boot({ relayService: configuredRelay().service }));
  const res = await http("/api/relay/status");
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.relayer, relayerWallet.address);
  assert.ok(ethers.isAddress(res.body.relayer));
  // The status endpoint never mentions the signer wallet or any key.
  assert.equal(res.raw.includes("privateKey"), false);
  assert.equal(res.raw.includes("RELAYER_PRIVATE_KEY"), false);
});

/* ========================================================================== */
/* 10. Secret safety                                                           */
/* ========================================================================== */

/** All textual forms of a private key that must never escape. */
function keyForms(wallet) {
  const key = wallet.privateKey;
  const body = key.startsWith("0x") ? key.slice(2) : key;
  return new Set([key, body, `0x${body}`, body.toUpperCase()]);
}

test("SECRET SAFETY: a real relayer key never reaches a log line, a response or an error", async () => {
  const logger = recordingLogger();
  const key = relayerWallet.privateKey;
  const forms = keyForms(relayerWallet);

  // A REAL ethers.Wallet holds the key inside it, and it reverts — the worst
  // possible case for a leak: a real revert error object on a real key.
  const realWallet = new ethers.Wallet(key, createFakeProvider({ estimateGasError: revertError("ClaimExpired") }));
  const service = createRelayService({
    provider: createFakeProvider({ estimateGasError: revertError("ClaimExpired") }),
    wallet: realWallet,
    claimerAddress: CLAIMER_ADDRESS,
    chainId: CHAIN_ID,
    logger,
  });
  const booted = await boot({ relayService: service, logger });
  baseUrl = booted.baseUrl;

  const bodies = [];
  const errors = [];

  /** Records a response's raw bytes for the leak sweep. */
  async function call(path, init) {
    const res = await fetch(`${baseUrl}${path}`, init);
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      body = undefined;
    }
    bodies.push({ path, status: res.status, raw, body });
    if (res.status >= 400) errors.push({ path, status: res.status, raw, body });
    return { status: res.status, raw, body };
  }

  const post = (p, payload) =>
    call(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  const status = await call("/api/relay/status");
  assert.equal(status.body.configured, true);
  const revoked = await post("/api/relay", signedClaim({ nonce: "31" }));
  assert.equal(revoked.status, 502, "the reverting transaction is what is being exercised");
  assert.equal(revoked.body.error, ERRORS.RELAY_TX_REVERTED);

  // The service-level error is clean too.
  let serviceError;
  try {
    await service.submitClaim(signedClaim());
  } catch (err) {
    serviceError = err;
  }
  assert.ok(serviceError instanceof Error);
  for (const form of forms) {
    assert.equal(serviceError.message.includes(form), false, "the error message leaked the relayer key");
    assert.equal(serviceError.reason.includes(form), false, "the error reason leaked the relayer key");
    assert.equal(JSON.stringify(serviceError).includes(form), false, "the serialized error leaked the relayer key");
    assert.equal(String(serviceError).includes(form), false);
  }
  assert.equal(serviceError.message.includes("    at "), false);

  /* (a) no log argument, on any level, contains any form of the key */
  assert.ok(logger.records.length > 0, "the reverting path must actually have logged");
  for (const record of logger.records) {
    for (const arg of record.args) {
      const text = typeof arg === "string" ? arg : JSON.stringify(arg) === undefined ? String(arg) : JSON.stringify(arg);
      for (const form of forms) {
        assert.equal(text.includes(form), false, `a ${record.level}() log argument leaked the relayer key`);
      }
      // A log line must never contain anything key-shaped either.
      assert.equal(/0x[0-9a-fA-F]{64}/.test(text), false, `a ${record.level}() line contained a 32-byte hex value`);
    }
  }

  /* (b) no response body contains any form of the key */
  for (const { path, status: code, raw } of bodies) {
    for (const form of forms) {
      assert.equal(raw.includes(form), false, `${path} (${code}) leaked the relayer key`);
    }
  }

  /* (c) no error response mentions the key at all */
  assert.ok(errors.length >= 1, "the sweep must have produced an error response");
  for (const { path, status: code, raw, body } of errors) {
    assert.ok(code >= 400);
    for (const form of forms) {
      assert.equal(raw.includes(form), false, `${path} (${code}) leaked the relayer key`);
    }
    assert.equal(
      /privatekey|private key|relayer_private/i.test(raw),
      false,
      `${path} (${code}) referenced the relayer key at all: ${raw.slice(0, 120)}`
    );
    assert.equal(typeof body.error, "string", "every error carries a stable code");
    assert.equal(raw.includes("    at "), false, `${path} (${code}) leaked a stack trace`);
  }

  /* (d) POSITIVE: the relayer's PUBLIC address IS published */
  assert.equal(status.body.relayer, relayerWallet.address, "the relayer address must be advertised");
  assert.equal(status.raw.includes(relayerWallet.address), true, "the address is on the wire");
  assert.equal(status.body.relayer !== relayerWallet.privateKey, true);
  assert.equal(
    relayerWallet.address.toLowerCase().includes(relayerWallet.privateKey.toLowerCase()),
    false,
    "an address is not a key"
  );
});

test("SECRET SAFETY: the env-built relay publishes only the relayer's public address", async () => {
  const logger = recordingLogger();
  const forms = keyForms(relayerWallet);
  const saved = {
    RPC_URL: process.env.RPC_URL,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
    CHAIN_ID: process.env.CHAIN_ID,
    MINING_CLAIMER_ADDRESS: process.env.MINING_CLAIMER_ADDRESS,
  };
  process.env.RPC_URL = "http://127.0.0.1:8545";
  process.env.RELAYER_PRIVATE_KEY = relayerWallet.privateKey;
  process.env.CHAIN_ID = String(CHAIN_ID);
  process.env.MINING_CLAIMER_ADDRESS = CLAIMER_ADDRESS;
  try {
    // Boot the DEFAULT relay (no injection) so the env path itself is exercised.
    const booted = await boot({ relayService: undefined, logger });
    baseUrl = booted.baseUrl;

    const status = await http("/api/relay/status");
    assert.equal(status.body.configured, true);
    assert.equal(status.body.relayer, relayerWallet.address);
    for (const form of forms) {
      assert.equal(status.raw.includes(form), false, "the status response leaked the relayer key");
    }
    assert.equal(status.raw.includes(relayerWallet.address), true);
    for (const record of logger.records) {
      for (const arg of record.args) {
        const text = typeof arg === "string" ? arg : String(arg);
        for (const form of forms) {
          assert.equal(text.includes(form), false, "an env-built log line leaked the relayer key");
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("createRelayServiceFromEnv is unconfigured with no env at all", async () => {
  const saved = {
    RPC_URL: process.env.RPC_URL,
    RELAYER_PRIVATE_KEY: process.env.RELAYER_PRIVATE_KEY,
  };
  delete process.env.RPC_URL;
  delete process.env.RELAYER_PRIVATE_KEY;
  try {
    const service = createRelayServiceFromEnv({ chainId: CHAIN_ID, claimerAddress: CLAIMER_ADDRESS, logger: recordingLogger() });
    assert.equal(service.isConfigured(), false);
    assert.equal(service.relayerAddress(), null);
    assert.equal(await service.getRelayerAddress(), null);
  } finally {
    if (saved.RPC_URL !== undefined) process.env.RPC_URL = saved.RPC_URL;
    if (saved.RELAYER_PRIVATE_KEY !== undefined) process.env.RELAYER_PRIVATE_KEY = saved.RELAYER_PRIVATE_KEY;
  }
});

/* ========================================================================== */
/* 11. Storage bookkeeping                                                     */
/* ========================================================================== */

test("the memory store implements getIssuedClaim and markRelayed exactly once", async () => {
  for (const name of ["getIssuedClaim", "markRelayed"]) {
    assert.ok(STORAGE_METHODS.includes(name), `${name} must be part of the storage interface`);
    assert.equal(typeof currentStore[name], "function", `${name} must be implemented`);
  }

  assert.equal(await currentStore.getIssuedClaim(USER_A, 1), undefined, "unknown nonce has no record");
  await currentStore.recordIssuedClaim({
    userAddress: USER_A,
    nonce: 1,
    sessionId: "s1",
    digest: "0x" + "00".repeat(32),
    reward: MISSION.reward,
    staminaCost: MISSION.staminaCost,
    deadline: 123,
    signature: "0x" + "44".repeat(65),
  });

  const record = await currentStore.getIssuedClaim(USER_A, 1);
  assert.equal(record.userAddress, USER_A);
  assert.equal(record.nonce, 1);
  assert.equal(record.reward, MISSION.reward);
  assert.equal(record.relayerTxHash, null, "issued but not yet relayed");

  // Case-insensitive: the checksummed address finds the lowercase-stored row.
  assert.ok(await currentStore.getIssuedClaim(USER_A.toLowerCase(), "1"));

  assert.equal(await currentStore.markRelayed({ userAddress: USER_A, nonce: 1, txHash: FAKE_TX_HASH }), true);
  assert.equal(await currentStore.markRelayed({ userAddress: USER_A, nonce: 1, txHash: "0x" + "99".repeat(32) }), false,
    "a nonce may be relayed at most once");
  assert.equal((await currentStore.getIssuedClaim(USER_A, 1)).relayerTxHash, FAKE_TX_HASH, "the first hash wins");

  // A nonce with no issuance record still becomes un-relayable.
  assert.equal(await currentStore.markRelayed({ userAddress: USER_B, nonce: 77, txHash: FAKE_TX_HASH }), true);
  assert.equal(await currentStore.markRelayed({ userAddress: USER_B, nonce: 77, txHash: FAKE_TX_HASH }), false);
  const orphan = await currentStore.getIssuedClaim(USER_B, 77);
  assert.equal(orphan.reward, null);
  assert.equal(orphan.relayerTxHash, FAKE_TX_HASH);
});

/* ========================================================================== */
/* 12. End to end: Judge issuance -> gasless relay                            */
/* ========================================================================== */

test("END TO END: a claim the Judge issued is relayed and settles, untouched", async () => {
  const relayStub = configuredRelay();
  ({ baseUrl } = await boot({ relayService: relayStub.service, store: currentStore, logger: relayStub.logger }));

  /* --- the user mines for real, through the real Judge --- */
  await postJson("/api/session", { sessionId: "e2e-1", user: USER_A, missionId: MISSION_ID });
  await postJson("/api/telemetry", { sessionId: "e2e-1", samples: humanTelemetry() });
  const judged = await postJson("/api/submit", {
    sessionId: "e2e-1",
    user: USER_A,
    answers: ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex })),
    highlight: ARTICLE.highlightTask.keySentences.join(" "),
    typingMs: GENEROUS_TYPING_MS,
  });
  assert.equal(judged.status, 200);
  assert.equal(judged.body.status, "PASS", "the human fixture must pass the anti-cheat engine");
  assert.equal(judged.body.signer, judgeWallet.address);
  const claim = judged.body.claim;

  // The issuance record exists and agrees with the signed struct.
  const issued = await currentStore.getIssuedClaim(USER_A, claim.nonce);
  assert.ok(issued, "the Judge recorded the issuance");
  assert.equal(issued.reward, claim.reward);
  assert.equal(issued.staminaCost, claim.staminaCost);
  assert.equal(Number(issued.deadline), Number(claim.deadline));
  assert.equal(issued.relayerTxHash, null);

  /* --- the app hands that exact payload to the relay --- */
  const relayed = await postJson("/api/relay", {
    user: claim.user,
    reward: claim.reward,
    staminaCost: claim.staminaCost,
    nonce: claim.nonce,
    deadline: claim.deadline,
    signature: judged.body.signature,
  });
  assert.equal(relayed.status, 200);
  assert.equal(relayed.body.txHash, FAKE_TX_HASH);
  assert.equal(relayed.body.user, USER_A);
  assert.equal(relayed.body.nonce, claim.nonce);
  assert.equal(relayed.body.relayer, relayerWallet.address);
  assert.equal(relayed.body.status, 1);

  /* --- what the chain stub received IS the signed struct --- */
  const decoded = new ethers.Interface(MINING_CLAIMER_ABI).decodeFunctionData(
    "claimReward",
    relayStub.stubs.sent[0].data
  );
  assert.deepEqual(
    [...decoded].map(String),
    [claim.user, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, judged.body.signature],
    "the relayer broadcast exactly what the Judge signed, in contract order"
  );

  /* --- and the nonce is now spent on OUR side too --- */
  const after = await currentStore.getIssuedClaim(USER_A, claim.nonce);
  assert.equal(after.relayerTxHash, FAKE_TX_HASH);

  /* --- a retry on a flaky connection is refused, not re-broadcast --- */
  const retry = await postJson("/api/relay", {
    user: claim.user,
    reward: claim.reward,
    staminaCost: claim.staminaCost,
    nonce: claim.nonce,
    deadline: claim.deadline,
    signature: judged.body.signature,
  });
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.body, { error: ERRORS.RELAY_ALREADY_RELAYED });
  assert.equal(relayStub.stubs.sent.length, 1, "no second transaction for the same nonce");

  /* --- the Judge can still mint the next claim for the same user --- */
  await postJson("/api/session", { sessionId: "e2e-2", user: USER_A, missionId: MISSION_ID });
  await postJson("/api/telemetry", { sessionId: "e2e-2", samples: humanTelemetry(25, 1_760_000_500_000) });
  const second = await postJson("/api/submit", {
    sessionId: "e2e-2",
    user: USER_A,
    answers: ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex })),
    highlight: ARTICLE.highlightTask.keySentences.join(" "),
    typingMs: GENEROUS_TYPING_MS,
  });
  assert.equal(second.body.status, "PASS");
  assert.ok(Number(second.body.claim.nonce) > Number(claim.nonce), "the burned nonce is never reissued");
  const secondRelay = await postJson("/api/relay", {
    ...second.body.claim,
    signature: second.body.signature,
  });
  assert.equal(secondRelay.status, 200, "a fresh nonce relays normally");
});

/* ========================================================================== */
/* Local helpers                                                              */
/* ========================================================================== */

/**
 * A configured relay service backed by the local chain stub.
 *
 * @param {Object} [opts]
 * @param {function(Object): Promise<Object>} [opts.onSend] Replaces `sendTransaction`.
 * @param {Object} [opts.store] Store to hand to the service.
 * @returns {{ service: Object, stubs: Object, logger: Object }}
 */
function configuredRelay(opts = {}) {
  const stubs = createStubSigner(opts.stub || {});
  const logger = opts.logger || recordingLogger();
  const service = createRelayService({
    wallet: stubs.wallet,
    provider: stubs.provider,
    claimerAddress: CLAIMER_ADDRESS,
    chainId: CHAIN_ID,
    store: opts.store,
    logger,
  });
  return { service, stubs, logger };
}