/**
 * CATT Protocol — Judge HTTP layer tests (PRD 3.2, PRD 6.2 "Mining Loop").
 *
 * No test framework dependency. Node's built-in `node:test` runner plus
 * `node:assert/strict`, the app bound to an ephemeral port via `listen(0)`,
 * and the global `fetch` to drive it. Every server is closed in an `after`
 * hook so the process can exit.
 *
 * TEST HYGIENE:
 *   - A FRESH app and a FRESH store per test. The store holds per-user nonce
 *     counters and a cross-user submission log, so sharing one between tests
 *     would make the nonce and syndicate assertions order-dependent.
 *   - A THROWAWAY signing key created with `ethers.Wallet.createRandom()` per
 *     file and passed in through `createApp({ privateKey })`. No key is ever
 *     hardcoded, and nothing is ever placed in `process.env`, so a test can
 *     never accidentally read a real deployment's configuration.
 *   - Mock users are obviously-fake literal addresses. The backend wallet's
 *     address is deliberately NEVER used as a user, so a bug that conflated
 *     "who signed" with "who gets paid" could not pass unnoticed.
 */

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const content = require("../src/content");
const anticheat = require("../src/anticheat");
const signer = require("../signer");
const { createApp, CLAIM_TTL_SECONDS, ERRORS, JUDGE_FLAGS } = require("../src/server");
const { createMemoryStore, STORAGE_METHODS, assertStoreShape } = require("../src/storage");

/* -------------------------------------------------------------------------- */
/* Fixed test configuration                                                    */
/* -------------------------------------------------------------------------- */

/** Throwaway backend signer. Created fresh; never written anywhere persistent. */
const backendWallet = ethers.Wallet.createRandom();

const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

/** Obviously fake users. Valid hex, deterministic, and never the signer. */
const USER_A = "0x" + "11".repeat(20);
const USER_B = "0x" + "22".repeat(20);
const USER_C = "0x" + "33".repeat(20);
const USER_D = "0x" + "44".repeat(20);

/** Generic but non-repeating typing time, comfortably above the anticheat floor. */
const GENEROUS_TYPING_MS = 40_000;

/** Mission/article pair used by the bulk of the suite. */
const MISSION_ID = "mission-1";
const MISSION = content.getMission(MISSION_ID);
const ARTICLE_ID = MISSION.articleId;
const ARTICLE = content.getArticle(ARTICLE_ID);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A realistic HUMAN telemetry stream: the mobile app posts every 5 seconds
 * (PRD 3.1), so 25 samples covers roughly two minutes of reading.
 *
 * Every property an emulator gets wrong is varied on purpose, because
 * `evaluateTelemetry` looks at exactly these things:
 *   - battery temperature DRIFTS monotonically upward with small non-repeating
 *     steps inside 26..34C (a real SoC warms up; it is never identical twice),
 *   - no (x, y) touch pair repeats, because a human thumb jitters,
 *   - scroll deltas vary in magnitude and SIGN across the window, and every
 *     implied velocity stays far below the 4000 px/s plausibility ceiling
 *     (|delta| / 5s is well under 20000 px for these values).
 *
 * Deterministic by construction: the mod arithmetic is chosen so that all 25
 * temperature values and all 25 touch pairs are distinct, which means this
 * fixture never accidentally trips a duplicate-detection flag and the test
 * never becomes flaky.
 *
 * @param {number} [count] Number of samples.
 * @param {number} [startTs] First sample's timestamp, in ms.
 * @returns {Array<{ ts: number, batteryTempC: number, touch: { x: number, y: number }, scrollDelta: number }>}
 */
function humanTelemetry(count = 25, startTs = 1_760_000_000_000) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    // gcd(7, 81) === 1, so 7*i mod 81 is distinct for i in [0, 81): no repeats.
    const batteryTempC = 26 + ((i * 7) % 81) / 10;
    // gcd(37, 260) === 1 and gcd(53, 420) === 1, so pairs never collide here.
    const x = 40 + ((i * 37) % 260);
    const y = 90 + ((i * 53) % 420);
    // Signed, varied, and tiny next to the 20000px-per-5s budget.
    const scrollDelta = [120, -45, 310, -260, 0, 175, -95, 60][i % 8];
    samples.push({
      ts: startTs + i * 5000,
      batteryTempC,
      touch: { x, y },
      scrollDelta,
    });
  }
  return samples;
}

/**
 * A realistic EMULATOR stream: the battery temperature is byte-identical on
 * every sample (a stubbed sensor replaying a canned value) AND the scripted
 * tap replays one fixed coordinate. Both are classic emulator artefacts; the
 * repeated tap is included because a flatline alone lands exactly on the pass
 * threshold (100 - 40 = 60 = TELEMETRY_PASS_SCORE), so a fixture built only
 * from the flatline would be *accepted* by `isTelemetryAcceptable` and would
 * not exercise the failure path this test is about.
 *
 * @param {number} [count] Number of samples.
 * @param {number} [startTs] First sample's timestamp, in ms.
 * @returns {Array<Object>} Emulator-shaped samples.
 */
