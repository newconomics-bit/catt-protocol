/**
 * CATT Protocol — DETERMINISTIC DRAIN SIMULATION of the shipped tokenomics, run
 * as a test.
 *
 *   cd backend-server && npm test      # this file prints its full report
 *   cd backend-server && node scripts/simulate-drain.js   # identical report
 *
 * ===========================================================================
 * THIS FILE REPORTS THE FOUNDER'S CLAIM. IT DOES NOT ENFORCE IT.
 * ===========================================================================
 * The claim under test is:
 *
 *     "with 10,000 active miners, the 2,000,000 CATT per-season pool will NEVER
 *      break earlier than the schedule without breaking the system, and the 40M
 *      total runway is safe for at least 20 seasons (600 days)."
 *
 * There is NO assertion anywhere below of the form "the claim is true". Every
 * assertion is a FACTUAL INVARIANT of the shipped constants and of the
 * simulation's own internal consistency:
 *
 *   - `SEASON_COUNT * SEASON_ALLOCATION_CATT === TOTAL_HEADROOM_CATT === 40M`
 *   - `SEASON_COUNT * SEASON_DURATION_DAYS === TOTAL_SEASON_DAYS === 600`
 *   - the 25-digit allocation literal is 2,000,000 CATT and not 2,000 or 2
 *   - the real 20-season schedule is 20 contiguous 30-day windows from
 *     `SEASON_EPOCH`, totalling 600 days
 *   - the network drain is MONOTONE NON-INCREASING in `activeMiners`, and never
 *     negative, at every budget and every streak state
 *   - a season's pool is either FULLY drained (the hard cap stopped it) or the
 *     window closed first — never partially drained
 *   - `runwayDays === seasonsOpened * seasonMinedDays` and
 *     `seasonMinedDays + daysLost === SEASON_DURATION_DAYS`
 *   - total drained never exceeds the 40,000,000 CATT headroom
 *   - the realised daily routine never spends more stamina than the day's cap
 *   - the 2.0x streak cap pays strictly more than the 1.0x day-1 multiple
 *   - the simulation is DETERMINISTIC: two runs are byte-identical
 *   - every reward the simulation reports is reproduced by a direct call to the
 *     REAL `computeReward` from this file (cross-check, not re-derivation)
 *
 * If the shipped configuration drains the headroom in 80 days instead of 600,
 * this suite is GREEN and the report says so loudly. A failing economy is data,
 * not a red build. Making these numbers look better is a founder decision, and
 * nothing in this file edits a constant to make one.
 *
 * ONE ARITHMETIC, ONE SOURCE: every number here comes from
 * `scripts/simulate-drain.js`, which the test requires and whose `formatReport`
 * output this file prints verbatim. The duplication runs in ONE direction —
 * script -> test — so the test never re-derives a figure the script also prints.
 * The direct `computeReward` calls in the cross-check below are an INDEPENDENT
 * verification that the script really is pricing through the shipped function,
 * not a second copy of the arithmetic.
 *
 * NO randomness, NO wall clock, NO I/O, NO store, NO network: the only notion of
 * time is an index into the season list, and the epoch is the injected
 * `SEASON_EPOCH`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeReward,
  dynamicEmissionFactorBps,
  streakFactorBps,
  DYNAMIC_EMISSION_TRIGGER_MINERS,
  DYNAMIC_EMISSION_FLOOR_BPS,
  STREAK_BASE_BPS,
  STREAK_MAX_BPS,
  STREAK_CAP_FIRST_REACHED_DAY,
} = require("../src/economics.js");

const {
  SEASON_ALLOCATION,
  SEASON_ALLOCATION_CATT,
  SEASON_COUNT,
  SEASON_DURATION_DAYS,
  SEASON_EPOCH,
  TOTAL_HEADROOM_CATT,
  TOTAL_SEASON_DAYS,
  CATT_BASE_UNITS,
  buildSeasonSchedule,
} = require("../src/seasons.js");

const { MISSIONS, DIFFICULTIES, DEFAULT_DAILY_STAMINA_CAP } = require("../src/content.js");
const { FREE_STAMINA_PER_DAY, DAILY_SPEND_CAP_POINTS } = require("../src/stamina-allowance.js");

const {
  MIX_WAVE8,
  SCENARIOS,
  BUDGETS,
  STREAK_OFF_DAYS,
  STREAK_CAP_DAYS,
  price,
  runScenario,
  runSimulation,
  evaluateClaim,
  formatReport,
} = require("../scripts/simulate-drain.js");

/** One simulation for the whole file: pure, so it is computed once. */
const SIM = runSimulation();

