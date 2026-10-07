/**
 * CATT Protocol — the persistent SQLite storage adapter.
 *
 * These tests are the proof that `createSqliteStore()` is a DROP-IN
 * replacement for `createMemoryStore()` and not merely "something with similar
 * method names":
 *
 *   - `interface parity` runs one scripted sequence of calls against BOTH
 *     adapters and compares every resulting view. If the two ever disagree
 *     about what a caller can see, that is a bug in the swap, and this is where
 *     it is caught.
 *   - the remaining tests pin the things the memory store could only hold in
 *     application code — nonce uniqueness, relay-once, durability — and prove
 *     they are enforced by the SCHEMA (raw SQL) and not only by JavaScript.
 *   - `test/persistence.test.js` carries the across-a-PROCESS-restart proof.
 *
 * `node:test` + `node:assert/strict` only: no test framework dependency.
 */

"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSqliteStore, SCHEMA_VERSION, DEFAULT_SQLITE_PATH, MIGRATIONS } = require("../src/sqlite-store");
const { createMemoryStore, assertStoreShape, STORAGE_METHODS, STORAGE_ADAPTERS, getStorageAdapter } = require("../src/storage");

const USER_A = "0x1111111111111111111111111111111111111111";
const USER_B = "0x2222222222222222222222222222222222222222";
const USER_C = "0x3333333333333333333333333333333333333333";
const TX_A = "0x" + "ab".repeat(32);
const TX_B = "0x" + "cd".repeat(32);
const TX_C = "0x" + "ef".repeat(32);
const BIG_REWARD = "1000000000000000000000001"; // 1e24, far above 2^53.

/** Every temp directory this file created, removed in `after`. */
const tempDirs = [];

/**
 * Creates a throwaway directory under the OS temp dir and returns a database
 * path inside it. NEVER inside the repository: the database holds session and
 * wallet data, and a test that leaves one in a checkout is a test that teaches
 * operators to commit one.
 *
 * @param {string} [label] Suffix that makes the directory recognisable.
 * @returns {string} An absolute path to a not-yet-created `.db` file.
 */
function tempDbPath(label = "judge") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catt-sqlite-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, "judge.db");
}

/** Closes the store if it is still open, and removes every temp directory. */
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Opens a store on a fresh temp database. */
async function openStore() {
  const filename = tempDbPath();
  const store = createSqliteStore({ filename });
  await store.init();
  return { store, filename };
}

/* ========================================================================== */
/* 1. Interface parity                                                        */
/* ========================================================================== */

test("interface: the sqlite adapter implements every STORAGE_METHODS name", () => {
  const store = createSqliteStore({ filename: tempDbPath("shape") });
  assert.equal(assertStoreShape(store), store, "assertStoreShape must accept the store and return it");
  for (const name of STORAGE_METHODS) {
    assert.equal(typeof store[name], "function", `missing method: ${name}`);
  }
  // A half-implemented adapter must still fail loudly.
  assert.throws(() => assertStoreShape({}), /missing required method/);
  return store.close();
});

test("interface: the sqlite adapter is registered in STORAGE_ADAPTERS and lazy-loads", () => {
  const ids = STORAGE_ADAPTERS.map((adapter) => adapter.id);
  assert.deepEqual(ids, ["memory", "sqlite"], "both adapters must be documented in one place");
  assert.equal(STORAGE_ADAPTERS.find((a) => a.id === "memory").persistent, false);
  assert.equal(STORAGE_ADAPTERS.find((a) => a.id === "sqlite").persistent, true);
  assert.equal(getStorageAdapter("SQLite").id, "sqlite", "adapter lookup is case-insensitive");
  assert.equal(getStorageAdapter("nope"), undefined);
  // `storage.js` must not eagerly pull in the native module, or every test and
  // every memory-store deployment would load it.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "storage.js"), "utf8");
  assert.equal(/require\("\.\/sqlite-store"\)/.test(source), true, "the lazy require must exist");
  assert.equal(
    /^\s*const .* = require\("\.\/sqlite-store"\);/m.test(source),
    false,
    "storage.js must not require ./sqlite-store at module scope"
  );
});

