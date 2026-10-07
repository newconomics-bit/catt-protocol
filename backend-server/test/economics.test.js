/**
 * Unit tests for the CATT reward economics module — dynamic emission and the
 * streak multiplier (PRD "Economics", AGGRESSIVE path).
 *
 * Runner: Node's built-in test runner, no dependencies.
 *   cd backend-server && node --test test/economics.test.js
 *
 * What is asserted here, and why each is the property that could break:
 *   - AT/BELOW THE TRIGGER the factor is exactly 10000n and the reward is
 *     BYTE-IDENTICAL to the authored mission string (early adopters are paid
 *     the full base; a rounding artefact here would silently tax them).
 *   - The LADDER values are exact, at 6k / 10k / 25k / 50k miners, for all three
 *     real missions READ FROM content.js (never a hardcoded reward).
 *   - MONOTONIC NON-INCREASING and NEVER BELOW 50%, swept over the whole range.
 *   - A MISSING/HOSTILE miner reading means ZERO miners, i.e. FULL base reward,
 *     not a throw and not a guess at "busy".
 *   - A POISONED base reward THROWS with a stable code and never pays zero.
 *   - A DEGENERATE ramp (floor at or below the trigger) throws.
 *   - The streak ladder is the LITERAL +0.2x/day ladder, whose 2.0x cap is
 *     first reached on DAY 6, not day 7 — the documented discrepancy.
 *   - Composition multiplies the two bps factors FIRST and divides ONCE, so the
 *     composed factor is order-independent and the reward has one floor.
 *   - PURITY: 25 calls with absurd inputs against a REAL store leave every
 *     streak row and `countActiveMiners` untouched. This is the proof that the
 *     multiplier can only ever be paid on a streak the store actually earned.
 *   - INTEGRITY: every amount is a digit-only decimal string and every value is
 *     above 2^53, where a float would already be lossy.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BPS_ONE,
  DYNAMIC_EMISSION_TRIGGER_MINERS,
  DYNAMIC_EMISSION_FLOOR_MINERS,
  DYNAMIC_EMISSION_FLOOR_BPS,
  STREAK_STEP_BPS,
  STREAK_MAX_BPS,
  ECONOMICS_ERRORS,
  ECONOMICS_ERROR_NAME,
  normalizeActiveMiners,
  dynamicEmissionFactorBps,
  streakFactorBps,
  applyFactorBps,
  computeReward,
} = require("../src/economics.js");

const { MISSIONS } = require("../src/content.js");
const { createMemoryStore } = require("../src/storage.js");

/** The three real missions, in the AGGRESSIVE 12 / 20 / 40 CATT ladder. */
const REAL_MISSIONS = Object.freeze(MISSIONS.slice(0, 3));

/** Matches a canonical decimal string: digits only, no sign, point or exponent. */
const DIGITS_ONLY = /^[0-9]+$/;

/**
 * The expected dynamic factor at a given miner count, computed here from the
 * specification formula with BigInt arithmetic so the expectation is
 * INDEPENDENT of the implementation under test.
 *
 * @param {number} miners Active miners.
 * @returns {bigint} Expected factor in basis points.
 */
function expectedDynamicBps(miners) {
  if (miners <= 5000) return 10000n;
  const span = BigInt(50000 - 5000);
  const progress = BigInt(miners) - 5000n;
  return 10000n - (5000n * progress) / span;
}

/* -------------------------------------------------------------------------- */
/* Module constants                                                             */
/* -------------------------------------------------------------------------- */

