/**
 * CATT Protocol — THE LIVE ECONOMY, WIRED: aggressive tokenomics end to end.
 *
 * NO test framework dependency. Node's built-in `node:test` plus
 * `node:assert/strict`, the app bound to an ephemeral port via `listen(0)`, and
 * the global `fetch` — exactly the pattern `server.test.js` uses, and its
 * human-telemetry fixture is reproduced here verbatim so the two suites cannot
 * drift apart.
 *
 * WHAT THIS FILE IS FOR. Wave 9b built the four economic modules as pure,
 * store-free mechanics (`economics.js`, `seasons.js`, `stamina-allowance.js`).
 * This file proves they are WIRED into the Judge's request path, with the
 * founder's parameters live and uns softened:
 *
 *   1. a real PASS is signed at the DYNAMIC + STREAK-adjusted reward
 *   2. the emission curve is live over HTTP (below the flat base at 5,000+
 *      miners, exactly the flat base at or below it)
 *   3. the streak ladder rises day 1 -> day 7, CLAMPS at 2.0 from day 7, and
 *      resets on a missed day — driven by an INJECTED CLOCK, not by waiting
 *   4. two graded PASSes on one day cannot farm a streak day, and a FAIL moves
 *      no streak at all
 *   5. the season pool is a HARD CAP: exhausted, the claim fails loudly with
 *      no signature, no nonce burned and no allocation minted — and mining
 *      resumes only when the NEXT season opens
 *   6. the free-stamina grant is 30 points, once per day, per user, and does
 *      not lift the 50-point daily spend cap or touch the signed `staminaCost`
 *   7. the config parse is INVERTED: only an explicit false/0/off disables a
 *      mechanism; unset, empty and garbage all leave it ON
 *   8. the wired path mutates none of the frozen module exports
 *   9. anti-cheat, syndicate, telemetry, relay and nonce behaviour all still
 *      hold through the wired path
 *
 * TEST HYGIENE (inherited from `server.test.js`):
 *   - A FRESH app and a FRESH store per case: the store holds per-user nonce
 *     counters, the season pool, the streak rows and a cross-user submission
 *     log, so sharing one would make every assertion order-dependent.
 *   - A THROWAWAY signing key per file, injected through `createApp`. No key is
 *     ever hardcoded and nothing is written to disk.
 *   - The economy flags are injected through `createApp({ env })`, which is the
 *     same reader `process.env` goes through by default; one case deliberately
 *     uses `process.env` itself to prove that default.
 *   - Every server is closed with `closeAllConnections()`, because the global
 *     `fetch` keeps sockets alive and a bare `close()` hangs the runner at exit.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const content = require("../src/content");
const anticheat = require("../src/anticheat");
const economics = require("../src/economics");
const seasons = require("../src/seasons");
const staminaAllowance = require("../src/stamina-allowance");
const relayModule = require("../src/relay");
const backendSigner = require("../signer");
const { createApp, ERRORS } = require("../src/server");
const { createMemoryStore } = require("../src/storage");

/* -------------------------------------------------------------------------- */
/* Fixed test configuration                                                    */
/* -------------------------------------------------------------------------- */

/** Throwaway backend signer. Never written anywhere persistent. */
const backendWallet = ethers.Wallet.createRandom();

const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

/** Obviously fake users. Valid hex, deterministic, never the signer. */
const USER_A = "0x" + "11".repeat(20);
const USER_B = "0x" + "22".repeat(20);
const USER_C = "0x" + "33".repeat(20);
/** Used to fill a season pool to its allocation without signing anything. */
const FILLER = "0x" + "99".repeat(20);

const GENEROUS_TYPING_MS = 40_000;

const MISSION_ID = "mission-1";
const MISSION = content.getMission(MISSION_ID);
const ARTICLE = content.getArticle(MISSION.articleId);

/** Day 0 of every ladder here: 2026-01-01T00:00:00Z, as epoch milliseconds. */
const DAY_0_MS = Date.UTC(2026, 0, 1);
const ONE_DAY_MS = 86_400_000;
/** The wired `SEASON_EPOCH` when the flag is unset: the boot instant, floored. */
const BOOT_SECONDS = Math.floor(DAY_0_MS / 1000);

/** The authored base rewards, as the exact strings the modules compare against. */
const EASY_BASE = MISSION.reward; // "12000000000000000000"  (12 CATT)
const MEDIUM_BASE = content.getMission("mission-2").reward; // 20 CATT
const HARD_BASE = content.getMission("mission-3").reward; // 40 CATT
/** The 50% dynamic-emission floor for each difficulty. */
const EASY_FLOOR_REWARD = (BigInt(EASY_BASE) / 2n).toString();
const HARD_FLOOR_REWARD = (BigInt(HARD_BASE) / 2n).toString();

/**
 * The literal streak ladder on the EASY base, indexed by the user's k-th
 * CONSECUTIVE GRADED DAY.
 *
 * THE INDEX IS THE POINT. The Judge READS the streak before it RECORDS the
 * completion, so the k-th graded day is paid on `k - 1` already-banked days:
 *
 *     banked days d -> factor = 10000 + 2000 * (d - 1), clamped at 20000
 *     d = 0 -> 1.0x   (first ever: nothing banked)
 *     d = 1 -> 1.0x   (second consecutive day)
 *     d = 2 -> 1.2x   (third)
 *     ...
 *     d = 6 -> 2.0x   THE CAP — reached on the SEVENTH consecutive graded day
 *
 * so the first entry (k = 1) and the second (k = 2) both pay the base, and the
 * 2.0x cap is first PAID on k = 7.
 */
const STREAK_LADDER_EASY = [
  "12000000000000000000", // k=1, reads 0 banked days -> 1.0x (12 CATT)
  "12000000000000000000", // k=2, reads 1            -> 1.0x (12 CATT)
  "14400000000000000000", // k=3, reads 2            -> 1.2x (14.4 CATT)
  "16800000000000000000", // k=4, reads 3            -> 1.4x (16.8 CATT)
  "19200000000000000000", // k=5, reads 4            -> 1.6x (19.2 CATT)
  "21600000000000000000", // k=6, reads 5            -> 1.8x (21.6 CATT)
  "24000000000000000000", // k=7, reads 6            -> 2.0x (24 CATT) THE CAP
  "24000000000000000000", // k=8, reads 7            -> clamped at 2.0x
];

/** Fake transaction hash for the relay stub. */
const FAKE_TX_HASH = "0x" + "ab".repeat(32);

/* -------------------------------------------------------------------------- */
/* Fixtures — the human-telemetry stream, reproduced from server.test.js      */
/* -------------------------------------------------------------------------- */

/**
 * A realistic HUMAN telemetry stream: the mobile app posts every 5 seconds, so
 * 25 samples cover roughly two minutes of reading. Battery temperature drifts,
 * no touch pair repeats, and scroll deltas vary in magnitude and SIGN inside
 * the plausibility ceiling. Deterministic by construction.
 *
 * @param {number} [count] Number of samples.
 * @param {number} [startTs] First sample's timestamp, in ms.
 * @returns {Array<Object>} Telemetry samples.
 */
