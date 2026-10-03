/**
 * CATT Protocol — RED-TEAM SUITE (adversarial).
 *
 * This file is written from the ATTACKER's side of the wire. Every other suite
 * in this directory asserts that the Judge works; this one asserts that the
 * Judge cannot be robbed. Where a test here is written the way an honest
 * engineer would write it, it is not a red-team test — so the rules applied
 * throughout are:
 *
 *   - DRIVE THE REAL HTTP SURFACE. `createApp` + `app.listen(0)` + the global
 *     `fetch`, exactly like test/server.test.js, with a stub relay service in
 *     place of a chain. The stub is a MODEL of `MiningClaimer.claimReward` +
 *     `StakingManager.consumeStamina` + `CATT._mint` (see `FakeChain` below),
 *     not a rubber stamp: it enforces the nonce, the zero-stamina and the
 *     MAX_SUPPLY rules the real contracts enforce, and it reports reverts
 *     through the same `RELAY_ERRORS` channel the real relay adapter uses.
 *   - REAL CRYPTOGRAPHY. Every signature is produced by `signer.signClaim`
 *     from backend-server/signer.js over a throwaway `ethers.Wallet
 *     .createRandom()` key. No key is hardcoded, no digest is faked, and no
 *     assertion is satisfied by a hardcoded string.
 *   - COUNT SIDE EFFECTS, NOT STATUS CODES. "200 OK" is not proof a reward was
 *     not paid. Where a claim could be broadcast, the test asserts on the stub
 *     chain's own ledger (broadcasts, settlements, reverts), because that is
 *     the only place a double payment would actually show up.
 *   - A REJECTION MUST NAME ITSELF. Every refusal is asserted on the stable
 *     error code / flag the product tells the client, not merely on "it was not
 *     200", so that a future refactor cannot turn a specific defence into a
 *     generic 500 and still keep the tests green.
 *   - REPORT, DO NOT PAPER OVER. Several tests below deliberately assert the
 *     system's ACTUAL behaviour, including behaviour that is weaker than the
 *     attack it is named after. Those are marked RESIDUAL WEAKNESS and carry
 *     the measured numbers in the assertion message, so the weakness stays
 *     visible in CI instead of being quietly "fixed" by the test author.
 *
 * HYGIENE:
 *   - A fresh app, a fresh store and a fresh fake chain per test: the store
 *     holds per-user nonce counters and a CROSS-USER submission log, so a
 *     shared store would make the syndicate and nonce assertions
 *     order-dependent.
 *   - Nothing is ever written to `process.env`, so a test can never pick up a
 *     real deployment's key or chain configuration.
 *   - The mock users are obviously-fake literal addresses and the backend
 *     wallet is never used as a user, so a bug conflating "who signed" with
 *     "who gets paid" cannot pass unnoticed.
 */

const { test, describe, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const content = require("../src/content");
const anticheat = require("../src/anticheat");
const signer = require("../signer");
const relayModule = require("../src/relay");
const { createApp, ERRORS, JUDGE_FLAGS } = require("../src/server");
const { createMemoryStore } = require("../src/storage");
const { createSqliteStore } = require("../src/sqlite-store");

/* -------------------------------------------------------------------------- */
/* Fixed configuration                                                         */
/* -------------------------------------------------------------------------- */

/** Throwaway backend signer. Created per process; never written anywhere. */
const backendWallet = ethers.Wallet.createRandom();

/** A SECOND throwaway key that is NOT the Judge's — the impersonator. */
const impostorWallet = ethers.Wallet.createRandom();

const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** A second deployment of the same contract, for the cross-deployment attack. */
const OTHER_CLAIMER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

/** CATT.MAX_SUPPLY, verbatim from contracts/CATT.sol. */
const MAX_SUPPLY = 100_000_000n * 10n ** 18n;

/** Obviously fake users. Valid hex, deterministic, never the signer. */
const RING_USERS = ["11", "22", "33", "44", "55", "66"].map((byte) => "0x" + byte.repeat(20));
const VICTIM = "0x" + "ab".repeat(20);
const STRANGER = "0x" + "cd".repeat(20);

/** Comfortably above anticheat's MIN_TYPING_MS_PER_CHAR floor. */
const GENEROUS_TYPING_MS = 40_000;

const MISSION_ID = "mission-1";
const MISSION = content.getMission(MISSION_ID);
const ARTICLE = content.getArticle(MISSION.articleId);

/* -------------------------------------------------------------------------- */
/* Telemetry forgeries                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A PERFECT HUMAN profile: drifting temperature, jittered non-repeating touch
 * coordinates, plausible varied signed scroll deltas, 5s cadence timestamps.
 *
 * The mod arithmetic is chosen so every temperature and every (x, y) pair is
 * distinct across the window (gcd(7, 81) = 1, gcd(37, 260) = 1, gcd(53, 420) =
 * 1), so the fixture can never accidentally trip a duplicate flag and a test
 * can never be flaky.
 *
 * @param {number} [count] Sample count.
 * @param {number} [startTs] First timestamp, ms.
 * @returns {Array<Object>} Samples.
 */
function perfectHuman(count = 25, startTs = 1_760_000_000_000) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: startTs + i * 5000,
      batteryTempC: 26 + ((i * 7) % 81) / 10,
      touch: { x: 40 + ((i * 37) % 260), y: 90 + ((i * 53) % 420) },
      scrollDelta: [120, -45, 310, -260, 0, 175, -95, 60][i % 8],
    });
  }
  return samples;
}

/**
 * ATTACK 3's forgery: a profile that is perfect on EVERY surface a client can
 * control, except the one thing a client cannot fabricate — a battery
 * temperature that NEVER MOVES. A stuck sensor, a pinned value, or a farm of
 * devices all reporting the same rounded constant.
 *
 * Deliberately built to be maximally convincing: jittered, non-repeating
 * touch coordinates (so PIXEL_PERFECT_TOUCH cannot fire), scroll deltas that
 * vary in magnitude and sign at a plausible velocity (so INHUMAN_SCROLL_SPEED
 * cannot fire), and a real 5-second cadence (so TOO_FEW_SAMPLES cannot fire).
 *
 * The ONLY flag it can possibly raise is BATTERY_FLATLINE.
 *
 * @param {number} [count] Sample count.
 * @param {number} [startTs] First timestamp, ms.
 * @param {number} [stuckTemp] The pinned temperature.
 * @returns {Array<Object>} Samples.
 */
function perfectButFlatlined(count = 25, startTs = 1_760_000_000_000, stuckTemp = 31.5) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: startTs + i * 5000,
      batteryTempC: stuckTemp,
      touch: { x: 40 + ((i * 37) % 260), y: 90 + ((i * 53) % 420) },
      scrollDelta: [120, -45, 310, -260, 0, 175, -95, 60][i % 8],
    });
  }
  return samples;
}

/**
 * A flatline DILUTED with `null` readings: the cheat where a cheater tries to
 * switch the battery check off by claiming the sensor sometimes fails. The
 * policy is that nulls are not readings, so they cannot clear the flatline.
 *
 * @param {number} nullEvery Report a null every Nth sample (N = 0 for none).
 * @returns {Array<Object>} Samples.
 */
function flatlineDilutedWithNulls(nullEvery = 5) {
  const samples = perfectButFlatlined();
  if (nullEvery > 0) {
    for (let i = 0; i < samples.length; i += 1) {
      if (i % nullEvery === 0) samples[i].batteryTempC = null;
    }
  }
  return samples;
}

/** A session whose hardware cannot report temperature at all: all nulls. */
function noTemperature(count = 25, startTs = 1_760_000_000_000) {
  return perfectHuman(count, startTs).map((sample) => ({ ...sample, batteryTempC: null }));
}

/** A realistic human with a genuinely DRIFTING temperature, non-round values. */
function driftingTemperature(count = 25, startTs = 1_760_000_000_000) {
  const samples = perfectHuman(count, startTs);
  // Sub-epsilon-to-several-degrees drift, non-integer and non-repeating: what
  // a real SoC actually reports. Keyed off `i` so it is deterministic, not
  // random, and therefore the test cannot be flaky.
  const drift = [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.9, 1.05, 1.2, 1.4];
  for (let i = 0; i < samples.length; i += 1) {
    samples[i].batteryTempC = 29 + drift[i % drift.length] - 0.2 * (i % 3);
  }
  return samples;
}

/* -------------------------------------------------------------------------- */
/* Answer fixtures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The correct answer set, read from `content` INSIDE the test process and never
 * over HTTP. That is the point: `GET /api/article/:id` must never carry the
 * key, and this suite is the attacker, so it has to cheat the way a cheat
 * engine would rather than be handed the answers by the endpoint.
 *
 * @returns {Array<{ questionId: string, answerIndex: number }>}
 */
function correctAnswers() {
  return ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex }));
}

/** A highlight containing every key sentence, i.e. a real reader's output. */
function fullHighlight() {
  return ARTICLE.highlightTask.keySentences.join(" ");
}

/* -------------------------------------------------------------------------- */
/* FakeChain — a model of the contracts, not a rubber stamp                   */
/* -------------------------------------------------------------------------- */

