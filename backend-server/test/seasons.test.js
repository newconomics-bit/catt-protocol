/**
 * CATT Protocol — the SEASON SCHEDULER and its HARD CAP.
 *
 * WHAT THIS FILE IS PROVING, in order of how much it matters:
 *
 *   1. THE HEADROOM IS 39,600,000 CATT, NOT 39,600. `12 x 3,300,000 = 39,600,000`
 *      and `3,300,000 CATT at 18 decimals` is a 25-DIGIT base-unit string. The
 *      22-digit literal `"3300000000000000000000"` that a lost attempt of this
 *      module carried is 3,300 CATT — a 1000x typo that satisfies every local
 *      check and starves the schedule on day two. It is named here and asserted
 *      against, because a typo that is only prevented by being remembered is a
 *      typo waiting to come back.
 *
 *   2. THE CAP IS A HARD CAP AND IT IS LOUD. A season filled to exactly its
 *      3,300,000 CATT refuses the next claim of ANY positive amount with
 *      `SEASON_ALLOCATION_EXHAUSTED`, and the season total does not move. No
 *      clamp, no partial payment, no successful zero — all three were considered
 *      and all three are undetectable under-payment, which is worse than a
 *      visible outage.
 *
 *   3. THERE IS EXACTLY ONE LIVE SEASON AT EVERY INSTANT, AND NONE BEFORE THE
 *      EPOCH. `SEASON_EPOCH` is a DOCUMENTED, FOUNDER-UNSPECIFIED default, and
 *      before it `settle` throws rather than inventing a season — an invented
 *      season would be an uncapped pool by another name.
 *
 *   4. NOTHING IS A FLOAT. Every CATT figure crosses a boundary as an exact
 *      decimal string, `3.3e24` is far above `Number.MAX_SAFE_INTEGER`, and a
 *      value one base unit above 2^53 round-trips through `settle`,
 *      `remainingForSeason` and the store unchanged.
 *
 * BOTH ADAPTERS: every behavioural assertion runs against `createMemoryStore()`
 * AND `createSqliteStore()` on an `os.tmpdir()` mkdtemp database, removed in
 * `after`, so no `.db`, `-wal` or `-shm` is ever left in the tree.
 *
 * `node:test` + `node:assert/strict` only: no test framework dependency.
 */

"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SECONDS_PER_DAY,
  SEASON_COUNT,
  SEASON_DURATION_DAYS,
  SEASON_DURATION_SECONDS,
  SEASON_ALLOCATION_CATT,
  SEASON_ALLOCATION,
  SEASON_EPOCH,
  TOTAL_HEADROOM_CATT,
  TOTAL_SEASON_DAYS,
  CLAIM_MODE_DAILY,
  SEASON_IDS,
  CATT_DECIMALS,
  CATT_BASE_UNITS,
  SEASON_ERRORS,
  SEASON_ERROR_NAME,
  buildSeasonSchedule,
  assertSeasonIdentities,
  seasonFor,
  currentSeason,
  ensureSeasons,
  remainingForSeason,
  totalHeadroomClaimed,
  totalHeadroomStillUnallocated,
  settle,
  previewSettlement,
} = require("../src/seasons");
const { createSqliteStore } = require("../src/sqlite-store");
const { createMemoryStore } = require("../src/storage");

const USER_A = "0x1111111111111111111111111111111111111111";
const USER_B = "0x2222222222222222222222222222222222222222";
const USER_C = "0x3333333333333333333333333333333333333333";

/** Just past 2^53 (9007199254740992), so a lossy round trip would be visible. */
const HUGE = "9007199254740993";
/**
 * 1.2345678901234568e24 base units: far above 2^53, and inside a 2e24 season, so
 * it can actually be claimed and its exactness proven end to end. Note the float
 * value of this literal is 1234567890123456800000000 — different by
 * 100,000,000,000,000,000 — which is exactly what a float would have paid.
 */
const HUGE_CATT = "1234567890123456789012345";

/**
 * The SHORTENED literals a lost attempt of this module shipped, both asserted
 * against. The brief that described that attempt quoted the 19-digit string
 * while calling it 22 digits and 2,000 CATT — three different values — so both
 * spellings are pinned here and the real claim is the scale-agnostic one: a
 * shortened allocation is 1,000x (or worse) short, and 2,000,000 CATT is the
 * 25-DIGIT literal below.
 */
const THE_1000X_TYPO_AS_QUOTED = "2000000000000000000";
const THE_1000X_TYPO_AS_DESCRIBED = "2000000000000000000000";

/** Every temp directory this file created, removed in `after`. */
const tempDirs = [];

/**
 * A throwaway directory under the OS temp dir and a database path inside it.
 * NEVER inside the repository.
 *
 * @param {string} [label] Recognisable suffix.
 * @returns {string} An absolute path to a not-yet-created `.db` file.
 */
function tempDbPath(label = "seasons") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catt-seasons-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, "judge.db");
}

/** Removes every temp directory, so no `.db`, `-wal` or `-shm` is ever left behind. */
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Opens a SQLite store on a fresh temp database, already seeded with the schedule. */
async function openSeededStore(label) {
  const store = createSqliteStore({ filename: tempDbPath(label) });
  await store.init();
  await ensureSeasons(store, { epoch: SEASON_EPOCH });
  return store;
}

/**
 * Runs `body` against a memory store and a seeded SQLite store, in that order.
 *
 * Every behavioural test is written through this helper, so no assertion can
 * accidentally hold for one adapter only.
 *
 * @param {string} label Temp-directory label.
 * @param {(store: Object) => Promise<void>} body The assertions.
 * @returns {Promise<void>}
 */