function humanTelemetry(count = 25, startTs = 1_760_000_000_000) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    // gcd(7, 81) === 1, gcd(37, 260) === 1 and gcd(53, 420) === 1: no repeats.
    const batteryTempC = 26 + ((i * 7) % 81) / 10;
    const x = 40 + ((i * 37) % 260);
    const y = 90 + ((i * 53) % 420);
    const scrollDelta = [120, -45, 310, -260, 0, 175, -95, 60][i % 8];
    samples.push({ ts: startTs + i * 5000, batteryTempC, touch: { x, y }, scrollDelta });
  }
  return samples;
}

/**
 * A realistic EMULATOR stream: flatlined battery temperature plus a replayed tap
 * coordinate. The flatline alone lands exactly on the pass threshold, so the
 * repeated tap is what makes the profile disqualifying.
 *
 * @param {number} [count] Number of samples.
 * @returns {Array<Object>} Telemetry samples.
 */
function emulatorTelemetry(count = 25) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: 1_760_000_000_000 + i * 5000,
      batteryTempC: 31.5,
      touch: { x: 540, y: 960 },
      scrollDelta: 90,
    });
  }
  return samples;
}

/**
 * The article a mission reads, so a case can mine a non-default mission without
 * answering the WRONG article's quiz.
 *
 * @param {string} missionId Mission.
 * @returns {Object} The article.
 */
function articleFor(missionId) {
  return content.getArticle(content.getMission(missionId).articleId);
}

/**
 * The correct answer set for a mission's own article, read from `content` INSIDE
 * the test process and never fetched over HTTP — the reading endpoint must not
 * carry the answer key.
 *
 * @param {string} [missionId] Mission; defaults to `mission-1`.
 * @returns {Array<{ questionId: string, answerIndex: number }>}
 */
function correctAnswers(missionId = MISSION_ID) {
  return articleFor(missionId).quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex }));
}

/** A highlight containing the key sentences: what a real reader produces. */
function fullHighlight(missionId = MISSION_ID) {
  return articleFor(missionId).highlightTask.keySentences.join(" ");
}

