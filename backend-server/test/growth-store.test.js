/**
 * CATT Protocol — the growth-store ledgers: per-day stamina spend, streaks,
 * free-stamina grants, seasons and their claims, and the daily active-miner
 * count.
 *
 * WHAT THIS FILE IS PROVING, in order of how much it matters:
 *
 *   1. THE UNIT. `content.js` seeded stamina costs in 18-decimal CATT base units
 *      while `StakingManager.sol` states that stamina "is unitless and has no
 *      monetary value" and `STAMINA_PER_STAKE = 50`. A cost of `1e18` needs
 *      `1e18 / 50 = 2e16` successful stakes to cover, so no claim could settle and
 *      realised emission was 0. The seed now says 10 / 20 / 30 POINTS and this
 *      file proves the whole system treats them as points: the guards reject the
 *      old values, the cheapest mission is coverable, and the two units are never
 *      conflated anywhere downstream.
 *
 *   2. THE DAY KEY IS A PARAMETER. Every day-scoped method takes a
 *      caller-supplied `YYYY-MM-DD`. The store never reads a clock, which is why
 *      a ten-day streak, a leap day and a month rollover are all ordinary cases
 *      here instead of things a test has to wait for — and why two Judge
 *      processes cannot disagree about which bucket an event lands in.
 *
 *   3. THE ADAPTERS ARE INTERCHANGEABLE. `assertStoreShape` for both, a
 *      memory-vs-SQLite parity run over every new method, raw-SQL duplicate
 *      inserts refused BY THE SCHEMA (not by JavaScript), and durability across
 *      a real process boundary with `user_version` proving which schema the child
 *      read.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: any economic value. No reward, no
 * season split, no multiplier and no free-stamina amount is set or checked by
 * this file. The ledgers count; what counting is worth is another module's
 * decision.
 *
 * `node:test` + `node:assert/strict` only: no test framework dependency.
 */

"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const content = require("../src/content");
const { createSqliteStore, SCHEMA_VERSION } = require("../src/sqlite-store");
const {
  createMemoryStore,
  assertStoreShape,
  STORAGE_METHODS,
  normalizeDayKey,
  isNextDayAfter,
} = require("../src/storage");

const USER_A = "0x1111111111111111111111111111111111111111";
const USER_B = "0x2222222222222222222222222222222222222222";
const USER_C = "0x3333333333333333333333333333333333333333";
const MIXED = "0xaBcDeF0123456789aBcDeF0123456789AbCdEf01";

/** Well beyond 2^53 (9007199254740992), so a lossy round trip would show. */
const HUGE = "9007199254740993";
/** 1e24: out of range for a signed 64-bit SQLite INTEGER, not merely imprecise. */
const HUGE_CATT = "1000000000000000000000001";

/** Every temp directory this file created, removed in `after`. */
const tempDirs = [];

/**
 * A throwaway directory under the OS temp dir and a database path inside it.
 * NEVER inside the repository: the database holds wallet data, and a test that
 * leaves one in a checkout teaches operators to commit one.
 *
 * @param {string} [label] Recognisable suffix.
 * @returns {string} An absolute path to a not-yet-created `.db` file.
 */
function tempDbPath(label = "growth") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catt-growth-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, "judge.db");
}

/** Removes every temp directory, so no `.db`, `-wal` or `-shm` is ever left behind. */
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Opens a SQLite store on a fresh temp database. */
async function openStore(label) {
  const store = createSqliteStore({ filename: tempDbPath(label) });
  await store.init();
  return store;
}

/**
 * Runs `body` against a memory store and a SQLite store, in that order.
 *
 * Every behavioural test in this file is written through this helper so that no
 * assertion can accidentally hold for one adapter only.
 *
 * @param {string} label Temp-directory label.
 * @param {(store: Object) => Promise<void>} body The assertions.
 * @returns {Promise<void>}
 */
async function bothAdapters(label, body) {
  const memory = createMemoryStore();
  await memory.init();
  await body(memory);
  const sqlite = await openStore(label);
  try {
    await body(sqlite);
  } finally {
    await sqlite.close();
  }
}

/* ========================================================================== */
/* 1. Interface                                                               */
/* ========================================================================== */

test("interface: both adapters implement every STORAGE_METHODS name, including the growth ledgers", async () => {
  const memory = createMemoryStore();
  const sqlite = await openStore("shape");
  try {
    for (const store of [memory, sqlite]) {
      assert.equal(assertStoreShape(store), store, "assertStoreShape returns the store it accepted");
      for (const name of STORAGE_METHODS) {
        assert.equal(typeof store[name], "function", `missing method: ${name}`);
      }
    }
    // The growth methods are part of the CONTRACT, not an optional extra: an
    // adapter that forgot one must fail at boot, not at the first claim.
    const growth = [
      "getStaminaConsumed",
      "recordStaminaConsumption",
      "getStreak",
      "recordGradedCompletion",
      "getFreeStaminaGranted",
      "recordFreeStaminaGrant",
      "getSeason",
      "saveSeason",
      "getActiveSeason",
      "recordSeasonClaim",
      "getSeasonClaimedTotal",
      "getSeasonUserAccrued",
      "isSeasonClaimUsed",
      "countActiveMiners",
    ];
    for (const name of growth) {
      assert.ok(STORAGE_METHODS.includes(name), `${name} must be in STORAGE_METHODS`);
    }
    const incomplete = { ...STORAGE_METHODS };
    for (const name of growth) delete incomplete[name];
    for (const name of Object.keys(incomplete)) incomplete[name] = () => {};
    assert.throws(() => assertStoreShape(incomplete), /missing required method\(s\)/);
  } finally {
    await sqlite.close();
  }
});

/* ========================================================================== */
/* 2. The stamina unit                                                        */
/* ========================================================================== */