async function bothAdapters(label, body) {
  const memory = createMemoryStore();
  await memory.init();
  await ensureSeasons(memory, { epoch: SEASON_EPOCH });
  await body(memory);
  const sqlite = await openSeededStore(label);
  try {
    await body(sqlite);
  } finally {
    await sqlite.close();
  }
}

/** An instant safely inside season 1 under the default epoch. */
const IN_SEASON_1 = 1000;

/* ========================================================================== */
/* 1. The frozen identities                                                    */
/* ========================================================================== */

test("identities: 12 seasons x 3,300,000 CATT = 39,600,000 CATT over 360 days", () => {
  assert.equal(SEASON_COUNT, 12);
  assert.equal(SEASON_DURATION_DAYS, 30);
  assert.equal(SEASON_ALLOCATION_CATT, 3_300_000n);
  assert.equal(TOTAL_HEADROOM_CATT, 39_600_000n);
  assert.equal(TOTAL_SEASON_DAYS, 360);
  assert.equal(SECONDS_PER_DAY, 86400);
  assert.equal(SEASON_DURATION_SECONDS, 30 * 86400);
  assert.equal(SEASON_DURATION_SECONDS, 2592000);
  assert.equal(SEASON_DURATION_SECONDS, SEASON_DURATION_DAYS * SECONDS_PER_DAY);

  // The founder's multiplication, in WHOLE CATT and then in base units.
  assert.equal(BigInt(SEASON_COUNT) * SEASON_ALLOCATION_CATT, 39_600_000n);
  assert.equal(BigInt(SEASON_COUNT) * BigInt(SEASON_DURATION_DAYS), 360n);

  assert.equal(CATT_DECIMALS, 18);
  assert.equal(CATT_BASE_UNITS, 10n ** 18n);
  assert.equal(BigInt(SEASON_ALLOCATION), SEASON_ALLOCATION_CATT * CATT_BASE_UNITS);
  assert.equal(
    BigInt(SEASON_ALLOCATION) * BigInt(SEASON_COUNT),
    TOTAL_HEADROOM_CATT * CATT_BASE_UNITS,
    "all twelve allocations together are exactly the 39,600,000 CATT headroom"
  );
  assert.equal(CLAIM_MODE_DAILY, "daily");
});

test("the allocation literal is 25 digits: 3,300,000 CATT, not the 22-digit 3,300 CATT typo", () => {
  // THE 1000x TRAP, asserted rather than remembered.
  assert.equal(
    SEASON_ALLOCATION,
    "3300000000000000000000000",
    "the per-season allocation literal must be 3,300,000 CATT in 18-decimal base units"
  );
  assert.equal(SEASON_ALLOCATION.length, 25, "3,300,000 CATT at 18 decimals is a 25-digit string");
  assert.equal(BigInt(SEASON_ALLOCATION), 3_300_000n * CATT_BASE_UNITS);
  assert.equal(BigInt(SEASON_ALLOCATION) / CATT_BASE_UNITS, 3_300_000n);

  // What the shortened literal was, in both spellings, and what each would
  // have done to the headroom.
  const THE_1000X_TYPO_AS_QUOTED = "3300000000000000000"; // 19 digits = 3.3 CATT
  const THE_1000X_TYPO_AS_DESCRIBED = "3300000000000000000000"; // 22 digits = 3,300 CATT
  assert.equal(THE_1000X_TYPO_AS_QUOTED.length, 19, "the quoted literal was 19 digits");
  assert.equal(BigInt(THE_1000X_TYPO_AS_QUOTED), 3_300_000n * CATT_BASE_UNITS / 1_000_000n, "19 digits is 3.3 CATT");
  assert.equal(THE_1000X_TYPO_AS_DESCRIBED.length, 22, "the described literal was 22 digits");
  assert.equal(BigInt(THE_1000X_TYPO_AS_DESCRIBED), 3_300n * CATT_BASE_UNITS, "22 digits is 3,300 CATT");
  assert.equal(
    BigInt(THE_1000X_TYPO_AS_DESCRIBED),
    SEASON_ALLOCATION_CATT * CATT_BASE_UNITS / 1000n,
    "22 digits is exactly the 1000x under-allocation"
  );
  assert.notEqual(SEASON_ALLOCATION, THE_1000X_TYPO_AS_QUOTED);
  assert.notEqual(SEASON_ALLOCATION, THE_1000X_TYPO_AS_DESCRIBED);
  // 12 x either shortened literal falls far short of the founder's headroom:
  // 22 digits shrinks it 1,000x, 19 digits 1,000,000x.
  const fullHeadroom = TOTAL_HEADROOM_CATT * CATT_BASE_UNITS;
  assert.equal(
    BigInt(SEASON_COUNT) * BigInt(THE_1000X_TYPO_AS_DESCRIBED),
    fullHeadroom / 1_000n,
    "12 x 3,300 CATT is 39,600 CATT: a 1000x shrink of the headroom"
  );
  assert.equal(
    BigInt(SEASON_COUNT) * BigInt(THE_1000X_TYPO_AS_QUOTED),
    fullHeadroom / 1_000_000n,
    "12 x 3 CATT is 36 CATT: a 1,000,000x shrink of the headroom"
  );

  // The schedule itself carries the right literal on every row.
  for (const season of buildSeasonSchedule()) assert.equal(season.allocation, SEASON_ALLOCATION);
});

