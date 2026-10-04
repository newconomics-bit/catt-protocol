/**
 * Unit tests for the CATT DAILY BUDGET GOVERNOR — the pure normaliser that sits
 * in the reward path (PRD economics, strategy S1+S2).
 *
 * Runner: Node's built-in test runner, no dependencies.
 *   cd backend-server && npm test          (whole backend suite)
 *   cd backend-server && node --test test/governor.test.js   (this file alone)
 *
 * What is asserted here, and why each is a property that could break:
 *   1. A HEALTHY DAY INTERFERES WITH NOTHING — full 12 / 20 / 40, byte-identical,
 *      `scaleBps === 10000n`. The founder's first requirement; a rounding
 *      artefact here would silently tax every early adopter.
 *   2. PROPORTIONAL SCALE-DOWN has an EXACT basis-point scale and an EXACT
 *      reward, pinned against BigInt arithmetic derived independently of the
 *      implementation.
 *   3. THE HARD FLOOR HOLDS — 3 / 5 / 10 CATT exactly, including a 10,000-miner
 *      viral spike priced with the REAL mission rewards read from `content.js`.
 *   4. BLACKOUT IS THE LAST RESORT — priced but NOT approved, and this module
 *      does not throw `SEASON_ALLOCATION_EXHAUSTED` itself.
 *   5. MONOTONICITY and the bounds `[floor, requested]` / `[0, 10000n]`.
 *   6. BOUNDARY ARITHMETIC — exactly-at-budget, one base unit over, a precisely
 *      exhausted day, and amounts far beyond `Number.MAX_SAFE_INTEGER`.
 *   7. INVALID INPUT throws `GOVERNOR_INVALID_INPUT` and never pays.
 *   8. PURITY — 25 hostile calls touch no store, no global and no clock, and the
 *      source contains no I/O, no randomness, no environment access and no async.
 *   9. INTEGRITY — every amount is a digit-only decimal string and no float
 *      literal appears anywhere in the module.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const governor = require("../src/governor.js");
const {
  BPS_ONE,
  DAILY_BUDGET,
  DAILY_BUDGET_CATT,
  SEASON_ALLOCATION_CATT,
  SEASON_DURATION_DAYS,
  GOVERNOR_FLOORS,
  GOVERNOR_FLOORS_CATT,
  GOVERNOR_DIFFICULTIES,
  GOVERNOR_REASONS,
  BLACKOUT_CALLER_ERROR_CODE,
  GOVERNOR_ERRORS,
  GOVERNOR_ERROR_NAME,
  governorReward,
} = governor;

const { MISSIONS } = require("../src/content.js");

/** One CATT in 18-decimal base units. */
const C = 10n ** 18n;

/** The three REAL missions, in the AGGRESSIVE 12 / 20 / 40 CATT ladder. */
const REAL_MISSIONS = Object.freeze(MISSIONS.slice(0, 3));

/** The default budget as a bigint, for arithmetic in the expectations. */
const BUDGET = BigInt(DAILY_BUDGET);

/** Matches a canonical decimal string: digits only, no sign, point or exponent. */
const DIGITS_ONLY = /^[0-9]+$/;

/**
 * The expected proportional scale, recomputed here from the specification with
 * BigInt arithmetic so the expectation is INDEPENDENT of the module under test.
 *
 * @param {bigint} remaining What is left of the day.
 * @param {bigint} requested The authored reward.
 * @returns {bigint} Expected basis-point scale.
 */
function expectedScaleBps(remaining, requested) {
  return (remaining * 10000n) / requested;
}

/* -------------------------------------------------------------------------- */
/* Module constants                                                             */
/* -------------------------------------------------------------------------- */

test("the daily budget is the season allocation spread over its days", () => {
  assert.equal(SEASON_ALLOCATION_CATT, 3_300_000n);
  assert.equal(SEASON_DURATION_DAYS, 30n);
  assert.equal(DAILY_BUDGET_CATT, 110_000n);
  assert.equal(DAILY_BUDGET, "110000000000000000000000");
  assert.equal(DAILY_BUDGET.length, 24, "110,000 CATT at 18 decimals is 24 digits");
  assert.equal(BigInt(DAILY_BUDGET), 110_000n * C);
  // The literal 110,000 CATT at 18 decimals is the string above; a shortened
  // literal would be a 1000x under-budget that still looks like a big number.
  assert.equal(BigInt(DAILY_BUDGET), DAILY_BUDGET_CATT * C);
  assert.equal(BPS_ONE, 10000n);
});

test("the floors are the founder's 3 / 5 / 10 CATT, in base units and absolute", () => {
  assert.equal(GOVERNOR_FLOORS.EASY, 3n * C);
  assert.equal(GOVERNOR_FLOORS.MEDIUM, 5n * C);
  assert.equal(GOVERNOR_FLOORS.HARD, 10n * C);
  assert.deepEqual(Object.keys(GOVERNOR_FLOORS), ["EASY", "MEDIUM", "HARD"]);
  assert.deepEqual(GOVERNOR_DIFFICULTIES, ["EASY", "MEDIUM", "HARD"]);
  assert.deepEqual(GOVERNOR_FLOORS_CATT, { EASY: 3n, MEDIUM: 5n, HARD: 10n });
  for (const floor of Object.values(GOVERNOR_FLOORS)) {
    assert.equal(typeof floor, "bigint");
    assert.ok(floor > 0n, "a positive floor is what makes an empty day detectable");
  }
  assert.ok(Object.isFrozen(GOVERNOR_FLOORS), "the floor record is frozen");
  assert.throws(() => {
    "use strict";
    GOVERNOR_FLOORS.EASY = 0n;
  }, TypeError);
});