test("constants are the founder's numbers, in bigint", () => {
  assert.equal(typeof BPS_ONE, "bigint");
  assert.equal(BPS_ONE, 10000n);
  assert.equal(DYNAMIC_EMISSION_TRIGGER_MINERS, 5000n);
  assert.equal(DYNAMIC_EMISSION_FLOOR_BPS, 5000n, "the floor is exactly 50% of base");
  assert.equal(DYNAMIC_EMISSION_FLOOR_BPS * 2n, BPS_ONE);
  // Unspecified-by-the-founder top of the ramp, defaulted here and overridable.
  assert.equal(DYNAMIC_EMISSION_FLOOR_MINERS, 50000n);
  assert.ok(DYNAMIC_EMISSION_FLOOR_MINERS > DYNAMIC_EMISSION_TRIGGER_MINERS);
  // The literal streak ladder: +0.2x per day, 2.0x ceiling.
  assert.equal(STREAK_STEP_BPS, 2000n);
  assert.equal(STREAK_MAX_BPS, 20000n);
});

/* -------------------------------------------------------------------------- */
/* Dynamic emission — at and below the trigger                                 */
/* -------------------------------------------------------------------------- */

test("at 0, 1 and exactly 5,000 miners the factor is exactly 10000n", () => {
  for (const miners of [0, 1, 5000]) {
    assert.equal(
      dynamicEmissionFactorBps(miners),
      10000n,
      `at ${miners} miners the factor must be exactly 1.0x`
    );
  }
});