test("assertSeasonIdentities passes on the shipped schedule, and the exported ids are season-1..12", () => {
  const schedule = assertSeasonIdentities({ epoch: SEASON_EPOCH });
  assert.equal(schedule.length, 12);
  assert.equal(SEASON_IDS.length, 12);
  assert.equal(SEASON_IDS[0], "season-1");
  assert.equal(SEASON_IDS[11], "season-12");
  assert.ok(Object.isFrozen(SEASON_IDS), "SEASON_IDS is frozen");
  assert.equal(new Set(SEASON_IDS).size, 12, "season ids are unique");
  for (let index = 0; index < SEASON_COUNT; index += 1) {
    assert.equal(SEASON_IDS[index], `season-${index + 1}`);
  }
});

/* ========================================================================== */
/* 2. The schedule                                                             */
/* ========================================================================== */

test("schedule: all 12 seasons with correct ids, starts, ends, allocation and claim mode", () => {
  const schedule = buildSeasonSchedule({ epoch: SEASON_EPOCH });
  assert.equal(schedule.length, 12);
  for (let index = 0; index < schedule.length; index += 1) {
    const season = schedule[index];
    assert.equal(season.id, `season-${index + 1}`);
    assert.equal(season.start, SEASON_EPOCH + index * SEASON_DURATION_SECONDS);
    assert.equal(season.end, season.start + SEASON_DURATION_SECONDS);
    assert.equal(season.allocation, SEASON_ALLOCATION);
    assert.equal(season.claimMode, CLAIM_MODE_DAILY);
  }
  assert.equal(schedule[0].start, 0, "season 1 starts at the epoch");
  assert.equal(schedule[11].start, 11 * 2592000);
  assert.equal(
    schedule[11].end,
    SEASON_EPOCH + 360 * SECONDS_PER_DAY,
    "season 12 ends exactly 360 days after the epoch"
  );
  assert.ok(Object.isFrozen(schedule));
  assert.ok(Object.isFrozen(schedule[0]));
});

test("schedule: contiguous — no overlap and no gap between consecutive seasons", () => {
  const schedule = buildSeasonSchedule({ epoch: SEASON_EPOCH });
  for (let index = 1; index < schedule.length; index += 1) {
    const previous = schedule[index - 1];
    const current = schedule[index];
    // Equality is both halves of the claim at once: not `>` (overlap) and not
    // `<` (gap).
    assert.equal(current.start, previous.end, `${current.id} must start exactly where ${previous.id} ends`);
    assert.equal(current.start - previous.start, SEASON_DURATION_SECONDS);
  }
  // And no window is open-ended, which is what makes "exhausted then wait for
  // the next season" possible at all.
  for (const season of schedule) assert.notEqual(season.end, null);
});

test("schedule: deterministic and frozen — the same epoch always yields the same array", () => {
  const first = buildSeasonSchedule({ epoch: 1_700_000_000 });
  const second = buildSeasonSchedule({ epoch: 1_700_000_000 });
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  // An explicit epoch shifts the whole schedule and changes nothing else.
  const shifted = buildSeasonSchedule({ epoch: 1_700_000_000 });
  assert.equal(shifted[0].start, 1_700_000_000);
  assert.equal(shifted[11].end, 1_700_000_000 + 360 * SECONDS_PER_DAY);
  assert.deepEqual(
    shifted.map((season) => season.allocation),
    first.map((season) => season.allocation)
  );
  // The default epoch is the DOCUMENTED, UNSPECIFIED one.
  assert.equal(SEASON_EPOCH, 0);
  assert.equal(buildSeasonSchedule()[0].start, SEASON_EPOCH);
});

/* ========================================================================== */
/* 3. Exactly one live season, and none before the epoch                       */
/* ========================================================================== */

test("liveness: exactly one season covers any instant >= epoch, and none before it", async () => {
  const schedule = buildSeasonSchedule({ epoch: SEASON_EPOCH });
  for (const season of schedule) {
    for (const instant of [season.start, season.start + 1, season.end - 1]) {
      const covering = schedule.filter((row) => row.start <= instant && instant < row.end);
      assert.equal(covering.length, 1, `${instant} must be covered by exactly one season`);
      assert.equal(covering[0].id, season.id);
      assert.equal(seasonFor(instant).id, season.id, "seasonFor agrees with the schedule");
    }
    // Half-open: the closing instant belongs to the NEXT season.
    if (season.id !== "season-12") {
      assert.equal(seasonFor(season.end).id, `season-${Number(season.id.slice(7)) + 1}`);
    } else {
      assert.equal(seasonFor(season.end), undefined, "nothing is live after the last season ends");
    }
  }
  // BEFORE THE EPOCH THERE IS NO ACTIVE SEASON. Not a default one.
  assert.equal(seasonFor(SEASON_EPOCH - 1), undefined);
  assert.equal(seasonFor(-1), undefined);
  assert.equal(seasonFor(-999999), undefined);
  // And at the epoch itself season 1 is live.
  assert.equal(seasonFor(SEASON_EPOCH).id, "season-1");
});

test("liveness: the store and the pure planner agree at every sampled instant", async () => {
  const schedule = buildSeasonSchedule({ epoch: SEASON_EPOCH });
  await bothAdapters("liveness", async (store) => {
    for (const season of schedule) {
      for (const instant of [season.start, season.start + 12345, season.end - 1]) {
        const active = await currentSeason(store, instant);
        assert.ok(active, `store must resolve a season at ${instant}`);
        assert.equal(active.id, season.id);
        assert.equal(active.allocation, SEASON_ALLOCATION);
        assert.equal(active.claimMode, CLAIM_MODE_DAILY);
      }
      // Nothing is live before the epoch, on either resolution path.
      if (season.id === "season-1") {
        assert.equal(await currentSeason(store, SEASON_EPOCH - 1), undefined);
      }
    }
  });
});