/**
 * A stub of the on-chain side, faithful to the ORDER of the checks in
 * `MiningClaimer.claimReward` (smart-contracts/contracts/MiningClaimer.sol:392)
 * followed by `StakingManager.consumeStamina` (:472) and `CATT._mint` (:62):
 *
 *   1. `usedNonces[user][nonce]` -> ClaimAlreadyUsed
 *   2. the nonce is burned BEFORE the external calls
 *   3. `consumeStamina`: `amount == 0` -> ZeroAmount, `available < amount` ->
 *      StaminaInsufficient
 *   4. `_mint`: `totalSupply + reward > MAX_SUPPLY` -> MintExceedsMaxSupply
 *   5. a revert UNWINDS the nonce burn, which is why the real contract releases
 *      a nonce on a failed claim and why the relay route deliberately does not
 *      mark a reverted claim as relayed.
 *
 * It also keeps the ledgers the assertions are made against: `calls` (every
 * broadcast ATTEMPT), `settled` (rewards actually minted) and `reverts`.
 */
class FakeChain {
  /**
   * @param {Object} [options]
   * @param {string} [options.expectedSigner] Address whose signatures count.
   * @param {number} [options.chainId] Chain the RELAY is pointed at.
   * @param {string} [options.claimerAddress] Deployment the RELAY is pointed at.
   * @param {bigint} [options.totalSupply] Already-minted supply.
   * @param {Map<string,bigint>} [options.stamina] Stamina per user.
   * @param {boolean} [options.unstaked] Model a chain where NOBODY has staked,
   *   so every reward claim reverts `StaminaInsufficient`. Default false: an
   *   ordinary test user is assumed to have staked, because the question these
   *   tests ask is "can the reward be double-spent", not "can an unstaked user
   *   mine", and the unstaked case has its own dedicated probe (P3/P4).
   * @param {number} [options.broadcastDelayMs] Artificial latency, so a
   *   concurrency race is forced open rather than raced by luck.
   */
  constructor(options = {}) {
    this.chainId = options.chainId === undefined ? CHAIN_ID : options.chainId;
    this.claimerAddress = options.claimerAddress || VERIFYING_CONTRACT;
    this.expectedSigner = options.expectedSigner || backendWallet.address;
    this.totalSupply = options.totalSupply === undefined ? 0n : options.totalSupply;
    this.stamina = new Map(options.stamina || []);
    this.unstaked = options.unstaked === true;
    // A comfortable stake for anyone not explicitly modelled, so a
    // double-payment test fails for the reason it is about and not because the
    // fake user happens to be broke.
    this.defaultStamina = 1_000_000n * 10n ** 18n;
    this.broadcastDelayMs = options.broadcastDelayMs || 0;
    this.calls = [];
    this.settled = [];
    this.reverts = [];
    this.usedNonces = new Set();
    this.relayerAddress = ethers.Wallet.createRandom().address;
    this.txCounter = 0;
  }

  /** Grants a user stamina, as `StakingManager.stake` would. */
  grantStamina(user, amount) {
    this.stamina.set(String(user).toLowerCase(), amount);
  }

  /** A `RELAY_TX_REVERTED` shaped exactly like the real relay adapter's. */
  _revert(reason) {
    const err = new Error(`execution reverted: ${reason}`);
    err.code = relayModule.RELAY_ERRORS.TX_REVERTED;
    err.reason = reason;
    return err;
  }

