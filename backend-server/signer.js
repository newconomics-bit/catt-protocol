/**
 * CATT Protocol — Backend "Signature Generator" (PRD 3.2)
 *
 * SIGNING-ONLY MODULE. This file does one thing: turn an already-validated
 * mining claim into an EIP-712 signature that the on-chain MiningClaimer
 * contract can verify with `ECDSA.recover`. The user then claims the reward
 * in a gasless on-chain transaction.
 *
 * SCOPE NOTE: The anti-cheat / Judge engine (Proof-of-Attention validation,
 * telemetry analysis, content randomizer) is OUT OF SCOPE for this wave and
 * lives elsewhere. This module must only ever be fed claims that already
 * passed validation, and it holds NO secret of its own.
 *
 * SECURITY NOTE: No private key, mnemonic, API key or any other secret is
 * hardcoded, defaulted, logged or embedded in this file. The signing key is
 * supplied by the caller (or read from `process.env.SIGNER_PRIVATE_KEY`,
 * see `signerAddressFromEnv()`) and is never returned to the caller.
 */

const { ethers } = require("ethers");

/**
 * EIP-712 typed-data definition for the mining claim.
 * Field order is SIGNIFICANT: EIP-712 encodes each field as
 * keccak256("<name> <type>") in the order declared, and the contract's
 * Solidity struct must match exactly. This yields the type hash
 * keccak256("ClaimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline)").
 *
 * @type {{ ClaimReward: Array<{ name: string, type: string }> }}
 */