test("ensureSeasons is idempotent against both adapters and never clobbers a differing row", async () => {
  const memory = createMemoryStore();
  await memory.init();
  const first = await ensureSeasons(memory, { epoch: SEASON_EPOCH });
  assert.equal(first.seasonCount, 12);
  assert.equal(first.created.length, 12, "a fresh store has all 12 seasons written");
  assert.deepEqual(first.preserved, []);
  assert.equal(first.epoch, SEASON_EPOCH);

  const second = await ensureSeasons(memory, { epoch: SEASON_EPOCH });
  assert.deepEqual(second.created, [], "the second run writes nothing new");
  assert.deepEqual(second.preserved, [], "the second run preserves nothing: nothing differs");
  for (const id of SEASON_IDS) {
    const season = await memory.getSeason(id);
    assert.equal(season.id, id);
    assert.equal(season.allocation, SEASON_ALLOCATION);
  }

  // SAME ON SQLITE.
  const sqlite = await openSeededStore("idempotent-fresh");
  try {
    const again = await ensureSeasons(sqlite, { epoch: SEASON_EPOCH });
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.preserved, []);
  } finally {
    await sqlite.close();
  }

  // A DIFFERING ROW IS PRESERVED, not overwritten. An operator who moved or
  // resized a window must not have it silently rewritten by a boot.
  const operatorEdition = { id: "season-1", start: 5, end: 7, allocation: "1", claimMode: "weekly" };
  await memory.saveSeason(operatorEdition);
  const afterOperator = await ensureSeasons(memory, { epoch: SEASON_EPOCH });
  assert.deepEqual(afterOperator.preserved, ["season-1"]);
  assert.equal(afterOperator.created.length, 0);
  const preserved = await memory.getSeason("season-1");
  assert.deepEqual(preserved, { ...operatorEdition });
});

/* ========================================================================== */
/* 4. settle — daily mode                                                      */
/* ========================================================================== */

test("settle: daily mode accumulates and pays immediately, per claim", async () => {
  await bothAdapters("daily", async (store) => {
    const first = await settle(store, {
      userAddress: USER_A,
      amount: "1000000000000000000",
      nonce: 1,
      now: IN_SEASON_1,
    });
    assert.equal(first.settled, true);
    assert.equal(first.seasonId, "season-1");
    assert.equal(first.claimMode, CLAIM_MODE_DAILY);
    assert.equal(first.paid, "1000000000000000000", "daily pays the signed amount, immediately");
    assert.equal(first.amount, "1000000000000000000");
    assert.equal(first.userAccrued, "1000000000000000000");
    assert.equal(first.seasonClaimedTotal, "1000000000000000000");
    assert.equal(first.remaining, SEASON_ALLOCATION, "the whole pool was available before this claim");
    assert.equal(first.remainingAfter, "3299999000000000000000000", "and 1 CATT of it after");

    const second = await settle(store, {
      userAddress: USER_A,
      amount: "2500000000000000000",
      nonce: 2,
      now: IN_SEASON_1 + 60,
    });
    assert.equal(second.paid, "2500000000000000000");
    assert.equal(second.userAccrued, "3500000000000000000", "accrual accumulates per claim");
    assert.equal(second.seasonClaimedTotal, "3500000000000000000");

    // A second user's claim is independent but shares the one pool.
    const third = await settle(store, {
      userAddress: USER_B,
      amount: "1500000000000000000",
      nonce: 1,
      now: IN_SEASON_1 + 120,
    });
    assert.equal(third.userAccrued, "1500000000000000000");
    assert.equal(third.seasonClaimedTotal, "5000000000000000000");
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "5000000000000000000");
    assert.equal(await store.getSeasonUserAccrued({ seasonId: "season-1", userAddress: USER_A }), "3500000000000000000");
  });
});

test("settle: before SEASON_EPOCH there is no active season — SEASON_NO_ACTIVE_SEASON, never a default", async () => {
  await bothAdapters("pre-epoch", async (store) => {
    await assert.rejects(
      () =>
        settle(store, {
          userAddress: USER_A,
          amount: "1000000000000000000",
          nonce: 1,
          now: SEASON_EPOCH - 1,
        }),
      (err) => {
        assert.equal(err.name, SEASON_ERROR_NAME);
        assert.equal(err.code, SEASON_ERRORS.NO_ACTIVE_SEASON);
        assert.equal(err.code, "SEASON_NO_ACTIVE_SEASON");
        assert.equal(err.now, SEASON_EPOCH - 1);
        assert.equal(err.epoch, SEASON_EPOCH);
        return true;
      }
    );
    // Nothing was written: no claim, no allocation consumed.
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "0");
    assert.equal(
      await store.isSeasonClaimUsed({ seasonId: "season-1", userAddress: USER_A, nonce: 1 }),
      false
    );
  });
});