test("unit: the seeded stamina costs are unitless POINTS, not 18-decimal CATT amounts", () => {
  const missions = content.listMissions();
  assert.deepEqual(
    missions.map((m) => [m.id, m.staminaCost]),
    [
      ["mission-1", 10],
      ["mission-2", 20],
      ["mission-3", 30],
    ],
    "10 / 20 / 30 stamina points"
  );
  for (const mission of missions) {
    assert.ok(
      Number.isSafeInteger(mission.staminaCost),
      `${mission.id}: a plain safe integer — the reachable range is single-digit, so Number is lossless`
    );
    // The reward keeps the OTHER unit: an 18-decimal decimal string.
    assert.match(mission.reward, /^\d+$/, `${mission.id}: reward is base units`);
    assert.ok(BigInt(mission.reward) > 1000000000000000000n, `${mission.id}: reward is wei-scaled`);
    assert.notEqual(
      String(mission.staminaCost),
      mission.reward,
      "the two units must never be the same value"
    );
  }
  // The article mirrors the mission exactly — the board and the reader cannot
  // disagree about what a mission costs.
  for (const mission of missions) {
    assert.equal(content.getArticle(mission.articleId).staminaCost, mission.staminaCost);
  }
});

test("unit: the cheapest mission is COVERABLE, which is what the unit fix bought", () => {
  // STAMINA_PER_STAKE = 50 in StakingManager.sol. Under the old CATT-denominated
  // cost the cheapest mission needed 1e18 / 50 = 2e16 successful stakes, so no
  // account could ever hold enough and NO claim could settle.
  const STAMINA_PER_STAKE = 50;
  const cheapest = Math.min(...content.listMissions().map((m) => m.staminaCost));
  const stakesNeeded = Math.ceil(cheapest / STAMINA_PER_STAKE);
  assert.equal(stakesNeeded, 1, "one successful stake covers the cheapest mission");
  assert.ok(
    cheapest < STAMINA_PER_STAKE,
    "a mission must cost less than one stake's worth of stamina, or it is unclaimable on day one"
  );
});

test("unit: the authoring guard rejects the OLD CATT-denominated values, as numbers AND as strings", () => {
  // The wave-8 `staminaCost > 0` guard could not catch this: all three old values
  // are strictly positive. `MAX_STAMINA_COST_POINTS` is the magnitude half of the
  // guard, and this is its regression test.
  for (const bad of ["1000000000000000000", "2000000000000000000", "3000000000000000000"]) {
    assert.throws(
      () => content.validateMission({ ...content.listMissions()[0], staminaCost: bad }, { articles: content.ARTICLES }),
      (err) => err.field === "staminaCost" && /POINTS/.test(err.message),
      `the string ${bad} must be rejected as a unit error, not accepted as "positive"`
    );
    assert.throws(
      () => content.validateArticle({ ...content.getArticle("art-focus-101"), staminaCost: bad }, { missions: content.MISSIONS }),
      (err) => err.field === "staminaCost"
    );
  }
  for (const bad of [1e18, 2e18, 3e18, BigInt("1000000000000000000")]) {
    assert.throws(
      () => content.validateMission({ ...content.listMissions()[0], staminaCost: bad }, { articles: content.ARTICLES }),
      (err) => err.field === "staminaCost"
    );
  }
});

test("unit: the wave-8 staminaCost > 0 guard is STILL green", () => {
  // Zero, negative and non-integer costs must all still be refused. The unit fix
  // widened the guard; it must not have weakened it.
  for (const bad of ["0", 0, -1, -1n, "-1", "-1000000000000000000", -1000000000000000000]) {
    assert.throws(
      () => content.validateMission({ ...content.listMissions()[0], staminaCost: bad }, { articles: content.ARTICLES }),
      (err) => err.field === "staminaCost" && /ZeroAmount/.test(err.message),
      `${String(bad)} must be rejected`
    );
  }
  for (const bad of [1.5, "1.5", "abc", "", " ", NaN, Infinity, -Infinity, true, {}, [], null, undefined]) {
    assert.throws(
      () => content.validateMission({ ...content.listMissions()[0], staminaCost: bad }, { articles: content.ARTICLES }),
      (err) => err.field === "staminaCost",
      `${String(bad)} must be rejected as a non-integer`
    );
  }
  // The guard is not vacuous: ordinary point values still pass.
  for (const good of [1, 10, "10", 30, content.MAX_STAMINA_COST_POINTS]) {
    assert.equal(
      content.validateMission({ ...content.listMissions()[0], staminaCost: good }, { articles: content.ARTICLES }).staminaCost,
      good
    );
  }
});

/* ========================================================================== */
/* 3. The daily spend cap, the policy hook and the day key                     */
/* ========================================================================== */

test("cap: DEFAULT_DAILY_STAMINA_CAP is STAMINA_PER_STAKE and is a THROTTLE, not a confiscation", () => {
  const STAMINA_PER_STAKE = 50;
  assert.equal(content.DEFAULT_DAILY_STAMINA_CAP, STAMINA_PER_STAKE);
  // The mixed-average stamina cost of the seeded board: 0.6x10 + 0.3x20 + 0.1x30.
  const mixedAverage = 0.6 * 10 + 0.3 * 20 + 0.1 * 30;
  assert.equal(mixedAverage, 15);
  assert.ok(
    Math.abs(content.DEFAULT_DAILY_STAMINA_CAP / mixedAverage - 3.3) < 0.05,
    "the cap is ~3.3 mixed missions a day"
  );
});