test("parity: memory and sqlite agree on the same scripted sequence", async () => {
  /* --- the script. Every call an HTTP handler can make, in order. ------- */
  async function script(store) {
    const log = {};

    log.sessionCreated = await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "mission-1" });

    log.telemetryTotal1 = await store.appendTelemetry("s-1", [
      { ts: 1000, batteryTempC: 29.5, touch: { x: 10, y: 20 }, scrollDelta: 120 },
      { ts: 6000, batteryTempC: 30.25, touch: { x: 11, y: 21 }, scrollDelta: -40 },
    ]);
    log.telemetryTotal2 = await store.appendTelemetry("s-1", [
      { ts: 11000, batteryTempC: 31, touch: { x: 12, y: 22 }, scrollDelta: 0 },
    ]);

    // A repeat registration must not wipe what was already streamed.
    log.sessionReRegistered = await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "mission-1" });
    log.telemetryAfterReRegister = (await store.getTelemetry("s-1")).length;

    // Telemetry for a session that was never registered still lands.
    log.telemetryAutoCreated = await store.appendTelemetry("s-unregistered", [{ ts: 1, touch: { x: 0, y: 0 } }]);
    log.autoCreatedSession = await store.getSession("s-unregistered");
    log.unknownSession = await store.getSession("s-never-existed");

    log.submissionA = await store.saveSubmission({
      sessionId: "s-1",
      userAddress: USER_A,
      missionId: "mission-1",
      answers: [1, 0],
      highlight: "the highlighted sentence",
      typingMs: 42000,
      freeText: "a shared answer that a syndicate would copy",
      result: { status: "PASS", reward: "1000000000", staminaCost: "5" },
    });
    log.submissionB = await store.saveSubmission({
      sessionId: "s-2",
      userAddress: USER_B,
      missionId: "mission-1",
      answers: [1, 0],
      highlight: "another sentence",
      typingMs: 38000,
      freeText: "a shared answer that a syndicate would copy",
      result: { status: "FAIL", reward: 0, staminaCost: "5" },
    });
    log.recentAll = await store.listRecentSubmissions({ limit: 10 });
    log.recentScoped = await store.listRecentSubmissions({ userAddress: USER_B, limit: 10 });
    log.recentLimited = await store.listRecentSubmissions({ limit: 1 });
    log.recentDefaulted = await store.listRecentSubmissions({});
    // The exclusive filter (residual risk #3): the syndicate corpus is everyone
    // BUT the submitter. Exercised here so the two adapters are compared on the
    // new parameter too, not just on the old one.
    log.recentExcludingA = await store.listRecentSubmissions({ excludeUserAddress: USER_A, limit: 10 });
    log.recentExcludingUnknown = await store.listRecentSubmissions({
      excludeUserAddress: "0x9999999999999999999999999999999999999999",
      limit: 10,
    });
    log.recentBothDegenerate = await store.listRecentSubmissions({
      userAddress: USER_A,
      excludeUserAddress: USER_A,
      limit: 10,
    });
    log.recentBothDistinct = await store.listRecentSubmissions({
      userAddress: USER_A,
      excludeUserAddress: USER_B,
      limit: 10,
    });
    log.recentExcludingLimited = await store.listRecentSubmissions({ excludeUserAddress: USER_A, limit: 1 });

    log.nonces = [];
    for (let i = 0; i < 3; i += 1) log.nonces.push(await store.reserveNonce(USER_A));
    log.noncesB = await store.reserveNonce(USER_B);
    log.usedMatrix = [
      await store.isNonceUsed(USER_A, 1),
      await store.isNonceUsed(USER_A, 3),
      await store.isNonceUsed(USER_A, 4),
      await store.isNonceUsed(USER_A, 0),
      await store.isNonceUsed(USER_B, 1),
      await store.isNonceUsed("0x9999999999999999999999999999999999999999", 1),
    ];

    log.claimBefore = await store.getIssuedClaim(USER_A, 2);
    log.claimRecorded = await store.recordIssuedClaim({
      userAddress: USER_A,
      nonce: 2,
      sessionId: "s-1",
      digest: "0x" + "11".repeat(32),
      reward: BIG_REWARD,
      staminaCost: "5",
      deadline: 1700000000,
      signature: "0x" + "22".repeat(65),
    });
    log.claimAfter = await store.getIssuedClaim(USER_A, 2);
    // Re-recording must not clear the relay bookkeeping.
    log.claimRerecorded = await store.recordIssuedClaim({
      userAddress: USER_A,
      nonce: 2,
      sessionId: "s-1",
      digest: "0x" + "33".repeat(32),
      reward: BIG_REWARD,
      staminaCost: "5",
      deadline: 1700000000,
      signature: "0x" + "44".repeat(65),
    });
    log.markFirst = await store.markRelayed({ userAddress: USER_A, nonce: 2, txHash: TX_A });
    log.markSecond = await store.markRelayed({ userAddress: USER_A, nonce: 2, txHash: TX_B });
    log.claimRelayed = await store.getIssuedClaim(USER_A, 2);

    // A relay for a nonce this backend never issued still gets a record.
    log.markUnrecorded = await store.markRelayed({ userAddress: USER_B, nonce: 77, txHash: TX_C });
    log.claimUnrecorded = await store.getIssuedClaim(USER_B, 77);
    log.claimNeverIssued = await store.getIssuedClaim(USER_A, 1);

    log.telemetry = await store.getTelemetry("s-1");
    log.telemetryUnknown = await store.getTelemetry("s-never-existed");

    /* --- the growth ledgers ------------------------------------------- */
    // Driven through the SAME script as everything above, because "the two
    // adapters return identical views" is a claim about the whole interface and
    // not about the parts that existed when it was first written. The full
    // behavioural specification of these methods is in test/growth-store.test.js;
    // this is the drop-in guarantee.
    log.staminaEmpty = await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-09-01" });
    log.staminaOne = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-09-01", amount: 10 });
    log.staminaTwo = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-09-01", amount: 20 });
    log.staminaOtherDay = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-09-02", amount: BIG_REWARD });
    log.staminaRead = await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-09-01" });
    log.staminaHuge = await store.recordStaminaConsumption({ userAddress: USER_B, dayKey: "2026-09-01", amount: "9007199254740993" });

    log.streakNone = await store.getStreak({ userAddress: USER_C });
    log.streakFirst = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-09-01", reward: BIG_REWARD, missionId: "mission-1" });
    log.streakSameDay = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-09-01", missionId: "mission-3" });
    log.streakNextDay = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-09-02" });
    log.streakGap = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-09-09" });
    log.streakRetro = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-09-07" });
    log.streakRead = await store.getStreak({ userAddress: USER_A });

    log.freeEmpty = await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-09-01" });
    log.freeDay1 = await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-09-01", amount: 25 });
    log.freeDay1Again = await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-09-01", amount: 25 });
    log.freeDay2 = await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-09-02" });

    log.seasonMissing = await store.getSeason("season-never-created");
    log.seasonSaved = await store.saveSeason({ id: "s1", start: 100, end: 200, allocation: BIG_REWARD, claimMode: "pro-rata" });
    // An OPEN-ENDED season (`end: null`), deliberately placed so it does NOT
    // overlap `s1`: the boundary semantics stay readable, and the overlap rule is
    // pinned separately in test/growth-store.test.js.
    log.seasonOpen = await store.saveSeason({ id: "s-open", start: 300, end: null, allocation: "5", claimMode: "flat" });
    log.seasonUpdated = await store.saveSeason({ id: "s1", start: 100, end: 250, allocation: BIG_REWARD, claimMode: "pro-rata" });
    log.seasonRead = await store.getSeason("s1");
    // The window is [start, end). `s1` was extended from 200 to 250 by the
    // upsert above, so 199 is inside it and 250 is the first instant outside it.
    log.activeBefore = await store.getActiveSeason(99);
    log.activeStart = await store.getActiveSeason(100);
    log.activeBeforeEnd = await store.getActiveSeason(199);
    log.activeAtEnd = await store.getActiveSeason(250);
    log.activeBeforeOpen = await store.getActiveSeason(299);
    log.activeOpenStart = await store.getActiveSeason(300);
    log.activeFar = await store.getActiveSeason(99999);

    log.claimUnused = await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 });
    log.claimRecorded = await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: BIG_REWARD, nonce: 1 });
    log.claimUsed = await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 });
    log.claimOther = await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_B, amount: "7", nonce: 1 });
    log.seasonTotal = await store.getSeasonClaimedTotal("s1");
    log.userAccruedA = await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_A });
    log.userAccruedB = await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_B });
    log.seasonTotalOpen = await store.getSeasonClaimedTotal("s-open");

    log.minersDay1 = await store.countActiveMiners({ dayKey: "2026-09-01" });
    log.minersDay2 = await store.countActiveMiners({ dayKey: "2026-09-02" });
    log.minersDay3 = await store.countActiveMiners({ dayKey: "2026-09-03" });
    log.minersDay9 = await store.countActiveMiners({ dayKey: "2026-09-09" });
    log.minersMixed = await store.countActiveMiners({ dayKey: "2026-09-10" });

    return log;
  }

  /**
   * Strips the fields that are wall-clock values rather than behaviour, so the
   * comparison is about WHAT the two adapters say, not about when they said it.
   * Their PRESENCE and TYPE are asserted separately, below.
   */
  const strip = (value, volatile) => {
    if (Array.isArray(value)) return value.map((row) => strip(row, volatile));
    if (value === null || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (volatile.includes(key)) continue;
      out[key] = strip(value[key], volatile);
    }
    return out;
  };

  const VOLATILE = ["createdAt", "submittedAt", "issuedAt", "relayedAt"];

  const memory = createMemoryStore();
  const sqlite = createSqliteStore({ filename: tempDbPath("parity") });
  await sqlite.init();
  const [a, b] = [await script(memory), await script(sqlite)];

  // Volatile fields: present, and of the right kind, in both.
  assert.equal(typeof a.sessionCreated.createdAt, "number");
  assert.equal(typeof b.sessionCreated.createdAt, "number");
  assert.equal(typeof a.recentAll[0].submittedAt, "number");
  assert.equal(typeof b.recentAll[0].submittedAt, "number");
  assert.equal(typeof a.claimAfter.issuedAt, "number");
  assert.equal(typeof b.claimAfter.issuedAt, "number");
  // `_seq` is a private ordering field the memory store adds to each sample; it
  // has no counterpart here because SQLite's order is the row order.
  assert.equal(typeof a.telemetry[0]._seq, "number");
  assert.equal("_seq" in b.telemetry[0], false);

  // The whole scripted log, compared field by field. This is the drop-in
  // guarantee: a caller cannot tell the two adapters apart from what they see.
  assert.deepEqual(
    strip(b, VOLATILE),
    strip({ ...a, telemetry: a.telemetry.map((sample) => strip(sample, ["_seq"])) }, VOLATILE),
    "the scripted views of the two adapters diverged"
  );

  // Explicit spot-checks, so a failure names the behaviour that broke.
  assert.deepEqual(b.telemetryTotal1, a.telemetryTotal1);
  assert.deepEqual(b.telemetryTotal2, a.telemetryTotal2);
  assert.deepEqual(b.telemetryAfterReRegister, 3, "a repeat createSession must not wipe telemetry");
  assert.deepEqual(b.nonces, [1, 2, 3]);
  assert.deepEqual(b.usedMatrix, [true, true, false, false, true, false]);
  assert.deepEqual(b.recentAll.map((row) => row.userAddress), [USER_B, USER_A], "newest-first across ALL users");
  assert.deepEqual(b.recentScoped.map((row) => row.id), [a.submissionB.id]);
  assert.deepEqual(b.recentLimited.length, 1);
  assert.deepEqual(b.recentExcludingA.map((row) => row.userAddress), [USER_B], "excludeUserAddress keeps only OTHER users");
  assert.deepEqual(
    b.recentExcludingUnknown.map((row) => row.userAddress),
    [USER_B, USER_A],
    "excluding an address nobody used changes nothing"
  );
  assert.deepEqual(b.recentBothDegenerate, [], "userAddress === excludeUserAddress is the empty set, not a fallback");
  assert.deepEqual(b.recentBothDistinct.map((row) => row.userAddress), [USER_A], "two different addresses compose");
  assert.deepEqual(b.recentExcludingLimited.length, 1, "limit is applied AFTER filtering");
  assert.deepEqual(b.markFirst, true);
  assert.deepEqual(b.markSecond, false);
  assert.equal(b.claimRelayed.relayerTxHash, TX_A, "the winning relay hash must never be overwritten");

  // Growth-ledger spot-checks, so a parity failure names the behaviour that broke.
  assert.deepEqual(b.staminaEmpty.consumed, "0");
  assert.deepEqual(b.staminaTwo.consumed, "30", "the stamina ledger accumulates");
  assert.deepEqual(b.staminaRead.consumed, "30", "and does not bleed into another day");
  assert.deepEqual(b.staminaOtherDay.consumed, BIG_REWARD, "a 1e24 amount is exact, not rounded");
  assert.deepEqual(b.staminaHuge.consumed, "9007199254740993", "a value above 2^53 is exact");
  assert.deepEqual(
    [b.streakFirst.current, b.streakSameDay.current, b.streakNextDay.current, b.streakGap.current, b.streakRetro.current],
    [1, 1, 2, 1, 1],
    "the four streak cases"
  );
  assert.deepEqual(b.streakRead, { userAddress: USER_A, current: 1, lastGradedDay: "2026-09-07" });
  assert.deepEqual(b.freeDay1Again.granted, "50");
  assert.deepEqual(b.freeDay2.granted, "0", "a day-A grant never leaks into day B");
  assert.deepEqual(b.seasonOpen.end, null, "an open-ended season round-trips as null");
  assert.deepEqual(b.activeBefore, undefined);
  assert.deepEqual(b.activeStart.id, "s1", "the window is start-inclusive");
  assert.deepEqual(b.activeBeforeEnd.id, "s1");
  assert.deepEqual(b.activeAtEnd, undefined, "`end` is EXCLUSIVE, so back-to-back windows are well defined");
  assert.deepEqual(b.activeBeforeOpen, undefined, "and there is a real gap before the next season");
  assert.deepEqual(b.activeOpenStart.id, "s-open", "an open-ended season starts inclusively");
  assert.deepEqual(b.activeFar.id, "s-open", "and owns everything from its start onward");
  assert.deepEqual([b.claimUnused, b.claimUsed], [false, true], "isSeasonClaimUsed flips");
  assert.deepEqual(b.claimRecorded, { seasonClaimedTotal: BIG_REWARD, userAccrued: BIG_REWARD });
  assert.deepEqual(b.seasonTotal, (BigInt(BIG_REWARD) + 7n).toString());
  assert.deepEqual(b.userAccruedA, BIG_REWARD);
  assert.deepEqual(b.userAccruedB, "7");
  assert.deepEqual(b.seasonTotalOpen, "0", "seasons do not share a total");
  assert.deepEqual([b.minersDay1, b.minersDay2, b.minersDay3, b.minersDay9, b.minersMixed], [1, 1, 0, 1, 0]);

  await sqlite.close();
  await sqlite.dispose();
});