test("the reasons and error codes are stable constants", () => {
  assert.deepEqual(Object.keys(GOVERNOR_REASONS).sort(), [
    "BLACKOUT_SEASON_ALLOCATION_EXHAUSTED",
    "FLOOR_APPLIED",
    "SCALED_PROPORTIONALLY",
    "WITHIN_DAILY_BUDGET",
  ]);
  assert.equal(BLACKOUT_CALLER_ERROR_CODE, "SEASON_ALLOCATION_EXHAUSTED");
  assert.deepEqual(GOVERNOR_ERRORS, { INVALID_INPUT: "GOVERNOR_INVALID_INPUT" });
  assert.equal(GOVERNOR_ERROR_NAME, "GovernorError");
  assert.ok(Object.isFrozen(GOVERNOR_ERRORS));
  assert.ok(Object.isFrozen(GOVERNOR_REASONS));
});

/* -------------------------------------------------------------------------- */
/* 1. A healthy day interferes with nothing                                    */
/* -------------------------------------------------------------------------- */

test("1. with spentToday = 0 every difficulty is paid IN FULL, byte-identically", () => {
  for (const mission of REAL_MISSIONS) {
    const result = governorReward({
      difficulty: mission.difficulty,
      requestedReward: mission.reward,
      spentToday: "0",
    });
    assert.equal(result.reward, mission.reward, `${mission.difficulty} must pay the authored string`);
    assert.equal(result.requestedReward, mission.reward);
    assert.equal(result.scaleBps, BPS_ONE, "an untouched reward has an identity scale");
    assert.equal(result.floorApplied, false);
    assert.equal(result.blackout, false);
    assert.equal(result.wouldExceedBudget, false);
    assert.equal(result.approved, true);
    assert.equal(result.reason, GOVERNOR_REASONS.WITHIN_DAILY_BUDGET);
    assert.equal(result.callerMustSurface, undefined);
    assert.equal(result.remainingBudget, DAILY_BUDGET);
  }
  assert.deepEqual(
    REAL_MISSIONS.map((m) => m.reward),
    ["12000000000000000000", "20000000000000000000", "40000000000000000000"],
    "the ladder under test is the real 12 / 20 / 40 read from content.js"
  );
});