/** The whole report, exactly as `node scripts/simulate-drain.js` prints it. */
const REPORT = formatReport(SIM);

/** The three real missions, by difficulty, straight out of `content.js`. */
const EASY = MISSIONS.find((m) => m.difficulty === DIFFICULTIES.EASY);
const MEDIUM = MISSIONS.find((m) => m.difficulty === DIFFICULTIES.MEDIUM);
const HARD = MISSIONS.find((m) => m.difficulty === DIFFICULTIES.HARD);

/** The scenarios in ascending miner count, which is also emission-descending. */
const ASCENDING = [...SIM.scenarios].sort((a, b) => a.activeMiners - b.activeMiners);

/* -------------------------------------------------------------------------- */

test("PRINTS THE DRAIN SIMULATION REPORT (the deliverable of this file)", () => {
  assert.equal(typeof REPORT, "string");
  assert.ok(REPORT.length > 2000, "the report must be the full report, not a stub");
  console.log(`\n${REPORT}\n`);
});

test("the schedule identity 20 x 2,000,000 = 40,000,000 CATT holds", () => {
  assert.equal(BigInt(SEASON_COUNT) * SEASON_ALLOCATION_CATT, TOTAL_HEADROOM_CATT);
  assert.equal(TOTAL_HEADROOM_CATT, 40_000_000n);
  assert.equal(TOTAL_HEADROOM_CATT * CATT_BASE_UNITS, SIM.constants.totalHeadroomBaseUnits);
});

test("the 2,000,000 CATT allocation is the 25-digit base-unit literal", () => {
  assert.equal(SEASON_ALLOCATION.length, 25);
  assert.equal(BigInt(SEASON_ALLOCATION), 2_000_000n * CATT_BASE_UNITS);
  assert.equal(BigInt(SEASON_ALLOCATION), SIM.constants.seasonPoolBaseUnits);
  assert.equal(SIM.constants.seasonPoolCatt, SEASON_ALLOCATION_CATT);
});

test("20 seasons x 30 days is the 600-day schedule", () => {
  assert.equal(SEASON_COUNT, 20);
  assert.equal(SEASON_DURATION_DAYS, 30);
  assert.equal(SEASON_COUNT * SEASON_DURATION_DAYS, 600);
  assert.equal(TOTAL_SEASON_DAYS, SEASON_COUNT * SEASON_DURATION_DAYS);
  assert.equal(SIM.constants.totalScheduleDays, 600);
});

test("the REAL schedule is 20 contiguous 30-day windows covering exactly 600 days", () => {
  const schedule = buildSeasonSchedule({ epoch: SEASON_EPOCH });
  assert.equal(schedule.length, SEASON_COUNT);
  assert.equal(schedule[0].start, SEASON_EPOCH);
  for (let i = 1; i < schedule.length; i += 1) {
    assert.equal(schedule[i].start, schedule[i - 1].end, `season ${i + 1} must abut season ${i}`);
  }
  const last = schedule[schedule.length - 1];
  assert.equal(last.end - SEASON_EPOCH, 600 * 86400);
  assert.ok(schedule.every((season) => season.allocation === SEASON_ALLOCATION));
});

test("the report is DETERMINISTIC: two runs are byte-identical", () => {
  assert.equal(formatReport(runSimulation()), REPORT);
});

test("every reward the report shows comes from the REAL computeReward", () => {
  const founder = SIM.scenarios.find((s) => s.label === "FOUNDER'S CASE");
  assert.equal(founder.activeMiners, 10000);
  for (const [mission, difficulty] of [
    [EASY, DIFFICULTIES.EASY],
    [MEDIUM, DIFFICULTIES.MEDIUM],
    [HARD, DIFFICULTIES.HARD],
  ]) {
    const direct = computeReward({
      mission,
      activeMiners: founder.activeMiners,
      streakDays: STREAK_CAP_DAYS,
    });
    assert.equal(BigInt(direct.reward), founder.priced.perDifficulty[difficulty]);
    assert.equal(direct.dynamicFactorBps, founder.dynamicFactorBps);
    assert.equal(direct.combinedFactorBps, founder.priced.cycle[0].combinedFactorBps);
  }
  // And the base rewards the report quotes are the authored strings, byte for byte.
  assert.equal(SIM.constants.missions[DIFFICULTIES.EASY].reward, EASY.reward);
  assert.equal(SIM.constants.missions[DIFFICULTIES.MEDIUM].reward, MEDIUM.reward);
  assert.equal(SIM.constants.missions[DIFFICULTIES.HARD].reward, HARD.reward);
});