/* ========================================================================== */
/* 2. Schema, version, idempotency                                            */
/* ========================================================================== */

test("schema: user_version records the schema version a future migration bumps", async () => {
  const { store, filename } = await openStore();
  assert.equal(store._schemaVersion(), SCHEMA_VERSION);
  // DE-BRITTLED (was `SCHEMA_VERSION === 3`): the expectation is derived from
  // MIGRATIONS instead of being written as a literal, so the next wave appending
  // a migration does not have to edit this test to keep it green — the test that
  // matters is "the file is stamped with the last migration's version", which is
  // asserted below and is what actually breaks if the bump is forgotten.
  assert.equal(
    SCHEMA_VERSION,
    MIGRATIONS[MIGRATIONS.length - 1].version,
    "SCHEMA_VERSION must equal the last migration's version"
  );
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1),
    "migrations must be exactly 1..SCHEMA_VERSION: append-only, contiguous, never edited"
  );
  assert.ok(
    MIGRATIONS.some((m) => /governor_daily_spend/.test(m.up.toString())),
    "the daily governor budget ledger must ship as one of the migrations"
  );
  assert.equal(
    MIGRATIONS[MIGRATIONS.length - 1].version,
    SCHEMA_VERSION,
    "the last migration must produce exactly SCHEMA_VERSION"
  );
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    [...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b),
    "migrations must be ordered and unique, since they are applied in order"
  );
  await store.close();

  // The version lives in the FILE, so it survives a close and a re-open.
  const reopened = createSqliteStore({ filename });
  assert.equal(reopened._schemaVersion(), SCHEMA_VERSION, "user_version must be persistent");
  await reopened.close();
});