test("cap: the policy admits up to the cap, refuses past it, and `cap: null` disables it", () => {
  const policy = content.createStaminaPolicy();
  assert.equal(policy.cap, content.DEFAULT_DAILY_STAMINA_CAP);
  assert.equal(policy.enabled, true);

  // A fresh day: the cheapest mission fits.
  assert.equal(policy.admits({ consumed: 0, amount: 10 }).allowed, true);
  // Exactly at the cap is allowed — the cap is inclusive.
  assert.equal(policy.admits({ consumed: 40, amount: 10 }).allowed, true);
  assert.equal(policy.remaining({ consumed: 40 }), 10);
  // One point past the cap is refused.
  const refused = policy.admits({ consumed: 45, amount: 10 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 5);
  // Two HARD missions (60) exceed the whole cap.
  assert.equal(policy.admits({ consumed: 0, amount: 60 }).allowed, false);
  // Overspending never reports a negative allowance.
  assert.equal(policy.remaining({ consumed: 500 }), 0);

  // `cap: null` disables the throttle entirely: no allowance concept at all.
  const off = content.createStaminaPolicy({ cap: null });
  assert.equal(off.enabled, false);
  assert.equal(off.cap, null);
  assert.equal(off.remaining({ consumed: 10 ** 9 }), null);
  assert.equal(off.admits({ consumed: 10 ** 9, amount: 30 }).allowed, true);

  // The policy is frozen and stateless: two calls with the same input agree, and
  // nothing about a user survives between them.
  assert.ok(Object.isFrozen(policy));
  assert.deepEqual(policy.admits({ consumed: 20, amount: 20 }), policy.admits({ consumed: 20, amount: 20 }));

  // A cap is an integer point count; anything else is a programming error.
  for (const bad of [-1, 1.5, NaN, "abc", {}]) {
    assert.throws(() => content.createStaminaPolicy({ cap: bad }), TypeError);
  }
});

test("dayKey: dayKeyFor is the WIB BUSINESS day (04:00 WIB = 21:00 UTC), timezone-immune, and reads no clock itself", () => {
  // !! BEHAVIOUR CHANGE: the day used to roll at 00:00 UTC. It now rolls at
  // 04:00 WIB, which is 21:00 UTC of the PREVIOUS UTC date, because WIB is a
  // fixed UTC+7 with no DST. So an instant between 21:00:00Z and 23:59:59Z
  // names TOMORROW's date. See `src/reset-schedule.js` and
  // `test/reset-schedule.test.js` for the full rule; the cases below are the
  // instants whose expected keys moved.
  //
  // Inside a business day (before 21:00Z) the key is the UTC date, unchanged.
  assert.equal(content.dayKeyFor(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01-01");
  assert.equal(content.dayKeyFor(new Date("2026-01-01T12:00:00.000Z")), "2026-01-01");
  assert.equal(content.dayKeyFor(new Date("2026-02-01T00:00:00.000Z")), "2026-02-01");
  assert.equal(content.dayKeyFor(new Date("2024-02-29T12:00:00.000Z")), "2024-02-29");
  // 23:59:59.999 UTC is 03:00 WIB the NEXT morning: still the day it names.
  assert.equal(content.dayKeyFor(new Date("2026-01-01T23:59:59.999Z")), "2026-01-02");
  // A month boundary, a year boundary and the leap day, at the 21:00 rollover.
  assert.equal(content.dayKeyFor(new Date("2026-01-31T20:59:59.999Z")), "2026-01-31");
  assert.equal(content.dayKeyFor(new Date("2026-01-31T21:00:00.000Z")), "2026-02-01");
  assert.equal(content.dayKeyFor(new Date("2025-12-31T20:59:59.999Z")), "2025-12-31");
  assert.equal(content.dayKeyFor(new Date("2025-12-31T21:00:00.000Z")), "2026-01-01");
  assert.equal(content.dayKeyFor(new Date("2026-01-01T00:00:00.000Z")), "2026-01-01");
  // The clock is injected, never defaulted: calling it with no argument is an
  // error, because `new Date()` inside a pure module is a clock read.
  for (const bad of [undefined, null, "2026-01-01", NaN, new Date("nonsense")]) {
    assert.throws(() => content.dayKeyFor(bad), TypeError);
  }
});

test("dayKey: normalizeDayKey accepts only a real UTC calendar day; isNextDayAfter handles every boundary", () => {
  assert.equal(normalizeDayKey(" 2026-01-01 "), "2026-01-01");
  for (const bad of ["2026-1-1", "20260101", "2026-01-01T00:00:00Z", "", "today", 20260101, null, undefined]) {
    assert.throws(() => normalizeDayKey(bad), TypeError, `${String(bad)} must be refused`);
  }
  // A well-formed string that names no real day is refused too, because a
  // ledger bucket keyed by it is one nothing can ever roll over into.
  for (const bad of ["2026-02-30", "2026-13-01", "2025-02-29", "2026-00-10", "2026-01-32"]) {
    assert.throws(() => normalizeDayKey(bad), TypeError, `${bad} is not a real UTC day`);
  }
  // 2024 is a leap year and 2023 is not, which is the whole point.
  assert.equal(isNextDayAfter("2024-02-28", "2024-02-29"), true);
  assert.equal(isNextDayAfter("2023-02-28", "2023-03-01"), true);
  // 2023 is not a leap year, so "2023-02-29" names no day at all — and it is
  // refused as a day key rather than being treated as March 1st.
  assert.throws(() => isNextDayAfter("2023-02-28", "2023-02-29"), TypeError);
  assert.equal(isNextDayAfter("2024-12-31", "2025-01-01"), true);
  assert.equal(isNextDayAfter("2026-01-31", "2026-02-01"), true);
  assert.equal(isNextDayAfter("2024-02-28", "2024-03-01"), false, "a leap day is in between");
  assert.equal(isNextDayAfter("2026-01-01", "2026-01-02"), true);
  assert.equal(isNextDayAfter("2026-01-02", "2026-01-01"), false, "the relation is direction-sensitive");
  assert.equal(isNextDayAfter("2026-01-01", "2026-01-01"), false);
  assert.equal(isNextDayAfter("2026-01-01", "2026-01-05"), false, "a gap is not a rollover");
});

/* ========================================================================== */
/* 4. The per-day stamina ledger                                              */
/* ========================================================================== */

test("stamina ledger: accumulates within a day, resets across days, and is exact above 2^53", async () => {
  await bothAdapters("stamina", async (store) => {
    // An untouched day reads as exactly zero, as a canonical decimal string.
    assert.deepEqual(await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-01" }), {
      userAddress: USER_A,
      dayKey: "2026-01-01",
      consumed: "0",
    });

    // ACCUMULATES, never replaces: three claims in one day sum.
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-01", amount: 10 })).consumed, "10");
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-01", amount: 20 })).consumed, "30");
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-01", amount: 30 })).consumed, "60");
    assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-01" })).consumed, "60");

    // DAY RESET: tomorrow starts at zero, and yesterday is untouched by it. This
    // is what makes the daily cap a throttle instead of a lifetime budget — and
    // what makes unspent stamina roll over instead of being confiscated.
    assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-02" })).consumed, "0");
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-02", amount: 5 })).consumed, "5");
    assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-01-01" })).consumed, "60");

    // >2^53 EXACTNESS: 2^53 + 1 cannot survive a JS number, and 1e24 cannot
    // survive a signed 64-bit SQLite INTEGER. Both are returned exactly.
    const hugeDay = "2026-02-01";
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_B, dayKey: hugeDay, amount: HUGE })).consumed, HUGE);
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_B, dayKey: hugeDay, amount: HUGE })).consumed, "18014398509481986");
    const expectedTotal = (2n * BigInt(HUGE) + BigInt(HUGE_CATT)).toString();
    assert.equal((await store.recordStaminaConsumption({ userAddress: USER_B, dayKey: hugeDay, amount: HUGE_CATT })).consumed, expectedTotal);
    const read = await store.getStaminaConsumed({ userAddress: USER_B, dayKey: hugeDay });
    assert.equal(typeof read.consumed, "string", "an amount column is text, so exactness is not a coincidence of magnitude");
    assert.equal(BigInt(read.consumed), BigInt(expectedTotal));

    // PER-USER ISOLATION: one wallet's spending is never another's.
    assert.equal((await store.getStaminaConsumed({ userAddress: USER_C, dayKey: "2026-01-01" })).consumed, "0");

    // Case-insensitive, like every other address in this store.
    assert.equal((await store.recordStaminaConsumption({ userAddress: MIXED, dayKey: "2026-01-01", amount: 7 })).consumed, "7");
    assert.equal((await store.getStaminaConsumed({ userAddress: MIXED.toUpperCase().replace("0X", "0x"), dayKey: "2026-01-01" })).consumed, "7");
    assert.equal((await store.getStaminaConsumed({ userAddress: MIXED.toLowerCase(), dayKey: "2026-01-01" })).consumed, "7");

    // A malformed amount or day key is refused identically in both adapters,
    // rather than silently creating a junk bucket. The store methods are async, so
    // the refusal is a REJECTION — and it must be a rejection in both, not a
    // synchronous throw in one and a rejection in the other.
    for (const bad of [-1, 1.5, "1.5", "abc", NaN, null, undefined, {}, "-1"]) {
      await assert.rejects(
        () => store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-01-01", amount: bad }),
        TypeError,
        `amount ${String(bad)} must be refused`
      );
    }
    for (const bad of ["2026-02-30", "not-a-day", 20260101]) {
      await assert.rejects(
        () => store.getStaminaConsumed({ userAddress: USER_A, dayKey: bad }),
        TypeError,
        `dayKey ${String(bad)} must be refused`
      );
    }
  });
});