/** The deliberately-wrong answer set for a mission's own article. */
function wrongAnswers(missionId = MISSION_ID) {
  const article = articleFor(missionId);
  return article.quiz.map((q) => ({ questionId: q.id, answerIndex: (q.correctIndex + 1) % q.options.length }));
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Servers started by the CURRENT test. Closed between cases. */
let liveServers = [];

/**
 * Closes every server started so far and forces keep-alive sockets shut.
 *
 * @returns {Promise<void>}
 */
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
 * A logger that swallows everything, so the suite never depends on console
 * output while still exercising the logging branches.
 *
 * @returns {Object} A logger with every level.
 */
function quietLogger() {
  return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
}

/**
 * Boots a fresh app on an ephemeral port.
 *
 * @param {Object} [options]
 * @param {Object} [options.store] Store override; defaults to a memory store.
 * @param {number} [options.now] The clock's initial instant, epoch ms.
 * @param {Object} [options.env] Economy flags; defaults to "everything unset".
 * @param {Object} [options.relayService] Relay adapter override.
 * @param {number|null} [options.dailyStaminaCap] Cap override.
 * @returns {Promise<{ baseUrl: string, store: Object, now: Object }>}
 */
async function boot(options = {}) {
  const logger = quietLogger();
  const store = options.store || createMemoryStore();
  const now = { ms: options.now === undefined ? DAY_0_MS : options.now };
  const clock = () => now.ms;

  const app = createApp({
    store,
    logger,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    privateKey: backendWallet.privateKey,
    clock,
    // An empty environment IS the "unset" case: every flag then defaults to the
    // founder's aggressive value.
    env: options.env || {},
    relayService: options.relayService,
    expectedSigner: options.relayService ? backendWallet.address : undefined,
    dailyStaminaCap: options.dailyStaminaCap,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, store, now };
}

/**
 * Issues a request and returns both the parsed body and the RAW text.
 *
 * @param {string} baseUrl Server root.
 * @param {string} path Path.
 * @param {Object} [init] `fetch` init.
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
async function http(baseUrl, path, init = {}) {
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

/**
 * JSON POST helper.
 *
 * @param {string} baseUrl Server root.
 * @param {string} path Path.
 * @param {Object} payload Body.
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
function postJson(baseUrl, path, payload) {
  return http(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Registers a session and streams telemetry into it.
 *
 * @param {string} baseUrl Server root.
 * @param {string} sessionId Session id.
 * @param {string} user User address.
 * @param {Array<Object>} [samples] Telemetry; defaults to the human fixture.
 * @param {string} [missionId] Mission; defaults to `mission-1`.
 * @returns {Promise<string>} The session id.
 */
async function primeSession(baseUrl, sessionId, user, samples = humanTelemetry(), missionId = MISSION_ID) {
  const created = await postJson(baseUrl, "/api/session", { sessionId, user, missionId });
  assert.equal(created.status, 201, `session registration failed: ${created.raw}`);
  const pushed = await postJson(baseUrl, "/api/telemetry", { sessionId, samples });
  assert.equal(pushed.status, 200, `telemetry ingest failed: ${pushed.raw}`);
  return sessionId;
}

/**
 * An honest, complete mining attempt body for a mission's own article.
 *
 * @param {Object} overrides Field overrides.
 * @param {string} [overrides.__missionId] Internal: the mission being answered.
 * @returns {Object} Submission body.
 */
function submission(overrides = {}) {
  const { __missionId, ...rest } = overrides;
  const missionId = __missionId || MISSION_ID;
  return {
    sessionId: "s-default",
    user: USER_A,
    answers: correctAnswers(missionId),
    highlight: fullHighlight(missionId),
    typingMs: GENEROUS_TYPING_MS,
    ...rest,
  };
}

/**
 * Runs one complete mining attempt and returns the RAW response, so a case can
 * assert on a refusal status as easily as on a PASS.
 *
 * @param {string} baseUrl Server root.
 * @param {Object} params
 * @param {string} params.sessionId Session id.
 * @param {string} params.user User address.
 * @param {string} [params.missionId] Mission.
 * @param {Array<Object>} [params.samples] Telemetry.
 * @param {Object} [params.overrides] Submission-body overrides.
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
async function attempt(baseUrl, { sessionId, user, missionId = MISSION_ID, samples, overrides = {} }) {
  await primeSession(baseUrl, sessionId, user, samples, missionId);
  return postJson(baseUrl, "/api/submit", submission({ sessionId, user, __missionId: missionId, ...overrides }));
}

/**
 * Runs one honest mining attempt and returns the graded body, asserting that it
 * was graded (HTTP 200) rather than refused.
 *
 * @param {string} baseUrl Server root.
 * @param {Object} params See {@link attempt}.
 * @returns {Promise<Object>} The response body.
 */
async function mine(baseUrl, params) {
  const res = await attempt(baseUrl, params);
  assert.equal(res.status, 200, `submit should be graded, not errored: ${res.raw}`);
  return res.body;
}

/**
 * A memory store whose active-miner count is FORCED, so the emission curve can
 * be driven past the 5,000-miner trigger without mining 50,000 missions.
 *
 * A spread copy, not a mutation: `createMemoryStore()` returns an object literal
 * whose methods are own properties, so overriding one leaves every other
 * `STORAGE_METHODS` entry — and all of its own state — intact.
 *
 * @param {number} miners Value `countActiveMiners` reports.
 * @returns {Object} A store implementing the whole storage interface.
 */
function storeWithMinerCount(miners) {
  const store = createMemoryStore();
  return { ...store, countActiveMiners: async () => miners };
}

/* ========================================================================== */
/* 1. THE HAPPY PATH, AT THE PRICED REWARD                                     */
/* ========================================================================== */

test("1. a real PASS is signed at the dynamic + streak adjusted reward, with unitless stamina", async () => {
  const judge = await boot();

  // Day 1: no banked streak and one active miner, so the priced reward is the
  // authored base exactly — the factor is 1.0 and the reward is byte-identical
  // to `mission.reward`.
  const first = await mine(judge.baseUrl, { sessionId: "w-1", user: USER_A });
  assert.equal(first.status, "PASS");
  assert.equal(first.claim.reward, EASY_BASE);
  assert.equal(first.result.reward, EASY_BASE);
  assert.equal(first.economy.streak.daysBeforeCompletion, "0");
  assert.equal(first.economy.dynamicEmission.factorBps, "10000");
  assert.equal(first.economy.season.seasonId, "season-1");

  // Day 2: one day is banked, and the ladder pays 1.0x on a single banked day,
  // so the reward is still the base. The factor only starts moving at TWO
  // banked days — see `STREAK_LADDER_EASY`.
  judge.now.ms += ONE_DAY_MS;
  const second = await mine(judge.baseUrl, { sessionId: "w-2", user: USER_A });
  assert.equal(second.status, "PASS");
  assert.equal(second.economy.streak.daysBeforeCompletion, "1");
  assert.equal(second.economy.streak.factorBps, "10000");
  assert.equal(second.claim.reward, EASY_BASE);

  // Day 3: two banked days, so the streak pays 1.2x — 12 x 1.2 = 14.4 CATT.
  judge.now.ms += ONE_DAY_MS;
  const third = await mine(judge.baseUrl, { sessionId: "w-3", user: USER_A });
  assert.equal(third.status, "PASS");
  assert.equal(third.economy.streak.daysBeforeCompletion, "2");
  assert.equal(third.economy.streak.factorBps, "12000");
  assert.equal(third.economy.streak.applied, true);
  assert.equal(third.claim.reward, "14400000000000000000");
  assert.equal(third.claim.reward, STREAK_LADDER_EASY[2]);
  // The PRICED amount is what was signed, not merely what was reported.
  assert.equal(third.result.reward, third.claim.reward);

  // The stamina cost is the UNITLESS point count: 10, never a CATT amount.
  assert.equal(third.claim.staminaCost, "10");
  assert.equal(third.claim.staminaCost, String(MISSION.staminaCost));

  // And the signed struct is exactly the returned one.
  const digest = backendSigner.claimDigest({
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    claim: third.claim,
  });
  assert.equal(third.digest, digest);
  assert.equal(ethers.recoverAddress(digest, third.signature), backendWallet.address);

  // The ledgers behind the ladder.
  assert.deepEqual(await judge.store.getStreak({ userAddress: USER_A }), {
    userAddress: USER_A.toLowerCase(),
    current: 3,
    lastGradedDay: content.dayKeyFor(DAY_0_MS + 2 * ONE_DAY_MS),
  });
  assert.equal(await judge.store.countActiveMiners({ dayKey: content.dayKeyFor(DAY_0_MS + 2 * ONE_DAY_MS) }), 1);

  await closeAllServers();
});

/* ========================================================================== */
/* 2. DYNAMIC EMISSION, LIVE OVER HTTP                                        */
/* ========================================================================== */

test("2. dynamic emission is live: strictly below the flat base above 5,000 miners, exactly the flat base at or below it", async () => {
  // AT the floor of the ramp: emission has decayed to 50% and stops there.
  const busy = await boot({ store: storeWithMinerCount(Number(economics.DYNAMIC_EMISSION_FLOOR_MINERS)) });
  const decayed = await mine(busy.baseUrl, { sessionId: "dyn-busy", user: USER_A });
  assert.equal(decayed.status, "PASS");
  assert.equal(decayed.economy.dynamicEmission.activeMiners, economics.DYNAMIC_EMISSION_FLOOR_MINERS.toString());
  assert.equal(decayed.economy.dynamicEmission.factorBps, economics.DYNAMIC_EMISSION_FLOOR_BPS.toString());
  assert.equal(decayed.economy.dynamicEmission.applied, true);
  assert.equal(decayed.claim.reward, EASY_FLOOR_REWARD);
  assert.equal(decayed.claim.reward, "6000000000000000000");
  assert.ok(
    BigInt(decayed.claim.reward) < BigInt(EASY_BASE),
    `reward ${decayed.claim.reward} must be strictly below the flat base ${EASY_BASE}`
  );
  assert.ok(!decayed.claim.reward.includes("e"), "the decayed reward is a plain decimal string");
  await closeAllServers();

  // The same 50% floor for the HARD mission: 40 CATT -> 20 CATT.
  const busyHard = await boot({ store: storeWithMinerCount(Number(economics.DYNAMIC_EMISSION_FLOOR_MINERS)) });
  const hard = await mine(busyHard.baseUrl, {
    sessionId: "dyn-hard",
    user: USER_A,
    missionId: "mission-3",
    samples: humanTelemetry(25, 1_760_000_900_000),
  });
  assert.equal(hard.claim.reward, HARD_FLOOR_REWARD);
  assert.equal(hard.claim.reward, "20000000000000000000");
  assert.ok(BigInt(hard.claim.reward) < BigInt(HARD_BASE));
  await closeAllServers();

  // MID-RAMP, so the curve is proved to be the LINEAR ramp and not a two-state
  // switch: 27,500 miners is the exact halfway point of 5,000..50,000, so the
  // factor is (10000 + 5000) / 2 = 7500 bps = 0.75x.
  const midway = await boot({ store: storeWithMinerCount(27500) });
  const half = await mine(midway.baseUrl, { sessionId: "dyn-mid", user: USER_A });
  assert.equal(half.economy.dynamicEmission.factorBps, "7500");
  assert.equal(half.claim.reward, "9000000000000000000", "12 CATT at 0.75x");
  assert.ok(BigInt(half.claim.reward) < BigInt(EASY_BASE));
  await closeAllServers();

  // AT the trigger: the factor is exactly 1.0 and every mission pays its exact
  // authored base string. This is the early-adopter end of the curve, and it is
  // three different wallets so the 50-point daily spend cap is not what is
  // being measured.
  const calm = await boot({ store: storeWithMinerCount(5000) });
  for (const [missionId, user, expectedBase, expectedCost, startTs] of [
    [MISSION_ID, USER_A, EASY_BASE, "10", 1_760_000_000_000],
    ["mission-2", USER_B, MEDIUM_BASE, "20", 1_760_000_100_000],
    ["mission-3", USER_C, HARD_BASE, "30", 1_760_000_200_000],
  ]) {
    const flat = await mine(calm.baseUrl, { sessionId: `dyn-flat-${missionId}`, user, missionId, samples: humanTelemetry(25, startTs) });
    assert.equal(flat.status, "PASS");
    assert.equal(flat.economy.dynamicEmission.activeMiners, "5000");
    assert.equal(flat.economy.dynamicEmission.factorBps, "10000");
    assert.equal(flat.economy.dynamicEmission.applied, false);
    assert.equal(flat.claim.reward, expectedBase, `${missionId} must pay its exact authored base string`);
    assert.equal(flat.claim.staminaCost, expectedCost);
  }
  await closeAllServers();
});

/* ========================================================================== */
/* 3. THE STREAK LADDER, DAY BY DAY                                           */
/* ========================================================================== */

test("3. the streak ladder rises day1 -> day7, CLAMPS at 2.0, and resets to 1.0 on a missed day", async () => {
  const judge = await boot();

  for (let day = 0; day < STREAK_LADDER_EASY.length; day += 1) {
    const body = await mine(judge.baseUrl, { sessionId: `ladder-${day}`, user: USER_A });
    assert.equal(body.status, "PASS", `day ${day + 1} should pass`);
    assert.equal(body.economy.streak.daysBeforeCompletion, String(day), `day ${day + 1} reads ${day} banked days`);
    assert.equal(body.claim.reward, STREAK_LADDER_EASY[day], `day ${day + 1} reward`);
    // One UTC day per rung. Without this the whole ladder would be walked inside
    // ONE dayKey, and the anti-farming rule would (correctly) freeze it at 1.0x.
    judge.now.ms += ONE_DAY_MS;
  }

  // THE CAP IS FIRST PAID ON GRADED DAY 7, and clamped thereafter. This is the
  // documented discrepancy between "cap 2.0x" and "+0.2/day starting at day 1":
  // the module's own constant counts BANKED days (six of them), while the k-th
  // graded day reads `k - 1`, so the top rung is one day later than the
  // constant's name suggests.
  assert.equal(economics.STREAK_CAP_FIRST_REACHED_DAY, 6n, "six BANKED days is the first rung at the cap");
  assert.equal(STREAK_LADDER_EASY[5], "21600000000000000000", "graded day 6 is still 1.8x");
  assert.equal(STREAK_LADDER_EASY[6], "24000000000000000000", "graded day 7 is the 2.0x cap");
  assert.equal(STREAK_LADDER_EASY[7], STREAK_LADDER_EASY[6], "graded day 8 must be clamped, not 2.2x");
  assert.ok(BigInt(STREAK_LADDER_EASY[6]) === BigInt(EASY_BASE) * 2n, "the cap is exactly 2.0x of the base");
  assert.equal((await judge.store.getStreak({ userAddress: USER_A })).current, 8);

  // A MISSED DAY: two rungs of the loop above are followed by a two-day jump, so
  // a whole UTC day passes with nothing graded. The ladder resets.
  judge.now.ms += 2 * ONE_DAY_MS;
  const afterGap = await mine(judge.baseUrl, { sessionId: "ladder-gap", user: USER_A });
  assert.equal(afterGap.status, "PASS");
  assert.equal(
    afterGap.economy.streak.daysBeforeCompletion,
    "0",
    "a missed day must reset the ladder to its base rather than continue it"
  );
  assert.equal(afterGap.claim.reward, EASY_BASE);
  assert.equal(afterGap.claim.reward, STREAK_LADDER_EASY[0]);

  await closeAllServers();
});

/* ========================================================================== */
/* 4. NO FREE STREAK FARMING                                                   */
/* ========================================================================== */

test("4. two graded PASSes on one day neither raise the factor nor change the reward, and a FAIL moves no streak", async () => {
  const judge = await boot();
  const dayOneKey = content.dayKeyFor(DAY_0_MS);

  const first = await mine(judge.baseUrl, { sessionId: "farm-1", user: USER_A });
  assert.equal(first.claim.reward, EASY_BASE);

  const second = await mine(judge.baseUrl, { sessionId: "farm-2", user: USER_A });
  assert.equal(second.status, "PASS");
  // The store's row counts 1 consecutive graded day ENDING TODAY, so the days
  // banked BEFORE today are 0. Reading the raw row would price the day's second
  // mission on 1 banked day while its first was priced on 0 — a free, repeatable
  // intra-day escalation. Both must read the same number and pay the same.
  assert.equal(
    second.economy.streak.daysBeforeCompletion,
    "0",
    "a same-day second mission has no extra banked day to price itself on"
  );
  assert.equal(first.economy.streak.daysBeforeCompletion, "0");
  assert.equal(second.economy.streak.factorBps, "10000", "a 1.0x streak — no bonus");
  assert.equal(second.claim.reward, first.claim.reward, "two missions in one UTC day must pay the same reward");

  // The ledger agrees: one calendar day is one streak day, however many
  // missions were cleared in it.
  const streak = await judge.store.getStreak({ userAddress: USER_A });
  assert.equal(streak.current, 1);
  assert.equal(streak.lastGradedDay, dayOneKey);
  assert.equal(
    await judge.store.countActiveMiners({ dayKey: dayOneKey }),
    1,
    "one user clearing two missions is ONE active miner"
  );

  // A FAIL on day 2 must touch neither the streak nor the active-miner ledger.
  judge.now.ms += ONE_DAY_MS;
  const dayTwoKey = content.dayKeyFor(DAY_0_MS + ONE_DAY_MS);
  const minersBefore = await judge.store.countActiveMiners({ dayKey: dayTwoKey });

  const failed = await mine(judge.baseUrl, {
    sessionId: "farm-fail",
    user: USER_A,
    overrides: {
      answers: ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: (q.correctIndex + 1) % q.options.length })),
    },
  });
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.result.reward, 0);
  assert.equal("claim" in failed, false);
  assert.equal("economy" in failed, false, "a FAIL is never priced");
  // The two PASSes above took nonces 1 and 2, so the FAIL must leave 3 unissued.
  assert.equal(await judge.store.isNonceUsed(USER_A, 1), true, "the first PASS took nonce 1");
  assert.equal(await judge.store.isNonceUsed(USER_A, 2), true, "the second PASS took nonce 2");
  assert.equal(await judge.store.isNonceUsed(USER_A, 3), false, "a FAIL burns no nonce");

  const afterFail = await judge.store.getStreak({ userAddress: USER_A });
  assert.equal(afterFail.current, 1, "a FAIL must not advance the streak");
  assert.equal(afterFail.lastGradedDay, dayOneKey, "and must not move the graded day");
  assert.equal(
    await judge.store.countActiveMiners({ dayKey: dayTwoKey }),
    minersBefore,
    "a FAIL must not count its author as an active miner"
  );

  // Which is observable in the payout: day 2's PASS pays 1.2x off a streak of
  // ONE. Had the FAIL advanced the ledger, this would read 1.4x / 16.8 CATT.
  const dayTwo = await mine(judge.baseUrl, { sessionId: "farm-3", user: USER_A });
  assert.equal(dayTwo.economy.streak.daysBeforeCompletion, "1");
  assert.equal(dayTwo.claim.reward, STREAK_LADDER_EASY[1]);
  assert.notEqual(dayTwo.claim.reward, STREAK_LADDER_EASY[2]);

  await closeAllServers();
});