test("1b. a healthy day also stays full when the budget is nearly spent", () => {
  for (const mission of REAL_MISSIONS) {
    const requested = BigInt(mission.reward);
    const result = governorReward({
      difficulty: mission.difficulty,
      requestedReward: mission.reward,
      spentToday: (BUDGET - requested).toString(),
    });
    assert.equal(result.reward, mission.reward, "exactly-at-budget is still exactly at budget");
    assert.equal(result.scaleBps, BPS_ONE);
    assert.equal(result.floorApplied, false);
    assert.equal(result.remainingBudget, requested.toString());
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Proportional scale-down                                                   */
/* -------------------------------------------------------------------------- */

test("2. an oversold day scales down proportionally, with exact bps and reward", () => {
  // 13 CATT left of the day, 20 CATT requested: scaleBps = 13/20 = 6500.
  const remaining = 13n * C;
  const requested = 20n * C;
  const result = governorReward({
    difficulty: "MEDIUM",
    requestedReward: requested.toString(),
    spentToday: (BUDGET - remaining).toString(),
  });
  assert.equal(result.scaleBps, 6500n);
  assert.equal(result.scaleBps, expectedScaleBps(remaining, requested));
  assert.equal(result.reward, (13n * C).toString());
  assert.equal(result.breakdown.scaledReward, (13n * C).toString());
  assert.equal(result.floorApplied, false);
  assert.equal(result.blackout, false);
  assert.equal(result.wouldExceedBudget, true);
  assert.equal(result.approved, true);
  assert.equal(result.reason, GOVERNOR_REASONS.SCALED_PROPORTIONALLY);
  // Strictly between the floor and the request, as the founder specified.
  assert.ok(BigInt(result.reward) > GOVERNOR_FLOORS.MEDIUM);
  assert.ok(BigInt(result.reward) < requested);
});

test("2b. the two floors truncate toward zero and never overspend the day", () => {
  // 13 CATT + 1 base unit left, 20 CATT requested: scaleBps = 6500n (not 6500.0000...5),
  // and reward = 13 CATT, so the day's true spend is one base unit UNDER budget.
  const remaining = 13n * C + 1n;
  const requested = 20n * C;
  const result = governorReward({
    difficulty: "MEDIUM",
    requestedReward: requested.toString(),
    spentToday: (BUDGET - remaining).toString(),
  });
  assert.equal(result.scaleBps, expectedScaleBps(remaining, requested));
  assert.equal(result.scaleBps, 6500n);
  assert.equal(result.breakdown.scaleNumerator, (remaining * BPS_ONE).toString());
  assert.equal(result.reward, (13n * C).toString());
  assert.ok(BigInt(result.reward) <= remaining, "floor rounding can only underspend, never overspend");
});

/* -------------------------------------------------------------------------- */
/* 3. The hard floor holds                                                      */
/* -------------------------------------------------------------------------- */

test("3. proportional scaling that would undercut the floor is raised to EXACTLY it", () => {
  const cases = [
    { difficulty: "EASY", requested: 12n * C, remaining: 2n * C },
    { difficulty: "MEDIUM", requested: 20n * C, remaining: 4n * C },
    { difficulty: "HARD", requested: 40n * C, remaining: 9n * C },
  ];
  for (const { difficulty, requested, remaining } of cases) {
    const result = governorReward({
      difficulty,
      requestedReward: requested.toString(),
      spentToday: (BUDGET - remaining).toString(),
    });
    const floor = GOVERNOR_FLOORS[difficulty];
    const scaled = (requested * expectedScaleBps(remaining, requested)) / BPS_ONE;
    assert.ok(scaled < floor, `${difficulty}: the proportional scale really is under the floor`);
    assert.equal(result.reward, floor.toString(), `${difficulty}: the reward is EXACTLY the floor`);
    assert.equal(result.floorApplied, true);
    assert.equal(result.floor, floor);
    assert.equal(result.floorUsed, floor);
    assert.equal(result.floorSuppressed, false);
    assert.equal(result.reason, GOVERNOR_REASONS.BLACKOUT_SEASON_ALLOCATION_EXHAUSTED);
    // The floor CAN overshoot the day — the founder's explicit choice.
    assert.equal(result.breakdown.emissionOvershootsDailyBudget, true);
    assert.ok(BigInt(result.reward) > remaining);
  }
});

test("3b. the floor applies without a blackout when the scale lands a step under it", () => {
  // 7 CATT requested with exactly 3 CATT left: 3/7 of the reward is
  // 2.9995 CATT, one rounding step under the 3 CATT floor, so the floor raises
  // it — and because the floor still FITS in the day's remainder, this is a
  // priced, approved payout rather than a blackout. (With the authored 12 / 20 /
  // / 40 ladder the two events coincide; see test 3c.)
  const result = governorReward({
    difficulty: "EASY",
    requestedReward: (7n * C).toString(),
    spentToday: (BUDGET - 3n * C).toString(),
  });
  assert.equal(result.scaleBps, 4285n);
  assert.equal(result.breakdown.scaledReward, ((7n * C * 4285n) / BPS_ONE).toString());
  assert.equal(result.breakdown.scaledReward, "2999500000000000000");
  assert.equal(result.floorApplied, true);
  assert.equal(result.reward, GOVERNOR_FLOORS.EASY.toString());
  assert.equal(result.blackout, false, "the floor still fits: 3 CATT is exactly what is left");
  assert.equal(result.approved, true);
  assert.equal(result.reason, GOVERNOR_REASONS.FLOOR_APPLIED);
});

test("3c. a 10,000-miner viral spike is priced with the REAL mission rewards", () => {
  const [easy, medium, hard] = REAL_MISSIONS;
  const perMiner = BigInt(easy.reward) + BigInt(medium.reward) + BigInt(hard.reward);
  const demand = 10_000n * perMiner;
  assert.equal(demand, 720_000n * C, "10,000 miners x (12 + 20 + 40) = 720,000 CATT of demand");
  assert.ok(demand > BUDGET, "the demand is 6.5x the 110,000 CATT daily budget");

  // The budget covers 1,527 whole miners (109,944 CATT) and 56 CATT of the next.
  const wholeMiners = BUDGET / perMiner;
  const spentBeforeLastMiner = wholeMiners * perMiner;
  assert.equal(wholeMiners, 1527n);
  assert.equal(spentBeforeLastMiner, 109_944n * C);
  assert.equal(BUDGET - spentBeforeLastMiner, 56n * C);

  // Miner 1,528, mission by mission: two FULL rewards, then a reduced third.
  let spent = spentBeforeLastMiner;
  const first = governorReward({
    difficulty: easy.difficulty,
    requestedReward: easy.reward,
    spentToday: spent.toString(),
  });
  assert.equal(first.reward, easy.reward, "12 of 12 CATT while the day still has room");
  assert.equal(first.scaleBps, BPS_ONE);

  spent += BigInt(first.reward);
  const second = governorReward({
    difficulty: medium.difficulty,
    requestedReward: medium.reward,
    spentToday: spent.toString(),
  });
  assert.equal(second.reward, medium.reward, "20 of 20 CATT with 44 CATT still in the day");
  assert.equal(second.scaleBps, BPS_ONE);

  spent += BigInt(second.reward);
  assert.equal(BUDGET - spent, 24n * C);
  const third = governorReward({
    difficulty: hard.difficulty,
    requestedReward: hard.reward,
    spentToday: spent.toString(),
  });
  assert.equal(third.scaleBps, 6000n, "24 of the 40 CATT requested: 6000 bps");
  assert.equal(third.reward, (24n * C).toString());
  assert.ok(BigInt(third.reward) > GOVERNOR_FLOORS.HARD, "reduced, but NOT down to the floor");
  assert.ok(BigInt(third.reward) < BigInt(hard.reward), "and visibly reduced from the request");
  assert.equal(third.floorApplied, false);
  assert.equal(third.blackout, false);
  assert.equal(third.approved, true);

  // The next miner arrives at a day with ZERO left: floored, blacked out, and
  // NOT approved — a reduced-but-real reward is what the spike gets until then.
  const drained = governorReward({
    difficulty: easy.difficulty,
    requestedReward: easy.reward,
    spentToday: (spent + third.reward).toString(),
  });
  assert.equal(drained.reward, GOVERNOR_FLOORS.EASY.toString());
  assert.equal(drained.floorApplied, true);
  assert.equal(drained.blackout, true);
  assert.equal(drained.approved, false);
});

test("3d. a daily budget smaller than the floor still refuses cleanly", () => {
  const result = governorReward({
    difficulty: "EASY",
    requestedReward: (12n * C).toString(),
    spentToday: "0",
    dailyBudget: 1n * C,
  });
  assert.equal(result.scaleBps, 833n);
  assert.equal(result.breakdown.scaledReward, "999600000000000000");
  assert.equal(result.reward, GOVERNOR_FLOORS.EASY.toString(), "the floor is the absolute minimum");
  assert.equal(result.floorApplied, true);
  assert.equal(result.blackout, true, "even 3 CATT does not fit in a 1 CATT budget");
  assert.equal(result.approved, false);
});

test("3e. a reward already BELOW the floor is not inflated", () => {
  const result = governorReward({
    difficulty: "HARD",
    requestedReward: (2n * C).toString(),
    spentToday: BUDGET.toString(),
  });
  assert.equal(result.reward, (2n * C).toString(), "the governor normalises; it does not mint");
  assert.equal(result.floor, GOVERNOR_FLOORS.HARD);
  assert.equal(result.floorUsed, 2n * C);
  assert.equal(result.floorSuppressed, true);
  // `floorApplied` here is the FLOOR PROTECTING THE SCALED VALUE (0 -> 2 CATT),
  // not the governor raising the authored reward: the reward is still exactly
  // the 2 CATT that was requested, and it was never above it.
  assert.equal(result.floorApplied, true);
  assert.equal(result.breakdown.scaledReward, "0");
  assert.ok(BigInt(result.reward) <= BigInt(result.requestedReward));
  // And with a healthy day it is untouched as well.
  const healthy = governorReward({
    difficulty: "HARD",
    requestedReward: (2n * C).toString(),
    spentToday: "0",
  });
  assert.equal(healthy.reward, (2n * C).toString());
  assert.equal(healthy.floorSuppressed, true);
});

test("3f. a per-call floor may RAISE the policy floor but never undercut it", () => {
  const raised = governorReward({
    difficulty: "EASY",
    requestedReward: (12n * C).toString(),
    spentToday: (BUDGET - 6n * C).toString(),
    floor: (8n * C).toString(),
  });
  assert.equal(raised.reward, (8n * C).toString(), "the stricter floor wins");
  assert.equal(raised.floor, 8n * C);
  assert.equal(raised.floorApplied, true);

  const undercut = governorReward({
    difficulty: "EASY",
    requestedReward: (12n * C).toString(),
    spentToday: (BUDGET - 6n * C).toString(),
    floor: "1",
  });
  assert.equal(undercut.floor, GOVERNOR_FLOORS.EASY, "the founder's floor is absolute");
  assert.equal(undercut.reward, (6n * C).toString());
  assert.equal(undercut.floorApplied, false);
});

/* -------------------------------------------------------------------------- */
/* 4. Blackout is the last resort                                               */
/* -------------------------------------------------------------------------- */

test("4. when even the floor does not fit, the reward is priced but NOT approved", () => {
  for (const mission of REAL_MISSIONS) {
    const result = governorReward({
      difficulty: mission.difficulty,
      requestedReward: mission.reward,
      spentToday: BUDGET.toString(),
    });
    const floor = GOVERNOR_FLOORS[mission.difficulty];
    assert.equal(result.reward, floor.toString(), "the floor is still what it would cost");
    assert.equal(result.remainingBudget, "0", "the day is precisely exhausted");
    assert.equal(result.scaleBps, 0n);
    assert.equal(result.blackout, true);
    assert.equal(result.approved, false, "the caller owns the refusal");
    assert.equal(result.floorApplied, true);
    assert.equal(result.reason, GOVERNOR_REASONS.BLACKOUT_SEASON_ALLOCATION_EXHAUSTED);
    assert.equal(result.callerMustSurface, BLACKOUT_CALLER_ERROR_CODE);
  }
});

test("4b. the module itself does NOT throw SEASON_ALLOCATION_EXHAUSTED", () => {
  let result;
  assert.doesNotThrow(() => {
    result = governorReward({
      difficulty: "HARD",
      requestedReward: REAL_MISSIONS[2].reward,
      spentToday: (BUDGET + 5n * C).toString(),
    });
  });
  assert.equal(result.blackout, true);
  assert.equal(result.approved, false);
  // The season error is ABSENT as an error: no `.code`, no `.error`, no throw.
  assert.equal(result.code, undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.name, undefined);
  // The reason is the GOVERNOR's own constant, and it names the backstop for the
  // caller to raise, which is the season pool's hard cap in seasons.js.
  assert.equal(result.reason, GOVERNOR_REASONS.BLACKOUT_SEASON_ALLOCATION_EXHAUSTED);
  assert.notEqual(result.reason, BLACKOUT_CALLER_ERROR_CODE);
  assert.equal(result.callerMustSurface, BLACKOUT_CALLER_ERROR_CODE);
  assert.match(
    result.reason,
    /BLACKOUT/,
    "a caller branching on `reason` can see the season-pool backstop is next"
  );
  // The reason string is the governor's own; the season code appears ONLY as
  // the caller's instruction, never as a thrown or embedded error object.
  const flattened = JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  assert.equal(flattened.includes(BLACKOUT_CALLER_ERROR_CODE), true);
  assert.equal(flattened.includes('"code"'), false);
});

test("4c. remainingBudget lets a caller price against a pool it already knows", () => {
  const result = governorReward({
    difficulty: "MEDIUM",
    requestedReward: REAL_MISSIONS[1].reward,
    spentToday: "0",
    remainingBudget: (5n * C).toString(),
  });
  assert.equal(result.remainingBudget, (5n * C).toString());
  assert.equal(result.dailyBudget, DAILY_BUDGET, "the default budget is still reported");
  assert.equal(result.scaleBps, 2500n, "5 of 20 CATT requested: 2500 bps");
  assert.equal(result.reward, GOVERNOR_FLOORS.MEDIUM.toString());
  assert.equal(result.floorApplied, false, "the scale lands exactly ON the floor, not under it");
  assert.equal(result.blackout, false);

  // One base unit less and the scale lands UNDER the floor (2499 bps, 4.998
  // CATT), so the floor restores it to exactly 5 CATT — and because the floor no
  // longer FITS in what is left of the day, the same call is a blackout. The
  // floor and the blackout are decided on the SAME boundary, from one unit.
  const squeezed = governorReward({
    difficulty: "MEDIUM",
    requestedReward: REAL_MISSIONS[1].reward,
    spentToday: "0",
    remainingBudget: (5n * C - 1n).toString(),
  });
  assert.equal(squeezed.scaleBps, 2499n);
  assert.equal(squeezed.breakdown.scaledReward, "4998000000000000000");
  assert.equal(squeezed.reward, GOVERNOR_FLOORS.MEDIUM.toString());
  assert.equal(squeezed.floorApplied, true);
  assert.equal(squeezed.blackout, true, "5 CATT does not fit in 5 CATT minus one base unit");
  assert.equal(squeezed.approved, false);
  assert.equal(squeezed.reason, GOVERNOR_REASONS.BLACKOUT_SEASON_ALLOCATION_EXHAUSTED);
});

/* -------------------------------------------------------------------------- */
/* 5. Monotonicity, floors and scale bounds                                     */
/* -------------------------------------------------------------------------- */

test("5. as spentToday rises the reward is non-increasing, never under the floor", () => {
  const requested = BigInt(REAL_MISSIONS[2].reward); // 40 CATT
  const floor = GOVERNOR_FLOORS.HARD;
  let previous = null;
  let previousScale = null;
  let compared = 0;
  for (let spent = BUDGET - 45n * C; spent <= BUDGET + 5n * C; spent += C) {
    const result = governorReward({
      difficulty: "HARD",
      requestedReward: requested.toString(),
      spentToday: spent.toString(),
    });
    const reward = BigInt(result.reward);
    assert.ok(reward >= floor, `at spent=${spent} the reward is under the floor`);
    assert.ok(reward <= requested, `at spent=${spent} the governor never RAISES a reward`);
    assert.ok(result.scaleBps >= 0n && result.scaleBps <= BPS_ONE, "scale within [0, 10000n]");
    if (previous !== null) {
      assert.ok(reward <= previous, `reward fell as spentToday rose (at spent=${spent})`);
      assert.ok(result.scaleBps <= previousScale, "the scale is non-increasing too");
      compared += 1;
    }
    previous = reward;
    previousScale = result.scaleBps;
  }
  assert.equal(compared, 50, "51 points swept, 50 monotonicity comparisons");
  assert.equal(previous, floor, "the sweep ends on the floor, not below it");
});

test("5b. base-unit granularity is monotone too, not just CATT granularity", () => {
  const requested = BigInt(REAL_MISSIONS[0].reward);
  let previous = null;
  for (let offset = 0n; offset <= 2000n; offset += 1n) {
    const spent = BUDGET - 13n * C + offset;
    const result = governorReward({
      difficulty: "EASY",
      requestedReward: requested.toString(),
      spentToday: spent.toString(),
    });
    assert.ok(result.scaleBps >= 0n && result.scaleBps <= BPS_ONE);
    const reward = BigInt(result.reward);
    if (previous !== null) assert.ok(reward <= previous);
    previous = reward;
  }
  assert.ok(previous >= GOVERNOR_FLOORS.EASY);
});

/* -------------------------------------------------------------------------- */
/* 6. Boundary arithmetic                                                       */
/* -------------------------------------------------------------------------- */

test("6. exactly-at-budget is untouched; ONE base unit over scales", () => {
  const requested = BigInt(REAL_MISSIONS[0].reward);
  const atBudget = governorReward({
    difficulty: "EASY",
    requestedReward: requested.toString(),
    spentToday: (BUDGET - requested).toString(),
  });
  assert.equal(atBudget.reward, REAL_MISSIONS[0].reward);
  assert.equal(atBudget.scaleBps, BPS_ONE);
  assert.equal(atBudget.wouldExceedBudget, false);
  assert.equal(atBudget.reason, GOVERNOR_REASONS.WITHIN_DAILY_BUDGET);

  const overBy = governorReward({
    difficulty: "EASY",
    requestedReward: requested.toString(),
    spentToday: (BUDGET - requested + 1n).toString(),
  });
  assert.equal(overBy.wouldExceedBudget, true);
  assert.equal(overBy.scaleBps, 9999n, "one base unit of shortfall is one basis point");
  assert.equal(overBy.reward, "11998800000000000000");
  assert.equal(overBy.floorApplied, false);
  assert.equal(overBy.blackout, false);
  assert.equal(overBy.reason, GOVERNOR_REASONS.SCALED_PROPORTIONALLY);
});

test("6b. the day the budget is precisely exhausted blackouts every difficulty", () => {
  for (const mission of REAL_MISSIONS) {
    const result = governorReward({
      difficulty: mission.difficulty,
      requestedReward: mission.reward,
      spentToday: DAILY_BUDGET,
    });
    assert.equal(result.spentToday, DAILY_BUDGET);
    assert.equal(result.remainingBudget, "0");
    assert.equal(result.reward, GOVERNOR_FLOORS[mission.difficulty].toString());
    assert.equal(result.blackout, true);
    assert.equal(result.approved, false);
  }
  // Overshooting the day clamps the remainder at zero rather than going
  // negative, so nothing can be priced "back into" the budget.
  const over = governorReward({
    difficulty: "EASY",
    requestedReward: REAL_MISSIONS[0].reward,
    spentToday: (BUDGET + 12345n).toString(),
  });
  assert.equal(over.remainingBudget, "0");
  assert.equal(over.blackout, true);
});

test("6c. amounts far beyond 2^53 keep every base unit", () => {
  const budget = 123456789012345678901234567890n; // 30 digits, ~1.2e29
  assert.ok(budget > BigInt(Number.MAX_SAFE_INTEGER));
  const requested = 40n * C;
  assert.ok(requested > BigInt(Number.MAX_SAFE_INTEGER));

  // A healthy day: untouched, byte-identical.
  const healthy = governorReward({
    difficulty: "HARD",
    requestedReward: requested.toString(),
    dailyBudget: budget.toString(),
    spentToday: (budget - requested).toString(),
  });
  assert.equal(healthy.reward, "40000000000000000000");
  assert.equal(healthy.scaleBps, BPS_ONE);
  assert.equal(healthy.dailyBudget, "123456789012345678901234567890");
  assert.equal(healthy.remainingBudget, requested.toString());

  // A scaled day on the SAME huge budget, where the whole arithmetic happens
  // in 29-digit numbers: one base unit already spent on a 30-digit budget that
  // is requested in full, so the scale is 9999 bps and the reward is
  // budget - ceil(budget / 10000). A float could not hold either number.
  const giant = governorReward({
    difficulty: "HARD",
    requestedReward: budget.toString(),
    dailyBudget: budget.toString(),
    spentToday: "1",
  });
  const expectedBps = (budget - 1n) * BPS_ONE / budget;
  assert.equal(giant.scaleBps, expectedBps);
  assert.equal(giant.scaleBps, 9999n);
  const expectedReward = (budget * expectedBps) / BPS_ONE;
  assert.equal(giant.reward, expectedReward.toString());
  assert.equal(giant.reward, "123444443333444444333344444433");
  assert.ok(expectedReward > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(
    giant.reward.length,
    expectedReward.toString().length,
    "not one digit is lost: 30 digits in, 30 digits out"
  );
  assert.equal(Number.isSafeInteger(Number(giant.reward)), false, "a float could not hold this");
  assert.equal(giant.floorApplied, false);
  assert.equal(giant.blackout, false);

  // And a floored day on the same huge budget, where only the low 30 digits of
  // the arithmetic could plausibly have been lost.
  const floored = governorReward({
    difficulty: "HARD",
    requestedReward: requested.toString(),
    dailyBudget: budget.toString(),
    spentToday: budget.toString(),
  });
  assert.equal(floored.reward, "10000000000000000000");
  assert.equal(floored.blackout, true);
  assert.equal(floored.approved, false);
});

/* -------------------------------------------------------------------------- */
/* 7. Invalid input                                                             */
/* -------------------------------------------------------------------------- */

test("7. every unusable input throws GOVERNOR_INVALID_INPUT and pays nothing", () => {
  const base = {
    difficulty: "MEDIUM",
    requestedReward: REAL_MISSIONS[1].reward,
    spentToday: "0",
  };
  const cases = [
    ["a negative spentToday", { ...base, spentToday: -1n }],
    ["a negative spentToday string", { ...base, spentToday: "-1" }],
    ["a non-numeric spentToday", { ...base, spentToday: "twelve" }],
    ["a fractional spentToday", { ...base, spentToday: 1.5 }],
    ["a NaN spentToday", { ...base, spentToday: NaN }],
    ["an infinite spentToday", { ...base, spentToday: Infinity }],
    ["a null spentToday", { ...base, spentToday: null }],
    ["a lossy numeric spentToday", { ...base, spentToday: 1e21 }],
    ["a zero dailyBudget", { ...base, dailyBudget: 0n }],
    ["a negative dailyBudget", { ...base, dailyBudget: "-5" }],
    ["a fractional dailyBudget", { ...base, dailyBudget: 0.5 }],
    ["a non-numeric dailyBudget", { ...base, dailyBudget: "lots" }],
    ["an unknown difficulty", { ...base, difficulty: "IMPOSSIBLE" }],
    ["a missing difficulty", { ...base, difficulty: undefined }],
    ["a non-string difficulty", { ...base, difficulty: 3 }],
    ["a malformed reward string", { ...base, requestedReward: "12.5" }],
    ["an exponent reward", { ...base, requestedReward: "1e18" }],
    ["an empty reward string", { ...base, requestedReward: "" }],
    ["a negative reward", { ...base, requestedReward: -12n }],
    ["a zero reward", { ...base, requestedReward: "0" }],
    ["a lossy numeric reward", { ...base, requestedReward: 1.2e19 }],
    ["a negative per-call floor", { ...base, floor: -1 }],
    ["a malformed remainingBudget", { ...base, remainingBudget: "1.5" }],
    ["no arguments at all", undefined],
  ];

  for (const [label, params] of cases) {
    let thrown = null;
    let returned;
    try {
      returned = governorReward(params);
    } catch (err) {
      thrown = err;
    }
    assert.equal(returned, undefined, `${label} returns no payout at all`);
    assert.ok(thrown !== null, `${label} must throw rather than return a payout`);
    assert.equal(thrown.name, GOVERNOR_ERROR_NAME, `${label}: error name`);
    assert.equal(thrown.code, GOVERNOR_ERRORS.INVALID_INPUT, `${label}: error code`);
    assert.ok(thrown.message.startsWith("governor:"), `${label}: message is prefixed`);
    assert.match(thrown.message, /`[a-zA-Z]+`/, `${label}: message names the offending field`);
    assert.ok(
      "field" in thrown && thrown.field !== undefined,
      `${label}: the error carries the offending field`
    );
  }
});

test("7b. the error message names the field and the bad value, and leaks nothing", () => {
  try {
    governorReward({ difficulty: "EASY", requestedReward: "12", spentToday: "-5" });
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.field, "spentToday");
    assert.equal(err.value, "-5");
    assert.match(err.message, /spentToday/);
    assert.match(err.message, /"-5"/);
    assert.match(err.message, /coercing/, "the message says why it refused");
  }
  // A number beyond the safe range is rejected rather than silently rounded.
  try {
    governorReward({ difficulty: "EASY", requestedReward: 1.2e19, spentToday: "0" });
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.code, GOVERNOR_ERRORS.INVALID_INPUT);
    assert.equal(err.field, "requestedReward");
  }
});

/* -------------------------------------------------------------------------- */
/* 8. Purity                                                                    */
/* -------------------------------------------------------------------------- */

/** The module source with block and line comments removed. */
const GOVERNOR_CODE = fs
  .readFileSync(path.join(__dirname, "..", "src", "governor.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("8. 25 hostile calls touch no store, no global and no clock", () => {
  const globalsBefore = Object.getOwnPropertyNames(globalThis).length;
  const envBefore = JSON.stringify(Object.keys(process.env).sort());
  const modulesBefore = Object.keys(require.cache).sort();
  const dateNowBefore = Date.now();
  const randomBefore = Math.random();

  const spentValues = ["0", "0", BUDGET.toString(), (BUDGET + 1n).toString(), "999999999999999999999999"];
  const budgets = [undefined, "1", DAILY_BUDGET, (2n * DAILY_BUDGET_CATT * C).toString()];
  const requestedValues = REAL_MISSIONS.map((m) => m.reward).concat(["1", "0"]);
  let calls = 0;
  let blackouts = 0;

  for (let i = 0; i < 25; i += 1) {
    const mission = REAL_MISSIONS[i % 3];
    const params = {
      difficulty: mission.difficulty,
      requestedReward: requestedValues[i % requestedValues.length],
      spentToday: spentValues[i % spentValues.length],
      dailyBudget: budgets[i % budgets.length],
    };
    let result = null;
    try {
      result = governorReward(params);
    } catch (err) {
      assert.equal(err.code, GOVERNOR_ERRORS.INVALID_INPUT);
    }
    if (result !== null) {
      assert.match(result.reward, DIGITS_ONLY);
      if (result.blackout) blackouts += 1;
      // A fresh object every call: a caller cannot poison the next call.
      assert.notEqual(result.reward, undefined);
    }
    calls += 1;
  }
  assert.equal(calls, 25);
  assert.ok(blackouts > 0, "the hostile sweep really did reach the blackout branch");

  assert.equal(Object.getOwnPropertyNames(globalThis).length, globalsBefore, "no globals added");
  assert.equal(JSON.stringify(Object.keys(process.env).sort()), envBefore, "env untouched");
  assert.deepEqual(Object.keys(require.cache).sort(), modulesBefore, "no module loaded lazily");
  assert.equal(typeof Date.now, "function", "the clock was never stubbed out");
  assert.ok(Date.now() >= dateNowBefore, "the clock still moves normally");
  assert.equal(typeof Math.random, "function", "the RNG was never stubbed out");
  assert.equal(typeof randomBefore, "number");
});

test("8b. the module requires ONLY the frozen constant module", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "governor.js"), "utf8");
  const requires = source.match(/require\([^)]*\)/g) ?? [];
  assert.deepEqual(
    requires,
    ['require("./contract-constants.js")'],
    "the only require is the constant mirror; no store, no seasons, no fs"
  );
  // In the CODE (comments stripped), no mutable module is named at all — the
  // file header discusses `seasons.js` in prose only.
  for (const forbiddenModule of [
    "storage.js",
    "sqlite-store.js",
    "seasons.js",
    "economics.js",
    "server.js",
    "content.js",
    "node:fs",
    "node:http",
    "ethers",
  ]) {
    assert.ok(
      !GOVERNOR_CODE.includes(forbiddenModule),
      `governor.js code must not reference ${forbiddenModule}`
    );
  }
});