test("settle: a season whose window has ENDED refuses the claim and routes it to the outstanding-accrual path", async () => {
  await bothAdapters("ended", async (store) => {
    const inside = await settle(store, {
      userAddress: USER_A,
      amount: "7000000000000000000",
      nonce: 1,
      now: IN_SEASON_1,
    });
    assert.equal(inside.settled, true);

    // The same user, the same season, but at an instant past its window.
    await assert.rejects(
      () =>
        settle(store, {
          userAddress: USER_A,
          amount: "1000000000000000000",
          nonce: 2,
          now: SEASON_DURATION_SECONDS + 10,
          seasonId: "season-1",
        }),
      (err) => {
        assert.equal(err.code, "SEASON_WINDOW_ENDED");
        assert.equal(err.seasonId, "season-1");
        assert.equal(err.settled, false);
        assert.equal(err.claimableLater, true);
        assert.equal(err.routedTo, "outstanding-accrual");
        // The accrual already in the ledger survives the close and is reported.
        assert.equal(err.userAccrued, "7000000000000000000");
        assert.equal(err.end, SEASON_DURATION_SECONDS);
        return true;
      }
    );
    // The season total did not move: a closed window accepts nothing new.
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "7000000000000000000");
    // And the accrual is still there, readable and payable out of band.
    assert.equal(
      await store.getSeasonUserAccrued({ seasonId: "season-1", userAddress: USER_A }),
      "7000000000000000000"
    );
  });
});

test("settle: an unknown stored claimMode throws SEASON_UNKNOWN_CLAIM_MODE and never falls back to daily", async () => {
  await bothAdapters("mode", async (store) => {
    const planned = buildSeasonSchedule({ epoch: SEASON_EPOCH })[0];
    await store.saveSeason({ ...planned, claimMode: "weekly" });
    await assert.rejects(
      () => settle(store, { userAddress: USER_A, amount: "1000000000000000000", nonce: 1, now: IN_SEASON_1 }),
      (err) => {
        assert.equal(err.code, "SEASON_UNKNOWN_CLAIM_MODE");
        assert.equal(err.claimMode, "weekly");
        assert.deepEqual(err.supported, [CLAIM_MODE_DAILY]);
        assert.equal(err.seasonId, "season-1");
        return true;
      }
    );
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "0");

    // A NULL claim mode is equally unknown: absence is not a licence to guess.
    await store.saveSeason({ ...planned, claimMode: null });
    await assert.rejects(
      () => settle(store, { userAddress: USER_A, amount: "1", nonce: 1, now: IN_SEASON_1 }),
      (err) => err.code === "SEASON_UNKNOWN_CLAIM_MODE"
    );
  });
});

test("settle: a replayed nonce does not double-accrue", async () => {
  await bothAdapters("replay", async (store) => {
    await settle(store, { userAddress: USER_A, amount: "3000000000000000000", nonce: 7, now: IN_SEASON_1 });
    await assert.rejects(
      () => settle(store, { userAddress: USER_A, amount: "3000000000000000000", nonce: 7, now: IN_SEASON_1 + 5 }),
      (err) => {
        assert.equal(err.code, "SEASON_CLAIM_ALREADY_RECORDED");
        assert.equal(err.code, "SEASON_CLAIM_ALREADY_RECORDED");
        assert.equal(err.nonce, "7");
        assert.equal(err.seasonId, "season-1");
        assert.equal(err.replay, true);
        return true;
      }
    );
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "3000000000000000000", "the replay did not accrue");
    assert.equal(
      await store.getSeasonUserAccrued({ seasonId: "season-1", userAddress: USER_A }),
      "3000000000000000000"
    );
    // A DIFFERENT nonce settles normally.
    const fresh = await settle(store, {
      userAddress: USER_A,
      amount: "1000000000000000000",
      nonce: 8,
      now: IN_SEASON_1 + 5,
    });
    assert.equal(fresh.userAccrued, "4000000000000000000");
    // Case-insensitive: the same wallet in checksummed form is the same nonce.
    assert.equal(
      await store.isSeasonClaimUsed({ seasonId: "season-1", userAddress: USER_A.toUpperCase(), nonce: 7 }),
      true
    );
  });
});

/* ========================================================================== */
/* 5. The hard cap — exhaustion is LOUD                                         */
/* ========================================================================== */

test("exhaustion: one 3,300,000 CATT claim fills the season exactly, and the next claim of ANY positive amount throws", async () => {
  await bothAdapters("exhaust-single", async (store) => {
    const filled = await settle(store, {
      userAddress: USER_A,
      amount: SEASON_ALLOCATION,
      nonce: 1,
      now: IN_SEASON_1,
    });
    assert.equal(filled.paid, SEASON_ALLOCATION);
    assert.equal(filled.seasonClaimedTotal, SEASON_ALLOCATION, "the season is filled to exactly its allocation");
    assert.equal(filled.remainingAfter, "0", "nothing is left once the 3,300,000 CATT claim lands");
    assert.equal(filled.remaining, SEASON_ALLOCATION, "and the whole pool was what was available before it");

    const exhausted = await remainingForSeason(store, "season-1");
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.remaining, "0");
    assert.equal(exhausted.claimedTotal, SEASON_ALLOCATION);

    // The smallest possible positive claim: one base unit, and a large one.
    for (const amount of ["1", "2000000000000000000", SEASON_ALLOCATION]) {
      await assert.rejects(
        () => settle(store, { userAddress: USER_B, amount, nonce: 1, now: IN_SEASON_1 + 10 }),
        (err) => {
          assert.equal(err.name, SEASON_ERROR_NAME);
          assert.equal(err.code, "SEASON_ALLOCATION_EXHAUSTED");
          assert.equal(err.code, "SEASON_ALLOCATION_EXHAUSTED");
          assert.equal(err.seasonId, "season-1");
          assert.equal(err.allocation, SEASON_ALLOCATION);
          assert.equal(err.claimedTotal, SEASON_ALLOCATION);
          assert.equal(err.requested, amount);
          assert.equal(err.remaining, "0");
          assert.equal(err.shortfall, amount, "shortfall is how far past the cap this claim would have gone");
          assert.equal(err.settled, false);
          assert.equal(err.partialPayment, false);
          return true;
        }
      );
    }
    // THE SEASON TOTAL DID NOT MOVE. Three refused claims, still exactly 2M.
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION);
    assert.equal(
      await store.getSeasonUserAccrued({ seasonId: "season-1", userAddress: USER_B }),
      "0",
      "a refused claim accrues nothing to anybody"
    );
    assert.equal(
      await store.isSeasonClaimUsed({ seasonId: "season-1", userAddress: USER_B, nonce: 1 }),
      false,
      "a refused claim is not recorded, so the nonce is still free"
    );
  });
});