test("the dynamic factor is what the shipped ramp actually returns at each scenario", () => {
  const expected = new Map([
    [1000, 10000n], // at/below the trigger: exactly 1.0x
    [5000, 10000n], // AT the trigger: still exactly 1.0x
    [10000, 9445n], // inside the ramp
    [20000, 8334n], // inside the ramp
  ]);
  for (const scenario of SIM.scenarios) {
    assert.equal(scenario.dynamicFactorBps, expected.get(scenario.activeMiners));
    assert.equal(scenario.dynamicFactorBps, dynamicEmissionFactorBps(scenario.activeMiners));
  }
  assert.ok(dynamicEmissionFactorBps(5000n) === 10000n);
  assert.ok(dynamicEmissionFactorBps(10000n) >= DYNAMIC_EMISSION_FLOOR_BPS);
  assert.ok(dynamicEmissionFactorBps(50_000_000n) === DYNAMIC_EMISSION_FLOOR_BPS);
  assert.equal(DYNAMIC_EMISSION_TRIGGER_MINERS, 5000n);
});

test("the drain is MONOTONE NON-INCREASING in activeMiners, at every budget and streak", () => {
  for (let index = 1; index < ASCENDING.length; index += 1) {
    const previous = ASCENDING[index - 1];
    const current = ASCENDING[index];
    assert.ok(current.activeMiners > previous.activeMiners, "scenarios must ascend by miner count");
    for (let row = 0; row < current.rows.length; row += 1) {
      assert.ok(
        current.rows[row].drainPerUserPerDay <= previous.rows[row].drainPerUserPerDay,
        `per-user drain must not rise from ${previous.activeMiners} to ${current.activeMiners} miners`
      );
      // More miners at an equal-or-lower per-user reward is strictly more drain.
      assert.ok(current.rows[row].netDrainPerDay > previous.rows[row].netDrainPerDay);
    }
  }
  // A finer sweep, still entirely through the real `computeReward`.
  const sweep = [0, 1, 999, 1000, 4999, 5000, 5001, 10_000, 25_000, 49_999, 50_000, 500_000];
  let lastPerUser = null;
  for (const miners of sweep) {
    const priced = price(EASY, { activeMiners: miners, streakDays: STREAK_CAP_DAYS });
    assert.ok(priced.reward > 0n, "a real mission always pays something positive");
    assert.ok(priced.dynamicFactorBps >= DYNAMIC_EMISSION_FLOOR_BPS);
    assert.ok(priced.dynamicFactorBps <= 10000n);
    if (lastPerUser !== null) assert.ok(priced.reward <= lastPerUser, `reward rose at ${miners} miners`);
    lastPerUser = priced.reward;
  }
});

test("no reward ever exceeds base x 2.0x or falls below base x 0.5x", () => {
  for (const scenario of SIM.scenarios) {
    for (const entry of scenario.priced.cycle) {
      assert.ok(entry.reward <= entry.baseReward * 2n, "the streak cap is the only thing above base");
      assert.ok(entry.reward >= (entry.baseReward * DYNAMIC_EMISSION_FLOOR_BPS) / 10000n);
    }
    for (const entry of SIM.streakLadder) {
      assert.ok(entry.streakFactorBps >= STREAK_BASE_BPS);
      assert.ok(entry.streakFactorBps <= STREAK_MAX_BPS);
    }
  }
  // The shipped ladder, exactly as economics.js documents it.
  assert.equal(streakFactorBps(0n), STREAK_BASE_BPS);
  assert.equal(streakFactorBps(1n), 10000n);
  assert.equal(streakFactorBps(6n), STREAK_MAX_BPS);
  assert.equal(streakFactorBps(99n), STREAK_MAX_BPS);
  assert.equal(STREAK_CAP_FIRST_REACHED_DAY, 6n);
});

test("the 2.0x streak cap pays strictly more than the 1.0x day-1 multiple", () => {
  const [off, capped] = SIM.streakSensitivity;
  assert.equal(off.streakFactorBps, STREAK_BASE_BPS);
  assert.equal(capped.streakFactorBps, STREAK_MAX_BPS);
  assert.equal(off.streakDays, STREAK_OFF_DAYS);
  assert.equal(capped.streakDays, STREAK_CAP_DAYS);
  for (let row = 0; row < capped.rows.length; row += 1) {
    assert.ok(capped.rows[row].drainPerUserPerDay > off.rows[row].drainPerUserPerDay);
  }
});