/* ========================================================================== */
/* 5. Streaks — mechanics only, no cap                                         */
/* ========================================================================== */

test("streak: all four cases, and NO cap is applied at write time", async () => {
  await bothAdapters("streak", async (store) => {
    // Never completed anything: 0, distinguishable from a streak of 1.
    assert.deepEqual(await store.getStreak({ userAddress: USER_A }), {
      userAddress: USER_A,
      current: 0,
      lastGradedDay: null,
    });

    // CASE 1 — first ever -> 1.
    assert.deepEqual(await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-01", reward: "12000000000000000000", missionId: "mission-1" }), {
      userAddress: USER_A,
      current: 1,
      lastGradedDay: "2026-03-01",
    });

    // CASE 2 — the SAME day again -> unchanged. Two missions in one calendar day
    // must not be two streak days.
    assert.deepEqual(await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-01", missionId: "mission-3" }), {
      userAddress: USER_A,
      current: 1,
      lastGradedDay: "2026-03-01",
    });
    assert.deepEqual(await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-01" }), {
      userAddress: USER_A,
      current: 1,
      lastGradedDay: "2026-03-01",
    });

    // CASE 3 — the IMMEDIATE NEXT calendar day -> +1. Real UTC rollover, so the
    // month boundary below is not a special case.
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-02" })).current, 2);
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-03" })).current, 3);
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-04" })).current, 4);

    // CASE 4a — a GAP resets to 1.
    assert.deepEqual(await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-10" }), {
      userAddress: USER_A,
      current: 1,
      lastGradedDay: "2026-03-10",
    });

    // CASE 4b — a RETROACTIVE earlier day also resets to 1. Back-filling an old
    // day is not "yesterday"; honouring it would reconstruct a streak that never
    // happened.
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-08" })).current, 1);
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-03-09" })).current, 2, "and the chain restarts from there");
    assert.equal((await store.getStreak({ userAddress: USER_A })).lastGradedDay, "2026-03-09");

    // Per-user isolation.
    assert.equal((await store.getStreak({ userAddress: USER_B })).current, 0);
    assert.equal((await store.recordGradedCompletion({ userAddress: USER_B, dayKey: "2026-03-10" })).current, 1);

    // Case-insensitive like every other address key.
    assert.equal((await store.recordGradedCompletion({ userAddress: MIXED.toUpperCase().replace("0X", "0x"), dayKey: "2026-03-10" })).current, 1);
    assert.equal((await store.getStreak({ userAddress: MIXED.toLowerCase() })).current, 1);
  });
});

test("streak: a ten-day run reads back as 10 — the store does NOT cap", async () => {
  await bothAdapters("streak-10", async (store) => {
    // Real consecutive UTC days across a month boundary, ending on a leap day.
    const days = [
      "2024-02-26",
      "2024-02-27",
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
      "2024-03-02",
      "2024-03-03",
      "2024-03-04",
      "2024-03-05",
      "2024-03-06",
    ];
    let last = 0;
    for (const dayKey of days) {
      last = (await store.recordGradedCompletion({ userAddress: USER_A, dayKey, reward: "12000000000000000000", missionId: "mission-1" })).current;
    }
    assert.equal(last, 10, "no cap is baked in at write time");
    assert.deepEqual(await store.getStreak({ userAddress: USER_A }), {
      userAddress: USER_A,
      current: 10,
      lastGradedDay: "2024-03-06",
    });
  });
});