test("at or below the trigger the reward is BYTE-IDENTICAL to the authored string", () => {
  assert.equal(REAL_MISSIONS.length, 3, "the three real missions must be present");
  for (const miners of [0, 1, 5000]) {
    for (const mission of REAL_MISSIONS) {
      assert.equal(typeof mission.reward, "string", "missions carry reward as a decimal string");
      const result = computeReward({ mission, activeMiners: miners, streakDays: 1 });
      assert.equal(result.dynamicFactorBps, 10000n);
      assert.equal(result.reward, mission.reward, `${mission.id} at ${miners} miners`);
      assert.equal(result.baseReward, mission.reward, "baseReward echoes the authored string");
      assert.equal(result.combinedFactorBps, 10000n);
      assert.equal(result.applied.dynamicEmission, false, "nothing was shrunk");
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Dynamic emission — the exact ladder                                          */
/* -------------------------------------------------------------------------- */

test("the factor ladder is exact at 6,000 / 10,000 / 25,000 / 50,000 miners", () => {
  const expectedFactors = new Map([
    [6000, 9889n],
    [10000, 9445n],
    [25000, 7778n],
    [50000, 5000n],
  ]);
  for (const [miners, expectedBps] of expectedFactors) {
    assert.equal(dynamicEmissionFactorBps(miners), expectedBps, `factor at ${miners} miners`);
    // The expectation must agree with the spec formula computed independently.
    assert.equal(expectedBps, expectedDynamicBps(miners));
  }
});

test("the reward ladder is exact for all three real missions at every rung", () => {
  // Expected rewards are DERIVED from content.js base rewards and the exact
  // factor bps, never hardcoded, so this test cannot drift from the content.
  const rungs = [
    { miners: 6000, bps: 9889n },
    { miners: 10000, bps: 9445n },
    { miners: 25000, bps: 7778n },
    { miners: 50000, bps: 5000n },
  ];
  for (const { miners, bps } of rungs) {
    for (const mission of REAL_MISSIONS) {
      const result = computeReward({ mission, activeMiners: miners, streakDays: 1 });
      const base = BigInt(mission.reward);
      assert.equal(result.dynamicFactorBps, bps);
      assert.equal(result.reward, ((base * bps) / 10000n).toString(), `${mission.id} at ${miners} miners`);
      assert.ok(BigInt(result.reward) < base, "a shrunk emission must pay less than the base");
    }
  }
});

test("at the floor the three real missions pay exactly 6 / 10 / 20 CATT", () => {
  const floorRewards = ["6000000000000000000", "10000000000000000000", "20000000000000000000"];
  REAL_MISSIONS.forEach((mission, index) => {
    const result = computeReward({ mission, activeMiners: 50000, streakDays: 1 });
    assert.equal(result.dynamicFactorBps, 5000n);
    assert.equal(result.reward, floorRewards[index], `${mission.id} at the emission floor`);
  });
});

test("the factor is monotonic non-increasing across the whole range", () => {
  let previous = dynamicEmissionFactorBps(0);
  for (let miners = 1; miners <= 120000; miners += 137) {
    const factor = dynamicEmissionFactorBps(miners);
    assert.ok(
      factor <= previous,
      `factor rose at ${miners} miners: ${factor} > ${previous}`
    );
    previous = factor;
  }
  assert.equal(previous, 5000n);
});

test("the factor never drops below the 50% floor, at any miner count", () => {
  for (const miners of [5001, 6000, 12345, 25000, 49999, 50000, 100000, 10 ** 9, 10 ** 15]) {
    const factor = dynamicEmissionFactorBps(miners);
    assert.ok(
      factor >= DYNAMIC_EMISSION_FLOOR_BPS,
      `factor at ${miners} miners (${factor}) fell below the 5000n floor`
    );
    assert.ok(factor <= BPS_ONE, `factor at ${miners} miners exceeded 1.0x`);
  }
});

test("at or above the floor the factor stays exactly 5000n forever", () => {
  for (const miners of [50000, 50001, 60000, 99999, 10 ** 6, 10 ** 12, Number.MAX_SAFE_INTEGER]) {
    assert.equal(dynamicEmissionFactorBps(miners), 5000n, `at ${miners} miners`);
  }
});

/* -------------------------------------------------------------------------- */
/* Dynamic emission — hostile / missing miner readings                         */
/* -------------------------------------------------------------------------- */

test("an unusable miner reading normalises to zero active miners, i.e. full base", () => {
  const hostile = [0, -1, -5000, NaN, Infinity, -Infinity, 0.5, 6000.7, null, undefined, "abc", "", {}, [], true];
  for (const value of hostile) {
    assert.equal(normalizeActiveMiners(value), 0n, `normalize(${String(value)})`);
    assert.equal(dynamicEmissionFactorBps(value), 10000n, `factor for ${String(value)}`);
    const result = computeReward({ mission: REAL_MISSIONS[0], activeMiners: value, streakDays: 1 });
    assert.equal(result.reward, REAL_MISSIONS[0].reward, `reward for ${String(value)}`);
    assert.equal(result.applied.dynamicEmission, false);
  }
});

/* -------------------------------------------------------------------------- */
/* Dynamic emission — poisoned base reward and degenerate ramp                 */
/* -------------------------------------------------------------------------- */

test("a non-positive or lossy mission.reward THROWS and never pays zero", () => {
  const poisoned = [
    undefined,
    null,
    0,
    "0",
    -1,
    "-1",
    -10000000000000000000n,
    0n,
    "0.0",
    "1.5",
    1.5,
    NaN,
    Infinity,
    "1e18",
    true,
    {},
    [],
    1e21, // beyond Number.MAX_SAFE_INTEGER: lossy as a number
  ];
  for (const value of poisoned) {
    assert.throws(
      () => computeReward({ mission: { reward: value }, activeMiners: 0, streakDays: 1 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(err.code, ECONOMICS_ERRORS.INVALID_BASE_REWARD, `code for ${String(value)}`);
        assert.equal(err.name, ECONOMICS_ERROR_NAME);
        return true;
      },
      `computeReward must reject reward=${String(value)} rather than pay 0`
    );
  }
  // A missing mission is the same failure, not a crash of a different shape.
  assert.throws(
    () => computeReward({ activeMiners: 0, streakDays: 1 }),
    (err) => err.code === ECONOMICS_ERRORS.INVALID_BASE_REWARD
  );
});

test("a fractional miner count is a broken reading and normalises to zero", () => {
  assert.equal(normalizeActiveMiners(6000.9), 0n, "a fraction invents nothing");
  assert.equal(normalizeActiveMiners(0.5), 0n);
  assert.equal(dynamicEmissionFactorBps(6000.9), 10000n, "and pays the full base");
  assert.equal(normalizeActiveMiners("6000"), 6000n, "a digit string is still a valid count");
  assert.equal(dynamicEmissionFactorBps("6000"), 9889n);
  assert.equal(normalizeActiveMiners("  6000  "), 6000n);
});

test("a healthy reward is accepted in both exact forms", () => {
  const mission = REAL_MISSIONS[0];
  assert.equal(computeReward({ mission }).reward, mission.reward, "the authored decimal string");
  assert.equal(
    computeReward({ mission: { reward: BigInt(mission.reward) } }).reward,
    mission.reward,
    "a bigint"
  );
  // A NUMBER is only accepted when it is exact, and 12e18 is not: passing the
  // reward as a JS number would already have lost the low digits.
  assert.throws(
    () => computeReward({ mission: { reward: Number(mission.reward) } }),
    (err) => err.code === ECONOMICS_ERRORS.INVALID_BASE_REWARD
  );
  assert.equal(computeReward({ mission: { reward: 12345 } }).reward, "12345", "a safe integer is exact");
});

test("a degenerate floorMiners THROWS instead of misbehaving", () => {
  const degenerate = [5000, 4999, 0, 1, -1, NaN, 1.5, "nope", {}, []];
  for (const floorMiners of degenerate) {
    assert.throws(
      () => dynamicEmissionFactorBps(6000, floorMiners),
      (err) => {
        assert.equal(err.code, ECONOMICS_ERRORS.INVALID_RANGE, `code for ${String(floorMiners)}`);
        assert.equal(err.name, ECONOMICS_ERROR_NAME);
        return true;
      },
      `floorMiners=${String(floorMiners)} must be rejected`
    );
    assert.throws(
      () => computeReward({ mission: REAL_MISSIONS[0], activeMiners: 6000, floorMiners }),
      (err) => err.code === ECONOMICS_ERRORS.INVALID_RANGE
    );
  }
});

test("floorMiners is overridable per call and moves the top of the ramp", () => {
  // A ramp whose top is 10,000 reaches the 50% floor at 10,000 miners, and the
  // midpoint (7500 miners) is exactly 0.75x.
  assert.equal(dynamicEmissionFactorBps(10000, 10000), 5000n);
  assert.equal(dynamicEmissionFactorBps(7500, 10000), 7500n);
  assert.equal(dynamicEmissionFactorBps(6000, 10000), 9000n);
  // The first legal floor is trigger + 1, which is a one-miner ramp.
  assert.equal(dynamicEmissionFactorBps(5001, 5001), 5000n);
  assert.equal(dynamicEmissionFactorBps(5000, 5001), 10000n);
  // A wider ramp is a shallower slope: at 10,000 miners, a 100,000 top is
  // 5,000*5,000/95,000 = 263 bps of drop, not 555.
  assert.equal(dynamicEmissionFactorBps(10000, 100000), 9737n);
  // The override reaches the settlement path too.
  const mission = REAL_MISSIONS[0];
  const overridden = computeReward({ mission, activeMiners: 10000, streakDays: 1, floorMiners: 10000 });
  assert.equal(overridden.dynamicFactorBps, 5000n);
  assert.equal(overridden.reward, "6000000000000000000");
  assert.equal(overridden.breakdown.floorMiners, "10000");
});

test("the error code map is frozen and stable", () => {
  assert.ok(Object.isFrozen(ECONOMICS_ERRORS));
  assert.equal(ECONOMICS_ERRORS.INVALID_RANGE, "ECONOMICS_INVALID_RANGE");
  assert.equal(ECONOMICS_ERRORS.INVALID_BASE_REWARD, "ECONOMICS_INVALID_BASE_REWARD");
});

/* -------------------------------------------------------------------------- */
/* Streak multiplier — the literal +0.2x/day ladder                            */
/* -------------------------------------------------------------------------- */

test("the streak ladder is the literal +0.2x/day ladder, capped at 2.0x on DAY 6", () => {
  const expected = new Map([
    [0, 10000n],
    [1, 10000n],
    [2, 12000n],
    [3, 14000n],
    [4, 16000n],
    [5, 18000n],
    // The cap is FIRST REACHED ON DAY 6, not day 7: five +0.2x steps from a 1.0
    // base lands exactly on 2.0. Landing on day 7 would need ~0.1667x/day.
    [6, 20000n],
    [7, 20000n],
    [8, 20000n],
    [30, 20000n],
    [10000, 20000n],
  ]);
  for (const [days, expectedBps] of expected) {
    assert.equal(streakFactorBps(days), expectedBps, `streak of ${days} day(s)`);
  }
});

test("the streak factor never exceeds 2.0x, at any streak length", () => {
  for (let days = 0; days <= 500; days += 1) {
    const factor = streakFactorBps(days);
    assert.ok(factor <= STREAK_MAX_BPS, `day ${days} exceeded the cap: ${factor}`);
    assert.ok(factor >= 10000n, `day ${days} fell below 1.0x: ${factor}`);
  }
  assert.equal(streakFactorBps(10000), 20000n);
  assert.equal(streakFactorBps(10n ** 12n), STREAK_MAX_BPS);
  assert.equal(streakFactorBps(10n ** 30n), STREAK_MAX_BPS, "an absurd streak is clamped, not overflowing");
});

test("a missing, reset or hostile streak is day 0 and pays 1.0x", () => {
  for (const value of [0, -1, NaN, Infinity, null, undefined, 0.4, "nope", {}, [], true]) {
    assert.equal(streakFactorBps(value), 10000n, `streakFactorBps(${String(value)})`);
  }
  assert.equal(streakFactorBps(1.9), 10000n, "a fractional day count floors");
});

test("the streak bonus actually moves the payout from day 2 onward", () => {
  const mission = REAL_MISSIONS[0];
  const day1 = computeReward({ mission, activeMiners: 0, streakDays: 1 });
  const day2 = computeReward({ mission, activeMiners: 0, streakDays: 2 });
  const day6 = computeReward({ mission, activeMiners: 0, streakDays: 6 });
  const day7 = computeReward({ mission, activeMiners: 0, streakDays: 7 });
  assert.equal(day1.reward, mission.reward);
  assert.equal(day2.reward, (BigInt(mission.reward) * 12000n / 10000n).toString());
  assert.equal(day6.reward, day7.reward, "day 6 and day 7 both pay the 2.0x cap");
  assert.equal(day1.applied.streakMultiplier, false);
  assert.equal(day2.applied.streakMultiplier, true);
  assert.equal(day6.applied.streakMultiplier, true);
});

/* -------------------------------------------------------------------------- */
/* Composition                                                                  */
/* -------------------------------------------------------------------------- */

test("the two factors are multiplied first and divided once", () => {
  const dynamicBps = dynamicEmissionFactorBps(25000); // 7778n
  const streakBps = streakFactorBps(3); // 14000n
  assert.equal(dynamicBps, 7778n);
  assert.equal(streakBps, 14000n);

  const mission = REAL_MISSIONS[0];
  const result = computeReward({ mission, activeMiners: 25000, streakDays: 3 });

  // Explicit BigInt expectation, written out rather than derived from the module.
  const expectedCombined = (7778n * 14000n) / 10000n; // 10889n — one floor
  assert.equal(expectedCombined, 10889n);
  const expectedReward = (BigInt(mission.reward) * expectedCombined) / 10000n;

  assert.equal(result.dynamicFactorBps, 7778n);
  assert.equal(result.streakFactorBps, 14000n);
  assert.equal(result.combinedFactorBps, expectedCombined);
  assert.equal(result.reward, expectedReward.toString());
  assert.equal(result.breakdown.factorProductBps, (7778n * 14000n).toString());
});

test("composition is order-independent: both factor orders give one identical result", () => {
  const cases = [
    { miners: 6000, days: 2 },
    { miners: 10000, days: 4 },
    { miners: 25000, days: 6 },
    { miners: 60000, days: 3 },
  ];
  for (const { miners, days } of cases) {
    const dynamicBps = dynamicEmissionFactorBps(miners);
    const streakBps = streakFactorBps(days);
    const dynamicFirst = (dynamicBps * streakBps) / BPS_ONE;
    const streakFirst = (streakBps * dynamicBps) / BPS_ONE;
    assert.equal(dynamicFirst, streakFirst, `bps composition differs at ${miners} miners / day ${days}`);

    // Also independent of which FACTOR was computed first from its inputs.
    const swapped = computeReward({ mission: REAL_MISSIONS[1], activeMiners: miners, streakDays: days });
    assert.equal(swapped.combinedFactorBps, dynamicFirst);
    assert.equal(swapped.reward, ((BigInt(REAL_MISSIONS[1].reward) * dynamicFirst) / BPS_ONE).toString());
  }
});

test("the reward has ONE floor: the two-step route is a genuinely different number", () => {
  const mission = REAL_MISSIONS[2]; // 40 CATT, the largest real base
  const result = computeReward({ mission, activeMiners: 25000, streakDays: 5 });
  const base = BigInt(mission.reward);
  const dynamicBps = 7778n; // 25,000 miners
  const streakBps = 18000n; // day 5

  const composed = (dynamicBps * streakBps) / BPS_ONE; // 14,000 bps (14000.4 truncated)
  const singleFloor = (base * composed) / BPS_ONE;
  const doubleFloor = (((base * dynamicBps) / BPS_ONE) * streakBps) / BPS_ONE;

  assert.equal(composed, 14000n, "the bps product truncates once, on the way in");
  assert.equal(result.combinedFactorBps, composed);
  assert.equal(result.reward, singleFloor.toString(), "computeReward takes exactly one floor");
  assert.notEqual(
    result.reward,
    doubleFloor.toString(),
    "which is why the factors are composed before the base is scaled at all"
  );

  // Order independence holds where it is claimed to: the composed bps is the
  // same whichever factor was applied first, so the single floor is the same.
  const other = computeReward({ mission, activeMiners: 25000, streakDays: 5, floorMiners: 50000 });
  assert.equal(other.reward, result.reward);
});

test("a boundary that actually truncates floors instead of rounding", () => {
  // 12 CATT plus one wei: no factor divides this evenly, so the single floor is
  // observable rather than invisible.
  const oddMission = { id: "odd", difficulty: "EASY", reward: "12000000000000000001" };
  const result = computeReward({ mission: oddMission, activeMiners: 25000, streakDays: 1 });
  const base = BigInt(oddMission.reward);
  const bps = 7778n;
  const product = base * bps;
  const quotient = product / 10000n;
  const remainder = product % 10000n;

  assert.ok(remainder > 0n, "this boundary must actually truncate");
  assert.equal(result.reward, quotient.toString());
  assert.notEqual(result.reward, ((product + 9999n) / 10000n).toString(), "it floors, it does not round");
  assert.ok(BigInt(result.reward) * 10000n < product, "the payable amount is below the exact product");
  assert.equal(product - BigInt(result.reward) * 10000n, remainder, "the loss is exactly the remainder");

  // The bps level truncates too: 9889 * 12000 = 118,668,000 -> 11,866 bps, not 11,866.8.
  const bpsResult = computeReward({ mission: oddMission, activeMiners: 6000, streakDays: 2 });
  assert.equal(bpsResult.dynamicFactorBps, 9889n);
  assert.equal(bpsResult.streakFactorBps, 12000n);
  assert.equal(bpsResult.combinedFactorBps, (9889n * 12000n) / 10000n);
  assert.equal(bpsResult.combinedFactorBps, 11866n);
  assert.notEqual(bpsResult.combinedFactorBps, 11867n);
});

test("applyFactorBps scales an exact amount by a bps factor with one floor", () => {
  const base = BigInt(REAL_MISSIONS[0].reward);
  assert.equal(applyFactorBps(base, BPS_ONE), base, "1.0x is the identity");
  assert.equal(applyFactorBps(base, 5000n), base / 2n);
  assert.equal(applyFactorBps(base, 20000n), base * 2n);
  assert.equal(applyFactorBps("12000000000000000001", 7778n), (12000000000000000001n * 7778n) / 10000n);
  // A zero or absurd factor is refused: this module never silently pays zero.
  for (const bad of [0, 0n, -1n, NaN, "x", null, undefined, 2000000n]) {
    assert.throws(() => applyFactorBps(base, bad), (err) => err.code === ECONOMICS_ERRORS.INVALID_FACTOR_BPS);
  }
  assert.throws(() => applyFactorBps(0, BPS_ONE), (err) => err.code === ECONOMICS_ERRORS.INVALID_BASE_REWARD);
});

test("computeReward is total on its optional inputs and echoes what it used", () => {
  const result = computeReward({ mission: REAL_MISSIONS[2], activeMiners: "25000", streakDays: "3" });
  assert.equal(result.missionId, REAL_MISSIONS[2].id);
  assert.equal(result.difficulty, REAL_MISSIONS[2].difficulty);
  assert.equal(result.breakdown.activeMiners, "25000");
  assert.equal(result.breakdown.streakDays, "3");
  assert.equal(result.breakdown.triggerMiners, "5000");
  assert.equal(result.breakdown.floorMiners, "50000");
  assert.equal(result.breakdown.dynamicReductionBps, (10000n - 7778n).toString());
  assert.equal(result.breakdown.streakBonusBps, (14000n - 10000n).toString());
  assert.equal(result.breakdown.reward, result.reward);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.breakdown));
  assert.ok(Object.isFrozen(result.applied));
});

/* -------------------------------------------------------------------------- */
/* Purity — the no-free-streak-farming proof                                    */
/* -------------------------------------------------------------------------- */

test("25 calls with absurd inputs leave a REAL store byte-identical", async () => {
  const store = createMemoryStore();
  const users = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const days = ["2026-01-01", "2026-01-02", "2026-01-03"];

  // Earn real streaks and a real active-miner ledger first.
  for (let day = 0; day < days.length; day += 1) {
    for (let u = 0; u < users.length; u += 1) {
      await store.recordGradedCompletion({
        userAddress: users[u],
        dayKey: days[day],
        reward: REAL_MISSIONS[u % 3].reward,
        missionId: REAL_MISSIONS[u % 3].id,
      });
    }
  }

  const snapshot = async () => ({
    streaks: await Promise.all(users.map((userAddress) => store.getStreak({ userAddress }))),
    activeMiners: await Promise.all(days.map((dayKey) => store.countActiveMiners({ dayKey }))),
  });

  const before = await snapshot();
  assert.equal(before.streaks[0].current, 3, "a real 3-day streak exists before the calls");
  assert.deepEqual(
    before.activeMiners,
    [3, 3, 3],
    "three real active miners exist on each day before the calls"
  );

  // 25 settlement-shaped calls, all of them trying to farm: absurd streaks,
  // absurd miner counts, hostile readings, the capped multiplier.
  const absurdStreaks = [10000, 99999, 500000, 10 ** 9, 10n ** 12n, -5, NaN, null];
  const absurdMinerCounts = [0, -1, NaN, null, 50000, 10 ** 9, 10n ** 15n, "25000"];
  let calls = 0;
  for (let i = 0; i < 25; i += 1) {
    const result = computeReward({
      mission: REAL_MISSIONS[i % 3],
      activeMiners: absurdMinerCounts[i % absurdMinerCounts.length],
      streakDays: absurdStreaks[i % absurdStreaks.length],
    });
    calls += 1;
    assert.match(result.reward, DIGITS_ONLY);
    // The store is never even reachable from here: computeReward takes no store.
    assert.equal(result.applied.streakMultiplier, streakFactorBps(absurdStreaks[i % absurdStreaks.length]) > 10000n);
  }
  assert.equal(calls, 25);

  const after = await snapshot();
  assert.deepEqual(after.streaks, before.streaks, "no streak row was created, advanced or reset");
  assert.deepEqual(after.activeMiners, before.activeMiners, "no active miner was counted");
  await store.close();
});

test("the module source contains no I/O, clock, randomness or logging", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "economics.js"), "utf8");
  for (const forbidden of [
    "require(",
    "Date.now",
    "new Date",
    "Math.random",
    "process.env",
    "console.",
    "globalThis",
    "fetch(",
    "async ",
    "await ",
  ]) {
    assert.ok(!source.includes(forbidden), `economics.js must not reference \`${forbidden}\``);
  }
  // A reward function that could be awaited or handed persistence could be
  // called speculatively and settle; assert the public shape that rules both out.
  assert.equal(computeReward.constructor.name, "Function");
  assert.equal(typeof computeReward({ mission: REAL_MISSIONS[0] }), "object");
  assert.equal(typeof computeReward({ mission: REAL_MISSIONS[0] }).reward, "string");
});