function emulatorTelemetry(count = 25, startTs = 1_760_000_000_000) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: startTs + i * 5000,
      batteryTempC: 31.5,
      touch: { x: 540, y: 960 },
      scrollDelta: 90,
    });
  }
  return samples;
}

/**
 * The correct answer set for an article, in the shape
 * `evaluateSubmission` expects: `[{ questionId, answerIndex }]`.
 *
 * The answer key is read from `content` DIRECTLY inside the test process. It is
 * never fetched over HTTP — which is the point: `GET /api/article/:id` must not
 * carry `correctIndex` or `keySentences`, and if it ever did, this suite would
 * still be checking the right thing because it deliberately does not go
 * through the network for the key.
 *
 * @param {Object} [article] Article to answer; defaults to the shared one.
 * @returns {Array<{ questionId: string, answerIndex: number }>} Correct answers.
 */
function correctAnswers(article = ARTICLE) {
  return article.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex }));
}

/**
 * A highlight string that contains the key sentences, i.e. what a user who
 * actually read the article would produce.
 *
 * @param {Object} [article] Article; defaults to the shared one.
 * @returns {string} Highlight text.
 */
function fullHighlight(article = ARTICLE) {
  return article.highlightTask.keySentences.join(" ");
}

/**
 * A highlight that contains none of the key sentences.
 *
 * @returns {string} Highlight text.
 */