/* ========================================================================== */
/* 5. THE SEASON POOL IS A HARD CAP                                           */
/* ========================================================================== */

test("5. an exhausted season fails loudly: no signature, no nonce burned, no allocation minted, and mining resumes next season", async () => {
  const judge = await boot();

  // Make sure the twenty-season schedule really is on disk, then fill season-1
  // to EXACTLY its 2,000,000 CATT allocation. The filler is not a user of this
  // Judge: it stands in for the season having already been mined out by
  // history, which is exactly the state an exhausted season is in.
  await seasons.ensureSeasons(judge.store, { epoch: BOOT_SECONDS });
  const season = await judge.store.getSeason("season-1");
  assert.ok(season, "the boot must have written season-1");
  assert.equal(season.allocation, seasons.SEASON_ALLOCATION);
  assert.equal(season.allocation, "2000000000000000000000000");

  await judge.store.recordSeasonClaim({ seasonId: "season-1", userAddress: FILLER, amount: season.allocation, nonce: "1" });
  const claimedBefore = await judge.store.getSeasonClaimedTotal("season-1");
  assert.equal(claimedBefore, seasons.SEASON_ALLOCATION);

  // The claim that would tip the pool past its cap.
  const refused = await attempt(judge.baseUrl, { sessionId: "season-x", user: USER_A });

  // LOUD, with a clear, stable code.
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, ERRORS.SEASON_ALLOCATION_EXHAUSTED);
  assert.equal(refused.body.error, "SEASON_ALLOCATION_EXHAUSTED");

  // NOTHING was minted, signed or reserved.
  assert.equal("claim" in refused.body, false);
  assert.equal("signature" in refused.body, false);
  assert.equal("digest" in refused.body, false);
  assert.equal("signer" in refused.body, false);
  assert.equal(await judge.store.isNonceUsed(USER_A, 1), false, "an exhausted season must burn NO nonce");
  assert.equal(await judge.store.getIssuedClaim(USER_A, 1), undefined);
  assert.equal(await judge.store.getSeasonClaimedTotal("season-1"), claimedBefore, "the season total must not move");
  assert.deepEqual(await judge.store.getStreak({ userAddress: USER_A }), {
    userAddress: USER_A.toLowerCase(),
    current: 0,
    lastGradedDay: null,
  });

  // The season's own view of the pool.
  const pool = await seasons.remainingForSeason(judge.store, "season-1");
  assert.equal(pool.exhausted, true);
  assert.equal(pool.remaining, "0");

  // Mining for that season STOPS. Twelve further attempts, all refused by the
  // same code, none of them consuming anything.
  for (let index = 0; index < 12; index += 1) {
    const again = await attempt(judge.baseUrl, { sessionId: `season-x-${index}`, user: USER_B });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, ERRORS.SEASON_ALLOCATION_EXHAUSTED);
  }
  assert.equal(await judge.store.isNonceUsed(USER_B, 1), false);

  // The NEXT SEASON opens on its own schedule with a fresh 2,000,000 pool, and
  // the very next claim is signed — with nonce 1, which is the proof that
  // nothing at all was consumed by the thirteen refusals above.
  judge.now.ms = DAY_0_MS + 31 * ONE_DAY_MS;
  const recovered = await mine(judge.baseUrl, { sessionId: "season-2", user: USER_A });
  assert.equal(recovered.status, "PASS");
  assert.equal(recovered.economy.season.seasonId, "season-2");
  assert.equal(recovered.claim.nonce, "1", "the first nonce this user ever receives is still 1");
  assert.equal(recovered.claim.reward, EASY_BASE);
  assert.ok(recovered.signature, "the recovered season signs normally");

  await closeAllServers();
});