const CLAIM_REWARD_TYPES = {
  ClaimReward: [
    { name: "user", type: "address" },
    { name: "reward", type: "uint256" },
    { name: "staminaCost", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * Builds the EIP-712 domain matching the on-chain
 * `EIP712("CATT Protocol", "1")` inheritor.
 *
 * @param {Object} params
 * @param {number|string} params.chainId EVM chain id (e.g. 11155111 for Sepolia).
 * @param {string} params.verifyingContract Deployed MiningClaimer address (checksummed or lowercase).
 * @returns {{ name: string, version: string, chainId: number, verifyingContract: string }}
 *   Domain object consumable by `ethers.TypedDataEncoder`.
 */
function buildDomain({ chainId, verifyingContract }) {
  return {
    name: "CATT Protocol",
    version: "1",
    chainId: Number(chainId),
    verifyingContract,
  };
}

/**
 * Builds the ClaimReward struct. Key order MUST be
 * user, reward, staminaCost, nonce, deadline.
 *
 * Amounts (`reward`, `staminaCost`) are 18-decimal CATT base units
 * (1 CATT = 1e18 wei-of-CATT) and may be a bigint or a decimal string.
 * `nonce` is the per-user claim counter (integer) and `deadline` is a unix
 * timestamp in SECONDS by which the signature expires on-chain.
 * Values are passed through untouched; `TypedDataEncoder` performs the
 * uint256/address encoding.
 *
 * @param {Object} params
 * @param {string} params.user Recipient address that may claim the reward.
 * @param {bigint|string} params.reward Reward amount in 18-decimal CATT base units.
 * @param {bigint|string} params.staminaCost Stamina amount spent, in 18-decimal CATT base units.
 * @param {bigint|string|number} params.nonce Per-user claim counter (unique per user).
 * @param {bigint|string|number} params.deadline Expiry as a unix timestamp in seconds.
 * @returns {{ user: string, reward: any, staminaCost: any, nonce: any, deadline: any }}
 *   Claim struct in canonical key order.
 */
function buildClaim({ user, reward, staminaCost, nonce, deadline }) {
  return { user, reward, staminaCost, nonce, deadline };
}

/**
 * Computes the EIP-712 digest (keccak256 of 0x1901 || domainSeparator || structHash)
 * that the on-chain contract recomputes before `ECDSA.recover`.
 *
 * @param {Object} params
 * @param {number|string} params.chainId EVM chain id.
 * @param {string} params.verifyingContract MiningClaimer address.
 * @param {Object} params.claim Claim struct (see `buildClaim`).
 * @returns {string} 0x-prefixed 32-byte hex digest.
 */
function claimDigest({ chainId, verifyingContract, claim }) {
  const domain = buildDomain({ chainId, verifyingContract });
  return ethers.TypedDataEncoder.hash(domain, CLAIM_REWARD_TYPES, claim);
}

/**
 * Resolves the private key from an argument, throwing if absent.
 * The key is NEVER logged or returned.
 *
 * @param {string|undefined} privateKey Hex private key from the caller/env.
 * @returns {string} Non-empty private key string.
 */
function _requireKey(privateKey) {
  if (privateKey === undefined || privateKey === null || String(privateKey).trim() === "") {
    throw new Error(
      "Signer private key missing: SIGNER_PRIVATE_KEY is not set. " +
        "Provide `privateKey` explicitly or export SIGNER_PRIVATE_KEY in the backend environment. " +
        "Never commit or log the key."
    );
  }
  return String(privateKey).trim();
}

/**
 * Signs a mining-reward claim with a raw ECDSA signature over the EIP-712
 * digest, which is exactly what Solidity's `ECDSA.recover` expects
 * (r, s, v where v is 27/28). No EIP-2098/compact-signature handling and no
 * `signTypedData` on the Wallet, so the on-chain verification matches.
 *
 * @param {Object} params
 * @param {string} params.privateKey Signer private key. Required; throws if missing/malformed.
 * @param {number|string} params.chainId EVM chain id.
 * @param {string} params.verifyingContract Deployed MiningClaimer address.
 * @param {string} params.user Recipient address.
 * @param {bigint|string} params.reward Reward in 18-decimal CATT base units.
 * @param {bigint|string} params.staminaCost Stamina cost in 18-decimal CATT base units.
 * @param {bigint|string|number} params.nonce Per-user claim counter.
 * @param {bigint|string|number} params.deadline Expiry as unix seconds.
 * @returns {{
 *   signature: string,
 *   digest: string,
 *   signer: string,
 *   claim: { user: string, reward: any, staminaCost: any, nonce: any, deadline: any },
 *   domain: { name: string, version: string, chainId: number, verifyingContract: string }
 * }} 65-byte 0x-prefixed signature, the signed digest, the signer's checksummed
 *   address, the claim struct and the domain that produced them.
 * @throws {Error} If the key is missing or malformed, or the claim/domain is invalid.
 */
function signClaim({
  privateKey,
  chainId,
  verifyingContract,
  user,
  reward,
  staminaCost,
  nonce,
  deadline,
}) {
  const key = _requireKey(privateKey);

  let wallet;
  try {
    wallet = new ethers.Wallet(key);
  } catch (err) {
    throw new Error(
      "Malformed signer private key: could not construct an ethers.Wallet from the supplied " +
        `SIGNER_PRIVATE_KEY value (${err && err.message ? err.message : "invalid key"}). ` +
        "Expected a 32-byte hex private key."
    );
  }
  if (!ethers.isAddress(wallet.address)) {
    throw new Error("Malformed signer private key: derived signer address is not a valid EVM address.");
  }

  const domain = buildDomain({ chainId, verifyingContract });
  const claim = buildClaim({ user, reward, staminaCost, nonce, deadline });
  const digest = ethers.TypedDataEncoder.hash(domain, CLAIM_REWARD_TYPES, claim);

  // Raw ECDSA over the digest (no EIP-191 personal-sign prefix, no EIP-2098).
  // `.serialized` is the canonical 65-byte (r || s || v) form OpenZeppelin's
  // ECDSA.recover(bytes32, bytes memory) expects.
  const signature = wallet.signingKey.sign(digest).serialized;

  return { signature, digest, signer: wallet.address, claim, domain };
}

/**
 * Returns the signer address derived from `process.env.SIGNER_PRIVATE_KEY`.
 * The key itself is never logged or returned.
 *
 * @returns {string} Checksummed signer address.
 * @throws {Error} If `SIGNER_PRIVATE_KEY` is unset, empty or malformed.
 */
function signerAddressFromEnv() {
  const key = _requireKey(process.env.SIGNER_PRIVATE_KEY);
  try {
    return new ethers.Wallet(key).address;
  } catch (err) {
    throw new Error(
      "Malformed SIGNER_PRIVATE_KEY in environment: " +
        `${err && err.message ? err.message : "invalid key"}. Expected a 32-byte hex private key.`
    );
  }
}

module.exports = {
  CLAIM_REWARD_TYPES,
  buildDomain,
  buildClaim,
  claimDigest,
  signClaim,
  signerAddressFromEnv,
};