test("exhaustion: a ladder of smaller claims fills the season to exactly its allocation, then the next fails", async () => {
  await bothAdapters("exhaust-ladder", async (store) => {
    // 66 claims of 50,000 CATT = 3,300,000 CATT. Integer base units throughout:
    // 50000 * 10^18.
    const rung = 50_000n * CATT_BASE_UNITS;
    assert.equal(rung * 66n, SEASON_ALLOCATION_CATT * CATT_BASE_UNITS);
    for (let step = 1; step <= 66; step += 1) {
      const result = await settle(store, {
        userAddress: step % 2 === 0 ? USER_B : USER_A,
        amount: rung.toString(),
        nonce: step,
        now: IN_SEASON_1 + step,
      });
      assert.equal(result.settled, true);
      assert.equal(result.paid, rung.toString());
      assert.equal(result.seasonClaimedTotal, (rung * BigInt(step)).toString());
    }
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION);

    // 67th claim, from a third user who has never claimed: refused, loudly.
    await assert.rejects(
      () => settle(store, { userAddress: USER_C, amount: rung.toString(), nonce: 99, now: IN_SEASON_1 + 99 }),
      (err) => {
        assert.equal(err.code, "SEASON_ALLOCATION_EXHAUSTED");
        assert.equal(err.claimedTotal, SEASON_ALLOCATION);
        assert.equal(err.remaining, "0");
        assert.equal(err.requested, rung.toString());
        assert.equal(err.shortfall, rung.toString());
        return true;
      }
    );
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION, "the total is unmoved");
  });
});

test("exhaustion: the boundary case — remaining allocation smaller than the request", async () => {
  await bothAdapters("exhaust-boundary", async (store) => {
    const left = "5";
    // Fill to allocation - 5 base units: a real claim, then a real remainder.
    const almost = BigInt(SEASON_ALLOCATION) - 5n;
    const filled = await settle(store, { userAddress: USER_A, amount: almost.toString(), nonce: 1, now: IN_SEASON_1 });
    assert.equal(filled.remainingAfter, left, "exactly 5 base units remain after that claim");

    // A request for 10 overshoots the remaining 5 by exactly 5.
    await assert.rejects(
      () => settle(store, { userAddress: USER_B, amount: "10", nonce: 1, now: IN_SEASON_1 + 1 }),
      (err) => {
        assert.equal(err.code, "SEASON_ALLOCATION_EXHAUSTED");
        assert.equal(err.remaining, left);
        assert.equal(err.requested, "10");
        assert.equal(err.shortfall, "5", "10 requested, 5 available, 5 short");
        assert.equal(err.claimedTotal, almost.toString());
        assert.equal(err.allocation, SEASON_ALLOCATION);
        return true;
      }
    );
    // The last 5 units are NOT reachable: a claim for exactly 5 settles, and
    // only then does the pool close for good.
    const last = await settle(store, { userAddress: USER_B, amount: left, nonce: 2, now: IN_SEASON_1 + 2 });
    assert.equal(last.paid, "5");
    assert.equal(last.remaining, left, "the last 5 units were available before this claim");
    assert.equal(last.remainingAfter, "0", "and the pool closes once they are taken");
    assert.equal((await remainingForSeason(store, "season-1")).remaining, "0");
    await assert.rejects(
      () => settle(store, { userAddress: USER_C, amount: "1", nonce: 1, now: IN_SEASON_1 + 3 }),
      (err) => err.code === "SEASON_ALLOCATION_EXHAUSTED"
    );
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION);
  });
});

test("exhaustion: a zero-amount claim consumes no allocation and moves no total", async () => {
  await bothAdapters("zero", async (store) => {
    const zero = await settle(store, { userAddress: USER_A, amount: "0", nonce: 1, now: IN_SEASON_1 });
    assert.equal(zero.settled, true);
    assert.equal(zero.amount, "0");
    assert.equal(zero.paid, "0");
    assert.equal(zero.seasonClaimedTotal, "0", "a zero claim moves nothing");
    assert.equal(zero.remaining, SEASON_ALLOCATION);
    assert.equal(zero.remainingAfter, SEASON_ALLOCATION, "a zero claim consumes nothing at all");

    // Even against a fully exhausted season, a zero claim is admissible: it
    // consumes no allocation, so it cannot push the total past the cap.
    await settle(store, { userAddress: USER_B, amount: SEASON_ALLOCATION, nonce: 1, now: IN_SEASON_1 });
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION);
    const zeroAfterExhaustion = await settle(store, {
      userAddress: USER_A,
      amount: 0n,
      nonce: 2,
      now: IN_SEASON_1 + 1,
    });
    assert.equal(zeroAfterExhaustion.paid, "0");
    assert.equal(zeroAfterExhaustion.seasonClaimedTotal, SEASON_ALLOCATION, "still unmoved");
    // And it is a NO-OP, not a payment: `paid` is zero and the season total is
    // unchanged. A caller reading `settled: true` must still see `paid: "0"`.
    assert.equal(zeroAfterExhaustion.settled, true);
    assert.equal(zeroAfterExhaustion.paid, "0");
  });
});