  /**
   * The stub equivalent of broadcasting `claimReward`.
   *
   * @param {Object} args `{ user, reward, staminaCost, nonce, deadline, signature }`.
   * @returns {Promise<{ txHash: string, status: number, blockNumber: number }>}
   */
  async submitClaim(args) {
    this.calls.push({ ...args });
    if (this.broadcastDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.broadcastDelayMs));
    }
    const user = String(args.user).toLowerCase();
    const nonce = String(args.nonce);
    const key = `${user}:${nonce}`;
    const reward = BigInt(args.reward);
    const staminaCost = BigInt(args.staminaCost);

    // 1. Replay.
    if (this.usedNonces.has(key)) {
      this.reverts.push({ ...args, reason: `ClaimAlreadyUsed(${args.user}, ${nonce})` });
      throw this._revert(`ClaimAlreadyUsed(${args.user}, ${nonce})`);
    }
    // 2. Effects first: burn, then interact.
    this.usedNonces.add(key);

    try {
      // 3. StakingManager.consumeStamina.
      if (staminaCost === 0n) throw this._revert("ZeroAmount()");
      const available = this.unstaked ? 0n : this.stamina.has(user) ? this.stamina.get(user) : this.defaultStamina;
      if (available < staminaCost) {
        throw this._revert(`StaminaInsufficient(${args.user}, ${staminaCost}, ${available})`);
      }
      this.stamina.set(user, available - staminaCost);

      // 4. CATT._mint against MAX_SUPPLY.
      if (this.totalSupply + reward > MAX_SUPPLY) {
        throw this._revert(`MintExceedsMaxSupply(${this.totalSupply + reward}, ${MAX_SUPPLY})`);
      }
      this.totalSupply += reward;
    } catch (err) {
      // A revert unwinds the nonce burn: the nonce stays spendable.
      this.usedNonces.delete(key);
      this.reverts.push({ ...args, reason: err.reason });
      throw err;
    }

    this.txCounter += 1;
    this.settled.push({ ...args, amount: reward });
    return {
      txHash: ethers.keccak256(ethers.toUtf8Bytes(`catt-tx-${this.txCounter}`)),
      status: 1,
      blockNumber: 1_000_000 + this.txCounter,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

let liveServers = [];
let baseUrl;
let chain;
let store;

/** Closes servers and force-closes undici's keep-alive sockets. */
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

after(async () => {
  await closeAllServers();
});

/**
 * Boots a Judge with the stub relay wired to `FakeChain`.
 *
 * @param {Object} [options]
 * @param {Object} [options.store] Storage adapter; defaults to a memory store.
 * @param {Object} [options.chainOptions] `FakeChain` options.
 * @param {number} [options.chainId] Chain the JUDGE signs for.
 * @param {string} [options.verifyingContract] Deployment the JUDGE signs for.
 * @returns {Promise<{ baseUrl: string, store: Object, chain: FakeChain }>}
 */
async function bootJudge(options = {}) {
  store = options.store || createMemoryStore();
  chain = new FakeChain({ expectedSigner: backendWallet.address, ...(options.chainOptions || {}) });

  const relayService = {
    isConfigured: () => true,
    relayerAddress: () => chain.relayerAddress,
    getRelayerAddress: async () => chain.relayerAddress,
    getExpectedSigner: async () => chain.expectedSigner,
    // The REAL validator, bound to the chain/deployment the RELAY points at.
    validateClaimPayload: (payload) =>
      relayModule.validateClaimPayload({
        ...payload,
        chainId: chain.chainId,
        claimerAddress: chain.claimerAddress,
      }),
    submitClaim: (args) => chain.submitClaim(args),
  };

  const app = createApp({
    store,
    privateKey: backendWallet.privateKey,
    chainId: options.chainId === undefined ? CHAIN_ID : options.chainId,
    verifyingContract: options.verifyingContract || VERIFYING_CONTRACT,
    logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    relayService,
    expectedSigner: chain.expectedSigner,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, store, chain };
}

/** Issue a request and return status, parsed body and RAW text. */
async function http(target, init = {}) {
  const res = await fetch(`${baseUrl}${target}`, init);
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
function postJson(target, payload) {
  return http(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Registers a session and streams telemetry into it.
 *
 * @param {string} sessionId Session id.
 * @param {string} user User address.
 * @param {Array<Object>} [samples] Telemetry; defaults to the human fixture.
 * @returns {Promise<string>} The session id.
 */
async function primeSession(sessionId, user, samples = perfectHuman()) {
  const created = await postJson("/api/session", { sessionId, user, missionId: MISSION_ID });
  assert.equal(created.status, 201, `session registration failed: ${created.raw}`);
  const pushed = await postJson("/api/telemetry", { sessionId, samples });
  assert.equal(pushed.status, 200, `telemetry ingest failed: ${pushed.raw}`);
  return sessionId;
}

/**
 * Runs a complete, HONEST mining attempt: real session, real telemetry, the
 * correct answers, a real highlight, a plausible typing time. This is the
 * baseline every attack is measured against — it is what an honest user does,
 * so an attack that cannot beat it is rejected for the right reason.
 *
 * @param {Object} params
 * @param {string} params.user User address.
 * @param {string} params.sessionId Session id.
 * @param {Array<Object>} [params.samples] Telemetry.
 * @param {string} [params.freeText] Free-text answer.
 * @param {string} [params.highlight] Highlight override.
 * @param {number} [params.typingMs] Typing time override.
 * @returns {Promise<Object>} The parsed `/api/submit` response body.
 */
async function mine({ user, sessionId, samples, freeText, highlight, typingMs }) {
  await primeSession(sessionId, user, samples);
  const res = await postJson("/api/submit", {
    sessionId,
    user,
    answers: correctAnswers(),
    highlight: highlight === undefined ? fullHighlight() : highlight,
    typingMs: typingMs === undefined ? GENEROUS_TYPING_MS : typingMs,
    ...(freeText === undefined ? {} : { freeText }),
  });
  assert.equal(res.status, 200, `submit should be graded, not errored: ${res.raw}`);
  return res.body;
}

/** The body `/api/relay` expects for an issued claim. */
function relayBody(claim, signature) {
  return {
    user: claim.user,
    reward: claim.reward,
    staminaCost: claim.staminaCost,
    nonce: claim.nonce,
    deadline: claim.deadline,
    signature,
  };
}

beforeEach(async () => {
  await closeAllServers();
  const booted = await bootJudge();
  baseUrl = booted.baseUrl;
  store = booted.store;
  chain = booted.chain;
});

/* ========================================================================== */
/* ATTACK 1 — REPLAY OF A RELAYED CLAIM                                       */
/* ========================================================================== */

describe("ATTACK 1 — replay of a relayed claim", () => {
  test("1a: relaying the same claim twice broadcasts one transaction and 409s the second", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "replay-a" });
    assert.equal(verdict.status, anticheat.PASS, "baseline honest mining must pass");
    const first = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(first.status, 200, `first relay should broadcast: ${first.raw}`);
    assert.equal(typeof first.body.txHash, "string", "a mined transaction hash must be returned");
    assert.equal(chain.settled.length, 1, "one reward minted after the first relay");

    const second = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(second.status, 409, "second relay of an identical claim must be refused");
    assert.equal(second.body.error, ERRORS.RELAY_ALREADY_RELAYED, "refusal must name the double-relay guard");

    // The point of the assertion: NO second transaction, not merely a 409.
    assert.equal(chain.calls.length, 1, "the second relay must not even reach the chain");
    assert.equal(chain.settled.length, 1, "exactly one reward may ever be minted for one nonce");
    assert.equal(chain.totalSupply, BigInt(verdict.claim.reward), "supply moved by exactly one reward");
  });

  test("1b: two CONCURRENT relays for one nonce settle exactly once", async () => {
    // Re-boot with broadcast latency so the race is forced open deterministically
    // rather than won or lost by scheduler luck.
    await closeAllServers();
    const booted = await bootJudge({ chainOptions: { broadcastDelayMs: 25 } });
    baseUrl = booted.baseUrl;
    store = booted.store;
    chain = booted.chain;

    const verdict = await mine({ user: RING_USERS[1], sessionId: "replay-b" });
    assert.equal(verdict.status, anticheat.PASS);
    const body = relayBody(verdict.claim, verdict.signature);

    const [a, b] = await Promise.all([
      postJson("/api/relay", body),
      postJson("/api/relay", body),
    ]);
    const statuses = [a.status, b.status].sort();

    // The invariant that actually matters is on the CHAIN, not in the HTTP
    // codes: one nonce must be able to produce at most one mint, ever.
    assert.equal(chain.settled.length, 1, "exactly ONE reward may be minted for one nonce under concurrency");
    assert.equal(chain.usedNonces.size, 1, "and the nonce is spent exactly once");
    assert.ok(
      chain.calls.length >= 1 && chain.calls.length <= 2,
      `both racers may broadcast, but never more than twice: ${chain.calls.length}`
    );
    assert.equal(
      chain.calls.length - chain.settled.length,
      chain.reverts.length,
      "every broadcast beyond the first must have been neutralized on-chain by ClaimAlreadyUsed"
    );
    assert.deepEqual(
      statuses,
      [200, 502],
      "the winner is told 200 and the loser is told the claim reverted on-chain; only one was paid for"
    );
    console.log(
      `    [red-team] concurrent relay: ${chain.calls.length} broadcast(s), ${chain.settled.length} settled, ` +
        `${chain.reverts.length} reverted on-chain (${chain.reverts.map((r) => r.reason).join("; ")}), ` +
        `HTTP statuses ${JSON.stringify(statuses)}`
    );
  });

  test("1c: the identical signature cannot be redeemed twice through any route", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "replay-c" });
    assert.equal(verdict.status, anticheat.PASS);
    const first = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(first.status, 200);

    // 1. The same signature again, verbatim.
    const again = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(again.status, 409);
    assert.equal(again.body.error, ERRORS.RELAY_ALREADY_RELAYED);

    // 2. The same signature with the address re-checksummed differently. The
    //    store keys on a lowercased (user, nonce), so casing cannot fork the
    //    record and open a second payout.
    const recased = await postJson("/api/relay", {
      ...relayBody(verdict.claim, verdict.signature),
      user: verdict.claim.user.toUpperCase().replace("0X", "0x"),
    });
    assert.equal(recased.status, 409, "address casing must not fork the double-relay guard");
    assert.equal(recased.body.error, ERRORS.RELAY_ALREADY_RELAYED);

    // 3. `/api/submit` takes NO signature field, so the signature itself cannot
    //    be re-presented for a second reward. Asserted explicitly: the endpoint
    //    must not grow a signature input, and must not accept one silently.
    const forged = await postJson("/api/submit", {
      sessionId: "replay-c",
      user: RING_USERS[0],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
      signature: verdict.signature,
      claim: verdict.claim,
    });
    assert.equal(forged.status, 200);
    // A re-POST of the same body is graded afresh and, if it passes, gets a NEW
    // nonce — never nonce 1 again, which is the only thing that would be a replay.
    if (forged.body.status === anticheat.PASS) {
      assert.notEqual(forged.body.claim.nonce, verdict.claim.nonce, "a re-POST must never reissue a spent nonce");
    }

    assert.equal(chain.settled.length, 1, "the original signature is worth exactly one reward, forever");
  });

  test("1d: replaying a BURNED nonce with a fresh signature for a different reward is refused", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "replay-d" });
    assert.equal(verdict.status, anticheat.PASS);
    const first = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(first.status, 200);

    // The attacker has a signature over (user, nonce). They want a BIGGER
    // reward on the same nonce, so they re-sign the mutated claim with their
    // OWN key. Two independent defences must each refuse it:
    //   - the store knows the exact reward it issued for that nonce, and
    //   - a self-signed claim does not recover to the configured signer.
    const greedy = {
      ...verdict.claim,
      reward: (BigInt(verdict.claim.reward) * 100n).toString(),
    };
    const forged = signer.signClaim({
      privateKey: impostorWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: greedy.user,
      reward: greedy.reward,
      staminaCost: greedy.staminaCost,
      nonce: greedy.nonce,
      deadline: greedy.deadline,
    });
    const res = await postJson("/api/relay", relayBody(greedy, forged.signature));
    assert.equal(res.status, 400, "a mutated claim on a known nonce must be refused");
    assert.ok(
      [ERRORS.RELAY_SIGNATURE_INVALID, ERRORS.RELAY_CLAIM_MISMATCH].includes(res.body.error),
      `refusal must be the signature check or the issuance cross-check, got ${res.body.error}`
    );
    assert.equal(chain.settled.length, 1, "no second reward for the mutated claim");
    assert.equal(chain.totalSupply, BigInt(verdict.claim.reward));
  });

  test("1e: a burned nonce stays burned across a RESTART (SQLite adapter)", async () => {
    await closeAllServers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catt-redteam-restart-"));
    const dbFile = path.join(dir, "judge.db");
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });

    try {
      /* --- Generation 1: mine, relay, shut the whole Judge down. --------- */
      const first = createSqliteStore({ filename: dbFile, logger: { warn() {}, error() {}, info() {} } });
      const appOne = createApp({
        store: first,
        privateKey: backendWallet.privateKey,
        chainId: CHAIN_ID,
        verifyingContract: VERIFYING_CONTRACT,
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        relayService: {
          isConfigured: () => true,
          relayerAddress: () => chain.relayerAddress,
          getRelayerAddress: async () => chain.relayerAddress,
          getExpectedSigner: async () => backendWallet.address,
          validateClaimPayload: (payload) =>
            relayModule.validateClaimPayload({ ...payload, chainId: CHAIN_ID, claimerAddress: VERIFYING_CONTRACT }),
          submitClaim: (args) => chain.submitClaim(args),
        },
        expectedSigner: backendWallet.address,
      });
      const serverOne = await new Promise((resolve) => {
        const s = appOne.listen(0, "127.0.0.1", () => resolve(s));
      });
      const urlOne = `http://127.0.0.1:${serverOne.address().port}`;

      const mineOn = async (url) => {
        await fetch(`${url}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "restart-s", user: RING_USERS[0], missionId: MISSION_ID }),
        });
        await fetch(`${url}/api/telemetry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "restart-s", samples: perfectHuman() }),
        });
        const res = await fetch(`${url}/api/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: "restart-s",
            user: RING_USERS[0],
            answers: correctAnswers(),
            highlight: fullHighlight(),
            typingMs: GENEROUS_TYPING_MS,
          }),
        });
        return res.json();
      };

      const verdict = await mineOn(urlOne);
      assert.equal(verdict.status, anticheat.PASS, "the pre-restart attempt must pass");
      assert.equal(verdict.claim.nonce, "1", "the first nonce a user ever receives is 1");

      const relayed = await fetch(`${urlOne}/api/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(relayBody(verdict.claim, verdict.signature)),
      });
      assert.equal(relayed.status, 200, "the first relay should succeed");
      assert.equal(chain.settled.length, 1);

      // Hard shutdown of BOTH the HTTP server and the database connection.
      serverOne.closeAllConnections();
      await new Promise((resolve) => serverOne.close(resolve));
      await first.close();

      /* --- Generation 2: a brand new process-worth of Judge, same file. --- */
      const second = createSqliteStore({ filename: dbFile, logger: { warn() {}, error() {}, info() {} } });
      const appTwo = createApp({
        store: second,
        privateKey: backendWallet.privateKey,
        chainId: CHAIN_ID,
        verifyingContract: VERIFYING_CONTRACT,
        logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        relayService: {
          isConfigured: () => true,
          relayerAddress: () => chain.relayerAddress,
          getRelayerAddress: async () => chain.relayerAddress,
          getExpectedSigner: async () => backendWallet.address,
          validateClaimPayload: (payload) =>
            relayModule.validateClaimPayload({ ...payload, chainId: CHAIN_ID, claimerAddress: VERIFYING_CONTRACT }),
          submitClaim: (args) => chain.submitClaim(args),
        },
        expectedSigner: backendWallet.address,
      });
      const serverTwo = await new Promise((resolve) => {
        const s = appTwo.listen(0, "127.0.0.1", () => resolve(s));
      });
      const urlTwo = `http://127.0.0.1:${serverTwo.address().port}`;

      // The nonce is still spent, and still spent on-chain, after a restart.
      assert.equal(await second.isNonceUsed(RING_USERS[0], 1), true, "nonce 1 must still be burned after a restart");
      assert.equal(
        await second.reserveNonce(RING_USERS[0]),
        2,
        "the counter must resume at 2, never reissue 1 (a memory store would return 1 here)"
      );
      const record = await second.getIssuedClaim(RING_USERS[0], 1);
      assert.ok(record && record.relayerTxHash, "the relayed transaction hash must survive the restart");
      assert.equal(await second.markRelayed({ userAddress: RING_USERS[0], nonce: 1, txHash: "0x" + "ff".repeat(32) }), false);

      // And the identical signature is still refused over HTTP after the restart.
      const replayed = await fetch(`${urlTwo}/api/relay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(relayBody(verdict.claim, verdict.signature)),
      });
      assert.equal(replayed.status, 409, "the replay must be refused by the RESTARTED Judge");
      assert.equal((await replayed.json()).error, ERRORS.RELAY_ALREADY_RELAYED);
      assert.equal(chain.settled.length, 1, "no reward was paid a second time, before or after the restart");
      assert.equal(chain.totalSupply, BigInt(verdict.claim.reward));

      serverTwo.closeAllConnections();
      await new Promise((resolve) => serverTwo.close(resolve));
      await second.close();
    } finally {
      cleanup();
    }
  });
});

/* ========================================================================== */
/* ATTACK 2 — SIGNATURE REUSE ACROSS CHAINS / DEPLOYMENTS                      */
/* ========================================================================== */

describe("ATTACK 2 — signature reuse across chains and deployments", () => {
  test("2a: a signature made for chainId X is rejected against chainId X+1", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "chain-a" });
    assert.equal(verdict.status, anticheat.PASS);

    // The relay is pointed at the NEXT chain, which is exactly the situation
    // after a chain id bump or a replay against the wrong RPC.
    await closeAllServers();
    const booted = await bootJudge({ chainOptions: { chainId: CHAIN_ID + 1 } });
    baseUrl = booted.baseUrl;

    const res = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(res.status, 400, "a cross-chain signature must be refused");
    assert.equal(res.body.error, ERRORS.RELAY_SIGNATURE_INVALID, "refusal must name the signature check");
    assert.equal(chain.calls.length, 0, "nothing may reach a chain on another id");
    assert.equal(chain.settled.length, 0);
  });

  test("2b: a signature made for one verifyingContract is rejected against another deployment", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "deploy-b" });
    assert.equal(verdict.status, anticheat.PASS);

    // Same chain, DIFFERENT deployment of MiningClaimer. The signature is
    // perfectly valid — for the other contract.
    await closeAllServers();
    const booted = await bootJudge({ chainOptions: { claimerAddress: OTHER_CLAIMER } });
    baseUrl = booted.baseUrl;

    const res = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(res.status, 400, "a cross-deployment signature must be refused");
    assert.equal(res.body.error, ERRORS.RELAY_SIGNATURE_INVALID);
    assert.equal(chain.settled.length, 0, "a valid signature for the wrong contract must never mint");
  });

  test("2c: MECHANISM — the domain separator and digest genuinely differ", async () => {
    const claim = {
      user: RING_USERS[0],
      reward: MISSION.reward,
      staminaCost: MISSION.staminaCost,
      nonce: 7,
      deadline: 1_800_000_000,
    };
    const home = { chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT };
    const otherChain = { chainId: CHAIN_ID + 1, verifyingContract: VERIFYING_CONTRACT };
    const otherDeploy = { chainId: CHAIN_ID, verifyingContract: OTHER_CLAIMER };

    const digestHome = signer.claimDigest({ ...home, claim });
    const digestOtherChain = signer.claimDigest({ ...otherChain, claim });
    const digestOtherDeploy = signer.claimDigest({ ...otherDeploy, claim });

    assert.notEqual(digestHome, digestOtherChain, "a different chainId MUST change the digest");
    assert.notEqual(digestHome, digestOtherDeploy, "a different verifyingContract MUST change the digest");

    // Prove it is the DOMAIN and not the struct doing the work, by hashing the
    // domain separator itself: EIP-712 binds the domain by its own keccak.
    const { name, version } = signer.buildDomain(home);
    const domainSeparator = (domain) =>
      ethers.TypedDataEncoder.hashDomain({ name, version, chainId: domain.chainId, verifyingContract: domain.verifyingContract });
    assert.notEqual(domainSeparator(home), domainSeparator(otherChain));
    assert.notEqual(domainSeparator(home), domainSeparator(otherDeploy));
    assert.equal(domainSeparator(home), ethers.TypedDataEncoder.hashDomain(signer.buildDomain(home)));

    // And the consequence: the SAME key recovers to the signer on the home
    // digest and to a DIFFERENT address on the foreign ones, which is precisely
    // why `recovered != signer` fires.
    const signed = signer.signClaim({
      privateKey: backendWallet.privateKey,
      ...home,
      user: claim.user,
      reward: claim.reward,
      staminaCost: claim.staminaCost,
      nonce: claim.nonce,
      deadline: claim.deadline,
    });
    assert.equal(ethers.recoverAddress(digestHome, signed.signature), backendWallet.address);
    assert.notEqual(ethers.recoverAddress(digestOtherChain, signed.signature), backendWallet.address);
    assert.notEqual(ethers.recoverAddress(digestOtherDeploy, signed.signature), backendWallet.address);
  });

  test("2d: a claim signed for user A cannot be submitted as user B", async () => {
    const verdictA = await mine({ user: RING_USERS[0], sessionId: "user-a" });
    assert.equal(verdictA.status, anticheat.PASS);

    // The attacker holds a valid signature and simply rewrites the beneficiary.
    const stolen = await postJson("/api/relay", {
      ...relayBody(verdictA.claim, verdictA.signature),
      user: STRANGER,
    });
    assert.equal(stolen.status, 400, "re-pointing a signature at another wallet must be refused");
    assert.equal(stolen.body.error, ERRORS.RELAY_SIGNATURE_INVALID, "`user` is inside the struct hash");
    assert.equal(chain.settled.length, 0, "no reward to anyone");
    assert.equal(chain.totalSupply, 0n);

    // And the same substitution with a FRESH signature by the backend for user
    // B but reusing A's nonce is caught by the per-user issuance record.
    const asB = await postJson("/api/relay", relayBody(verdictA.claim, verdictA.signature));
    assert.equal(asB.status, 200, "A's own claim for A still works — the signature is not globally poisoned");
    assert.equal(chain.settled.length, 1);
  });

  test("2e: an EXPIRED deadline is refused even with a perfectly valid signature", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "expiry-e" });
    assert.equal(verdict.status, anticheat.PASS);
    const originalDeadline = Number(verdict.claim.deadline);
    assert.ok(originalDeadline > Math.floor(Date.now() / 1000), "a fresh claim must not be born expired");

    // A correct, backend-signed claim whose deadline is already in the past.
    // The attacker cannot forge this (the Judge never issues one), so the only
    // way to obtain it is a leaked/stale signature: exactly what the deadline
    // exists to bound.
    const expired = signer.signClaim({
      privateKey: backendWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: verdict.claim.user,
      reward: verdict.claim.reward,
      staminaCost: verdict.claim.staminaCost,
      nonce: verdict.claim.nonce,
      deadline: Math.floor(Date.now() / 1000) - 1,
    });
    const res = await postJson("/api/relay", {
      user: verdict.claim.user,
      reward: verdict.claim.reward,
      staminaCost: verdict.claim.staminaCost,
      nonce: verdict.claim.nonce,
      deadline: String(Math.floor(Date.now() / 1000) - 1),
      signature: expired.signature,
    });
    assert.equal(res.status, 400, "an expired claim must be refused");
    assert.equal(res.body.error, ERRORS.RELAY_CLAIM_EXPIRED, "refusal must name expiry, not a generic failure");
    assert.equal(chain.calls.length, 0, "expiry is checked BEFORE the broadcast, so no gas is spent");
  });
});

/* ========================================================================== */
/* ATTACK 3 — TELEMETRY SPOOFING (the emulator-detection backbone)            */
/* ========================================================================== */

describe("ATTACK 3 — telemetry spoofing with a perfect-but-static profile", () => {
  test("3a: a perfect-but-flatlined profile must be REJECTED (this is the regression gate)", async () => {
    // The forgery: perfect jittered touch, plausible varied scroll velocities,
    // real 5s timestamps, and one thing no client controls — a battery
    // temperature that never moves.
    const samples = perfectButFlatlined();

    // First, establish what the engine sees, and report the real numbers.
    const engine = anticheat.evaluateTelemetry(samples);
    const flatlined = engine.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE);
    const acceptable = anticheat.isTelemetryAcceptable(engine);

    // The detector MUST be firing. This is the detection half of the attack and
    // it is not what changed: a flatline has always been flagged.
    assert.equal(flatlined, true, "a constant temperature must always raise BATTERY_FLATLINE");
    assert.deepEqual(
      engine.flags,
      [anticheat.FLAGS.BATTERY_FLATLINE],
      `the forgery must be caught by the battery signal ALONE (got ${JSON.stringify(engine.flags)}: ` +
        `a redundant flag would mean the profile was not built carefully enough to isolate the signal)`
    );

    // The policy half: the flag must be DISQUALIFYING, so the score no longer
    // gets a say. Reported here rather than merely asserted, because the
    // pre-fix arithmetic (100 - 40 = 60 = TELEMETRY_PASS_SCORE, compared with
    // `>=`) is the whole reason this test exists.
    const score = engine.score;
    const onScore = score >= anticheat.TELEMETRY_PASS_SCORE;
    assert.equal(
      acceptable,
      false,
      `a perfect-but-flatlined profile must NOT be acceptable. Measured: score=${score}, ` +
        `flags=${JSON.stringify(engine.flags)}, score>=${anticheat.TELEMETRY_PASS_SCORE} is ${onScore}, ` +
        `isTelemetryAcceptable=${acceptable}. If this fails, a lone BATTERY_FLATLINE still lands exactly ` +
        `on the pass threshold and the emulator-detection backbone is decorative.`
    );

    // And over the real wire: a full, otherwise perfect mining attempt built on
    // the forgery must be refused, and must be refused with no signature.
    const sessionId = "flatline-attack";
    await primeSession(sessionId, RING_USERS[0], samples);
    const live = await http("/api/session/" + sessionId + "/telemetry");
    assert.equal(live.body.score, score, "the wire score must match the pure-function score");
    assert.ok(
      live.body.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE),
      "the live evaluation must carry the flatline flag"
    );

    const verdict = await postJson("/api/submit", {
      sessionId,
      user: RING_USERS[0],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
    });
    assert.equal(verdict.status, 200);
    assert.equal(verdict.body.status, anticheat.FAIL, "a flatlined device must not be paid");
    assert.equal(verdict.body.result.reward, 0);
    assert.ok(
      verdict.body.result.flags.includes(JUDGE_FLAGS.TELEMETRY_UNACCEPTABLE),
      `refusal must name the telemetry verdict, got ${JSON.stringify(verdict.body.result.flags)}`
    );
    assert.equal(verdict.body.signature, undefined, "no signature may be issued");
    assert.equal(verdict.body.claim, undefined, "no claim may be issued");
    assert.equal(chain.settled.length, 0);
  });

  test("3d-i: NO OVER-REACH — a realistic human with genuinely drifting temperature still PASSES", async () => {
    const samples = driftingTemperature();
    const engine = anticheat.evaluateTelemetry(samples);
    assert.equal(engine.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE), false, "real drift must not be flagged");
    assert.equal(engine.score, 100, "a pristine human session must score 100");
    assert.equal(anticheat.isTelemetryAcceptable(engine), true);

    const verdict = await mine({ user: RING_USERS[0], sessionId: "human-drift", samples });
    assert.equal(verdict.status, anticheat.PASS, "an honest reader must still be paid");
    assert.ok(verdict.signature, "a real device must still receive a signature");
  });

  test("3d-ii: NO OVER-REACH — a session with NO temperature still passes at ZERO battery penalty", async () => {
    const samples = noTemperature();
    const engine = anticheat.evaluateTelemetry(samples);
    assert.deepEqual(engine.flags, [anticheat.FLAGS.BATTERY_NOT_REPORTED], "absence is reported, not punished");
    assert.equal(anticheat.FLAGS_PENALTIES.BATTERY_NOT_REPORTED, 0, "the penalty must stay exactly 0");
    assert.equal(engine.score, 100, "hardware with no temperature API must not be charged for it");
    assert.equal(
      anticheat.isTelemetryAcceptable(engine),
      true,
      "the Wave-7 neutrality rule: incapable hardware must never be disqualified by the new policy"
    );
    assert.equal(
      anticheat.DISQUALIFYING_FLAGS.has(anticheat.FLAGS.BATTERY_NOT_REPORTED),
      false,
      "BATTERY_NOT_REPORTED must never become disqualifying, or every sensor-less phone is banned"
    );

    const verdict = await mine({ user: RING_USERS[0], sessionId: "no-sensor", samples });
    assert.equal(verdict.status, anticheat.PASS, "a phone with no battery-temperature API must still be paid");
    assert.ok(verdict.signature, "and must still receive a signature");
  });

  test("3d-iii: NO OVER-REACH — MIXED sessions (some readings, some nulls) still work", async () => {
    // A real device whose sensor intermittently returns nothing: mostly honest
    // readings with a few nulls. It must pass, because it genuinely drifts.
    const samples = driftingTemperature();
    for (let i = 0; i < samples.length; i += 1) {
      if (i % 6 === 0) samples[i].batteryTempC = null;
    }
    const engine = anticheat.evaluateTelemetry(samples);
    assert.equal(engine.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE), false, "real drift must survive nulls");
    assert.equal(engine.flags.includes(anticheat.FLAGS.BATTERY_NOT_REPORTED), false, "some readings means capable");
    assert.equal(engine.score, 100);
    assert.equal(anticheat.isTelemetryAcceptable(engine), true);

    const verdict = await mine({ user: RING_USERS[0], sessionId: "mixed-ok", samples });
    assert.equal(verdict.status, anticheat.PASS, "a partially-reporting but honest device must still be paid");
  });

  test("3e: a flatline DILUTED with nulls must still be caught", async () => {
    // The anti-evasion probe: a cheater who notices the flatline check would
    // sprinkle `batteryTempC: null` to try to switch the battery signal off.
    // Nulls are not readings, so they can only keep the check armed.
    for (const every of [2, 3, 5, 7]) {
      const samples = flatlineDilutedWithNulls(every);
      const engine = anticheat.evaluateTelemetry(samples);
      assert.equal(
        engine.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE),
        true,
        `a flatline with a null every ${every} samples must STILL be a flatline: nulls are not readings`
      );
      assert.equal(
        anticheat.isTelemetryAcceptable(engine),
        false,
        `diluting a flatline with nulls (every ${every}) must not buy a pass`
      );
    }

    // The extreme: exactly ONE real reading among 24 nulls. A cheater reporting
    // the minimum possible evidence. Still caught.
    const oneReading = perfectHuman().map((s) => ({ ...s, batteryTempC: null }));
    oneReading[7].batteryTempC = 31.5;
    const engine = anticheat.evaluateTelemetry(oneReading);
    assert.equal(engine.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE), true, "a single reading is not a trend");
    assert.equal(anticheat.isTelemetryAcceptable(engine), false);

    // And over the wire.
    const sessionId = "flatline-diluted";
    await primeSession(sessionId, RING_USERS[0], flatlineDilutedWithNulls(3));
    const verdict = await postJson("/api/submit", {
      sessionId,
      user: RING_USERS[0],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
    });
    assert.equal(verdict.body.status, anticheat.FAIL, "dilution must not rescue a flatline on the wire either");
    assert.equal(verdict.body.signature, undefined);
  });

  test("3f: the policy is explicit, exported and reversible, and moves no other number", async () => {
    assert.equal(anticheat.FLATLINE_DISQUALIFIES, true, "the policy must be an explicit, auditable constant");
    assert.equal(
      anticheat.DISQUALIFYING_FLAGS instanceof Set,
      true,
      "the disqualifying set must be an exported Set, not a re-derived list"
    );
    assert.equal(anticheat.DISQUALIFYING_FLAGS.has(anticheat.FLAGS.BATTERY_FLATLINE), true);

    // Nothing else may be disqualifying: these four are the flags whose
    // penalties leave them above the pass bar, and re-gating them would be an
    // unauthorised economy change.
    for (const flag of [
      anticheat.FLAGS.BATTERY_IMPOSSIBLE,
      anticheat.FLAGS.BATTERY_NOT_REPORTED,
      anticheat.FLAGS.PIXEL_PERFECT_TOUCH,
      anticheat.FLAGS.INHUMAN_SCROLL_SPEED,
    ]) {
      assert.equal(
        anticheat.DISQUALIFYING_FLAGS.has(flag),
        false,
        `${flag} must NOT be disqualifying: only the flatline policy was authorised`
      );
    }

    // Wave 7 pins the penalty table exactly. Asserted value-by-value.
    assert.deepEqual(anticheat.FLAGS_PENALTIES, {
      BATTERY_FLATLINE: 40,
      BATTERY_IMPOSSIBLE: 30,
      PIXEL_PERFECT_TOUCH: 25,
      INHUMAN_SCROLL_SPEED: 20,
      TOO_FEW_SAMPLES: 100,
      BATTERY_NOT_REPORTED: 0,
    });
    assert.equal(anticheat.TELEMETRY_PASS_SCORE, 60, "the numeric threshold is unchanged");
    assert.equal(anticheat.BATTERY_FLATLINE_EPSILON, 0.01);
    assert.equal(anticheat.MIN_TELEMETRY_SAMPLES, 8);
    assert.equal(anticheat.SYNDICATE_SIMILARITY_THRESHOLD, 0.9);

    // The flag is the GATE; the score stays for transparency. A flatline still
    // reports 60 — the change did not hide the arithmetic, it stopped trusting
    // it as the verdict.
    const engine = anticheat.evaluateTelemetry(perfectButFlatlined());
    assert.equal(engine.score, 60, "the score is still computed and still reported");
    assert.equal(anticheat.isTelemetryAcceptable(engine), false, "but the flag is now what decides");

    // Defensive: a forged result object cannot smuggle a disqualifying flag
    // away, and a non-object is still unacceptable.
    assert.equal(anticheat.isTelemetryAcceptable({ score: 60, flags: [] }), true, "an unflagged 60 still passes");
    assert.equal(anticheat.isTelemetryAcceptable(null), false);
    assert.equal(anticheat.isTelemetryAcceptable({ score: 100, flags: ["NOT_A_FLAG"] }), true, "unknown flags are inert");
  });
});

/* ========================================================================== */
/* ATTACK 4 — SYNDICATE COPY-PASTE RING                                       */
/* ========================================================================== */

describe("ATTACK 4 — a five-account syndicate ring", () => {
  /** The copy-pasted free text every accomplice submits verbatim. */
  const RING_ANSWER =
    "The article argues that paying readers on the session itself optimises for the feeling of mastery, " +
    "while paying after a delayed check optimises for retention, and that the harder to check version is " +
    "also harder to cheat, which is not a coincidence.";

  test("4a/4b: five accounts, one copied answer — the first is graded, the other four are refused and NONE of the five is paid twice", async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      const user = RING_USERS[i];
      const verdict = await mine({ user, sessionId: `ring-${i}`, freeText: RING_ANSWER });
      results.push(verdict);
    }

    // (a) The FIRST is graded on its merits.
    assert.equal(results[0].status, anticheat.PASS, "the first submitter is graded on its own merits");
    assert.ok(results[0].signature, "and is signed");
    assert.equal(results[0].syndicate.syndicate, false, "with no history to match against, there is no signal");

    // Every SUBSEQUENT one is refused as a syndicate.
    for (let i = 1; i < 5; i += 1) {
      const v = results[i];
      assert.equal(v.status, anticheat.FAIL, `ring member ${i} must be refused`);
      assert.equal(v.syndicate.syndicate, true, `ring member ${i} must be flagged as a syndicate`);
      assert.ok(
        v.syndicate.similarity > anticheat.SYNDICATE_SIMILARITY_THRESHOLD,
        `ring member ${i}: the refusal must be driven by measured similarity, got ${v.syndicate.similarity}`
      );
      assert.ok(
        v.result.flags.includes(JUDGE_FLAGS.SYNDICATE_MATCH),
        `ring member ${i}: the refusal must NAME the syndicate signal, got ${JSON.stringify(v.result.flags)}`
      );
      assert.equal(v.result.reward, 0, `ring member ${i} must be owed nothing`);
      assert.equal(v.signature, undefined, `ring member ${i} must receive NO signature`);
      assert.equal(v.claim, undefined, `ring member ${i} must receive NO claim`);
    }

    // (b) At most ONE reward for the whole ring.
    const signed = results.filter((v) => typeof v.signature === "string");
    assert.equal(signed.length, 1, "exactly one of the five may hold a signature");
    const relayed = await postJson("/api/relay", relayBody(signed[0].claim, signed[0].signature));
    assert.equal(relayed.status, 200);
    assert.equal(chain.settled.length, 1, "one minted reward for the whole ring");
    assert.equal(chain.totalSupply, BigInt(signed[0].claim.reward));
  });

  test("4c: a legitimately different sixth submitter is not swept up", async () => {
    // A sixth account with its OWN answer, arriving after the ring. It must not
    // be caught by proximity to the ring.
    const first = await mine({ user: RING_USERS[0], sessionId: "ring-0b", freeText: RING_ANSWER });
    assert.equal(first.status, anticheat.PASS);

    const bystander = await mine({
      user: RING_USERS[5],
      sessionId: "bystander",
      freeText:
        "My own summary: delayed payment rewards people who come back, immediate payment rewards people " +
        "who finish the page once, and the author is suspicious of both and prefers the one that is harder " +
        "to game with a script.",
    });
    assert.equal(bystander.status, anticheat.PASS, "an unrelated honest answer must not be collateral damage");
    assert.equal(bystander.syndicate.syndicate, false, "and must not be flagged at all");
    assert.ok(bystander.signature, "and must still be paid");
  });

  test("4d: PROBE THE LIMIT — reordering evades, synonym-swapping evades, and that is reported not hidden", async () => {
    // Measure the detector's real limits instead of asserting a rosy summary.
    const base = RING_ANSWER;
    const words = base.split(" ");

    const reordered = words.slice().reverse().join(" ");
    const synonymSwap =
      "The article argues that paying readers on the session itself optimises for the feeling of mastery, " +
      "while paying after a delayed check optimises for retention, and that the harder to check version is " +
      "also harder to cheat, which is not a coincidence.";

    const paraphrases = {
      "word-order permutation": reordered,
      "case + punctuation only": base.toUpperCase().replace(/ /g, ", "),
      "one word swapped for a synonym": base.replace("optimises", "maximises"),
      "two words swapped for synonyms": base.replace("optimises", "maximises").replace("harder", "tougher"),
      "one word dropped": base.replace("cheat,", ""),
      "wholesale rewrite": "Payment timing changes user behaviour: instant payout rewards completion, " +
        "deferred payout rewards retention, and delayed verification resists automation better.",
    };

    const measured = {};
    for (const [label, text] of Object.entries(paraphrases)) {
      const sim = anticheat.similarity(base, text);
      const detected = anticheat.detectSyndicate({ previousTexts: [base], currentText: text });
      measured[label] = { similarity: Number(sim.toFixed(4)), detected: detected.syndicate };
    }

    // A pure word-order permutation is IDENTICAL as a token SET, and the
    // detector is set-based, so reordering is caught at similarity 1.0. That is
    // a genuine strength and it is asserted.
    assert.equal(
      anticheat.detectSyndicate({ previousTexts: [base], currentText: reordered }).syndicate,
      true,
      "a reordered copy is the same token set and must be caught"
    );

    // RESIDUAL WEAKNESS, MEASURED: light paraphrasing falls under the 0.9 bar.
    // These are NOT fixed here (out of scope and not authorised); the numbers
    // are asserted so the weakness cannot regress into invisibility.
    const evaders = Object.entries(measured).filter(([, m]) => m.similarity <= anticheat.SYNDICATE_SIMILARITY_THRESHOLD);
    assert.ok(
      evaders.length > 0,
      `expected the >0.9 threshold to be defeatable by paraphrase; measured ${JSON.stringify(measured)}. ` +
        "If this now fails, the paraphrase evasion has been closed and this test should be inverted."
    );
    assert.ok(
      measured["wholesale rewrite"].similarity < 0.2,
      `a genuine rewrite should be far below the bar, measured ${measured["wholesale rewrite"].similarity}`
    );

    // Report the table so the numbers appear in CI output rather than only in a
    // comment nobody reads.
    console.log("    [red-team] syndicate detector limits (base answer vs variant):");
    for (const [label, m] of Object.entries(measured)) {
      console.log(`      - ${label}: similarity=${m.similarity} detected=${m.detected}`);
    }
  });

  test("4e: PROBE — a single honest user submitting the same answer twice is falsely accused. Reported, not hidden", async () => {
    // What `listRecentSubmissions` actually does: the Judge calls it with
    // `{ limit }` and NO `userAddress`, so the corpus spans ALL users and
    // includes the current user's OWN earlier submissions. A syndicate is a
    // group copying each other, so a per-user query could not see the copy —
    // but that same choice means an honest user who re-mines the same article
    // and writes the same summary is compared against their own previous text.
    const user = RING_USERS[0];
    const first = await mine({ user, sessionId: "repeat-1", freeText: RING_ANSWER });
    assert.equal(first.status, anticheat.PASS, "the first attempt is clean");

    const second = await mine({ user, sessionId: "repeat-2", freeText: RING_ANSWER });
    assert.equal(
      second.status,
      anticheat.FAIL,
      "RESIDUAL WEAKNESS: the second attempt by the SAME user with the SAME answer is refused as a " +
        "syndicate, because the lookup spans all users including the caller's own history. " +
        "This is a genuine false positive against an honest re-miner. It is NOT fixed here — the " +
        "cross-user corpus is the syndicate defence — and it is asserted so it stays visible."
    );
    assert.equal(second.syndicate.similarity, 1, "self-comparison is a perfect match");
    assert.ok(second.result.flags.includes(JUDGE_FLAGS.SYNDICATE_MATCH));
    assert.equal(second.signature, undefined);

    // The store's per-user filter, for the record: it DOES work when asked for,
    // it is simply not used by the syndicate path.
    const all = await store.listRecentSubmissions({ limit: 50 });
    const scoped = await store.listRecentSubmissions({ userAddress: user, limit: 50 });
    assert.equal(all.length, 2, "the unfiltered listing spans all users");
    assert.equal(scoped.length, 2, "the filtered listing returns only this user's rows");
    assert.equal(
      all.some((row) => row.userAddress !== user),
      false,
      "in this scenario every row happens to be the caller's, which is exactly the false-positive shape"
    );
  });
});

/* ========================================================================== */
/* ADDITIONAL PROBES                                                           */
/* ========================================================================== */

describe("PROBES — ingest, supply, stamina, impersonation, payloads", () => {
  test("P1: too-few-samples and zero-telemetry submits are refused at ingest", async () => {
    // Fewer than MIN_TELEMETRY_SAMPLES: a "session" too short for any hardware
    // signal to mean anything. This is a FAIL, not a pass — the burden of proof
    // is on the claimant.
    const few = anticheat.evaluateTelemetry(perfectHuman(7));
    assert.ok(few.flags.includes(anticheat.FLAGS.TOO_FEW_SAMPLES));
    assert.equal(few.score, 0, "too few samples is always 0");
    assert.equal(anticheat.isTelemetryAcceptable(few), false);

    const tooFew = await mine({ user: RING_USERS[0], sessionId: "too-few", samples: perfectHuman(7) });
    assert.equal(tooFew.status, anticheat.FAIL, "a 7-sample session must not be paid");
    assert.equal(tooFew.signature, undefined);
    assert.ok(tooFew.result.flags.includes(anticheat.SUBMISSION_FLAGS.TELEMETRY_POOR));

    // ZERO telemetry: the session exists and the submit is well-formed, but no
    // Proof-of-Attention was ever streamed.
    await postJson("/api/session", { sessionId: "zero", user: RING_USERS[1], missionId: MISSION_ID });
    const zero = await postJson("/api/submit", {
      sessionId: "zero",
      user: RING_USERS[1],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
    });
    assert.equal(zero.status, 200);
    assert.equal(zero.body.status, anticheat.FAIL, "no telemetry at all must not be paid");
    assert.equal(zero.body.telemetry.score, 0);
    assert.ok(zero.body.telemetry.flags.includes(anticheat.FLAGS.TOO_FEW_SAMPLES));
    assert.equal(zero.body.signature, undefined);

    // And an empty telemetry batch is refused at the endpoint itself.
    const emptyBatch = await postJson("/api/telemetry", { sessionId: "zero", samples: [] });
    assert.equal(emptyBatch.status, 400, "an empty batch must be refused at ingest");
    assert.equal(emptyBatch.body.error, ERRORS.INVALID_TELEMETRY);
  });

  test("P2: a claim breaching MAX_SUPPLY reverts cleanly and RELEASES the nonce", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "supply-breach" });
    assert.equal(verdict.status, anticheat.PASS);

    // A Judge-signed claim whose reward alone exceeds the immutable cap. The
    // attacker cannot produce this (they cannot sign), so it models the
    // realistic failure: a content/economy bug, or a compromised signer. The
    // ONLY thing standing between that and 100M+ minted CATT is the contract.
    //
    // A FRESH beneficiary is used on purpose: if the (user, nonce) pair were
    // one this Judge had issued, the issuance cross-check would reject the
    // request at 400 RELAY_CLAIM_MISMATCH before the chain was ever reached,
    // and the contract's cap would go untested.
    const capUser = STRANGER;
    const absurd = signer.signClaim({
      privateKey: backendWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: capUser,
      reward: (MAX_SUPPLY + 1n).toString(),
      staminaCost: verdict.claim.staminaCost,
      nonce: verdict.claim.nonce,
      deadline: verdict.claim.deadline,
    });
    const res = await postJson("/api/relay", {
      user: capUser,
      reward: absurd.claim.reward,
      staminaCost: absurd.claim.staminaCost,
      nonce: absurd.claim.nonce,
      deadline: absurd.claim.deadline,
      signature: absurd.signature,
    });
    assert.equal(res.status, 502, "an over-cap claim must be a clean relay failure, not a 500");
    assert.equal(res.body.error, ERRORS.RELAY_TX_REVERTED);
    assert.ok(/MintExceedsMaxSupply/.test(res.body.reason), `the revert reason must be surfaced: ${res.body.reason}`);
    assert.equal(chain.totalSupply, 0n, "not one wei above the cap was minted");

    // NONCE RELEASED: a revert unwinds the burn, so the nonce stays spendable.
    // This matters: if a revert burned the nonce, a transient chain failure
    // would permanently destroy a user's claim. The over-cap claim was for a
    // beneficiary this Judge never issued a nonce to, so both the chain and
    // the store must show the nonce as untouched and unrelayed.
    assert.equal(chain.usedNonces.size, 0, "a reverted claim must not burn the nonce");
    assert.equal(await store.getIssuedClaim(capUser, absurd.claim.nonce), undefined, "and the store recorded nothing");
    assert.equal(
      await store.isNonceUsed(capUser, absurd.claim.nonce),
      false,
      "the nonce must still be reservable by that user"
    );

    // The same claim is immediately retryable and now succeeds.
    const retry = await postJson("/api/relay", relayBody(verdict.claim, verdict.signature));
    assert.equal(retry.status, 200, "the released nonce must be usable immediately");
    assert.equal(chain.settled.length, 1);

    // Now the ABSURD-BUT-WITH-HEADROOM case: a huge reward that still fits
    // under the cap. The contract ACCEPTS it. Reported honestly: the backend
    // performs no economic sanity check of its own on `reward`; the cap is the
    // only bound, and it is a 100M-CATT bound, not a per-mission one.
    // A pristine chain is booted so the headroom arithmetic is unambiguous.
    await closeAllServers();
    const fresh = await bootJudge({});
    baseUrl = fresh.baseUrl;
    store = fresh.store;
    chain = fresh.chain;

    const headroom = signer.signClaim({
      privateKey: backendWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: capUser,
      reward: (MAX_SUPPLY - 1n).toString(),
      staminaCost: verdict.claim.staminaCost,
      nonce: 1,
      deadline: verdict.claim.deadline,
    });
    const whale = await postJson("/api/relay", {
      user: STRANGER,
      reward: headroom.claim.reward,
      staminaCost: headroom.claim.staminaCost,
      nonce: headroom.claim.nonce,
      deadline: headroom.claim.deadline,
      signature: headroom.signature,
    });
    assert.equal(whale.status, 200, "a within-cap claim is accepted: the cap, not the Judge, bounds the reward");
    assert.equal(chain.totalSupply, MAX_SUPPLY - 1n);
    assert.equal(
      chain.settled.length,
      1,
      "RESIDUAL WEAKNESS: a signature over ~100M CATT settles if it is under the cap. Requires the " +
        "backend signer key, so it is not attacker-reachable, but the Judge itself never range-checks reward."
    );
  });

  test("P3: FINDING — a claim with staminaCost = 0 cannot pay out; the CONTRACT is the only defence", async () => {
    const verdict = await mine({ user: RING_USERS[0], sessionId: "stamina-zero" });
    assert.equal(verdict.status, anticheat.PASS);

    // The attack: obtain a signature for a full reward while paying ZERO
    // stamina, so a cheater can mine forever having never staked anything.
    // Two ways a cheater might try, both driven here:
    const forged = signer.signClaim({
      privateKey: impostorWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: RING_USERS[0],
      reward: MISSION.reward,
      staminaCost: 0,
      nonce: verdict.claim.nonce,
      deadline: verdict.claim.deadline,
    });
    const viaImpostor = await postJson("/api/relay", {
      user: RING_USERS[0],
      reward: MISSION.reward,
      staminaCost: "0",
      nonce: verdict.claim.nonce,
      deadline: verdict.claim.deadline,
      signature: forged.signature,
    });
    // A) Self-signed: refused at the relay, before the chain is touched.
    assert.equal(viaImpostor.status, 400, "a self-signed zero-stamina claim must be refused");
    assert.equal(viaImpostor.body.error, ERRORS.RELAY_SIGNATURE_INVALID);
    assert.equal(chain.calls.length, 0, "and must never reach a chain");

    // B) The signer-issued variant: the backend's own key, staminaCost zero.
    //    Unreachable by a cheater today, but it isolates the CONTRACT, which is
    //    the layer this suite is not allowed to change. A beneficiary this
    //    Judge never issued a nonce for is used so that the request clears the
    //    issuance cross-check and actually reaches the chain — otherwise the
    //    400 RELAY_CLAIM_MISMATCH would mask the contract's own refusal.
    const zeroUser = STRANGER;
    const zeroSigned = signer.signClaim({
      privateKey: backendWallet.privateKey,
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      user: zeroUser,
      reward: MISSION.reward,
      staminaCost: 0,
      nonce: 1,
      deadline: verdict.claim.deadline,
    });
    const viaSigner = await postJson("/api/relay", {
      user: zeroUser,
      reward: MISSION.reward,
      staminaCost: "0",
      nonce: 1,
      deadline: verdict.claim.deadline,
      signature: zeroSigned.signature,
    });
    assert.equal(viaSigner.status, 502, "even a correctly signed zero-stamina claim cannot settle");
    assert.equal(viaSigner.body.error, ERRORS.RELAY_TX_REVERTED);
    assert.ok(
      /ZeroAmount/.test(viaSigner.body.reason),
      `StakingManager.consumeStamina must reject a zero debit: ${viaSigner.body.reason}`
    );
    assert.equal(chain.settled.length, 0, "NOTHING may be minted for a zero-stamina claim");
    assert.equal(chain.totalSupply, 0n);
    assert.equal(chain.usedNonces.size, 0, "and the nonce is released, so the claim is retryable, not bricked");

    // The economic bound that actually matters: stamina is a hard prerequisite
    // for ANY reward, so mining volume is capped by staked principal. A user
    // with no stamina cannot settle a single reward.
    const broke = await bootJudge({ chainOptions: { unstaked: true } });
    baseUrl = broke.baseUrl;
    chain = broke.chain;
    const brokeVerdict = await mine({ user: RING_USERS[0], sessionId: "broke" });
    assert.equal(brokeVerdict.status, anticheat.PASS, "the Judge still grades honestly...");
    const brokeRelay = await postJson("/api/relay", relayBody(brokeVerdict.claim, brokeVerdict.signature));
    assert.equal(brokeRelay.status, 502, "...but an unstaked user cannot actually collect");
    assert.ok(/StaminaInsufficient/.test(brokeRelay.body.reason), brokeRelay.body.reason);
    assert.equal(chain.settled.length, 0, "zero stamina, zero rewards");

    // Severity verdict, in the assertion so it is read:
    //   - As an ATTACK: NOT REACHABLE. The signed `staminaCost` is taken from
    //     the mission by `evaluateSubmission` and is not attacker-influenced
    //     through any request field, so a cheater cannot obtain a
    //     staminaCost = 0 signature without the backend key.
    //   - As a DEFENCE: the rejection lives ONLY in
    //     `StakingManager.consumeStamina`'s `if (amount == 0) revert
    //     ZeroAmount()`. The backend has no rule of its own requiring a
    //     positive stamina cost, so the invariant is a single untyped
    //     contract line with no second implementation to keep it honest.
    //   - SEVERITY: LOW as an exploit (unreachable), MEDIUM as a defence-in-
    //     depth gap (a content.js mission authored with `staminaCost: "0"`
    //     would make 100% of that mission's claims revert on-chain, and the
    //     released nonce makes it a permanent livelock rather than a loss).
    //   No contract fix is attempted or recommended here; the finding is
    //   reported for the contract owners.
    const missions = content.listMissions();
    assert.ok(
      missions.every((m) => BigInt(m.staminaCost) > 0n),
      "every shipped mission must have a positive stamina cost (today's invariant, not a guarantee)"
    );
  });

  test("P4: FINDING — `/api/submit` accepts a `user` the caller does not control", async () => {
    // There is no proof-of-possession on the submit path: no signature from the
    // user, no nonce bound to a key they hold. Anyone can register a session in
    // the victim's name and mine into their account.
    //
    // Why it is not catastrophic: the reward can only be claimed by the
    // VICTIM, and only out of the VICTIM's own staked stamina, because
    // `claimReward` debits `staminaCost` from `user` and mints to `user`. The
    // victim below is given a zero balance, which is what makes that concrete:
    // the impersonator's own perfect session cannot convert into a single wei.
    await closeAllServers();
    const victimless = await bootJudge({ chainOptions: { stamina: new Map([[VICTIM.toLowerCase(), 0n]]) } });
    baseUrl = victimless.baseUrl;
    store = victimless.store;
    chain = victimless.chain;

    await postJson("/api/session", { sessionId: "impersonate", user: VICTIM, missionId: MISSION_ID });
    await postJson("/api/telemetry", { sessionId: "impersonate", samples: perfectHuman() });
    const res = await postJson("/api/submit", {
      sessionId: "impersonate",
      user: VICTIM,
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.body.status,
      anticheat.PASS,
      "RESIDUAL WEAKNESS: a signature is issued for an address the caller never proved control of"
    );
    assert.equal(res.body.claim.user.toLowerCase(), VICTIM.toLowerCase(), "the claim names the victim as beneficiary");
    assert.ok(res.body.signature);

    const relay = await postJson("/api/relay", relayBody(res.body.claim, res.body.signature));
    assert.equal(502, relay.status, "and it still cannot settle without the victim's staked stamina");
    assert.ok(/StaminaInsufficient/.test(relay.body.reason), relay.body.reason);
    assert.equal(chain.settled.length, 0);

    // The converse is harmless: `user` is inside the signed struct, so this
    // signature is useless to anyone but the victim.
    const stolen = await postJson("/api/relay", {
      ...relayBody(res.body.claim, res.body.signature),
      user: STRANGER,
    });
    assert.equal(stolen.status, 400, "and cannot be re-pointed at the attacker");
    assert.equal(stolen.body.error, ERRORS.RELAY_SIGNATURE_INVALID);
  });

  test("P5: empty, whitespace, and enormous freeText are all handled without a crash", async () => {
    // Empty and whitespace-only text carry no content, so they are excluded from
    // syndicate comparison rather than compared against "" (which would match
    // everything or nothing depending on implementation).
    const empty = await mine({ user: RING_USERS[0], sessionId: "ft-empty", freeText: "" });
    assert.equal(empty.status, anticheat.PASS, "an empty freeText is not a syndicate signal");
    assert.equal(empty.syndicate.syndicate, false);

    const blank = await mine({ user: RING_USERS[0], sessionId: "ft-blank", freeText: "   \n\t  " });
    assert.equal(blank.status, anticheat.PASS, "a whitespace-only answer is also not a syndicate signal");
    assert.equal(
      blank.syndicate.syndicate,
      false,
      "it is excluded from the corpus entirely (the Judge drops blank texts before comparing), so a " +
        "blank answer can never be used to frame someone else as a syndicate"
    );

    // A non-string freeText is a 400, not a crash.
    const wrongType = await postJson("/api/submit", {
      sessionId: "ft-empty",
      user: RING_USERS[0],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
      freeText: { evil: true },
    });
    assert.equal(wrongType.status, 400, "a non-string freeText must be a clean 400");
    assert.equal(wrongType.body.error, ERRORS.INVALID_SUBMISSION);

    // An enormous but legal freeText: ~200 KiB, under the 256 KiB body limit.
    // It must be graded without a timeout, an OOM or a 500, and must NOT match
    // the short answers it is compared against.
    const huge = Array.from({ length: 24000 }, (_, i) => `w${i}`).join(" ");
    assert.ok(huge.length < 250_000, `fixture must stay under the body limit, got ${huge.length}`);
    const t0 = Date.now();
    const enormous = await mine({ user: RING_USERS[1], sessionId: "ft-huge", freeText: huge });
    const elapsed = Date.now() - t0;
    assert.equal(enormous.status, anticheat.PASS, `a 200 KiB freeText must be handled cleanly (took ${elapsed}ms)`);
    assert.equal(enormous.syndicate.syndicate, false, "and must not spuriously match the short answers");
    assert.ok(elapsed < 5000, `the 200 KiB compare must not be quadratic-slow, took ${elapsed}ms`);

    // Over the body limit: a clean 413, never a crash.
    const tooBig = "x".repeat(300_000);
    const overLimit = await postJson("/api/submit", {
      sessionId: "ft-huge",
      user: RING_USERS[1],
      answers: correctAnswers(),
      highlight: fullHighlight(),
      typingMs: GENEROUS_TYPING_MS,
      freeText: tooBig,
    });
    assert.equal(overLimit.status, 413, "an over-limit body must be a clean 413");
  });
});