/* ========================================================================== */
/* 6. Free-stamina grants — day isolation                                      */
/* ========================================================================== */

test("free grants: accumulate within a day and NEVER leak into the next one", async () => {
  await bothAdapters("free", async (store) => {
    assert.deepEqual(await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-05-01" }), {
      userAddress: USER_A,
      dayKey: "2026-05-01",
      granted: "0",
    });
    assert.equal((await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-05-01", amount: 25 })).granted, "25");
    assert.equal((await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-05-01", amount: 25 })).granted, "50");

    // DAY ISOLATION: day B starts at zero even though day A granted the same
    // user the same amount. This is the property that lets a daily grant be
    // replayed or audited one day at a time.
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-05-02" })).granted, "0");
    assert.equal((await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-05-02", amount: 10 })).granted, "10");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-05-01" })).granted, "50", "day A is untouched");

    // Per-user isolation, and case-insensitivity.
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_B, dayKey: "2026-05-01" })).granted, "0");
    assert.equal((await store.recordFreeStaminaGrant({ userAddress: MIXED, dayKey: "2026-05-01", amount: 5 })).granted, "5");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: MIXED.toLowerCase(), dayKey: "2026-05-01" })).granted, "5");

    // Exact above 2^53, same as every other accumulator.
    assert.equal((await store.recordFreeStaminaGrant({ userAddress: USER_C, dayKey: "2026-05-01", amount: HUGE_CATT })).granted, HUGE_CATT);
  });
});

/* ========================================================================== */
/* 7. Seasons and season claims                                               */
/* ========================================================================== */

test("seasons: round-trip, upsert by id, and `end: null` as a real open-ended state", async () => {
  await bothAdapters("season", async (store) => {
    assert.equal(await store.getSeason("s-1"), undefined, "an unknown season is undefined, not a zeroed row");

    const saved = await store.saveSeason({
      id: "s-1",
      start: 1_700_000_000,
      end: 1_700_086_400,
      allocation: "1000000000000000000000",
      claimMode: "pro-rata",
    });
    assert.deepEqual(saved, {
      id: "s-1",
      start: 1_700_000_000,
      end: 1_700_086_400,
      allocation: "1000000000000000000000",
      claimMode: "pro-rata",
    });
    assert.deepEqual(await store.getSeason("s-1"), saved, "read-back equals what was written");

    // `end: null` is OPEN-ENDED and round-trips as null, not as a sentinel and
    // not as "missing".
    const open = await store.saveSeason({ id: "s-open", start: 1_800_000_000, end: null, allocation: "5", claimMode: "flat" });
    assert.equal(open.end, null);
    assert.deepEqual(await store.getSeason("s-open"), open);

    // Upsert BY ID: the same id is the same season, and a corrected window is a
    // replacement rather than a second row.
    const updated = await store.saveSeason({
      id: "s-1",
      start: 1_700_000_000,
      end: 1_700_172_800,
      allocation: "2000000000000000000000",
      claimMode: "pro-rata",
    });
    assert.equal(updated.end, 1_700_172_800);
    assert.deepEqual(await store.getSeason("s-1"), updated);

    // The allocation is an 18-decimal CATT amount and stays exact.
    await store.saveSeason({ id: "s-huge", start: 1, end: 2, allocation: HUGE_CATT, claimMode: "pro-rata" });
    assert.equal((await store.getSeason("s-huge")).allocation, HUGE_CATT);
  });
});

test("seasons: the window is [start, end), and overlap resolves to the LATEST start then id ASC", async () => {
  await bothAdapters("season-window", async (store) => {
    await store.saveSeason({ id: "s1", start: 100, end: 200, allocation: "1", claimMode: "pro-rata" });
    assert.equal((await store.getActiveSeason(99)), undefined, "before the window");
    assert.equal((await store.getActiveSeason(100)).id, "s1", "start is INCLUSIVE");
    assert.equal((await store.getActiveSeason(199)).id, "s1");
    assert.equal((await store.getActiveSeason(200)), undefined, "end is EXCLUSIVE — back-to-back seasons are well defined");
    assert.equal((await store.getActiveSeason(1000)), undefined);

    // An open-ended season owns everything from its start onward, and its
    // boundary is exclusive at the start too.
    await store.saveSeason({ id: "open", start: 300, end: null, allocation: "1", claimMode: "flat" });
    assert.equal((await store.getActiveSeason(299)), undefined);
    assert.equal((await store.getActiveSeason(300)).id, "open");
    assert.equal((await store.getActiveSeason(9999999999)).id, "open");

    // OVERLAP: two seasons covering the same instant. The one with the LATEST
    // start wins — the answer that does not depend on insertion order.
    await store.saveSeason({ id: "late", start: 150, end: 260, allocation: "1", claimMode: "pro-rata" });
    assert.equal((await store.getActiveSeason(150)).id, "late");
    assert.equal((await store.getActiveSeason(259)).id, "late");
    assert.equal((await store.getActiveSeason(260)), undefined, "the earlier season's end is not resurrected by the overlap");

    // TIE on `start`: the id ASC tiebreak decides, deterministically.
    await store.saveSeason({ id: "bbb", start: 150, end: 160, allocation: "1", claimMode: "pro-rata" });
    await store.saveSeason({ id: "aaa", start: 150, end: 160, allocation: "1", claimMode: "pro-rata" });
    assert.equal((await store.getActiveSeason(155)).id, "aaa", "id ASC breaks the tie, not row order");

    // And the open-ended season still loses to a later start.
    assert.equal((await store.getActiveSeason(400)).id, "open");
    await store.saveSeason({ id: "newest", start: 350, end: 360, allocation: "1", claimMode: "pro-rata" });
    assert.equal((await store.getActiveSeason(355)).id, "newest");
  });
});