test("the realised daily routine never spends more stamina than the day's cap", () => {
  assert.equal(DEFAULT_DAILY_STAMINA_CAP, 50);
  assert.equal(DAILY_SPEND_CAP_POINTS, DEFAULT_DAILY_STAMINA_CAP);
  assert.equal(FREE_STAMINA_PER_DAY, 30n);
  for (const scenario of SIM.scenarios) {
    for (const row of scenario.rows) {
      assert.ok(row.budget.spend <= DEFAULT_DAILY_STAMINA_CAP, "the spend cap binds");
      assert.ok(row.realised.pointsSpent <= row.budget.spend);
      assert.ok(row.realised.drain > 0n, "a day with a budget pays something");
      assert.ok(row.realised.missions >= 1);
    }
  }
  // The free grant alone funds a 30-point day; one stake lifts it to the 50 cap.
  assert.deepEqual(
    BUDGETS.map((b) => [b.stakes, Number(b.available), b.spend]),
    [
      [0, 30, 30],
      [1, 80, 50],
    ]
  );
  // The Wave 8 mix is 6 easy / 3 medium / 1 hard, priced from `content.js`.
  assert.equal(MIX_WAVE8.counts[DIFFICULTIES.EASY], 6);
  assert.equal(MIX_WAVE8.counts[DIFFICULTIES.MEDIUM], 3);
  assert.equal(MIX_WAVE8.counts[DIFFICULTIES.HARD], 1);
  assert.equal(
    SIM.scenarios[0].priced.totalPoints,
    BigInt(6 * EASY.staminaCost + 3 * MEDIUM.staminaCost + HARD.staminaCost)
  );
});

test("a season pool is FULLY drained or its window closed first — never partially", () => {
  for (const scenario of SIM.scenarios) {
    for (const row of scenario.rows) {
      for (const season of row.walk.seasons) {
        if (season.minedDays === SEASON_DURATION_DAYS) {
          assert.equal(season.drained, row.walk.seasons[0].drained);
          assert.ok(season.drained <= SIM.constants.seasonPoolBaseUnits);
        } else {
          // The hard cap stopped it: the whole pool is gone, and nothing more.
          assert.equal(season.drained, SIM.constants.seasonPoolBaseUnits, `${season.id} must be drained exactly`);
        }
        assert.equal(season.minedDays + season.daysLost, SEASON_DURATION_DAYS);
      }
    }
  }
});

test("runway = seasons opened x mining days per season, and never exceeds the schedule", () => {
  for (const scenario of SIM.scenarios) {
    for (const row of scenario.rows) {
      const walk = row.walk;
      assert.equal(walk.seasonsOpened, SEASON_COUNT);
      assert.equal(walk.runwayDays, walk.seasonsOpened * Number(walk.seasonMinedDays));
      assert.ok(walk.runwayDays <= TOTAL_SEASON_DAYS, "a season cannot pay beyond its own window");
      assert.ok(walk.totalDrained <= SIM.constants.totalHeadroomBaseUnits, "the headroom is a hard ceiling");
      if (!walk.headroomExhausted) {
        assert.ok(walk.leftover > 0n);
      } else {
        assert.equal(walk.leftover, 0n);
      }
    }
  }
});

test("the claim evaluation is STRUCTURAL: it is reported, never asserted", () => {
  const checks = SIM.claim.checks;
  assert.equal(checks.length, BUDGETS.length, "one verdict per stamina budget");
  for (const check of checks) {
    // Only the SHAPE is asserted. `check.poolSurvives30Days` and
    // `check.runwayReaches600Days` may be true OR false: the economy is what it
    // is, and a red build must not be how this file expresses that.
    assert.equal(typeof check.poolSurvives30Days, "boolean");
    assert.equal(typeof check.runwayReaches600Days, "boolean");
    assert.ok(check.runwayDays >= 1 && check.runwayDays <= TOTAL_SEASON_DAYS);
    assert.ok(check.emptiesOnSeasonDay >= 1 && check.emptiesOnSeasonDay <= SEASON_DURATION_DAYS);
    assert.equal(SIM.claim.holds, checks.every((c) => c.poolSurvives30Days && c.runwayReaches600Days));
  }
  // Re-evaluating from the scenario data alone gives the same verdicts.
  const founder = SIM.scenarios.find((s) => s.label === "FOUNDER'S CASE");
  assert.deepEqual(evaluateClaim(SIM), SIM.claim);
  assert.equal(founder.activeMiners, 10000);
  console.log(
    `  [reported, not asserted] founder's claim holds on the shipped constants: ${SIM.claim.holds}` +
      ` — pool-empty days: ${SIM.claim.checks.map((c) => c.emptiesOnSeasonDay).join("/")}, ` +
      `40M runway days: ${SIM.claim.checks.map((c) => c.runwayDays).join("/")} (needs 600).`
  );
});