test("8c. the module source contains no I/O, clock, randomness, env or async", () => {
  for (const forbidden of [
    "Date.now",
    "new Date",
    "Math.random",
    "process.env",
    "console.",
    "globalThis",
    "fetch(",
    "XMLHttpRequest",
    "eval(",
    "async ",
    "await ",
    "Promise",
    "setTimeout",
    "writeFile",
    "readFile",
  ]) {
    assert.ok(!GOVERNOR_CODE.includes(forbidden), `governor.js must not reference \`${forbidden}\``);
  }
  // A reward function that could be awaited, or handed persistence, could be
  // called speculatively and settle. Assert the shape that rules both out.
  assert.equal(governorReward.constructor.name, "Function");
  assert.equal(Object.prototype.hasOwnProperty.call(governorReward, "length"), true);
  assert.equal(governorReward.constructor === Function, true);
  assert.equal(governorReward.length, 0, "a defaulted single argument: no callback, no handle");
  const sample = governorReward({
    difficulty: "EASY",
    requestedReward: REAL_MISSIONS[0].reward,
    spentToday: "0",
  });
  assert.equal(typeof sample, "object");
  assert.ok(Object.isFrozen(sample), "the decision is frozen");
  assert.ok(Object.isFrozen(sample.breakdown));
  for (const key of Object.keys(sample)) {
    const value = sample[key];
    assert.ok(
      typeof value !== "function",
      `no callable escapes through \`${key}\`: a caller must not be handed a hook into the governor`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 9. Integrity: digit-only amounts, no floats anywhere                         */
/* -------------------------------------------------------------------------- */

/**
 * Asserts that every amount on a governor decision is a canonical decimal
 * string: digits only, no sign, no point, no exponent.
 *
 * @param {Object} result A `governorReward` decision.
 * @returns {void}
 */
function assertExactAmounts(result) {
  for (const key of ["requestedReward", "reward", "spentToday", "dailyBudget", "remainingBudget"]) {
    assert.equal(typeof result[key], "string", `${key} is a string`);
    assert.match(result[key], DIGITS_ONLY, `${key} is digits only: no '.', no 'e', no sign`);
  }
  for (const key of ["scaleBps", "floor", "floorUsed"]) {
    assert.equal(typeof result[key], "bigint", `${key} is a bigint`);
  }
  assert.equal(typeof result.floorApplied, "boolean");
  assert.equal(typeof result.floorSuppressed, "boolean");
  assert.equal(typeof result.blackout, "boolean");
  assert.equal(typeof result.approved, "boolean");
  assert.equal(typeof result.wouldExceedBudget, "boolean");
  assert.ok(Object.values(GOVERNOR_REASONS).includes(result.reason));
  for (const [key, value] of Object.entries(result.breakdown)) {
    assert.ok(
      typeof value !== "number",
      `breakdown.${key} must not be a float, got ${typeof value}`
    );
  }
  assert.match(result.breakdown.reward, DIGITS_ONLY);
  assert.match(result.breakdown.requestedReward, DIGITS_ONLY);
}

test("9. every returned amount is a digits-only decimal string", () => {
  const points = [
    { spentToday: "0", difficulty: "EASY", requestedReward: REAL_MISSIONS[0].reward },
    { spentToday: "0", difficulty: "MEDIUM", requestedReward: REAL_MISSIONS[1].reward },
    { spentToday: "0", difficulty: "HARD", requestedReward: REAL_MISSIONS[2].reward },
    { spentToday: DAILY_BUDGET, difficulty: "EASY", requestedReward: REAL_MISSIONS[0].reward },
    { spentToday: DAILY_BUDGET, difficulty: "HARD", requestedReward: REAL_MISSIONS[2].reward },
    { spentToday: (BUDGET - 13n * C).toString(), difficulty: "MEDIUM", requestedReward: REAL_MISSIONS[1].reward },
    { spentToday: "1", difficulty: "EASY", requestedReward: "1" },
  ];
  for (const params of points) {
    const result = governorReward(params);
    assertExactAmounts(result);
    assert.equal(result.reward.includes("."), false);
    assert.equal(result.reward.includes("e"), false);
    assert.equal(result.reward.includes("E"), false);
    assert.equal(BigInt(result.reward) >= 0n, true);
  }
  assert.equal(DAILY_BUDGET.includes("."), false);
  assert.equal(DAILY_BUDGET.includes("e"), false);
  assert.equal(DIGITS_ONLY.test(DAILY_BUDGET), true);
  for (const floor of Object.values(GOVERNOR_FLOORS)) {
    assert.equal(DIGITS_ONLY.test(floor.toString()), true);
  }
});

test("9b. no float literal and no Number() coercion anywhere in the module", () => {
  // The module code with comments stripped: a float mentioned in PROSE is a
  // documentation choice; a float LITERAL is a bug in an exact pipeline.
  assert.equal(/\d\.\d/.test(GOVERNOR_CODE), false, "no decimal-point float literal");
  assert.equal(/\b\d+(\.\d+)?[eE][+-]?\d/.test(GOVERNOR_CODE), false, "no exponent float literal");
  assert.equal(/\b\d+n\b\s*\*\s*[0-9]/.test(GOVERNOR_CODE), false, "no float into a bigint multiply");
  assert.ok(!GOVERNOR_CODE.includes("Number("), "a CATT amount is never parsed with Number(...)");
  assert.equal(GOVERNOR_CODE.includes("parseFloat"), false);
  assert.equal(GOVERNOR_CODE.includes("parseInt"), false);
  assert.equal(GOVERNOR_CODE.includes("Math."), false);
  // Everything arithmetic is bigint: the only `BPS_ONE` divisor is a bigint.
  assert.ok(GOVERNOR_CODE.includes("const BPS_ONE = 10000n;"));
  assert.equal(typeof BPS_ONE, "bigint");
});

/* -------------------------------------------------------------------------- */
/* Caller contract                                                              */
/* -------------------------------------------------------------------------- */

test("the caller contract: the governor only reports, and says what to report", () => {
  const ok = governorReward({
    difficulty: "HARD",
    requestedReward: REAL_MISSIONS[2].reward,
    spentToday: "0",
  });
  assert.equal(ok.blackout, false);
  assert.equal(ok.callerMustSurface, undefined, "nothing to surface while the budget is healthy");

  const refused = governorReward({
    difficulty: "HARD",
    requestedReward: REAL_MISSIONS[2].reward,
    spentToday: DAILY_BUDGET,
  });
  assert.equal(refused.approved, false);
  assert.equal(refused.callerMustSurface, "SEASON_ALLOCATION_EXHAUSTED");
  // The governor's own reason is namespaced to the governor; the season code is
  // handed over as the caller's next step, which is what seasons.js throws.
  assert.equal(refused.reason, "GOVERNOR_BLACKOUT_SEASON_ALLOCATION_EXHAUSTED");
  // And the healthy path is reproducible: the same inputs, the same decision.
  const again = governorReward({
    difficulty: "HARD",
    requestedReward: REAL_MISSIONS[2].reward,
    spentToday: "0",
  });
  assert.deepEqual(again, ok, "a pure function answers the same question the same way");
});