test("5b. before the configured epoch there is NO active season, and no fallback one", async () => {
  // The wired `SEASON_EPOCH` when the flag is unset is the boot instant. Set
  // explicitly, the founder's documented default of 0 is fully live: the whole
  // schedule lands in 1970 and every later instant has no season at all.
  const judge = await boot({ env: { CATT_SEASON_EPOCH: "0" } });

  const refused = await attempt(judge.baseUrl, { sessionId: "pre-epoch", user: USER_A });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, ERRORS.SEASON_NO_ACTIVE_SEASON);
  assert.equal("claim" in refused.body, false);
  assert.equal("signature" in refused.body, false);
  assert.equal(await judge.store.isNonceUsed(USER_A, 1), false, "no nonce is burned before the epoch");

  // The schedule really WAS written — it is 1970, not absent. There is
  // deliberately no default season to fall back to.
  const written = await judge.store.getSeason("season-1");
  assert.ok(written, "the 1970 schedule is written, not skipped");
  assert.equal(written.start, 0);
  assert.equal(written.end, 30 * 86_400);

  await closeAllServers();
});

/* ========================================================================== */
/* 6. FREE STAMINA                                                             */
/* ========================================================================== */

test("6. the free grant is 30 points, once per user per day, and does not lift the 50-point daily cap", async () => {
  const judge = await boot();
  const dayKey = content.dayKeyFor(DAY_0_MS);

  const first = await mine(judge.baseUrl, { sessionId: "stam-1", user: USER_A });
  assert.equal(first.status, "PASS");
  assert.equal(first.economy.freeStamina.grantedThisCall, "30");
  assert.equal(first.economy.freeStamina.dayTotal, "30");
  assert.equal((await judge.store.getFreeStaminaGranted({ userAddress: USER_A, dayKey })).granted, "30");

  // A SECOND call the same day grants NOTHING: the day's total stays 30.
  const second = await mine(judge.baseUrl, { sessionId: "stam-2", user: USER_A });
  assert.equal(second.status, "PASS");
  assert.equal(second.economy.freeStamina.grantedThisCall, "0", "the second call of the day grants zero");
  assert.equal(second.economy.freeStamina.dayTotal, "30", "and the day's total never exceeds 30");
  assert.equal(second.economy.freeStamina.remaining, "0");

  // Per USER: a different wallet on the same day gets its own 30.
  const other = await mine(judge.baseUrl, { sessionId: "stam-3", user: USER_B });
  assert.equal(other.economy.freeStamina.dayTotal, "30");
  assert.equal((await judge.store.getFreeStaminaGranted({ userAddress: USER_B, dayKey })).granted, "30");
  assert.equal((await judge.store.getFreeStaminaGranted({ userAddress: USER_C, dayKey })).granted, "0");

  // The signed `staminaCost` is UNTOUCHED by the grant: it is the mission's own
  // point cost — never the grant, never a balance, never a CATT amount.
  assert.equal(first.claim.staminaCost, "10");
  assert.equal(second.claim.staminaCost, "10");
  assert.equal(other.claim.staminaCost, "10");

  // THE SPEND CAP IS STILL 50 PER DAY. The grant buys access to the day's first
  // missions; it does not buy a way past the day's ceiling. Three users now hold
  // 30 free points each, and USER_A's sixth EASY mission of the day is refused.
  assert.equal(staminaAllowance.FREE_STAMINA_PER_DAY, 30n);
  assert.equal(content.DEFAULT_DAILY_STAMINA_CAP, 50);
  for (let index = 3; index <= 5; index += 1) {
    const ok = await mine(judge.baseUrl, { sessionId: `stam-a-${index}`, user: USER_A });
    assert.equal(ok.status, "PASS", `mission ${index} of the day fits under the cap`);
    assert.equal(Number(ok.economy.staminaSpend.consumedAfter), index * 10);
  }
  assert.equal((await judge.store.getStaminaConsumed({ userAddress: USER_A, dayKey })).consumed, "50", "exactly the cap");

  const overCap = await attempt(judge.baseUrl, { sessionId: "stam-6", user: USER_A });
  assert.equal(overCap.status, 429);
  assert.equal(overCap.body.error, ERRORS.DAILY_STAMINA_CAP_EXCEEDED);
  assert.equal("claim" in overCap.body, false);
  assert.equal("signature" in overCap.body, false);
  assert.equal(await judge.store.isNonceUsed(USER_A, 6), false, "a throttled claim burns no nonce");
  assert.equal((await judge.store.getStaminaConsumed({ userAddress: USER_A, dayKey })).consumed, "50");
  assert.equal(
    (await judge.store.getFreeStaminaGranted({ userAddress: USER_A, dayKey })).granted,
    "30",
    "the grant is a per-day allowance, not a per-mission one"
  );

  // The next UTC day resets the SPEND ledger and re-grants the day's 30 from
  // scratch — the ledger is keyed (user, day), so day 2 starts at 30, not 60.
  judge.now.ms += ONE_DAY_MS;
  const dayTwoKey = content.dayKeyFor(DAY_0_MS + ONE_DAY_MS);
  const nextDay = await mine(judge.baseUrl, { sessionId: "stam-7", user: USER_A });
  assert.equal(nextDay.status, "PASS");
  assert.equal(nextDay.economy.freeStamina.dayKey, dayTwoKey);
  assert.equal(nextDay.economy.freeStamina.grantedThisCall, "30");
  assert.equal(nextDay.economy.freeStamina.dayTotal, "30");
  assert.equal((await judge.store.getStaminaConsumed({ userAddress: USER_A, dayKey: dayTwoKey })).consumed, "10");

  await closeAllServers();
});