test("season claims: accumulate exactly, the nonce is idempotent, and totals are per-user", async () => {
  await bothAdapters("season-claims", async (store) => {
    await store.saveSeason({ id: "s1", start: 100, end: 200, allocation: "1000000000000000000000", claimMode: "pro-rata" });

    assert.equal(await store.getSeasonClaimedTotal("s1"), "0");
    assert.equal(await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_A }), "0");
    assert.equal(await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 }), false);

    // First claim: both totals move together.
    assert.deepEqual(await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: HUGE_CATT, nonce: 1 }), {
      seasonClaimedTotal: HUGE_CATT,
      userAccrued: HUGE_CATT,
    });
    // isSeasonClaimUsed FLIPS.
    assert.equal(await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 }), true);
    assert.equal(await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 2 }), false, "a different nonce is unused");

    // The SAME nonce again is a duplicate and must not accrue twice — the
    // (season, user, nonce) identity is what makes a retried request idempotent.
    // The refusal is a rejection in BOTH adapters (the memory store checks the
    // key, SQLite raises the schema's UNIQUE violation) and it is never swallowed.
    await assert.rejects(() => store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: "1", nonce: 1 }));
    assert.equal(await store.getSeasonClaimedTotal("s1"), HUGE_CATT, "the duplicate changed nothing");

    // A different nonce from the SAME user accrues again.
    assert.deepEqual(await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: "1", nonce: 2 }), {
      seasonClaimedTotal: (BigInt(HUGE_CATT) + 1n).toString(),
      userAccrued: (BigInt(HUGE_CATT) + 1n).toString(),
    });

    // A second user's claim moves the season total but NOT the first user's.
    await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_B, amount: "7", nonce: 1 });
    assert.equal(await store.getSeasonClaimedTotal("s1"), (BigInt(HUGE_CATT) + 8n).toString());
    assert.equal(await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_A }), (BigInt(HUGE_CATT) + 1n).toString());
    assert.equal(await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_B }), "7");

    // Seasons are isolated from each other, and a case-different address is the
    // same user.
    await store.saveSeason({ id: "s2", start: 300, end: 400, allocation: "1", claimMode: "flat" });
    assert.equal(await store.getSeasonClaimedTotal("s2"), "0");
    assert.equal(await store.isSeasonClaimUsed({ seasonId: "s2", userAddress: USER_A, nonce: 1 }), false);
    await store.recordSeasonClaim({ seasonId: "s2", userAddress: MIXED, amount: "3", nonce: 9 });
    assert.equal(await store.getSeasonUserAccrued({ seasonId: "s2", userAddress: MIXED.toLowerCase() }), "3");
    assert.equal(await store.isSeasonClaimUsed({ seasonId: "s2", userAddress: MIXED.toUpperCase().replace("0X", "0x"), nonce: 9 }), true);

    // Exactness again: the running total is not rounded anywhere.
    await store.recordSeasonClaim({ seasonId: "s2", userAddress: USER_C, amount: HUGE, nonce: 1 });
    assert.equal(await store.getSeasonClaimedTotal("s2"), (BigInt(HUGE) + 3n).toString());
  });
});

/* ========================================================================== */
/* 8. Active miners                                                           */
/* ========================================================================== */

test("active miners: DISTINCT users per day, counted from graded completions only", async () => {
  await bothAdapters("miners", async (store) => {
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-01" }), 0, "a day nobody used is 0, not an error");

    // One user, FOUR missions in a day: still ONE active user.
    for (const dayKey of ["2026-06-01", "2026-06-01", "2026-06-01", "2026-06-01"]) {
      await store.recordGradedCompletion({ userAddress: USER_A, dayKey, missionId: "mission-1" });
    }
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-01" }), 1, "distinctness matters as much as the day");

    // Two more users on the same day.
    await store.recordGradedCompletion({ userAddress: USER_B, dayKey: "2026-06-01" });
    await store.recordGradedCompletion({ userAddress: USER_C, dayKey: "2026-06-01" });
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-01" }), 3);

    // DAY ISOLATION: the same users on another day are counted there and NOT
    // here. This is the ledger property: yesterday still counts yesterday's users
    // after today's completion has moved `last_graded_day` forward.
    await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-06-02" });
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-02" }), 1);
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-01" }), 3, "an earlier day's count never shrinks");

    // A case-different address is the same user, so it does not inflate the count.
    await store.recordGradedCompletion({ userAddress: MIXED, dayKey: "2026-06-03" });
    await store.recordGradedCompletion({ userAddress: MIXED.toUpperCase().replace("0X", "0x"), dayKey: "2026-06-03" });
    await store.recordGradedCompletion({ userAddress: MIXED.toLowerCase(), dayKey: "2026-06-03" });
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-03" }), 1);

    // A day with nothing at all.
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-04" }), 0);

    // TELEMETRY IS NOT COUNTED, and this is why: telemetry has no `day_key`
    // column and its user link may be NULL, so counting it would force the store
    // to derive a day from a timestamp — the clock read this interface forbids.
    await store.createSession({ sessionId: "s-1", userAddress: USER_A, missionId: "mission-1" });
    await store.appendTelemetry("s-1", [{ ts: 1, touch: { x: 1, y: 1 } }, { ts: 2 }]);
    await store.appendTelemetry("s-anon", [{ ts: 3 }]);
    assert.equal(await store.countActiveMiners({ dayKey: "2026-06-04" }), 0, "an opened session is not a graded completion");
  });
});

/* ========================================================================== */
/* 9. Durability across a REAL process boundary                               */
/* ========================================================================== */