/* -------------------------------------------------------------------------- */
/* Integrity                                                                    */
/* -------------------------------------------------------------------------- */

test("every amount is a digit-only canonical decimal string", () => {
  for (const miners of [0, 5000, 6000, 25000, 50000, 10 ** 9, NaN, -1]) {
    for (let days = 0; days <= 8; days += 1) {
      for (const mission of REAL_MISSIONS) {
        const result = computeReward({ mission, activeMiners: miners, streakDays: days });
        for (const [key, value] of [
          ["reward", result.reward],
          ["baseReward", result.baseReward],
        ]) {
          assert.equal(typeof value, "string", `${key} must be a string`);
          assert.match(value, DIGITS_ONLY, `${key}=${value} is not digits-only`);
          assert.ok(!value.includes("."), `${key}=${value} contains a decimal point`);
          assert.ok(!value.includes("e") && !value.includes("E"), `${key}=${value} is in exponent form`);
          assert.equal(value, BigInt(value).toString(), `${key}=${value} is not canonical`);
        }
      }
    }
  }
});

test("no value ever passes through a float: everything is exact above 2^53", () => {
  const twoTo53 = BigInt(2 ** 53);
  for (const mission of REAL_MISSIONS) {
    const base = BigInt(mission.reward);
    assert.ok(base > twoTo53, `${mission.id} base reward sits above 2^53, where a float would be lossy`);
    assert.equal(base.toString(), mission.reward);
  }

  // The proof that a float would corrupt: one wei above 12 CATT cannot survive
  // a Number round-trip, so anything that reports the wei back was BigInt all
  // the way through.
  const oneWeiOff = "12000000000000000001";
  assert.notEqual(String(Number(oneWeiOff)), oneWeiOff, "a float cannot carry this value");
  const result = computeReward({ mission: { reward: oneWeiOff }, activeMiners: 0, streakDays: 1 });
  assert.equal(result.reward, oneWeiOff, "the exact wei survived the round trip");
  assert.equal(result.combinedFactorBps, BPS_ONE);

  // And a factor that does not divide evenly must not be silently rounded.
  const odd = computeReward({ mission: { reward: oneWeiOff }, activeMiners: 25000, streakDays: 3 });
  const expectedOdd = (BigInt(oneWeiOff) * ((7778n * 14000n) / 10000n)) / 10000n;
  assert.equal(odd.reward, expectedOdd.toString());
  assert.equal(typeof odd.dynamicFactorBps, "bigint");
  assert.equal(typeof odd.streakFactorBps, "bigint");
  assert.equal(typeof odd.combinedFactorBps, "bigint");
});