/* ========================================================================== */
/* 7. THE CONFIG PARSE IS INVERTED                                            */
/* ========================================================================== */

test("7. only an explicit false/0/off disables a mechanism; unset, empty and garbage leave it ON", async () => {
  /* --- dynamic emission, at 50,000 miners so the mechanism is observable --- */
  const busyStore = () => storeWithMinerCount(Number(economics.DYNAMIC_EMISSION_FLOOR_MINERS));

  // ONLY the three literals named by the founder's rule disable a mechanism.
  // `"0.0"`, `"-0"` and `" 0 "`-style near-misses are NOT one of them: the rule
  // is an allow-list of exact literals, not a numeric falsiness test.
  for (const raw of ["false", "FALSE", " off ", "0", "Off", "OFF"]) {
    const judge = await boot({ store: busyStore(), env: { CATT_DYNAMIC_EMISSION: raw } });
    const body = await mine(judge.baseUrl, { sessionId: `off-${raw.trim()}`, user: USER_A });
    assert.equal(body.status, "PASS");
    assert.equal(body.economy.dynamicEmission.enabled, false, `${JSON.stringify(raw)} must disable it`);
    assert.equal(body.claim.reward, EASY_BASE, `${JSON.stringify(raw)} must restore the flat base`);
    await closeAllServers();
  }

  for (const raw of [undefined, "", "   ", "banana", "yes", "1", "true", "TRUE", "enabled", "null", "no", "-1", "0.0", "off!", "falsey"]) {
    const judge = await boot({ store: busyStore(), env: { CATT_DYNAMIC_EMISSION: raw } });
    const body = await mine(judge.baseUrl, { sessionId: `on-${JSON.stringify(raw)}`, user: USER_A });
    assert.equal(body.status, "PASS");
    assert.equal(
      body.economy.dynamicEmission.enabled,
      true,
      `${JSON.stringify(raw)} must leave the AGGRESSIVE behaviour on`
    );
    assert.equal(
      body.claim.reward,
      EASY_FLOOR_REWARD,
      `${JSON.stringify(raw)} must leave emission decaying, not silently restored to flat`
    );
    await closeAllServers();
  }

  /* --- the streak, on day 2 of a ladder --- */
  for (const raw of ["false", "0", "off"]) {
    const judge = await boot({ env: { CATT_STREAK_MULTIPLIER: raw } });
    await mine(judge.baseUrl, { sessionId: `streak-off-a-${raw}`, user: USER_A });
    judge.now.ms += ONE_DAY_MS;
    const body = await mine(judge.baseUrl, { sessionId: `streak-off-b-${raw}`, user: USER_A });
    assert.equal(body.economy.streak.enabled, false, `${JSON.stringify(raw)} must disable the streak`);
    assert.equal(body.economy.streak.daysBeforeCompletion, "0", "a disabled streak is never read");
    assert.equal(body.claim.reward, EASY_BASE, `${JSON.stringify(raw)} must pay the flat base on day 2`);
    // The LEDGER still advances: the store counts days and the flag only decides
    // what counting is worth, so re-enabling the flag pays the real ladder.
    assert.equal((await judge.store.getStreak({ userAddress: USER_A })).current, 2);
    await closeAllServers();
  }

  for (const raw of [undefined, "", "   ", "banana", "yes", "1", "true"]) {
    const judge = await boot({ env: { CATT_STREAK_MULTIPLIER: raw } });
    await mine(judge.baseUrl, { sessionId: `streak-on-a-${String(raw)}`, user: USER_A });
    judge.now.ms += ONE_DAY_MS;
    const body = await mine(judge.baseUrl, { sessionId: `streak-on-b-${String(raw)}`, user: USER_A });
    assert.equal(body.economy.streak.enabled, true, `${JSON.stringify(raw)} must leave the streak ON`);
    assert.equal(body.claim.reward, STREAK_LADDER_EASY[1], `${JSON.stringify(raw)} must pay the 1.2x ladder`);
    await closeAllServers();
  }

  /* --- free stamina --- */
  const noGrant = await boot({ env: { CATT_FREE_STAMINA: "off" } });
  const dayKey = content.dayKeyFor(DAY_0_MS);
  await mine(noGrant.baseUrl, { sessionId: "no-grant", user: USER_A });
  assert.equal((await noGrant.store.getFreeStaminaGranted({ userAddress: USER_A, dayKey })).granted, "0");
  await closeAllServers();

  const garbageGrant = await boot({ env: { CATT_FREE_STAMINA: "wibble" } });
  await mine(garbageGrant.baseUrl, { sessionId: "garbage-grant", user: USER_A });
  assert.equal(
    (await garbageGrant.store.getFreeStaminaGranted({ userAddress: USER_A, dayKey })).granted,
    "30",
    "a garbage value must leave the grant ON"
  );
  await closeAllServers();

  /* --- seasons --- */
  const seasonless = await boot({ env: { CATT_SEASONS: "0" } });
  const unconstrained = await mine(seasonless.baseUrl, { sessionId: "no-seasons", user: USER_A });
  assert.equal(unconstrained.status, "PASS");
  assert.equal(unconstrained.economy.season.enabled, false);
  assert.equal(unconstrained.claim.reward, EASY_BASE);
  assert.equal(
    await seasonless.store.getSeason("season-1"),
    undefined,
    "with seasons off, no schedule is written at all"
  );
  await closeAllServers();

  /* --- a garbage numeric flag falls back to the founder's default --- */
  const garbageFloor = await boot({
    store: busyStore(),
    env: { CATT_DYNAMIC_EMISSION_FLOOR_MINERS: "not-a-number" },
  });
  const floored = await mine(garbageFloor.baseUrl, { sessionId: "garbage-floor", user: USER_A });
  assert.equal(floored.economy.dynamicEmission.floorMiners, "50000");
  assert.equal(floored.claim.reward, EASY_FLOOR_REWARD);
  await closeAllServers();

  /* --- and `process.env` IS the default source, not merely an injected object */
  const previous = process.env.CATT_STREAK_MULTIPLIER;
  process.env.CATT_STREAK_MULTIPLIER = "false";
  try {
    const app = createApp({
      store: createMemoryStore(),
      logger: quietLogger(),
      chainId: CHAIN_ID,
      verifyingContract: VERIFYING_CONTRACT,
      privateKey: backendWallet.privateKey,
      clock: () => DAY_0_MS,
      // NOTE: no `env`, so the Judge reads `process.env` exactly as it does in
      // production (`startServer` never passes one).
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    liveServers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const body = await mine(baseUrl, { sessionId: "pe-1", user: USER_A });
    assert.equal(body.economy.streak.enabled, false, "process.env must be the default flag source");
    assert.equal(body.claim.reward, EASY_BASE);
    assert.ok(body.signature, "the process.env path still signs");
  } finally {
    if (previous === undefined) delete process.env.CATT_STREAK_MULTIPLIER;
    else process.env.CATT_STREAK_MULTIPLIER = previous;
  }

  await closeAllServers();
});

/* ========================================================================== */
/* 8. THE FROZEN EXPORTS ARE NOT MUTATED                                      */
/* ========================================================================== */

test("8. the wired path mutates none of the frozen economic exports", async () => {
  const before = {
    trigger: economics.DYNAMIC_EMISSION_TRIGGER_MINERS,
    floorMiners: economics.DYNAMIC_EMISSION_FLOOR_MINERS,
    floorBps: economics.DYNAMIC_EMISSION_FLOOR_BPS,
    capDay: economics.STREAK_CAP_FIRST_REACHED_DAY,
    baseBps: economics.STREAK_BASE_BPS,
    stepBps: economics.STREAK_STEP_BPS,
    maxBps: economics.STREAK_MAX_BPS,
    seasonCount: seasons.SEASON_COUNT,
    seasonDurationDays: seasons.SEASON_DURATION_DAYS,
    seasonAllocation: seasons.SEASON_ALLOCATION,
    seasonEpoch: seasons.SEASON_EPOCH,
    seasonIds: seasons.SEASON_IDS.join(","),
    totalDays: seasons.TOTAL_SEASON_DAYS,
    headroom: seasons.TOTAL_HEADROOM_CATT,
    freeStamina: staminaAllowance.FREE_STAMINA_PER_DAY,
    spendCap: staminaAllowance.DAILY_SPEND_CAP_POINTS,
    dailyCap: content.DEFAULT_DAILY_STAMINA_CAP,
    missions: content.listMissions().map((m) => `${m.id}:${m.reward}:${m.staminaCost}`).join(","),
    schedule: JSON.stringify(seasons.buildSeasonSchedule({ epoch: BOOT_SECONDS })),
  };

  // Exercise every mechanism at once: decay, streak, seasons, free stamina.
  const judge = await boot({ store: storeWithMinerCount(27500) });
  for (let day = 0; day < 3; day += 1) {
    await mine(judge.baseUrl, { sessionId: `frozen-${day}`, user: USER_A });
    judge.now.ms += ONE_DAY_MS;
  }
  await closeAllServers();

  assert.equal(economics.DYNAMIC_EMISSION_TRIGGER_MINERS, before.trigger);
  assert.equal(economics.DYNAMIC_EMISSION_FLOOR_MINERS, before.floorMiners);
  assert.equal(economics.DYNAMIC_EMISSION_FLOOR_BPS, before.floorBps);
  assert.equal(economics.STREAK_CAP_FIRST_REACHED_DAY, before.capDay);
  assert.equal(economics.STREAK_BASE_BPS, before.baseBps);
  assert.equal(economics.STREAK_STEP_BPS, before.stepBps);
  assert.equal(economics.STREAK_MAX_BPS, before.maxBps);
  assert.equal(seasons.SEASON_COUNT, before.seasonCount);
  assert.equal(seasons.SEASON_DURATION_DAYS, before.seasonDurationDays);
  assert.equal(seasons.SEASON_ALLOCATION, before.seasonAllocation);
  assert.equal(seasons.SEASON_EPOCH, before.seasonEpoch);
  assert.equal(seasons.SEASON_IDS.join(","), before.seasonIds);
  assert.equal(seasons.TOTAL_SEASON_DAYS, before.totalDays);
  assert.equal(seasons.TOTAL_HEADROOM_CATT, before.headroom);
  assert.equal(staminaAllowance.FREE_STAMINA_PER_DAY, before.freeStamina);
  assert.equal(staminaAllowance.DAILY_SPEND_CAP_POINTS, before.spendCap);
  assert.equal(content.DEFAULT_DAILY_STAMINA_CAP, before.dailyCap);
  assert.equal(
    content.listMissions().map((m) => `${m.id}:${m.reward}:${m.staminaCost}`).join(","),
    before.missions,
    "the Judge must never rewrite the authored bounty board"
  );

  // The founder's identities, unchanged and still exact.
  assert.equal(economics.DYNAMIC_EMISSION_TRIGGER_MINERS, 5000n);
  assert.equal(economics.DYNAMIC_EMISSION_FLOOR_BPS, 5000n);
  assert.equal(seasons.SEASON_COUNT, 20);
  assert.equal(seasons.SEASON_DURATION_DAYS, 30);
  assert.equal(seasons.SEASON_ALLOCATION, "2000000000000000000000000");
  assert.equal(seasons.SEASON_ALLOCATION.length, 25);
  assert.equal(seasons.TOTAL_SEASON_DAYS, 600);
  assert.equal(seasons.TOTAL_HEADROOM_CATT, 40_000_000n);
  assert.equal(staminaAllowance.FREE_STAMINA_PER_DAY, 30n);

  // The twenty-season schedule is byte-identical before and after, contiguous,
  // and the store the wired Judge wrote agrees with the pure planner.
  assert.equal(JSON.stringify(seasons.buildSeasonSchedule({ epoch: BOOT_SECONDS })), before.schedule);
  const schedule = seasons.buildSeasonSchedule({ epoch: BOOT_SECONDS });
  assert.equal(schedule.length, 20);
  assert.equal(schedule[0].start, BOOT_SECONDS);
  assert.equal(schedule[19].end, BOOT_SECONDS + 600 * 86_400);
  for (let index = 1; index < schedule.length; index += 1) {
    assert.equal(schedule[index].start, schedule[index - 1].end, "season windows must be contiguous, not overlapping");
    assert.equal(schedule[index].allocation, seasons.SEASON_ALLOCATION);
  }
  const stored = await judge.store.getSeason("season-20");
  assert.equal(stored.allocation, seasons.SEASON_ALLOCATION);
  assert.equal(stored.claimMode, seasons.CLAIM_MODE_DAILY);
  assert.equal(stored.start, BOOT_SECONDS + 19 * 30 * 86_400);
});

/* ========================================================================== */
/* 9. REGRESSION THROUGH THE WIRED PATH                                        */
/* ========================================================================== */

test("9. anti-cheat, syndicate, telemetry and nonce behaviour all still hold through the wired path", async () => {
  const judge = await boot();

  /* --- a wrong quiz FAILs, and now also mints nothing and moves no ledger --- */
  await primeSession(judge.baseUrl, "reg-1", USER_A);
  const wrong = await postJson(judge.baseUrl, "/api/submit", {
    ...submission({ sessionId: "reg-1", user: USER_A }),
    answers: ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: (q.correctIndex + 1) % q.options.length })),
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.status, "FAIL");
  assert.equal(wrong.body.result.reward, 0);
  assert.ok(wrong.body.result.flags.includes(anticheat.SUBMISSION_FLAGS.QUIZ_INCORRECT));
  assert.equal("claim" in wrong.body, false);
  assert.equal("signature" in wrong.body, false);
  assert.equal("economy" in wrong.body, false, "a FAIL is never priced");
  assert.equal(await judge.store.isNonceUsed(USER_A, 1), false, "a FAIL burns no nonce");
  assert.deepEqual(await judge.store.getStreak({ userAddress: USER_A }), {
    userAddress: USER_A.toLowerCase(),
    current: 0,
    lastGradedDay: null,
  });
  assert.equal(
    (await judge.store.getStaminaConsumed({ userAddress: USER_A, dayKey: content.dayKeyFor(DAY_0_MS) })).consumed,
    "0",
    "a FAIL spends no stamina"
  );

  /* --- emulator telemetry still FAILs a perfect quiz --- */
  const emulated = await mine(judge.baseUrl, { sessionId: "reg-2", user: USER_A, samples: emulatorTelemetry() });
  assert.equal(emulated.status, "FAIL");
  assert.ok(emulated.telemetry.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE));
  assert.equal("claim" in emulated, false);
  assert.equal(await judge.store.isNonceUsed(USER_A, 1), false);

  /* --- a syndicate hit still overrides a perfect quiz --- */
  const copied =
    "Attention lapses because the mid reading switch cost is rarely recovered " +
    "and because unplanned interruptions reopen the task every single time";
  assert.ok(anticheat.similarity(copied, copied) > anticheat.SYNDICATE_SIMILARITY_THRESHOLD);
  const leader = await mine(judge.baseUrl, { sessionId: "reg-3", user: USER_A, overrides: { freeText: copied } });
  assert.equal(leader.status, "PASS", "the original author is still paid");
  const ring = await mine(judge.baseUrl, { sessionId: "reg-4", user: USER_B, overrides: { freeText: copied } });
  assert.equal(ring.status, "FAIL");
  assert.equal(ring.syndicate.syndicate, true);
  assert.equal(ring.result.reward, 0);
  assert.equal(await judge.store.isNonceUsed(USER_B, 1), false, "a syndicated FAIL burns no nonce");

  /* --- nonces still start at 1, are per user, and strictly increase --- */
  const pass1 = await mine(judge.baseUrl, { sessionId: "reg-5", user: USER_A });
  assert.equal(pass1.claim.nonce, "2", "the two FAILs above consumed nothing, and reg-3 took nonce 1");
  const pass2 = await mine(judge.baseUrl, { sessionId: "reg-6", user: USER_C });
  assert.equal(pass2.claim.nonce, "1", "nonces are per user");

  await closeAllServers();
});