test("schema: opening the same file twice does not error and does not lose data", async () => {
  const { store, filename } = await openStore();
  await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "mission-1" });
  await store.appendTelemetry("s-1", [{ ts: 1, touch: { x: 1, y: 2 } }]);
  await store.saveSubmission({
    sessionId: "s-1",
    userAddress: USER_A,
    missionId: "mission-1",
    answers: [0],
    highlight: "h",
    typingMs: 1,
    freeText: "t",
    result: { status: "PASS", reward: "1", staminaCost: "1" },
  });
  const before = store._debugState();
  assert.deepEqual(before, { sessions: 1, telemetry: 1, submissions: 1, issuedClaims: 0, relayedClaims: 0 });
  await store.close();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = createSqliteStore({ filename });
    await again.init(); // idempotent: re-running the migration check is a no-op
    assert.deepEqual(again._debugState(), before, `re-open #${attempt} lost data`);
    await again.close();
  }
});

test("schema: WAL and foreign keys are both actually on", async () => {
  const { store } = await openStore();
  const db = store._raw();
  assert.equal(String(db.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
  assert.equal(Number(db.pragma("foreign_keys", { simple: true })), 1);
  // Referential integrity, demonstrated: telemetry for a session that does not
  // exist is refused by the DATABASE, not by a JavaScript check.
  assert.throws(
    () => db.prepare("INSERT INTO telemetry (session_id, sample_index, sample_json, received_at) VALUES (?, 1, '{}', 1)").run("s-nope"),
    /FOREIGN KEY constraint failed/
  );
  await store.close();
});

/* ========================================================================== */
/* 3. Uniqueness — enforced by the schema                                     */
/* ========================================================================== */

test("uniqueness: (user_address, nonce) is a real UNIQUE constraint in the schema", async () => {
  const { store } = await openStore();
  await store.recordIssuedClaim({
    userAddress: USER_A,
    nonce: 1,
    sessionId: "s-1",
    digest: "0x" + "11".repeat(32),
    reward: "1",
    staminaCost: "1",
    deadline: 1700000000,
    signature: "0x" + "22".repeat(65),
  });

  // Raw SQL, bypassing every line of JavaScript: the duplicate must be refused
  // by SQLite itself.
  const insert = store._raw().prepare(
    `INSERT INTO issued_claims
       (user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature, issued_at)
     VALUES (?, ?, 's-1', '0xdup', '1', '1', '1700000000', '0xsig', 1)`
  );
  assert.throws(() => insert.run(USER_A.toLowerCase(), 1), /UNIQUE constraint failed: issued_claims/);
  assert.equal((await store.getIssuedClaim(USER_A, 1)).digest, "0x" + "11".repeat(32), "the original row must be intact");

  // The relay hash is unique too, so the same broadcast cannot be recorded
  // against two different nonces.
  await store.markRelayed({ userAddress: USER_A, nonce: 1, txHash: TX_A });
  const relayInsert = store._raw().prepare(
    `INSERT INTO issued_claims
       (user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature, issued_at, relayed_tx_hash, relayed_at)
     VALUES (?, ?, 's-1', '0xdup', '1', '1', '1700000000', '0xsig', 1, ?, 1)`
  );
  assert.throws(() => relayInsert.run(USER_B, 1, TX_A), /UNIQUE constraint failed: issued_claims/);

  // And the CHECK constraints make a half-written relay record unrepresentable.
  assert.throws(
    () =>
      store._raw()
        .prepare(
          `INSERT INTO issued_claims
             (user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature, issued_at, relayed_tx_hash, relayed_at)
           VALUES (?, ?, 's-1', '0xdup', '1', '1', '1700000000', '0xsig', 1, '', 1)`
        )
        .run(USER_B, 5),
    /CHECK constraint failed/
  );
  assert.throws(
    () =>
      store._raw()
        .prepare(
          `INSERT INTO issued_claims
             (user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature, issued_at, relayed_tx_hash, relayed_at)
           VALUES (?, ?, 's-1', '0xdup', '1', '1', '1700000000', '0xsig', 1, '0xabc', NULL)`
        )
        .run(USER_B, 6),
    /CHECK constraint failed/
  );
  await store.close();
});

test("uniqueness: repeated reserves never reissue, and a relay happens at most once", async () => {
  const { store } = await openStore();
  const first = await store.reserveNonce(USER_A);
  const second = await store.reserveNonce(USER_A);
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.notEqual(first, second, "two reserves must return two different values");
  assert.notEqual(await store.reserveNonce(USER_A), first);
  // Per-user isolation.
  assert.equal(await store.reserveNonce(USER_B), 1);

  assert.equal(await store.markRelayed({ userAddress: USER_A, nonce: 1, txHash: TX_A }), true);
  assert.equal(await store.markRelayed({ userAddress: USER_A, nonce: 1, txHash: TX_B }), false, "a second relay is refused");
  assert.equal((await store.getIssuedClaim(USER_A, 1)).relayerTxHash, TX_A, "the winning hash must survive the refusal");
  // A hash already recorded against another nonce is refused too.
  assert.equal(await store.markRelayed({ userAddress: USER_B, nonce: 1, txHash: TX_A }), false);
  assert.equal(await store.getIssuedClaim(USER_B, 1), undefined, "the refused relay must not leave a row behind");

  // A null address is refused by the schema rather than silently given its own
  // nonce sequence (SQLite does not imply NOT NULL from a TEXT PRIMARY KEY).
  assert.throws(() => store._raw().prepare("INSERT INTO nonce_counters (user_address, last_nonce) VALUES (NULL, 1)").run(), /NOT NULL/);
});

/* ========================================================================== */
/* 4. Big-integer fidelity                                                    */
/* ========================================================================== */

test("fidelity: a reward far above 2^53 round-trips exactly", async () => {
  const { store } = await openStore();
  const HUGE_DEADLINE = "9007199254740993"; // 2^53 + 1: lossy as a JS number.
  await store.recordIssuedClaim({
    userAddress: USER_A,
    nonce: 7,
    sessionId: "s-1",
    digest: "0x" + "aa".repeat(32),
    reward: BIG_REWARD, // 1e24: also far above SQLite's signed 64-bit INTEGER
    // NOT a seeded mission cost: this is a deliberate TEXT-CAPACITY probe, so it
    // stays in the 1e18 range on purpose. The seeded costs are unitless stamina
    // POINTS (10/20/30, see content.js); this value exists to prove the
    // stamina_cost column round-trips a value an INTEGER could not hold, and
    // `assert.equal(claim.staminaCost, "3000000000000000000")` below is that
    // proof. The seeded unit values are pinned in test/growth-store.test.js.
    staminaCost: "3000000000000000000",
    deadline: HUGE_DEADLINE,
    signature: "0x" + "bb".repeat(65),
  });
  const claim = await store.getIssuedClaim(USER_A, 7);
  assert.equal(claim.reward, BIG_REWARD, "reward must be exact, not rounded");
  assert.notEqual(claim.reward, "1000000000000000000000000");
  assert.equal(BigInt(claim.reward) ** 1n, 1000000000000000000000001n);
  assert.equal(claim.staminaCost, "3000000000000000000");
  // A deadline above 2^53 cannot come back as a JS number, so it comes back as
  // the exact decimal string instead of being rounded.
  assert.equal(String(claim.deadline), HUGE_DEADLINE);
  assert.equal(BigInt(claim.deadline), 9007199254740993n);
  // The nonce is a small integer and stays a number, exactly as the memory
  // store returns it (`Number(nonce)`).
  assert.equal(typeof claim.nonce, "number");
  assert.equal(claim.nonce, 7);

  // A bigint reward (what anticheat produces) is stored exactly too.
  const big = 1000000000000000000000001n;
  await store.recordIssuedClaim({ userAddress: USER_A, nonce: 8, reward: big, staminaCost: 1n, deadline: 5n });
  assert.equal(BigInt((await store.getIssuedClaim(USER_A, 8)).reward), big);

  // And the submission mirror keeps the amount, so a SQL consumer can read it
  // back without going through JSON.
  await store.saveSubmission({
    sessionId: "s-1",
    userAddress: USER_A,
    missionId: "m-1",
    answers: [0],
    highlight: "h",
    typingMs: 1,
    freeText: "t",
    result: { status: "PASS", reward: BIG_REWARD, staminaCost: "1" },
  });
  const mirrored = store._raw().prepare("SELECT reward_json, stamina_cost_json FROM submissions").get();
  assert.equal(mirrored.reward_json, BIG_REWARD);
  await store.close();
});

test("uniqueness: every growth table refuses a raw duplicate INSERT in the SCHEMA", async () => {
  const { store } = await openStore();
  const db = store._raw();

  /* --- the rows a caller writes through the adapter ---------------------- */
  await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-01", amount: 10 });
  await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-01-01", missionId: "mission-1" });
  await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-01-01", amount: 25 });
  await store.saveSeason({ id: "s1", start: 100, end: 200, allocation: BIG_REWARD, claimMode: "pro-rata" });
  await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: BIG_REWARD, nonce: 5 });
  await store.recordGovernorSpend({ seasonId: "s1", dayKey: "2026-01-01", amount: BIG_REWARD });

  /* --- and now the same rows again, in RAW SQL --------------------------- */
  // Bypassing every line of JavaScript: each of these must be refused by SQLite
  // itself, because the table's key IS its primary key. A JS check would be one
  // refactor away from being skipped, and the property being defended — one row
  // per (user, day) / per user / per season id / per (season, user, nonce) — is
  // a property of the DATA.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO stamina_ledger (user_address, day_key, consumed, updated_at) VALUES (?, ?, '1', 1)")
        .run(USER_A.toLowerCase(), "2026-01-01"),
    /UNIQUE constraint failed: stamina_ledger\.user_address, stamina_ledger\.day_key/
  );
  assert.throws(
    () => db.prepare("INSERT INTO streaks (user_address, current_streak, last_graded_day) VALUES (?, 99, '2026-01-01')").run(USER_A.toLowerCase()),
    /UNIQUE constraint failed: streaks\.user_address/
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO daily_active_miners (day_key, user_address) VALUES (?, ?)")
        .run("2026-01-01", USER_A.toLowerCase()),
    /UNIQUE constraint failed: daily_active_miners\.day_key, daily_active_miners\.user_address/
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO free_stamina_grants (user_address, day_key, granted, updated_at) VALUES (?, ?, '1', 1)")
        .run(USER_A.toLowerCase(), "2026-01-01"),
    /UNIQUE constraint failed: free_stamina_grants\.user_address, free_stamina_grants\.day_key/
  );
  assert.throws(
    () => db.prepare("INSERT INTO seasons (id, start_at, end_at, allocation, claim_mode) VALUES (?, 1, 2, '1', 'x')").run("s1"),
    /UNIQUE constraint failed: seasons\.id/
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO season_claims (season_id, user_address, nonce, amount, claimed_at) VALUES (?, ?, ?, '1', 1)"
        )
        .run("s1", USER_A.toLowerCase(), "5"),
    /UNIQUE constraint failed: season_claims\.season_id, season_claims\.user_address, season_claims\.nonce/
  );
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO governor_daily_spend (season_id, day_key, spent, updated_at) VALUES (?, ?, '1', 1)")
        .run("s1", "2026-01-01"),
    /UNIQUE constraint failed: governor_daily_spend\.season_id, governor_daily_spend\.day_key/
  );

  // THE FOREIGN KEY. A spend against a season that does not exist reconciles
  // against nothing and cannot be scaled or audited, so the DATABASE refuses it
  // with raw SQL — no line of application code is involved in this insert.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO governor_daily_spend (season_id, day_key, spent, updated_at) VALUES (?, ?, '1', 1)")
        .run("s-never-created", "2026-01-01"),
    /FOREIGN KEY constraint failed/
  );
  // And through the adapter itself, which refuses an unknown season on read and
  // on write (the SQLite side additionally re-checks the FK in the database).
  await assert.rejects(() => store.getGovernorSpend({ seasonId: "s-never-created", dayKey: "2026-01-01" }), /unknown season/);
  await assert.rejects(
    () => store.recordGovernorSpend({ seasonId: "s-never-created", dayKey: "2026-01-01", amount: "1" }),
    /unknown season/
  );
  await assert.rejects(() => store.getGovernorSpendTotal({ seasonId: "s-never-created" }), /unknown season/);

  // And the originals are intact: a refused duplicate changes nothing.
  assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-01" })).consumed, "10");
  assert.equal((await store.getStreak({ userAddress: USER_A })).current, 1);
  assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-01" })).granted, "25");
  assert.equal((await store.getSeasonClaimedTotal("s1")), BIG_REWARD);
  assert.equal(await store.countActiveMiners({ dayKey: "2026-01-01" }), 1);
  assert.equal(await store.getGovernorSpend({ seasonId: "s1", dayKey: "2026-01-01" }), BIG_REWARD);
  assert.equal(await store.getGovernorSpendTotal({ seasonId: "s1" }), BIG_REWARD);

  // A DIFFERENT day is a different row, not a duplicate — the property the daily
  // stamina cap, the free-grant ledger AND the governor's daily budget all depend
  // on: a new business day is a new bucket that starts at zero, and yesterday's
  // spend can never be read as today's.
  db.prepare("INSERT INTO stamina_ledger (user_address, day_key, consumed, updated_at) VALUES (?, '2026-01-02', '7', 1)").run(
    USER_A.toLowerCase()
  );
  assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-02" })).consumed, "7");
  db.prepare("INSERT INTO governor_daily_spend (season_id, day_key, spent, updated_at) VALUES ('s1', '2026-01-02', '7', 1)").run();
  assert.equal(await store.getGovernorSpend({ seasonId: "s1", dayKey: "2026-01-02" }), "7");
  assert.equal(await store.getGovernorSpend({ seasonId: "s1", dayKey: "2026-01-01" }), BIG_REWARD, "day one is untouched");
  assert.equal(await store.getGovernorSpendTotal({ seasonId: "s1" }), (BigInt(BIG_REWARD) + 7n).toString());

  // The governor ledger and the season claimed total are DIFFERENT QUANTITIES:
  // the same 1e24 sits in both here only because both were written, and the
  // governor's per-day row has no user and no nonce to be a claim record.
  assert.equal(
    store._raw().prepare("SELECT COUNT(*) AS n FROM governor_daily_spend").get().n,
    2,
    "exactly one row per (season, day): the upsert path never leaves a duplicate"
  );

  // SQLite does NOT imply NOT NULL from a TEXT PRIMARY KEY, so a NULL address is
  // refused explicitly rather than letting every NULL user share one bucket.
  assert.throws(
    () => db.prepare("INSERT INTO streaks (user_address, current_streak) VALUES (NULL, 1)").run(),
    /NOT NULL/
  );
  await store.close();
});