test("the break-even search agrees with the scenario walk at its own threshold", () => {
  for (const row of SIM.breakEven) {
    for (const entry of row.byBudget) {
      const walk = runScenario(
        { label: "BREAK-EVEN CHECK", activeMiners: entry.miners, streakDays: row.streakDays },
        { budgets: [entry.budget] }
      ).rows[0].walk;
      assert.ok(
        walk.emptiesOnSeasonDay >= BigInt(SEASON_DURATION_DAYS),
        `${entry.miners} miners must still fill 30 days`
      );
      const above = runScenario(
        { label: "BREAK-EVEN CHECK", activeMiners: entry.miners + 1, streakDays: row.streakDays },
        { budgets: [entry.budget] }
      ).rows[0].walk;
      assert.ok(
        above.emptiesOnSeasonDay < BigInt(SEASON_DURATION_DAYS),
        `${entry.miners + 1} miners must NOT still fill 30 days`
      );
    }
  }
});

test("the four requested scenarios are simulated, in miner order, with labels", () => {
  assert.deepEqual(
    SCENARIOS.map((s) => s.activeMiners),
    [1000, 5000, 10000, 20000]
  );
  assert.deepEqual(
    SIM.scenarios.map((s) => s.label),
    ["LOW", "CENTRAL", "FOUNDER'S CASE", "HIGH"]
  );
  for (const scenario of SIM.scenarios) {
    assert.equal(scenario.mix, MIX_WAVE8, "the central case is the Wave 8 mix everywhere");
    assert.equal(scenario.rows.length, BUDGETS.length);
    for (const row of scenario.rows) {
      assert.ok(row.drainPerUserPerDay > 0n);
      assert.equal(row.netDrainPerDay, row.drainPerUserPerDay * BigInt(scenario.activeMiners));
    }
  }
});

test("the options are SOLVED from the shipped numbers and NONE of them is applied", () => {
  const options = SIM.options;
  // The founder's two conditions are the same equation: 2M/30 == 40M/600, so the
  // ceiling is one number, and at that rate neither the pool nor the headroom
  // is ever exceeded. (Floored, so "at most" holds with the rounding.)
  const target = options.targetNetworkPerDay;
  assert.equal(target, SIM.constants.seasonPoolBaseUnits / BigInt(SEASON_DURATION_DAYS));
  assert.ok(target > 0n);
  assert.ok(target * BigInt(SEASON_DURATION_DAYS) <= SIM.constants.seasonPoolBaseUnits);
  assert.ok(target * BigInt(TOTAL_SEASON_DAYS) <= SIM.constants.totalHeadroomBaseUnits);
  assert.ok(target * BigInt(TOTAL_SEASON_DAYS) + 599n * target > 0n);
  assert.equal(options.options.length, 6);
  const ids = options.options.map((o) => o.id);
  assert.deepEqual(ids, ["A", "B", "C", "D", "E", "F"]);
  for (const option of options.options) {
    assert.ok(typeof option.tradeoff === "string" && option.tradeoff.length > 40, `${option.id} must state its trade-off`);
  }
  // Option C would have to break the shipped identity — reported, never applied.
  assert.ok(options.options[2].requiredHeadroom > SIM.constants.totalHeadroomBaseUnits);
  assert.notEqual(options.options[2].requiredPool, SIM.constants.seasonPoolBaseUnits);
  // The shipped constants are exactly where they were before the simulation ran.
  assert.equal(SEASON_ALLOCATION_CATT, 2_000_000n);
  assert.equal(TOTAL_HEADROOM_CATT, 40_000_000n);
  assert.equal(DEFAULT_DAILY_STAMINA_CAP, 50);
  assert.equal(FREE_STAMINA_PER_DAY, 30n);
  assert.equal(EASY.reward, "12000000000000000000");
  assert.equal(MEDIUM.reward, "20000000000000000000");
  assert.equal(HARD.reward, "40000000000000000000");
});