test("9b. the gasless relay still broadcasts exactly the wired, signed claim", async () => {
  const relayer = ethers.Wallet.createRandom();
  const sent = [];
  const relayService = {
    isConfigured: () => true,
    relayerAddress: () => relayer.address,
    getRelayerAddress: async () => relayer.address,
    getExpectedSigner: async () => backendWallet.address,
    validateClaimPayload: (payload) =>
      relayModule.validateClaimPayload({ ...payload, chainId: CHAIN_ID, claimerAddress: VERIFYING_CONTRACT }),
    submitClaim: async (args) => {
      sent.push(args);
      return { txHash: FAKE_TX_HASH, status: 1 };
    },
  };

  // `Date.now()` and not the ladder's DAY_0: `/api/relay` deliberately compares the
  // signed deadline against the REAL wall clock, so a claim stamped in January
  // 2026 would be refused as `RELAY_CLAIM_EXPIRED` before the relay was ever
  // consulted. The claim under test is still the one the wired Judge signed.
  const judge = await boot({ relayService, now: Date.now() });
  const judged = await mine(judge.baseUrl, { sessionId: "relay-1", user: USER_A });
  assert.equal(judged.status, "PASS");

  const relayed = await postJson(judge.baseUrl, "/api/relay", { ...judged.claim, signature: judged.signature });
  assert.equal(relayed.status, 200);
  assert.equal(relayed.body.txHash, FAKE_TX_HASH);
  assert.equal(sent.length, 1);
  // Exactly the signed struct, in the signed amounts.
  assert.deepEqual(sent[0], {
    user: judged.claim.user,
    reward: judged.claim.reward,
    staminaCost: judged.claim.staminaCost,
    nonce: judged.claim.nonce,
    deadline: judged.claim.deadline,
    signature: judged.signature,
  });
  assert.equal(sent[0].reward, EASY_BASE);
  assert.equal(sent[0].staminaCost, "10");

  // A retried relay of the same nonce is refused, not re-broadcast.
  const retry = await postJson(judge.baseUrl, "/api/relay", { ...judged.claim, signature: judged.signature });
  assert.equal(retry.status, 409);
  assert.deepEqual(retry.body, { error: ERRORS.RELAY_ALREADY_RELAYED });
  assert.equal(sent.length, 1);

  await closeAllServers();
});