test("schema: the growth migrations are additive, idempotent and applied in order", async () => {
  const filename = tempDbPath("migrations");
  const store = createSqliteStore({ filename });

  // DE-BRITTLED (was `MIGRATIONS.map((m) => m.version)` deepEqual `[1, 2, 3]`):
  // derived from SCHEMA_VERSION, so appending migration 4 (and the one after
  // that) does not turn this into a failure that has to be edited by hand.
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1),
    "migrations are append-only: one per version, no gaps, no rewrites"
  );
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1].version, SCHEMA_VERSION);
  // Never edit a shipped migration: re-running one must be a no-op, which is
  // what `IF NOT EXISTS` everywhere buys.
  const ddl = MIGRATIONS.map((m) => m.up.toString()).join("\n");
  for (const statement of ["CREATE TABLE IF NOT EXISTS", "CREATE INDEX IF NOT EXISTS"]) {
    assert.ok(ddl.includes(statement), `every DDL statement must be guarded by ${statement}`);
  }
  // No migration may drop or rewrite a shipped table.
  assert.equal(/DROP\s+TABLE/i.test(ddl), false);
  assert.equal(/ALTER\s+TABLE/i.test(ddl), false, "additive only: no column is added to or changed on an existing table");

  // Every table the growth methods read actually exists.
  const tables = store
    ._raw()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const name of [
    "stamina_ledger",
    "streaks",
    "daily_active_miners",
    "free_stamina_grants",
    "seasons",
    "season_claims",
    "governor_daily_spend",
  ]) {
    assert.ok(tables.includes(name), `missing table: ${name}`);
  }

  // countActiveMiners must not table-scan: its day lookup is index-served.
  const plan = store._raw().prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM daily_active_miners WHERE day_key = ?").all("2026-01-01");
  assert.match(JSON.stringify(plan), /daily_active_miners_day/, "the day filter must be served by an index");

  // The governor's per-day read must likewise be the (season_id, day_key) primary
  // key and not a scan of every season's every day.
  const governorPlan = store
    ._raw()
    .prepare("EXPLAIN QUERY PLAN SELECT spent FROM governor_daily_spend WHERE season_id = ? AND day_key = ?")
    .all("s1", "2026-01-01");
  assert.match(
    JSON.stringify(governorPlan),
    /sqlite_autoindex_governor_daily_spend/,
    "the (season, day) lookup must be served by the composite primary key index"
  );
  assert.equal(/SCAN governor_daily_spend/.test(JSON.stringify(governorPlan)), false, "and must never table-scan");

  // Re-opening is idempotent: the migration check runs again and changes nothing.
  const before = store._schemaVersion();
  await store.init();
  await store.init();
  assert.equal(store._schemaVersion(), before);
  await store.close();
  await store.close();
});