test("durability: a child process opened with `node -e` reads back every growth row", async () => {
  const filename = tempDbPath("child");
  const writer = createSqliteStore({ filename });
  await writer.init();

  const DAYS = ["2026-07-01", "2026-07-02", "2026-07-03"];
  for (const dayKey of DAYS) {
    await writer.recordStaminaConsumption({ userAddress: USER_A, dayKey, amount: 10 });
    await writer.recordStaminaConsumption({ userAddress: USER_A, dayKey, amount: HUGE });
    await writer.recordFreeStaminaGrant({ userAddress: USER_A, dayKey, amount: 25 });
    await writer.recordGradedCompletion({ userAddress: USER_A, dayKey, reward: HUGE_CATT, missionId: "mission-1" });
  }
  await writer.recordGradedCompletion({ userAddress: USER_B, dayKey: DAYS[0], missionId: "mission-2" });
  await writer.saveSeason({ id: "s1", start: 100, end: 200, allocation: HUGE_CATT, claimMode: "pro-rata" });
  await writer.saveSeason({ id: "s-open", start: 300, end: null, allocation: "5", claimMode: "flat" });
  await writer.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: HUGE_CATT, nonce: 7 });

  // The file must be closed before the child opens it: that is the whole point.
  await writer.close();

  // The child script is passed INLINE with `node -e`. Nothing is written into
  // the repository: a helper script checked into a tree is a file an operator
  // has to remember is a test artefact, and this one would sit next to real code.
  const modulePath = path.resolve(__dirname, "..", "src", "sqlite-store.js");
  const script = `
    const { createSqliteStore } = require(${JSON.stringify(modulePath)});
    const store = createSqliteStore({ filename: process.argv[1] });
    (async () => {
      const days = ["2026-07-01", "2026-07-02", "2026-07-03"];
      const out = {
        pid: process.pid,
        schemaVersion: store._schemaVersion(),
        stamina: [],
        free: [],
        streakA: await store.getStreak({ userAddress: ${JSON.stringify(USER_A)} }),
        streakB: await store.getStreak({ userAddress: ${JSON.stringify(USER_B)} }),
        miners: [],
        seasonS1: await store.getSeason("s1"),
        seasonOpen: await store.getSeason("s-open"),
        active150: await store.getActiveSeason(150),
        active399: await store.getActiveSeason(399),
        claimedTotal: await store.getSeasonClaimedTotal("s1"),
        userAccrued: await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: ${JSON.stringify(USER_A)} }),
        claimUsed: await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: ${JSON.stringify(USER_A)}, nonce: 7 }),
        claimUnused: await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: ${JSON.stringify(USER_A)}, nonce: 8 }),
      };
      for (const dayKey of days) {
        out.stamina.push(await store.getStaminaConsumed({ userAddress: ${JSON.stringify(USER_A)}, dayKey }));
        out.free.push(await store.getFreeStaminaGranted({ userAddress: ${JSON.stringify(USER_A)}, dayKey }));
        out.miners.push(await store.countActiveMiners({ dayKey }));
      }
      // The schema constraints are still in force in a fresh process.
      let duplicateRejected = null;
      try {
        store._raw()
          .prepare("INSERT INTO stamina_ledger (user_address, day_key, consumed, updated_at) VALUES (?, ?, ?, 1)")
          .run(${JSON.stringify(USER_A)}, "2026-07-01", "1");
      } catch (err) {
        duplicateRejected = err.message;
      }
      out.duplicateRejected = duplicateRejected;
      await store.close();
      process.stdout.write(JSON.stringify(out));
    })().catch((err) => {
      process.stderr.write(String(err && err.stack));
      process.exit(1);
    });
  `;
  const stdout = execFileSync(process.execPath, ["-e", script, filename], { encoding: "utf8" });
  const seen = JSON.parse(stdout);

  assert.notEqual(seen.pid, process.pid, "the read must come from a DIFFERENT process");

  // The schema version lives in the FILE, so the child proves which schema it
  // read — and it must be exactly the version this build publishes.
  assert.equal(seen.schemaVersion, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 3, "the growth tables are migrations on top of the base schema");

  // Per-day ledgers survived, exactly, in all three days.
  assert.deepEqual(seen.stamina, DAYS.map((dayKey) => ({
    userAddress: USER_A,
    dayKey,
    consumed: (BigInt(10) + BigInt(HUGE)).toString(),
  })));
  assert.deepEqual(seen.free, DAYS.map((dayKey) => ({ userAddress: USER_A, dayKey, granted: "25" })));

  // Streaks survived: A ran three consecutive days, B one day.
  assert.deepEqual(seen.streakA, { userAddress: USER_A, current: 3, lastGradedDay: "2026-07-03" });
  assert.deepEqual(seen.streakB, { userAddress: USER_B, current: 1, lastGradedDay: "2026-07-01" });

  // The active-miner ledger survived and is still per-day.
  assert.deepEqual(seen.miners, [2, 1, 1]);

  // Seasons survived, including the open-ended one and the overlap resolution.
  assert.deepEqual(seen.seasonS1, {
    id: "s1",
    start: 100,
    end: 200,
    allocation: HUGE_CATT,
    claimMode: "pro-rata",
  });
  assert.equal(seen.seasonOpen.end, null, "an open-ended season is still open-ended in a new process");
  assert.equal(seen.active150.id, "s1");
  assert.equal(seen.active399.id, "s-open");
  assert.equal(seen.active399.end, null);

  // Season claims survived, exactly, and the nonce is still spent.
  assert.equal(seen.claimedTotal, HUGE_CATT);
  assert.equal(seen.userAccrued, HUGE_CATT);
  assert.equal(seen.claimUsed, true);
  assert.equal(seen.claimUnused, false);

  // And the schema constraint is not a property of one process's memory.
  assert.match(seen.duplicateRejected, /UNIQUE constraint failed: stamina_ledger/);
});

/* ========================================================================== */
/* 10. Memory <-> SQLite parity over every new method                         */
/* ========================================================================== */