function emptyHighlight() {
  return "this paragraph was about the general topic of attention and reading";
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Servers started by the CURRENT test. Cleared and closed between tests. */
let liveServers = [];
/** The store backing the current test. */
let currentStore;
/** The base URL of the current test's server. */
let baseUrl;

/**
 * Closes every server started so far and forces their keep-alive sockets shut.
 *
 * `server.close()` alone is NOT enough: the global `fetch` (undici) keeps
 * connections alive in a pool, so `close()` waits for them and never resolves,
 * which hangs the runner at exit. `closeAllConnections()` is what actually
 * releases them.
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

/**
 * Records every argument passed to any log method, so a test can prove the
 * private key never reaches a log line.
 *
 * @returns {Object} A logger whose `records` array holds `{ level, args }`.
 */
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

/**
 * Boots a fresh app on an ephemeral port and returns everything a test needs.
 *
 * @param {Object} [options]
 * @param {boolean} [options.withPrivateKey] Pass the throwaway key (default true).
 * @param {Object} [options.store] Override the store (used for fault injection).
 * @param {Object} [options.logger] Override the logger.
 * @returns {Promise<{ baseUrl: string, store: Object, logger: Object }>}
 */
async function boot(options = {}) {
  const logger = options.logger || recordingLogger();
  const store = options.store || createMemoryStore();
  const app = createApp({
    store,
    logger,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    privateKey: options.withPrivateKey === false ? undefined : backendWallet.privateKey,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, store, logger };
}

/** Closes every server this file started, so the process can exit. */
after(async () => {
  await closeAllServers();
});

/**
 * Boot a clean app before each test, so no test can observe another's
 * nonces, telemetry or submissions. Any server the previous test left open is
 * torn down first, so sockets and file descriptors cannot accumulate.
 */
beforeEach(async () => {
  await closeAllServers();
  const booted = await boot();
  currentStore = booted.store;
  baseUrl = booted.baseUrl;
});

/* -------------------------------------------------------------------------- */
/* HTTP helper                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Issues a request and returns both the parsed body and the RAW text.
 * Secret-leak assertions must run against the raw text, because `JSON.parse`
 * normalising the value could hide a substring that is nonetheless present in
 * bytes on the wire.
 *
 * @param {string} path Path relative to the test server.
 * @param {Object} [init] `fetch` init options.
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
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

/**
 * Convenience wrapper for JSON POSTs.
 *
 * @param {string} path Path.
 * @param {Object} payload Body.
 * @returns {Promise<{ status: number, body: any, raw: string }>}
 */
function postJson(path, payload) {
  return http(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Registers a session, streams human telemetry into it, and returns the id.
 *
 * @param {string} sessionId Session id to use.
 * @param {string} user User address.
 * @param {Array<Object>} [samples] Telemetry samples; defaults to the human fixture.
 * @param {string} [missionId] Mission; defaults to `mission-1`.
 * @returns {Promise<string>} The session id.
 */
async function primeSession(sessionId, user, samples = humanTelemetry(), missionId = MISSION_ID) {
  const created = await postJson("/api/session", { sessionId, user, missionId });
  assert.equal(created.status, 201, "session registration should succeed");
  const posted = await postJson("/api/telemetry", { sessionId, samples });
  assert.equal(posted.status, 200, "telemetry post should succeed");
  return sessionId;
}

/**
 * Builds a submission body with correct answers by default.
 *
 * @param {Object} overrides Fields to override.
 * @returns {Object} Submission body.
 */
function submission(overrides = {}) {
  return {
    sessionId: "s-default",
    user: USER_A,
    answers: correctAnswers(),
    highlight: fullHighlight(),
    typingMs: GENEROUS_TYPING_MS,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Storage interface                                                           */
/* -------------------------------------------------------------------------- */

test("storage: the memory store implements the whole STORAGE_METHODS contract", () => {
  assert.ok(Array.isArray(STORAGE_METHODS), "STORAGE_METHODS must be an array");
  assert.ok(Object.isFrozen(STORAGE_METHODS), "STORAGE_METHODS must be frozen");
  for (const name of STORAGE_METHODS) {
    assert.equal(typeof currentStore[name], "function", `missing method: ${name}`);
  }
  // assertStoreShape is what a Postgres adapter must satisfy; prove it fails
  // loudly rather than silently booting a half-implemented store.
  assert.throws(() => assertStoreShape({}), /missing required method/);
});

test("storage: a nonce reserved but never signed is still permanently retired", async () => {
  assert.equal(await currentStore.isNonceUsed(USER_A, 1), false);
  assert.equal(await currentStore.reserveNonce(USER_A), 1);
  assert.equal(await currentStore.isNonceUsed(USER_A, 1), true);
  // Never reissued, even though nothing was signed or recorded for it.
  assert.equal(await currentStore.reserveNonce(USER_A), 2);
  assert.equal(await currentStore.reserveNonce(USER_A), 3);
  // Per-user isolation.
  assert.equal(await currentStore.reserveNonce(USER_B), 1);
});

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

test("GET /api/health returns ok", async () => {
  const res = await http("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

/* -------------------------------------------------------------------------- */
/* Missions — the bounty board                                                 */
/* -------------------------------------------------------------------------- */

test("GET /api/missions returns the 3 missions with only bounty-board fields", async () => {
  const res = await http("/api/missions");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 3);

  const expectedKeys = ["id", "articleId", "difficulty", "reward", "staminaCost"].sort();
  for (const mission of res.body) {
    assert.deepEqual(Object.keys(mission).sort(), expectedKeys, "unexpected field set on the bounty board");
    assert.equal(typeof mission.id, "string");
    assert.equal(typeof mission.articleId, "string");
    assert.ok(["EASY", "MEDIUM", "HARD"].includes(mission.difficulty));
    assert.ok(BigInt(mission.reward) > 0n, "reward must be a positive amount");
    assert.ok(BigInt(mission.staminaCost) > 0n, "staminaCost must be a positive amount");
  }

  // The answer key must not be anywhere in the RAW bytes, not merely absent
  // from the parsed object.
  assert.equal(res.raw.includes("quiz"), false, "raw body leaked the quiz");
  assert.equal(res.raw.includes("correctIndex"), false, "raw body leaked correctIndex");
  assert.equal(res.raw.includes("keySentences"), false, "raw body leaked keySentences");
  for (const mission of res.body) {
    const article = content.getArticle(mission.articleId);
    for (const key of article.highlightTask.keySentences) {
      assert.equal(res.raw.includes(key), false, "raw body leaked a key sentence");
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Article — the randomized reading material                                   */
/* -------------------------------------------------------------------------- */

test("GET /api/article/:id serves a shuffled layout with exactly one focus trap", async () => {
  const res = await http(`/api/article/${ARTICLE_ID}?session=s1`);
  assert.equal(res.status, 200);

  const layout = res.body;
  assert.equal(layout.id, ARTICLE_ID);
  assert.ok(Array.isArray(layout.paragraphs) && layout.paragraphs.length > 1);
  assert.equal(layout.paragraphs.length, ARTICLE.paragraphs.length);

  // Exactly ONE focus trap: an object, not a list, and carrying only the two
  // documented fields.
  assert.equal(Array.isArray(layout.focusTrap), false, "focusTrap must not be a list");
  assert.deepEqual(Object.keys(layout.focusTrap).sort(), ["index", "type"]);
  assert.equal(typeof layout.focusTrap.type, "string");
  assert.ok(Number.isInteger(layout.focusTrap.index));
  assert.ok(
    layout.focusTrap.index >= 0 && layout.focusTrap.index < layout.paragraphs.length,
    `focus trap index ${layout.focusTrap.index} is outside the paragraph array`
  );

  // The highlight answer key must never reach the client.
  assert.equal(res.raw.includes("keySentences"), false, "raw body leaked keySentences");
  assert.equal(res.raw.includes("correctIndex"), false, "raw body leaked correctIndex");
  assert.equal(res.raw.includes("minMatches"), true, "instructions/minMatches metadata should still ship");
});

test("GET /api/article/:id is byte-identical for the same session and permuted across sessions", async () => {
  const a = await http(`/api/article/${ARTICLE_ID}?session=s1`);
  const b = await http(`/api/article/${ARTICLE_ID}?session=s1`);
  assert.equal(a.raw, b.raw, "the same sessionId must produce a byte-identical body");

  // Different sessions must produce different paragraph orders. This asserts
  // "at least one of these pairs differs" rather than "this specific pair
  // differs", so the assertion cannot become flaky for a session pair that
  // happens to shuffle into the same permutation.
  const others = ["s2", "s3", "s4", "s5", "s6", "s7", "s8"];
  const orders = new Map();
  for (const session of ["s1", ...others]) {
    const res = await http(`/api/article/${ARTICLE_ID}?session=${session}`);
    assert.equal(res.status, 200);
    orders.set(session, res.body.paragraphs.join("\u0000"));
  }
  const base = orders.get("s1");
  const differing = others.filter((session) => orders.get(session) !== base);
  assert.ok(
    differing.length > 0,
    "every other session produced the same paragraph order as s1; the randomizer is not random"
  );
});

test("GET /api/article/:id rejects an unknown article and a missing session", async () => {
  const unknown = await http("/api/article/art-does-not-exist?session=s1");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: ERRORS.ARTICLE_NOT_FOUND });

  for (const path of [`/api/article/${ARTICLE_ID}`, `/api/article/${ARTICLE_ID}?session=`, `/api/article/${ARTICLE_ID}?session=%20`]) {
    const res = await http(path);
    assert.equal(res.status, 400, `expected 400 for ${path}`);
    assert.deepEqual(res.body, { error: ERRORS.SESSION_REQUIRED });
  }
});

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                   */
/* -------------------------------------------------------------------------- */

test("POST /api/telemetry appends and returns a live score and flags", async () => {
  const created = await postJson("/api/session", { sessionId: "tel-1", user: USER_A, missionId: MISSION_ID });
  assert.equal(created.status, 201);

  const first = humanTelemetry(12);
  const r1 = await postJson("/api/telemetry", { sessionId: "tel-1", samples: first });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.accepted, 12);
  assert.equal(r1.body.total, 12, "the first batch is the total");
  assert.equal(typeof r1.body.telemetry.score, "number");
  assert.ok(Array.isArray(r1.body.telemetry.flags));
  assert.deepEqual(r1.body.telemetry.flags, [], "human telemetry must raise no flags");
  assert.ok(anticheat.isTelemetryAcceptable(r1.body.telemetry), "human telemetry must be acceptable");

  // APPEND, not replace: the same batch posted again accumulates.
  const r2 = await postJson("/api/telemetry", { sessionId: "tel-1", samples: first });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.accepted, 12);
  assert.equal(r2.body.total, 24, "a second post must append, not replace");

  const view = await http("/api/session/tel-1/telemetry");
  assert.equal(view.status, 200);
  assert.equal(view.body.count, 24);
  assert.equal(view.body.sessionId, "tel-1");
});

test("POST /api/telemetry rejects malformed bodies with 400", async () => {
  const bad = [
    {},
    { sessionId: "", samples: humanTelemetry(3) },
    { sessionId: "x" },
    { sessionId: "x", samples: [] },
    { sessionId: "x", samples: "not-an-array" },
    { sessionId: 42, samples: humanTelemetry(3) },
    { samples: humanTelemetry(3) },
  ];
  for (const payload of bad) {
    const res = await postJson("/api/telemetry", payload);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.deepEqual(res.body, { error: ERRORS.INVALID_TELEMETRY });
  }
});

test("POST /api/session rejects a conflicting re-registration with 409", async () => {
  const first = await postJson("/api/session", { sessionId: "dup", user: USER_A, missionId: MISSION_ID });
  assert.equal(first.status, 201);
  // Idempotent for the same user.
  const same = await postJson("/api/session", { sessionId: "dup", user: USER_A, missionId: MISSION_ID });
  assert.equal(same.status, 201);
  // A session id may not be re-pointed at a different wallet.
  const other = await postJson("/api/session", { sessionId: "dup", user: USER_B, missionId: MISSION_ID });
  assert.equal(other.status, 409);
  assert.deepEqual(other.body, { error: ERRORS.SESSION_CONFLICT });
});

test("re-registering a session does not wipe the telemetry already streamed", async () => {
  await primeSession("keep-tel", USER_A, humanTelemetry(20));
  const before = await http("/api/session/keep-tel/telemetry");
  assert.equal(before.body.count, 20);

  const again = await postJson("/api/session", { sessionId: "keep-tel", user: USER_A, missionId: MISSION_ID });
  assert.equal(again.status, 201);

  const after_ = await http("/api/session/keep-tel/telemetry");
  assert.equal(after_.body.count, 20, "re-registration must not drop the Proof-of-Attention record");
});

/* -------------------------------------------------------------------------- */
/* Submit — the happy path                                                     */
/* -------------------------------------------------------------------------- */

test("POST /api/submit PASSES and issues a signature the contract can verify off-chain", async () => {
  await primeSession("happy-1", USER_A);

  const res = await postJson("/api/submit", submission({ sessionId: "happy-1", user: USER_A }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "PASS");
  assert.deepEqual(res.body.result.flags, [], "a clean human pass must raise no flags");
  assert.deepEqual(res.body.syndicate, { syndicate: false, similarity: 0 });
  assert.equal(typeof res.body.signature, "string");
  assert.equal(res.body.signature.length, 132, "65-byte 0x-prefixed signature");
  assert.equal(res.body.signer, backendWallet.address, "the response must name the signer ADDRESS");

  /* ---- claim payload assertions ---- */
  const claim = res.body.claim;
  assert.ok(claim, "a PASS must carry a claim");
  // Field ORDER matters: it is what the EIP-712 type string encodes.
  assert.deepEqual(Object.keys(claim), ["user", "reward", "staminaCost", "nonce", "deadline"]);
  assert.equal(claim.user, USER_A);
  // The amounts are independently derivable from the mission the session opened.
  assert.equal(claim.reward, MISSION.reward);
  // The wire form of a unitless POINT count: `toUintString` renders the seed's
  // plain integer `staminaCost` as the decimal text the EIP-712 struct carries.
  assert.equal(claim.staminaCost, String(MISSION.staminaCost));
  assert.ok(BigInt(claim.reward) > 0n, "reward must be positive");
  assert.ok(BigInt(claim.staminaCost) > 0n, "staminaCost must be positive");
  assert.ok(Number(claim.nonce) >= 1);
  assert.ok(
    Number(claim.deadline) > Math.floor(Date.now() / 1000),
    "the signed deadline must be in the future"
  );
  assert.ok(
    Number(claim.deadline) <= Math.floor(Date.now() / 1000) + CLAIM_TTL_SECONDS,
    "the deadline must respect CLAIM_TTL_SECONDS"
  );

  // The claim returned is exactly the struct that was signed: values checked
  // against the mission independently, nonce/deadline round-tripped.
  const expectedClaim = {
    user: USER_A,
    reward: MISSION.reward,
    staminaCost: String(MISSION.staminaCost),
    nonce: claim.nonce,
    deadline: claim.deadline,
  };
  assert.deepEqual(claim, expectedClaim);

  /* ---- off-chain verification, exactly as MiningClaimer will do it ---- */
  const recomputed = signer.claimDigest({
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    claim,
  });
  assert.equal(res.body.digest, recomputed, "the returned digest must equal the recomputed digest");
  assert.equal(ethers.recoverAddress(recomputed, res.body.signature), backendWallet.address);

  // The reward actually came from the anti-cheat verdict, not from the client.
  assert.equal(res.body.result.reward, MISSION.reward);
  // The verdict carries the seed's own value: the unitless POINTS integer.
  assert.equal(res.body.result.staminaCost, MISSION.staminaCost);
  assert.ok(Number.isSafeInteger(res.body.result.staminaCost));
});

test("a second PASS for the same user burns a strictly greater nonce", async () => {
  await primeSession("nonce-1", USER_A);
  const first = await postJson("/api/submit", submission({ sessionId: "nonce-1", user: USER_A }));
  assert.equal(first.body.status, "PASS");
  const nonce1 = Number(first.body.claim.nonce);
  assert.equal(nonce1, 1, "the first nonce a user ever receives is 1");
  assert.equal(await currentStore.isNonceUsed(USER_A, nonce1), true);

  await primeSession("nonce-2", USER_A);
  const second = await postJson("/api/submit", submission({ sessionId: "nonce-2", user: USER_A }));
  assert.equal(second.body.status, "PASS");
  const nonce2 = Number(second.body.claim.nonce);
  assert.ok(nonce2 > nonce1, `nonce2 (${nonce2}) must be greater than nonce1 (${nonce1})`);

  assert.equal(await currentStore.isNonceUsed(USER_A, nonce1), true);
  assert.equal(await currentStore.isNonceUsed(USER_A, nonce2), true);
  assert.equal(await currentStore.isNonceUsed(USER_A, nonce2 + 1), false, "an unissued nonce must not read as used");
});

/* -------------------------------------------------------------------------- */
/* Submit — the failure paths                                                  */
/* -------------------------------------------------------------------------- */

test("a wrong quiz answer FAILs, pays nothing and burns no nonce", async () => {
  await primeSession("wrong-1", USER_A);
  const wrong = ARTICLE.quiz.map((q) => ({
    questionId: q.id,
    answerIndex: (q.correctIndex + 1) % q.options.length,
  }));

  const res = await postJson("/api/submit", submission({ sessionId: "wrong-1", user: USER_A, answers: wrong }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAIL");
  assert.equal(res.body.result.reward, 0);
  assert.ok(res.body.result.flags.includes(anticheat.SUBMISSION_FLAGS.QUIZ_INCORRECT));
  // No signature, and no `claim` key at all: nothing to replay.
  assert.equal("signature" in res.body, false, "a FAIL must not carry a signature field");
  assert.equal("claim" in res.body, false, "a FAIL must not carry a claim field");
  assert.equal("digest" in res.body, false, "a FAIL must not carry a digest field");

  // Nothing was burned: the same user's next PASS is still nonce 1.
  assert.equal(await currentStore.isNonceUsed(USER_A, 1), false);
  await primeSession("wrong-2", USER_A);
  const good = await postJson("/api/submit", submission({ sessionId: "wrong-2", user: USER_A }));
  assert.equal(good.body.status, "PASS");
  assert.equal(Number(good.body.claim.nonce), 1, "a failed attempt must not consume a nonce");
});

test("a highlight missing the key sentences FAILs with the highlight flag", async () => {
  await primeSession("hl-1", USER_A);
  const res = await postJson("/api/submit", submission({ sessionId: "hl-1", user: USER_A, highlight: emptyHighlight() }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAIL");
  assert.equal(res.body.result.reward, 0);
  assert.ok(
    res.body.result.flags.includes(anticheat.SUBMISSION_FLAGS.HIGHLIGHT_MISSING),
    `expected HIGHLIGHT_MISSING, got ${JSON.stringify(res.body.result.flags)}`
  );
  assert.equal(res.body.result.details.highlightMatches, 0);
  assert.equal("signature" in res.body, false);
});

test("typingMs: 1 FAILs with the anticheat typing flag", async () => {
  await primeSession("fast-1", USER_A);
  const res = await postJson("/api/submit", submission({ sessionId: "fast-1", user: USER_A, typingMs: 1 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAIL");
  assert.equal(res.body.result.reward, 0);
  assert.ok(
    res.body.result.flags.includes(anticheat.SUBMISSION_FLAGS.TYPING_TOO_FAST),
    `expected TYPING_TOO_FAST, got ${JSON.stringify(res.body.result.flags)}`
  );
  assert.equal(res.body.result.details.impliedMs, 1);
  assert.ok(res.body.result.details.floorMs > 1);
  assert.equal("signature" in res.body, false);
});

test("emulator telemetry FAILs a perfect quiz and reports the flatline flag", async () => {
  await primeSession("emu-1", USER_A, emulatorTelemetry());
  const res = await postJson("/api/submit", submission({ sessionId: "emu-1", user: USER_A }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAIL");
  assert.equal(res.body.result.reward, 0);
  assert.ok(
    res.body.telemetry.flags.includes(anticheat.FLAGS.BATTERY_FLATLINE),
    `expected BATTERY_FLATLINE, got ${JSON.stringify(res.body.telemetry.flags)}`
  );
  assert.ok(anticheat.isTelemetryAcceptable({ score: 100, flags: [] }));
  assert.equal(
    anticheat.isTelemetryAcceptable(res.body.telemetry),
    false,
    "emulator telemetry must not clear the pass bar"
  );
  assert.ok(res.body.result.flags.includes(anticheat.SUBMISSION_FLAGS.TELEMETRY_POOR));
  assert.ok(
    res.body.result.flags.includes(JUDGE_FLAGS.TELEMETRY_UNACCEPTABLE),
    `expected TELEMETRY_UNACCEPTABLE, got ${JSON.stringify(res.body.result.flags)}`
  );
  assert.equal("signature" in res.body, false);
});

test("a syndicate hit FAILs an otherwise-perfect submission, a genuinely different answer does not", async () => {
  // Deterministic choice of strings on either side of the threshold, verified
  // against the module's own similarity function rather than guessed.
  const original =
    "Attention lapses because the mid reading switch cost is rarely recovered " +
    "and because unplanned interruptions reopen the task every single time";
  const copy =
    "Attention lapses because the mid reading switch cost is rarely recovered " +
    "and because unplanned interruptions reopen the task every single time";
  const originalWords = original.split(" ").length;
  const different =
    "I think the essay argues that planning sessions beat willpower because " +
    "externalising your distractions gives you something to fall back on " +
    "after a lapse happens partway through a chapter";

  assert.ok(
    anticheat.similarity(original, copy) === 1 &&
      anticheat.similarity(original, copy) > anticheat.SYNDICATE_SIMILARITY_THRESHOLD,
    "the copied text must be above the syndicate threshold"
  );
  assert.ok(
    anticheat.similarity(original, different) <= anticheat.SYNDICATE_SIMILARITY_THRESHOLD,
    "the genuinely different text must be at or below the syndicate threshold"
  );
  assert.ok(originalWords > 10);

  // User A publishes the original and passes.
  await primeSession("syn-a", USER_A);
  const a = await postJson("/api/submit", submission({ sessionId: "syn-a", user: USER_A, freeText: original }));
  assert.equal(a.status, 200);
  assert.equal(a.body.status, "PASS", "the first, original submission must pass");
  assert.equal(a.body.syndicate.syndicate, false);

  // User B submits a near-verbatim copy: FAIL purely because it is syndicated.
  await primeSession("syn-b", USER_B);
  const b = await postJson("/api/submit", submission({ sessionId: "syn-b", user: USER_B, freeText: copy }));
  assert.equal(b.status, 200);
  assert.equal(b.body.status, "FAIL", "a syndicate hit must override a perfect quiz");
  assert.equal(b.body.syndicate.syndicate, true);
  assert.ok(b.body.syndicate.similarity > anticheat.SYNDICATE_SIMILARITY_THRESHOLD);
  assert.equal(b.body.result.reward, 0, "a syndicated submission must be worth nothing");
  assert.equal(b.body.result.status, "FAIL", "the reported result must agree with the top-level status");
  assert.ok(
    b.body.result.flags.includes(JUDGE_FLAGS.SYNDICATE_MATCH),
    `expected SYNDICATE_MATCH, got ${JSON.stringify(b.body.result.flags)}`
  );
  assert.equal("signature" in b.body, false, "a syndicated submission must not be signed");
  assert.equal("claim" in b.body, false, "a syndicated submission must not carry a claim");
  assert.equal(await currentStore.isNonceUsed(USER_B, 1), false, "a syndicated FAIL must not burn a nonce");

  // User C, having actually read it, writes something different and passes.
  await primeSession("syn-c", USER_C);
  const c = await postJson("/api/submit", submission({ sessionId: "syn-c", user: USER_C, freeText: different }));
  assert.equal(c.status, 200);
  assert.equal(c.body.syndicate.syndicate, false, "a genuinely different answer must not be flagged");
  assert.equal(c.body.status, "PASS");
});

test("POST /api/submit with a missing or garbage body is 400, never 500", async () => {
  const noBody = await http("/api/submit", { method: "POST" });
  assert.equal(noBody.status, 400);
  assert.ok(noBody.body && noBody.body.error, "a 400 must carry an error code");

  const garbage = await http("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json at all",
  });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.error, ERRORS.INVALID_JSON);

  const notJson = await http("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "totally not json",
  });
  assert.equal(notJson.status, 400);

  // Structurally present but unusable.
  for (const payload of [{}, { sessionId: "s" }, { sessionId: "s", user: "not-an-address" }]) {
    const res = await postJson("/api/submit", payload);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.equal(res.body.error, ERRORS.INVALID_SUBMISSION);
  }

  // A well-formed submission for a session that does not exist is also a
  // client error, not a server error.
  const ghost = await postJson("/api/submit", submission({ sessionId: "no-such-session", user: USER_A }));
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.error, ERRORS.SESSION_NOT_FOUND);
});

test("an unknown route is a JSON 404", async () => {
  const res = await http("/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: ERRORS.NOT_FOUND });
  assert.equal(res.raw.includes("<html"), false, "the 404 must not be an HTML page");
});

/* -------------------------------------------------------------------------- */
/* Secret safety — the explicitly required test                               */
/* -------------------------------------------------------------------------- */

test("SECRET SAFETY: the private key never reaches a log line, a response body or an error", async () => {
  // A logger that records EVERY argument handed to it, on every level.
  const logger = recordingLogger();
  const key = backendWallet.privateKey;
  const keyBody = key.startsWith("0x") ? key.slice(2) : key;
  assert.match(keyBody, /^[0-9a-fA-F]{64}$/, "the throwaway key must be 32 bytes of hex");

  // Every 64-hex-character substring of the key, with and without the 0x
  // prefix. A 64-char key body has exactly one such substring, plus the
  // 66-char 0x-prefixed form; both are checked explicitly.
  const keyForms = new Set([key, keyBody, `0x${keyBody}`, keyBody.toUpperCase()]);

  /** Bodies captured across every request below. */
  const bodies = [];
  /** Parsed bodies of every response whose status was >= 400. */
  const errorBodies = [];

  /** @type {Object} */
  let store;
  /** @type {string} */
  let url;
  ({
    baseUrl: url,
    store,
  } = await boot({ logger }));

  /**
   * Performs a request against the secret-safe app and records its body.
   *
   * @param {string} path Path.
   * @param {Object} [init] fetch init.
   * @returns {Promise<{ status: number, raw: string, body: any }>}
   */
  async function call(path, init) {
    const res = await fetch(`${url}${path}`, init);
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      body = undefined;
    }
    bodies.push(raw);
    if (res.status >= 400) errorBodies.push({ status: res.status, raw, body });
    return { status: res.status, raw, body };
  }

  /**
   * @param {string} path Path.
   * @param {Object} payload Body.
   * @returns {Promise<{ status: number, raw: string, body: any }>}
   */
  function callJson(path, payload) {
    return call(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // --- the happy path, end to end ---
  await callJson("/api/session", { sessionId: "sec-1", user: USER_D, missionId: MISSION_ID });
  await callJson("/api/telemetry", { sessionId: "sec-1", samples: humanTelemetry() });
  const happy = await callJson("/api/submit", submission({ sessionId: "sec-1", user: USER_D }));
  assert.equal(happy.status, 200);
  const happyBody = happy.body;
  assert.equal(happyBody.status, "PASS");

  // --- every failure path ---
  await call("/api/health");
  await call("/api/missions");
  await call(`/api/article/${ARTICLE_ID}?session=sec-1`);
  await call(`/api/article/nope?session=sec-1`);
  await call(`/api/article/${ARTICLE_ID}`); // missing session -> 400
  await call("/api/session/does-not-exist/telemetry");
  await call("/api/api/nope"); // 404
  await callJson("/api/telemetry", {}); // 400
  await callJson("/api/telemetry", { sessionId: "sec-1", samples: [] }); // 400
  await callJson("/api/session", { sessionId: "sec-1", user: USER_A, missionId: MISSION_ID }); // 409
  await callJson("/api/submit", { sessionId: "sec-1" }); // 400
  await call("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{{{",
  }); // 400 invalid json
  // Wrong quiz -> FAIL, still a 200 by design.
  await callJson("/api/session", { sessionId: "sec-2", user: USER_D, missionId: MISSION_ID });
  await callJson("/api/telemetry", { sessionId: "sec-2", samples: humanTelemetry() });
  const failed = await callJson("/api/submit", submission({ sessionId: "sec-2", user: USER_D, answers: [] }));
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, "FAIL");
  // Missing signer key -> the signing path throws -> 500, logged server-side.
  // This uses its OWN app (and therefore its own store), so the session and
  // telemetry are registered against that app rather than reused.
  const keyless = await boot({ logger, withPrivateKey: false });
  const keylessPost = (p, payload) =>
    fetch(`${keyless.baseUrl}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  await keylessPost("/api/session", { sessionId: "sec-3", user: USER_D, missionId: MISSION_ID });
  await keylessPost("/api/telemetry", { sessionId: "sec-3", samples: humanTelemetry() });
  const keylessRes = await keylessPost("/api/submit", submission({ sessionId: "sec-3", user: USER_D }));
  const keylessRaw = await keylessRes.text();
  bodies.push(keylessRaw);
  assert.equal(keylessRes.status, 500, "a missing signer key must surface as a 500, not a silent pass");
  errorBodies.push({ status: keylessRes.status, raw: keylessRaw, body: JSON.parse(keylessRaw) });

  /* ---- (a) no recorded log string contains the key ---- */
  assert.ok(logger.records.length > 0, "the 500 path must actually have logged something");
  for (const record of logger.records) {
    for (const arg of record.args) {
      const text = typeof arg === "string" ? arg : String(arg);
      for (const form of keyForms) {
        assert.equal(
          text.includes(form),
          false,
          `a ${record.level}() log argument leaked the private key: ${text.slice(0, 120)}`
        );
      }
    }
  }

  /* ---- (b) no HTTP response body contains the key ---- */
  // 3 for the happy path + 15 for the failure sweep + 1 for the keyless 500.
  assert.equal(bodies.length, 19, "the sweep must have exercised every route");
  for (const raw of bodies) {
    for (const form of keyForms) {
      assert.equal(raw.includes(form), false, "an HTTP response body leaked the private key");
    }
  }

  /* ---- (c) JSON.stringify of the submit response does not contain it ---- */
  for (const responseBody of [happyBody, failed.body]) {
    const restrung = JSON.stringify(responseBody);
    for (const form of keyForms) {
      assert.equal(restrung.includes(form), false, "JSON.stringify of a submit response leaked the key");
    }
  }

  /* ---- (d) the key never appears in an error message returned to the client ---- */
  assert.ok(errorBodies.length >= 9, "the sweep must have produced every error response");
  for (const { status, body: parsed, raw } of errorBodies) {
    assert.ok(status >= 400);
    for (const form of keyForms) {
      assert.equal(raw.includes(form), false, `a ${status} response body leaked the private key`);
    }
    assert.equal(typeof parsed.error, "string", `a ${status} response must carry a stable error code`);
    for (const form of keyForms) {
      assert.equal(parsed.error.includes(form), false, `a ${status} error message leaked the private key`);
    }
    assert.equal(
      /privatekey|private key|signer_private/i.test(raw),
      false,
      `a ${status} response referenced the signing key at all: ${raw.slice(0, 120)}`
    );
  }
  // The 500 must be an opaque code: no stack, no message, no env dump.
  const fiveHundred = errorBodies[errorBodies.length - 1];
  assert.equal(fiveHundred.status, 500);
  assert.deepEqual(fiveHundred.body, { error: ERRORS.INTERNAL_ERROR });
  assert.equal(fiveHundred.raw.includes("    at "), false, "a stack trace reached the client");

  /* ---- and the positive case: the signer's ADDRESS is published ---- */
  assert.equal(happyBody.signer, backendWallet.address, "the response must name the signer ADDRESS");
  assert.ok(ethers.isAddress(happyBody.signer), "the published signer must be a valid EVM address");
  // The wire carries the CHECKSUMMED form (JSON is case-preserving), which is
  // the only signer-derived value allowed out of the process.
  assert.equal(happy.raw.includes(backendWallet.address), true, "the address should be checksummed");
  assert.notEqual(happyBody.signer, USER_D, "the signer must not be confused with the claiming user");
  assert.equal(happy.raw.includes(keyBody), false);

  /* ---- and no env value is dumped anywhere ---- */
  for (const raw of bodies) {
    assert.equal(raw.includes("SIGNER_PRIVATE_KEY"), false, "a response referenced the env var name");
  }
  for (const record of logger.records) {
    for (const arg of record.args) {
      const text = typeof arg === "string" ? arg : String(arg);
      assert.equal(
        /0x[0-9a-fA-F]{64}/.test(text),
        false,
        `a log line contained a 32-byte hex value, which is what a leaked key looks like: ${text.slice(0, 120)}`
      );
    }
  }

  await store.close();
});