/* ========================================================================== */
/* 5. Address normalisation                                                   */
/* ========================================================================== */

test("addresses: lowercase and checksummed inputs round-trip to one consistent form", async () => {
  const { store } = await openStore();
  const MIXED = "0xaBcDeF0123456789aBcDeF0123456789AbCdEf01";
  const LOWER = MIXED.toLowerCase();

  await store.createSession({ sessionId: "s-1", userAddress: MIXED, missionId: "m-1" });
  assert.equal((await store.getSession("s-1")).userAddress, LOWER);

  // A claim recorded under the checksummed form is found under the lowercase
  // one, and vice versa: the memory store made these lookups case-insensitive
  // in Wave 6, and a UNIQUE constraint over mixed-case text would let the same
  // wallet mint two nonce 1s.
  await store.recordIssuedClaim({ userAddress: MIXED, nonce: 1, reward: "1", staminaCost: "1", deadline: 1 });
  assert.equal((await store.getIssuedClaim(LOWER, 1)).userAddress, LOWER);
  assert.equal((await store.getIssuedClaim(MIXED.toUpperCase().replace("0X", "0x"), 1)).nonce, 1);
  assert.equal(await store.markRelayed({ userAddress: LOWER, nonce: 1, txHash: TX_A }), true);
  assert.equal(await store.markRelayed({ userAddress: MIXED, nonce: 1, txHash: TX_B }), false);

  // The nonce counter is shared across casings: one wallet, one sequence.
  assert.equal(await store.reserveNonce(MIXED), 1);
  assert.equal(await store.reserveNonce(LOWER), 2);
  assert.equal(await store.isNonceUsed(MIXED, 2), true);
  assert.equal(await store.isNonceUsed(LOWER, 3), false);

  // And submissions are scoped case-insensitively too.
  await store.saveSubmission({ sessionId: "s-1", userAddress: MIXED, missionId: "m-1", answers: [], highlight: "", typingMs: 1, freeText: "", result: { status: "PASS" } });
  assert.equal((await store.listRecentSubmissions({ userAddress: LOWER })).length, 1);
  await store.close();
});

/* ========================================================================== */
/* 6. Ordering, appends, append-only session re-registration                  */
/* ========================================================================== */