test("PARITY: every growth method returns IDENTICAL views from both adapters", async () => {
  const memory = createMemoryStore();
  const sqlite = await openStore("growth-parity");
  try {
    /**
     * One scripted sequence covering EVERY new method, in an order that
     * exercises the interesting states: a fresh ledger, accumulation, a day
     * change, all four streak cases, grants on two days, a season window with
     * an overlap, and claims from two users.
     *
     * @param {Object} store Either adapter.
     * @returns {Promise<Object>} Everything the sequence saw.
     */
    async function growthScript(store) {
      const out = {};
      out.emptyStamina = await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-08-01" });
      out.staminaDay1a = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-08-01", amount: 10 });
      out.staminaDay1b = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-08-01", amount: "20" });
      out.staminaDay2 = await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: "2026-08-02", amount: HUGE });
      out.staminaRead1 = await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-08-01" });
      out.staminaRead2 = await store.getStaminaConsumed({ userAddress: USER_A, dayKey: "2026-08-02" });
      out.staminaOther = await store.getStaminaConsumed({ userAddress: USER_B, dayKey: "2026-08-01" });

      out.streakNone = await store.getStreak({ userAddress: USER_C });
      out.streakFirst = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-08-01", reward: HUGE_CATT, missionId: "mission-1" });
      out.streakSameDay = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-08-01", missionId: "mission-3" });
      out.streakNextDay = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-08-02" });
      out.streakGap = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-08-09" });
      out.streakRetro = await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-08-07" });
      out.streakRead = await store.getStreak({ userAddress: USER_A });

      out.freeEmpty = await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-08-01" });
      out.freeDay1 = await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-08-01", amount: 25 });
      out.freeDay1Again = await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-08-01", amount: 25 });
      out.freeDay2 = await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-08-02" });

      out.seasonMissing = await store.getSeason("nope");
      out.seasonSaved = await store.saveSeason({ id: "s1", start: 100, end: 200, allocation: HUGE_CATT, claimMode: "pro-rata" });
      out.seasonOpen = await store.saveSeason({ id: "s-open", start: 150, end: null, allocation: "5", claimMode: "flat" });
      out.seasonUpdated = await store.saveSeason({ id: "s1", start: 100, end: 250, allocation: HUGE_CATT, claimMode: "pro-rata" });
      out.seasonRead = await store.getSeason("s1");
      out.active99 = await store.getActiveSeason(99);
      out.active100 = await store.getActiveSeason(100);
      out.active200 = await store.getActiveSeason(200);
      out.active250 = await store.getActiveSeason(250);
      out.active99999 = await store.getActiveSeason(99999);

      out.claimUnused = await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 });
      out.claim1 = await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_A, amount: HUGE_CATT, nonce: 1 });
      out.claimUsed = await store.isSeasonClaimUsed({ seasonId: "s1", userAddress: USER_A, nonce: 1 });
      out.claim2 = await store.recordSeasonClaim({ seasonId: "s1", userAddress: USER_B, amount: "7", nonce: 1 });
      out.seasonTotal = await store.getSeasonClaimedTotal("s1");
      out.userAccruedA = await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_A });
      out.userAccruedB = await store.getSeasonUserAccrued({ seasonId: "s1", userAddress: USER_B });
      out.seasonTotalOther = await store.getSeasonClaimedTotal("s-open");

      out.minersDay0 = await store.countActiveMiners({ dayKey: "2026-08-01" });
      out.minersDay2 = await store.countActiveMiners({ dayKey: "2026-08-02" });
      out.minersDay3 = await store.countActiveMiners({ dayKey: "2026-08-03" });
      out.minersDay9 = await store.countActiveMiners({ dayKey: "2026-08-09" });
      // Counted BEFORE the mixed-case user below, so day one holds only USER_A.

      // Mixed-case and case-normalised addresses must resolve identically.
      out.mixedStamina = await store.recordStaminaConsumption({ userAddress: MIXED, dayKey: "2026-08-01", amount: 5 });
      out.mixedStaminaRead = await store.getStaminaConsumed({ userAddress: MIXED.toUpperCase().replace("0X", "0x"), dayKey: "2026-08-01" });
      out.mixedStreak = await store.recordGradedCompletion({ userAddress: MIXED, dayKey: "2026-08-01" });
      out.mixedStreakRead = await store.getStreak({ userAddress: MIXED.toLowerCase() });
      // And again afterwards: the mixed-case user is a SECOND user, not a
      // duplicate of USER_A, so the day's count goes up by exactly one however
      // many times it is recorded.
      out.minersDay1AfterMixed = await store.countActiveMiners({ dayKey: "2026-08-01" });
      return out;
    }

    const [a, b] = [await growthScript(memory), await growthScript(sqlite)];

    // `undefined` does not survive JSON and does not need to: every entry is
    // either a value or an explicit undefined, and deepEqual compares both.
    assert.deepEqual(b, a, "the two adapters disagreed about the growth ledgers");

    // Named again, so a failure says WHICH behaviour broke.
    assert.deepEqual(b.emptyStamina.consumed, "0");
    assert.deepEqual(b.staminaDay1b.consumed, "30", "accumulate, never replace");
    assert.deepEqual(b.staminaRead2.consumed, HUGE, "exact above 2^53");
    assert.deepEqual(b.staminaOther.consumed, "0", "per-user isolation");
    assert.deepEqual([b.streakFirst.current, b.streakSameDay.current, b.streakNextDay.current, b.streakGap.current, b.streakRetro.current], [1, 1, 2, 1, 1]);
    assert.deepEqual(b.streakRead, { userAddress: USER_A, current: 1, lastGradedDay: "2026-08-07" });
    assert.deepEqual(b.freeDay1Again.granted, "50");
    assert.deepEqual(b.freeDay2.granted, "0", "a day-A grant never leaks into day B");
    assert.deepEqual(b.seasonOpen.end, null);
    assert.deepEqual(b.active99, undefined);
    assert.deepEqual(b.active100.id, "s1", "start is inclusive");
    assert.deepEqual(b.active200.id, "s-open", "end is exclusive, and the later-starting open season owns it");
    assert.deepEqual(b.claim1, { seasonClaimedTotal: HUGE_CATT, userAccrued: HUGE_CATT });
    assert.deepEqual(b.seasonTotal, (BigInt(HUGE_CATT) + 7n).toString());
    assert.deepEqual(b.userAccruedA, HUGE_CATT);
    assert.deepEqual(b.userAccruedB, "7");
    assert.deepEqual([b.claimUnused, b.claimUsed], [false, true]);
    assert.deepEqual([b.minersDay0, b.minersDay2, b.minersDay3, b.minersDay9], [1, 1, 0, 1]);
    assert.deepEqual(b.minersDay1AfterMixed, 2, "a second wallet adds exactly one active user");
    assert.deepEqual(b.mixedStaminaRead.consumed, "5", "one wallet, one bucket, whatever the casing");
  } finally {
    await sqlite.close();
  }
});