test("exhaustion is NEVER reported as a successful zero payment", async () => {
  await bothAdapters("no-silent-zero", async (store) => {
    await settle(store, { userAddress: USER_A, amount: SEASON_ALLOCATION, nonce: 1, now: IN_SEASON_1 });

    // The refusal is a THROW, so there is no return value a caller could mistake
    // for a payment: the refusal has no `paid` field at all.
    let returned;
    await assert.rejects(
      async () => {
        returned = await settle(store, {
          userAddress: USER_A,
          amount: "5000000000000000000",
          nonce: 2,
          now: IN_SEASON_1 + 1,
        });
      },
      (err) => err.code === "SEASON_ALLOCATION_EXHAUSTED"
    );
    assert.equal(returned, undefined, "settle returned nothing at all");
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION, "no partial payment landed");

    // The preview oracle agrees, loudly, and writes nothing — so a client that
    // asks first is told the same thing rather than discovering it on-chain.
    await assert.rejects(
      () =>
        previewSettlement(store, {
          userAddress: USER_A,
          amount: "5000000000000000000",
          nonce: 3,
          now: IN_SEASON_1 + 2,
        }),
      (err) => err.code === "SEASON_ALLOCATION_EXHAUSTED"
    );
    assert.equal(await store.getSeasonClaimedTotal("season-1"), SEASON_ALLOCATION);
    assert.equal(
      await store.isSeasonClaimUsed({ seasonId: "season-1", userAddress: USER_A, nonce: 3 }),
      false,
      "a preview burns no nonce"
    );

    // Mining for the season really has stopped: every positive claim from every
    // user is refused, not just this user's.
    for (const user of [USER_A, USER_B, USER_C]) {
      await assert.rejects(
        () => settle(store, { userAddress: user, amount: "1", nonce: 42, now: IN_SEASON_1 + 3 }),
        (err) => err.code === "SEASON_ALLOCATION_EXHAUSTED"
      );
    }
    // ...and the NEXT season opens a fresh pool, because that is the documented
    // way the stop is supposed to end.
    const nextSeasonNow = SEASON_DURATION_SECONDS + 1;
    const resumed = await settle(store, {
      userAddress: USER_A,
      amount: "5000000000000000000",
      nonce: 1,
      now: nextSeasonNow,
    });
    assert.equal(resumed.seasonId, "season-2");
    assert.equal(resumed.paid, "5000000000000000000");
    assert.equal(resumed.seasonClaimedTotal, "5000000000000000000", "season 2 starts empty, not at 2M-minus-spent");
  });
});

/* ========================================================================== */
/* 6. Pool readings                                                            */
/* ========================================================================== */

test("pool: remaining, claimed and still-unallocated across the whole headroom", async () => {
  await bothAdapters("pool", async (store) => {
    const fresh = await remainingForSeason(store, "season-1");
    assert.deepEqual({ ...fresh }, {
      seasonId: "season-1",
      allocation: SEASON_ALLOCATION,
      claimedTotal: "0",
      remaining: SEASON_ALLOCATION,
      exhausted: false,
    });

    assert.equal(await totalHeadroomClaimed(store), "0");
    assert.equal(
      await totalHeadroomStillUnallocated(store),
      (39_600_000n * CATT_BASE_UNITS).toString(),
      "a fresh 12-season schedule still holds the whole 39,600,000 CATT"
    );

    await settle(store, { userAddress: USER_A, amount: SEASON_ALLOCATION, nonce: 1, now: IN_SEASON_1 });
    assert.equal(await totalHeadroomClaimed(store), SEASON_ALLOCATION);
    assert.equal(
      await totalHeadroomStillUnallocated(store),
      (36_300_000n * CATT_BASE_UNITS).toString(),
      "season 1's spent 3,300,000 CATT is NOT recycled into anyone"
    );

    // A season that has not been written yet still owns its full allocation.
    await store.saveSeason({
      id: "season-3",
      start: 2 * SEASON_DURATION_SECONDS,
      end: 3 * SEASON_DURATION_SECONDS,
      allocation: SEASON_ALLOCATION,
      claimMode: CLAIM_MODE_DAILY,
    });
    await settle(store, {
      userAddress: USER_A,
      amount: "1000000000000000000",
      nonce: 1,
      now: 2 * SEASON_DURATION_SECONDS + 1,
    });
    assert.equal(await totalHeadroomClaimed(store), (BigInt(SEASON_ALLOCATION) + 1_000_000_000_000_000_000n).toString());
    assert.equal(
      await totalHeadroomStillUnallocated(store),
      (36_300_000n * CATT_BASE_UNITS - 1_000_000_000_000_000_000n).toString(),
      "season 1 is still exhausted and season 3 has spent 1 CATT; 36,300,000 CATT remain"
    );
  });
});

/* ========================================================================== */
/* 7. Exactness: decimal strings, no floats, values above 2^53                */
/* ========================================================================== */