test("ordering: telemetry keeps insertion order across batches and restarts", async () => {
  const { store, filename } = await openStore();
  await store.appendTelemetry("s-1", [
    { ts: 3, touch: { x: 3, y: 3 }, scrollDelta: 3 },
    { ts: 1, touch: { x: 1, y: 1 }, scrollDelta: 1 },
  ]);
  await store.appendTelemetry("s-1", [{ ts: 2, touch: { x: 2, y: 2 }, scrollDelta: 2 }]);
  // Out-of-order timestamps must NOT reorder the samples: the record is the
  // Proof-of-Attention history, in the order it was received.
  assert.deepEqual((await store.getTelemetry("s-1")).map((s) => s.ts), [3, 1, 2]);
  assert.deepEqual((await store.getTelemetry("s-1")).map((s) => s.touch), [{ x: 3, y: 3 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
  await store.close();

  const reopened = createSqliteStore({ filename });
  assert.deepEqual((await reopened.getTelemetry("s-1")).map((s) => s.ts), [3, 1, 2], "order must survive a re-open");
  // Appending after a re-open continues the sequence rather than restarting it.
  await reopened.appendTelemetry("s-1", [{ ts: 4, touch: { x: 4, y: 4 } }]);
  assert.deepEqual((await reopened.getTelemetry("s-1")).map((s) => s.ts), [3, 1, 2, 4]);
  assert.deepEqual(await reopened.getTelemetry("s-never"), []);
  await reopened.close();
});

test("ordering: listRecentSubmissions is newest-first and spans all users", async () => {
  const { store } = await openStore();
  const save = (user, text) =>
    store.saveSubmission({ sessionId: "s-1", userAddress: user, missionId: "m-1", answers: [0], highlight: "h", typingMs: 1, freeText: text, result: { status: "PASS" } });
  const first = await save(USER_A, "a");
  const second = await save(USER_B, "b");
  const third = await save(USER_A, "c");

  const all = await store.listRecentSubmissions({ limit: 10 });
  assert.deepEqual(all.map((row) => row.id), [third.id, second.id, first.id], "newest first");
  // Omitting userAddress spans ALL users: syndicate detection depends on it.
  assert.deepEqual([...new Set(all.map((row) => row.userAddress))].sort(), [USER_A, USER_B].sort());
  assert.deepEqual((await store.listRecentSubmissions({ userAddress: USER_A })).map((row) => row.freeText), ["c", "a"]);
  assert.deepEqual((await store.listRecentSubmissions({ userAddress: USER_B })).map((row) => row.freeText), ["b"]);
  assert.equal((await store.listRecentSubmissions({ limit: 2 })).length, 2);
  assert.equal((await store.listRecentSubmissions({})).length, 3);
  assert.equal((await store.listRecentSubmissions({ limit: 0 })).length, 3, "a nonsensical limit falls back to the default");
  await store.close();
});

/* ========================================================================== */
/* 6b. The exclusive address filter (`excludeUserAddress`)                     */
/* ========================================================================== */

/**
 * Runs the whole `excludeUserAddress` specification against ONE adapter and
 * returns what it saw, so the identical script can be run against both and
 * compared. The fixture is four submissions across three addresses plus one
 * with no address at all, inserted oldest-first: A, B, A, C, (null).
 *
 * The parameter exists for residual risk #3: the syndicate corpus must be the
 * recent submissions of OTHER users, or an honest user who writes the same
 * summary twice is compared against their own text and refused.
 */
async function exclusionScript(store) {
  const save = (user, text) =>
    store.saveSubmission({
      sessionId: "s-1",
      userAddress: user,
      missionId: "m-1",
      answers: [0],
      highlight: "h",
      typingMs: 1,
      freeText: text,
      result: { status: "PASS" },
    });
  await save(USER_A, "a1");
  await save(USER_B, "b1");
  await save(USER_A, "a2");
  await save(USER_C, "c1");
  await save(null, "anon");

  const texts = async (params) => (await store.listRecentSubmissions(params)).map((row) => row.freeText);

  return {
    neither: await texts({ limit: 10 }),
    includeOnly: await texts({ userAddress: USER_A, limit: 10 }),
    excludeOnly: await texts({ excludeUserAddress: USER_A, limit: 10 }),
    bothSameAddress: await texts({ userAddress: USER_A, excludeUserAddress: USER_A, limit: 10 }),
    bothDistinct: await texts({ userAddress: USER_A, excludeUserAddress: USER_B, limit: 10 }),
    excludeUnknown: await texts({ excludeUserAddress: "0x9999999999999999999999999999999999999999", limit: 10 }),
    excludeUnlimited: await texts({ excludeUserAddress: USER_A }),
    excludeLimit1: await texts({ excludeUserAddress: USER_A, limit: 1 }),
    excludeLimit2: await texts({ excludeUserAddress: USER_A, limit: 2 }),
    includeLimit1: await texts({ userAddress: USER_A, limit: 1 }),
    limit0FallsBack: (await texts({ excludeUserAddress: USER_A, limit: 0 })).length,
    emptyStoreShape: (await texts({ excludeUserAddress: undefined, limit: 10 })).length,
  };
}

test("excludeUserAddress: all four filter combinations behave exactly as specified", async () => {
  const { store } = await openStore();
  const seen = await exclusionScript(store);

  // NEITHER filter: everyone, newest first. The pre-existing behaviour, which
  // every other caller (and the relay/debug views) depends on.
  assert.deepEqual(seen.neither, ["anon", "c1", "a2", "b1", "a1"], "no filter spans ALL users, newest first");

  // `userAddress` ALONE: "ONLY this user". Unchanged from before this parameter
  // existed.
  assert.deepEqual(seen.includeOnly, ["a2", "a1"], "the inclusive filter returns only that user's rows");

  // `excludeUserAddress` ALONE: "everyone BUT this user" — THE SYNDICATE CASE.
  // An anonymous row belongs to nobody, so it is nobody's own history and it is
  // kept, exactly as the memory adapter keeps it.
  assert.deepEqual(seen.excludeOnly, ["anon", "c1", "b1"], "the exclusive filter returns every OTHER user");

  // BOTH, same address: DEGENERATE and honestly empty. Not "that user's rows"
  // (which would invert the caller's intent) and not "everyone" (which would
  // leak the very history the caller excluded).
  assert.deepEqual(seen.bothSameAddress, [], "userAddress === excludeUserAddress is the empty set, not a fallback");

  // BOTH, different addresses: composable, and the exclusion is a no-op because
  // no row can be both.
  assert.deepEqual(seen.bothDistinct, ["a2", "a1"], "two distinct addresses compose to that user's rows");

  // Excluding an address nobody has used is harmless.
  assert.deepEqual(seen.excludeUnknown, ["anon", "c1", "a2", "b1", "a1"], "an unused exclusion changes nothing");

  // A row with NO recorded address: kept by the exclusive filter (it is nobody's
  // own history) and dropped by the inclusive one (it is nobody's rows).
  assert.equal(seen.emptyStoreShape, 5);
  await store.close();
});

test("excludeUserAddress: newest-first ordering and limit still hold AFTER filtering", async () => {
  const { store } = await openStore();
  const seen = await exclusionScript(store);

  // The limit counts rows the caller ACTUALLY RECEIVES. A naive implementation
  // that takes the newest 50 rows and then discards the caller's own would hand
  // back fewer than the limit asked for — here it does not, and that is the
  // property that keeps the corpus the full size of the window.
  assert.deepEqual(seen.excludeUnlimited, ["anon", "c1", "b1"], "an omitted limit falls back to the default");
  assert.deepEqual(seen.excludeLimit1, ["anon"], "limit 1 after filtering returns the newest SURVIVING row");
  assert.deepEqual(seen.excludeLimit2, ["anon", "c1"], "and limit 2 the two newest surviving rows");
  assert.deepEqual(seen.includeLimit1, ["a2"], "the same holds for the inclusive filter");

  // The order is newest-first by (submitted_at, id) with the excluded address
  // removed, NOT the raw newest-N-with-holes-in-it. `c1` is the 4th submission
  // overall but the 2nd newest surviving row, which is the difference.
  assert.equal(seen.excludeLimit2[0], "anon");
  assert.equal(seen.excludeLimit2[1], "c1");

  // A nonsensical limit still falls back to the default rather than returning nothing.
  assert.equal(seen.limit0FallsBack, 3, "limit 0 falls back to the default, applied after filtering");
  await store.close();
});

test("excludeUserAddress: case differences must not let a user back into their own corpus", async () => {
  // A user may present the checksummed form it was given while another call site
  // stores the lowercase form. They are the same wallet, and a case-sensitive
  // exclusion would let their own earlier answer back into their own corpus —
  // residual risk #3 reintroduced through address casing.
  const MIXED_A = "0xaBcDeF0123456789aBcDeF0123456789AbCdEf01";
  for (const store of [createMemoryStore(), createSqliteStore({ filename: tempDbPath("casing") })]) {
    await store.saveSubmission({
      sessionId: "s-1",
      userAddress: MIXED_A,
      missionId: "m-1",
      answers: [0],
      highlight: "h",
      typingMs: 1,
      freeText: "mine",
      result: { status: "PASS" },
    });
    await store.saveSubmission({
      sessionId: "s-2",
      userAddress: USER_B,
      missionId: "m-1",
      answers: [0],
      highlight: "h",
      typingMs: 1,
      freeText: "theirs",
      result: { status: "PASS" },
    });

    assert.equal(
      (await store.listRecentSubmissions({ excludeUserAddress: MIXED_A.toLowerCase() })).length,
      1,
      "a lowercase exclusion must remove the checksummed row"
    );
    assert.equal(
      (await store.listRecentSubmissions({ excludeUserAddress: MIXED_A })).length,
      1,
      "and a checksummed exclusion must remove it too"
    );
    assert.equal(
      (await store.listRecentSubmissions({ excludeUserAddress: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01" })).length,
      1,
      "including the fully upper-cased form"
    );
    assert.equal((await store.listRecentSubmissions({ userAddress: MIXED_A.toLowerCase() })).length, 1);
    await store.close();
  }
});

test("excludeUserAddress: memory and sqlite return IDENTICAL views of the same script", async () => {
  const memory = createMemoryStore();
  const sqlite = createSqliteStore({ filename: tempDbPath("parity-exclude") });
  await sqlite.init();

  const [a, b] = [await exclusionScript(memory), await exclusionScript(sqlite)];
  assert.deepEqual(b, a, "the two adapters disagreed about excludeUserAddress");

  // Named again, so a failure says WHICH combination broke.
  assert.deepEqual(b.excludeOnly, ["anon", "c1", "b1"], "the syndicate corpus is identical in both adapters");
  assert.deepEqual(b.bothSameAddress, [], "and the degenerate composition is identical in both");
  assert.deepEqual(b.includeOnly, a.includeOnly);
  assert.deepEqual(b.neither, a.neither, "the unfiltered listing is unchanged in both");

  await sqlite.close();
});

test("sessions: a repeat createSession never wipes telemetry, and fill-in is allowed", async () => {
  const { store } = await openStore();
  await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "m-1" });
  await store.appendTelemetry("s-1", [{ ts: 1 }, { ts: 2 }]);
  const again = await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "m-2" });
  assert.equal((await store.getTelemetry("s-1")).length, 2, "telemetry must survive re-registration");
  assert.equal(again.missionId, "m-1", "an existing mission id is not overwritten");
  assert.equal(again.userAddress, USER_A);
  // A session that exists only because telemetry arrived can still be completed.
  await store.appendTelemetry("s-auto", [{ ts: 1 }]);
  const filled = await store.createSession({ sessionId: "s-auto", userAddress: USER_A, missionId: "m-1" });
  assert.equal(filled.missionId, "m-1");
  // The USER is deliberately not back-filled, because the memory store does not
  // back-fill it either: parity is the whole point of this adapter, and
  // attributing a session to a wallet here would be a judging decision the
  // store has no business making (the HTTP layer owns the 409 case).
  assert.equal(filled.userAddress, null);
  assert.equal((await store.getTelemetry("s-auto")).length, 1);
  await store.close();
});

/* ========================================================================== */
/* 7. Lifecycle                                                               */
/* ========================================================================== */

test("lifecycle: close() is safe twice, dispose() works, and calls after close throw", async () => {
  const { store } = await openStore();
  await store.close();
  await store.close();
  await store.dispose();
  await store.dispose();
  assert.equal(store._raw().open, false, "the handle must really be released");

  // ":memory:" is supported for throwaway databases.
  const ephemeral = createSqliteStore({ filename: ":memory:" });
  await ephemeral.init();
  await ephemeral.createSession({ sessionId: "s", userAddress: USER_A, missionId: "m" });
  assert.equal((await ephemeral.getSession("s")).userAddress, USER_A);
  await ephemeral.close();
});

test("lifecycle: the default database path is outside the repository", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  assert.equal(typeof DEFAULT_SQLITE_PATH, "string");
  assert.ok(DEFAULT_SQLITE_PATH.length > 0);
  assert.equal(
    DEFAULT_SQLITE_PATH.startsWith(repoRoot + path.sep),
    false,
    "the default database must not live inside the repository working tree"
  );
  assert.equal(path.isAbsolute(DEFAULT_SQLITE_PATH), true, "an absolute default is unambiguous from any cwd");
  assert.match(DEFAULT_SQLITE_PATH, /catt-judge/, "the default lives in its own dedicated directory");
});

test("lifecycle: a file written by a newer schema is refused rather than opened", async () => {
  const filename = tempDbPath("future");
  const store = createSqliteStore({ filename });
  // Simulate a database left behind by a newer build of the Judge.
  store._raw().pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  store.close();
  assert.throws(
    () => createSqliteStore({ filename }),
    /newer Judge/,
    "an older binary must never write rows into a newer schema"
  );
});