test("exactness: amounts round-trip as exact decimal strings and nothing is a float", async () => {
  await bothAdapters("exact", async (store) => {
    // 2^53 + 1: a Number cannot hold it, so a lossy implementation would show.
    const first = await settle(store, { userAddress: USER_A, amount: HUGE, nonce: 1, now: IN_SEASON_1 });
    assert.equal(typeof first.paid, "string");
    assert.equal(first.paid, HUGE);
    assert.equal(first.seasonClaimedTotal, HUGE);
    // The float that would have been used instead: lossy, and provably so.
    assert.notEqual(BigInt(String(Number(HUGE))), BigInt(HUGE));

    // And a long-tailed 1.23e24 amount, through the whole read path.
    const big = await settle(store, { userAddress: USER_B, amount: HUGE_CATT, nonce: 1, now: IN_SEASON_1 + 1 });
    assert.equal(big.paid, HUGE_CATT);
    assert.equal(
      big.seasonClaimedTotal,
      (BigInt(HUGE) + BigInt(HUGE_CATT)).toString(),
      "the running total is exact above 2^53 and above 2e24"
    );
    // The float path: `BigInt(Number(x))` is what a float-based implementation
    // would have written, and it lands on a DIFFERENT integer entirely.
    assert.notEqual(BigInt(Number(HUGE_CATT)), BigInt(HUGE_CATT));
    assert.notEqual(String(Number(HUGE_CATT)), HUGE_CATT);

    const remaining = await remainingForSeason(store, "season-1");
    assert.equal(remaining.claimedTotal, (BigInt(HUGE) + BigInt(HUGE_CATT)).toString());
    assert.equal(
      remaining.remaining,
      (BigInt(SEASON_ALLOCATION) - BigInt(HUGE) - BigInt(HUGE_CATT)).toString()
    );
    for (const field of [remaining.allocation, remaining.claimedTotal, remaining.remaining]) {
      assert.equal(typeof field, "string");
      assert.match(field, /^\d+$/, "every CATT figure is a decimal-digit string");
    }
    assert.equal(await totalHeadroomClaimed(store), (BigInt(HUGE) + BigInt(HUGE_CATT)).toString());
  });
});

test("exactness: a CATT amount may never be a Number, and floats are refused", async () => {
  await bothAdapters("no-number", async (store) => {
    for (const bad of [2.5, -1, NaN, Infinity, "1.5", "1e18", " 12 34 ", null, undefined, {}, true]) {
      await assert.rejects(
        () => settle(store, { userAddress: USER_A, amount: bad, nonce: 1, now: IN_SEASON_1 }),
        (err) => err.code === "SEASON_INVALID_ARGUMENT",
        `amount ${JSON.stringify(bad)} must be refused`
      );
    }
    // A whole-number `Number` is refused too: accepting it would make precision
    // a property of how carefully the caller typed.
    await assert.rejects(
      () => settle(store, { userAddress: USER_A, amount: 30, nonce: 1, now: IN_SEASON_1 }),
      (err) => err.code === "SEASON_INVALID_ARGUMENT"
    );
    // A `bigint` and a digit string are both fine, and agree.
    const viaBigInt = await settle(store, { userAddress: USER_A, amount: 1_000_000_000_000_000_000n, nonce: 1, now: IN_SEASON_1 });
    const viaString = await settle(store, { userAddress: USER_A, amount: "1000000000000000000", nonce: 2, now: IN_SEASON_1 });
    assert.equal(viaBigInt.paid, viaString.paid);
    assert.equal(viaString.seasonClaimedTotal, "2000000000000000000", "both spellings accrued exactly");
  });
});

test("previewSettlement never writes and agrees with settle verdict for verdict", async () => {
  await bothAdapters("preview", async (store) => {
    const preview = await previewSettlement(store, {
      userAddress: USER_A,
      amount: "4000000000000000000",
      nonce: 5,
      now: IN_SEASON_1,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.settled, false);
    assert.equal(preview.seasonId, "season-1");
    assert.equal(preview.amount, "4000000000000000000");
    assert.equal(preview.remaining, SEASON_ALLOCATION);
    assert.equal(preview.remainingAfter, (BigInt(SEASON_ALLOCATION) - 4_000_000_000_000_000_000n).toString());
    assert.equal(preview.claimMode, CLAIM_MODE_DAILY);
    // NOTHING was written and the nonce is still free.
    assert.equal(await store.getSeasonClaimedTotal("season-1"), "0");
    assert.equal(
      await store.isSeasonClaimUsed({ seasonId: "season-1", userAddress: USER_A, nonce: 5 }),
      false
    );
    // The same nonce then settles for real.
    const settled = await settle(store, {
      userAddress: USER_A,
      amount: "4000000000000000000",
      nonce: 5,
      now: IN_SEASON_1,
    });
    assert.equal(settled.paid, preview.amount);
    assert.equal(settled.settled, true);

    // A preview of an inadmissible claim fails the same way settle does.
    for (const params of [
      { amount: "1000000000000000000", nonce: 6, now: SEASON_EPOCH - 1 },
      { amount: "1000000000000000000", nonce: 5, now: IN_SEASON_1 },
    ]) {
      await assert.rejects(
        () => previewSettlement(store, { userAddress: USER_A, ...params }),
        (err) => typeof err.code === "string" && err.code.startsWith("SEASON_")
      );
    }
  });
});

/* ========================================================================== */
/* 8. The source itself                                                        */
/* ========================================================================== */

test("source: no CATT amount is ever parsed with Number, and the typo literal is absent", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "seasons.js"), "utf8");
  // `Number(` applied to an amount-bearing name is the exact shape of the bug
  // the module header warns about.
  assert.ok(
    !/Number\(\s*(amount|allocation|claimedTotal|remaining|paid|userAccrued|requested|shortfall)\b/.test(
      source
    ),
    "no CATT amount may be passed through Number()"
  );
  assert.ok(!/parseFloat|parseInt/.test(source), "no parseFloat/parseInt in a money path");
  assert.ok(source.includes('"2000000000000000000000000"'), "the 25-digit allocation literal is present");
  assert.ok(
    !/[^0-9"]2000000000000000000[^0-9"]/.test(source),
    "the 22-digit 2,000 CATT typo literal appears nowhere in the source"
  );
});
