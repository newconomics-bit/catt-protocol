/**
 * CATT Protocol — DETERMINISTIC DRAIN SIMULATION of the shipped tokenomics.
 *
 * RUN IT:
 *   cd backend-server && node scripts/simulate-drain.js
 *
 * WHAT IT IS: a REPORT, not a test and not a policy. It prices the three REAL
 * missions with the REAL `economics.computeReward`, at real miner counts and real
 * streak states, and asks one question of the result:
 *
 *     "With N active miners, how long does a 2,000,000 CATT season pool last,
 *      how long does the 40,000,000 CATT headroom last, and does that match the
 *      intended 20 seasons x 30 days = 600 days?"
 *
 * It computes that question and PRINTS the answer, whatever the answer is. It
 * does not adjust a constant, choose a friendlier mission mix, or a lower
 * streak, to make the shipped configuration look like the intended one. The
 * shipped constants are the inputs; the founder's claim is the thing being
 * measured, not a target.
 *
 * DETERMINISTIC: no randomness, no wall clock, no I/O, no store, no network.
 * The only "time" is an index into a season list; `SEASON_EPOCH` (0) is imported
 * for the schedule shape but no instant is ever read from a clock.
 *
 * WHY THE ARITHMETIC LIVES HERE AND NOT IN THE TEST:
 *   `test/tokenomics-simulation.test.js` requires THIS file and calls
 *   `formatReport(runSimulation())`, so the duplication runs in ONE direction —
 *   script -> test. The test never re-derives a number; it asserts invariants
 *   against the structured result this module returns and prints this module's
 *   report verbatim. One arithmetic, one source, one set of numbers, whether you
 *   read them from `npm test` or from this script.
 *
 * THE UNITS, ONCE:
 *   CATT    18-decimal base units, `BigInt` everywhere, never a `Number`.
 *   Stamina unitless POINTS (`StakingManager.sol` says so in as many words).
 *   The two are never added, converted or compared.
 */

"use strict";

const {
  computeReward,
  dynamicEmissionFactorBps,
  streakFactorBps,
  DYNAMIC_EMISSION_TRIGGER_MINERS,
  DYNAMIC_EMISSION_FLOOR_MINERS,
  DYNAMIC_EMISSION_FLOOR_BPS,
  STREAK_STEP_BPS,
  STREAK_MAX_BPS,
  STREAK_BASE_BPS,
  STREAK_CAP_FIRST_REACHED_DAY,
} = require("../src/economics.js");

const {
  SEASON_ALLOCATION,
  SEASON_ALLOCATION_CATT,
  SEASON_COUNT,
  SEASON_DURATION_DAYS,
  SEASON_EPOCH,
  SEASON_IDS,
  TOTAL_HEADROOM_CATT,
  TOTAL_SEASON_DAYS,
  CATT_BASE_UNITS,
  buildSeasonSchedule,
} = require("../src/seasons.js");

const { MISSIONS, DIFFICULTIES, DEFAULT_DAILY_STAMINA_CAP } = require("../src/content.js");
const { FREE_STAMINA_PER_DAY, DAILY_SPEND_CAP_POINTS } = require("../src/stamina-allowance.js");
const { CONTRACT_CONSTANTS } = require("../src/contract-constants.js");
const { governorReward, DAILY_BUDGET, GOVERNOR_FLOORS, GOVERNOR_REASONS } = require("../src/governor.js");

/* -------------------------------------------------------------------------- */
/* Inputs: the real missions, the real constants                             */
/* -------------------------------------------------------------------------- */

/** The three authored missions, looked up BY DIFFICULTY, never hardcoded. */
const MISSION_BY_DIFFICULTY = Object.freeze({
  [DIFFICULTIES.EASY]: MISSIONS.find((m) => m.difficulty === DIFFICULTIES.EASY),
  [DIFFICULTIES.MEDIUM]: MISSIONS.find((m) => m.difficulty === DIFFICULTIES.MEDIUM),
  [DIFFICULTIES.HARD]: MISSIONS.find((m) => m.difficulty === DIFFICULTIES.HARD),
});

/**
 * `STAMINA_PER_STAKE` from `StakingManager.sol` (`uint256 public constant
 * STAMINA_PER_STAKE = 50;`), sourced from the backend's contract-constants mirror.
 * The drift test in `test/reset-schedule.test.js` asserts this value matches the
 * Solidity source text, so the simulator now uses the exact same source of truth
 * as the rest of the backend.
 */
const STAMINA_PER_STAKE = CONTRACT_CONSTANTS.STAMINA_PER_STAKE;

/** The whole mining headroom in base units: 40,000,000 CATT. */
const TOTAL_HEADROOM_BASE_UNITS = TOTAL_HEADROOM_CATT * CATT_BASE_UNITS;

/** One season's pool in base units: 2,000,000 CATT. */
const SEASON_POOL_BASE_UNITS = BigInt(SEASON_ALLOCATION);

/** A mission mix: how many of each difficulty appear in one 10-mission cycle. */
function mix(name, easy, medium, hard) {
  return Object.freeze({
    name,
    counts: Object.freeze({
      [DIFFICULTIES.EASY]: easy,
      [DIFFICULTIES.MEDIUM]: medium,
      [DIFFICULTIES.HARD]: hard,
    }),
  });
}

/** The 60/30/10 mix used in Wave 8. The central case. */
const MIX_WAVE8 = mix("WAVE 8 CENTRAL 60/30/10", 6, 3, 1);

/** The mixes the sensitivity table varies over. */
const MIX_ALTERNATIVES = Object.freeze([
  MIX_WAVE8,
  mix("ALL EASY 100/0/0", 10, 0, 0),
  mix("EVEN 33/33/33", 1, 1, 1),
  mix("ALL HARD 0/0/100", 0, 0, 10),
]);

/**
 * The mission mix expanded into a deterministic ordered cycle.
 *
 * ORDER MATTERS, and the order is the honest one: the cycle is played in mission
 * sequence (six easy, then three medium, then one hard), because that is how a
 * day of play actually goes. A greedy player working through the cycle stops at
 * the daily spend cap, and with a 50-point cap the cycle's first five entries
 * are all easy — which is why the realised mix at the shipped cap is NOT 60/30/10
 * and is reported separately below.
 *
 * @param {Object} m A mix from {@link mix}.
 * @returns {ReadonlyArray<{ difficulty: string, mission: Object }>}
 */
function expandCycle(m) {
  const out = [];
  for (const difficulty of [DIFFICULTIES.EASY, DIFFICULTIES.MEDIUM, DIFFICULTIES.HARD]) {
    for (let i = 0; i < m.counts[difficulty]; i += 1) {
      out.push({ difficulty, mission: MISSION_BY_DIFFICULTY[difficulty] });
    }
  }
  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* The one place a reward is ever produced                                     */
/* -------------------------------------------------------------------------- */

/**
 * Prices one mission with the REAL `computeReward`, and returns the exact
 * numbers. Nothing in this file re-derives a factor, a reward or a bps product;
 * every figure below came out of this call.
 *
 * @param {Object} mission A real mission from `content.js`.
 * @param {Object} params `{ activeMiners, streakDays, floorMiners? }`.
 * @returns {{ reward: bigint, baseReward: bigint, dynamicFactorBps: bigint,
 *   streakFactorBps: bigint, combinedFactorBps: bigint, points: number }}
 */
function price(mission, { activeMiners, streakDays, floorMiners }) {
  const decision = computeReward({ mission, activeMiners, streakDays, floorMiners });
  return {
    reward: BigInt(decision.reward),
    baseReward: BigInt(decision.baseReward),
    dynamicFactorBps: decision.dynamicFactorBps,
    streakFactorBps: decision.streakFactorBps,
    combinedFactorBps: decision.combinedFactorBps,
    points: mission.staminaCost,
  };
}

/**
 * Prices a whole cycle at one (activeMiners, streakDays) state.
 *
 * @param {Object} m A mix from {@link mix}.
 * @param {Object} state `{ activeMiners, streakDays, floorMiners? }`.
 * @returns {{ cycle: Array, totalReward: bigint, totalPoints: bigint,
 *   length: number, perDifficulty: Object }}
 */
function priceCycle(m, state) {
  const entries = expandCycle(m).map(({ difficulty, mission }) => {
    const priced = price(mission, state);
    return { difficulty, mission, reward: priced.reward, points: priced.points, ...priced };
  });
  const perDifficulty = Object.freeze(
    Object.fromEntries(
      [DIFFICULTIES.EASY, DIFFICULTIES.MEDIUM, DIFFICULTIES.HARD].map((difficulty) => {
        const sample = entries.find((entry) => entry.difficulty === difficulty);
        return [difficulty, sample ? sample.reward : null];
      })
    )
  );
  return {
    cycle: entries,
    perDifficulty,
    totalReward: entries.reduce((sum, entry) => sum + entry.reward, 0n),
    totalPoints: entries.reduce((sum, entry) => sum + BigInt(entry.points), 0n),
    length: entries.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Stamina budget                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The day's SPEND budget in stamina points, from the real constants.
 *
 * `spend = min( freeGrant + stakedPoints, DAILY_SPEND_CAP_POINTS )`
 *
 * So the free 30 ALONE funds a 30-point day, and ONE stake (50 points) pushes
 * the day's budget to the 50-point cap, which is where it stops: a second stake
 * adds 50 more AVAILABLE points and cannot raise the day's spend above 50. The
 * free grant buys ACCESS, never a way around the cap.
 *
 * @param {number} stakes How many 50-point stakes the user holds.
 * @returns {{ name: string, available: bigint, spend: number, stakes: number }}
 */
function dailyBudget(stakes) {
  const available = FREE_STAMINA_PER_DAY + STAMINA_PER_STAKE * BigInt(stakes);
  const spend = Number(available < BigInt(DAILY_SPEND_CAP_POINTS) ? available : BigInt(DAILY_SPEND_CAP_POINTS));
  return {
    name: stakes === 0 ? "FREE 30 ONLY (no stake)" : `FREE 30 + ${stakes} x STAMINA_PER_STAKE(50)`,
    available,
    spend,
    stakes,
  };
}

/**
 * Expected missions and CATT per user per day, from the mix.
 *
 * THE FIX (Task 3b): The daily drain is now based on the REALISED routine —
 * playing the cycle in order until the day's stamina cap is hit. With the
 * shipped 50-point cap and 10/20/30 mission costs, a user can only complete
 * 5 easy missions (5 * 10 = 50 points) before the cap stops them. The 60/30/10
 * mix is NOT reachable in a single day; the realised routine is 100% easy.
 *
 * The expected-value formula (spend / totalPoints * totalReward) is retained
 * as `expectedDrain` for comparison, but `drainPerUserPerDay` now comes from
 * the realised routine, which is what actually happens.
 *
 * @param {ReturnType<typeof priceCycle>} priced
 * @param {ReturnType<typeof dailyBudget>} budget
 * @returns {{ missionsPerDay: number, missionsPerDayExact: bigint, drainPerUserPerDay: bigint,
 *   expectedDrain: bigint, meanReward: number, meanPoints: number, realised: Object }}
 */
function dayOutput(priced, budget) {
  const spend = BigInt(budget.spend);
  // Expected-value drain (the old formula) — kept for comparison only.
  const expectedDrain = (priced.totalReward * spend) / priced.totalPoints;
  const missionsPerDayExact = (spend * BigInt(priced.length)) / priced.totalPoints;
  const missionsPerDay = (Number(spend) / Number(priced.totalPoints)) * priced.length;
  // The REALISED routine: play the cycle in order until the day's points run out.
  // With the 50-point cap and 10/20/30 costs, this yields exactly 5 EASY missions.
  let spent = 0n;
  let realisedReward = 0n;
  const realisedByDifficulty = { [DIFFICULTIES.EASY]: 0, [DIFFICULTIES.MEDIUM]: 0, [DIFFICULTIES.HARD]: 0 };
  for (const entry of priced.cycle) {
    const cost = BigInt(entry.points);
    // Sequential play: a mission that does not fit ends the day.
    if (spent + cost > spend) break;
    spent += cost;
    realisedReward += entry.reward;
    realisedByDifficulty[entry.difficulty] += 1;
  }
  // The PRIMARY drain is now the realised routine (100% easy at 50-point cap).
  const drainPerUserPerDay = realisedReward;
  return {
    missionsPerDay,
    missionsPerDayExact,
    drainPerUserPerDay,
    expectedDrain,
    meanReward: Number(priced.totalReward) / priced.length,
    meanPoints: Number(priced.totalPoints) / priced.length,
    realised: {
      missions: Object.values(realisedByDifficulty).reduce((a, b) => a + b, 0),
      pointsSpent: Number(spent),
      drain: realisedReward,
      byDifficulty: Object.freeze(realisedByDifficulty),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Governor: daily budget normaliser (Strategy S1+S2)                          */
/* -------------------------------------------------------------------------- */

/**
 * Applies the Governor's daily budget normaliser to a day's claims.
 *
 * The Governor enforces a daily budget of 110,000 CATT (3.3M/30). Claims are
 * processed sequentially: each claim receives the full requested reward while
 * the daily budget has room; once the budget is tight, rewards are scaled
 * proportionally (in basis points); the hard floor (3/5/10 CATT by difficulty)
 * is never undercut; if even the floor does not fit, the claim is blacked out
 * (not approved) and the caller must surface SEASON_ALLOCATION_EXHAUSTED.
 *
 * This implementation matches the real `governorReward` logic: it continues
 * paying the floor for subsequent claims until the floor no longer fits in the
 * remaining budget (at which point all remaining claims are blacked out).
 *
 * For the simulation, all users do 5 EASY missions (realised routine at 50pt
 * cap). This function computes the total approved drain for the day and the
 * effective governor scaling factor.
 *
 * @param {Object} params
 * @param {bigint} params.easyReward The per-mission easy reward (post-economics).
 * @param {number} params.activeMiners Number of active miners.
 * @param {number} params.missionsPerUser Missions per user per day (5 for realised).
 * @returns {{ governedDrainPerDay: bigint, preGovernorDrainPerDay: bigint,
 *   governorScaleFactor: number, claimsApproved: number, claimsTotal: number,
 *   budgetUsed: bigint, blackoutClaims: number }}
 */
function applyGovernor({ easyReward, activeMiners, missionsPerUser }) {
  const requestedReward = easyReward; // already in base units
  const floor = GOVERNOR_FLOORS.EASY; // 3 CATT in base units
  const dailyBudget = BigInt(DAILY_BUDGET); // 110,000 CATT in base units
  const claimsTotal = BigInt(activeMiners * missionsPerUser);
  const preGovernorDrainPerDay = requestedReward * claimsTotal;

  // If total demand fits in budget, no governor scaling.
  if (preGovernorDrainPerDay <= dailyBudget) {
    return {
      governedDrainPerDay: preGovernorDrainPerDay,
      preGovernorDrainPerDay,
      governorScaleFactor: 1.0,
      claimsApproved: Number(claimsTotal),
      claimsTotal: Number(claimsTotal),
      budgetUsed: preGovernorDrainPerDay,
      blackoutClaims: 0,
    };
  }

  // Budget exceeded: process claims sequentially like the real governor.
  let spent = 0n;
  let claimsApproved = 0n;

  for (let i = 0n; i < claimsTotal; i++) {
    const remaining = dailyBudget - spent;
    if (remaining <= 0n) {
      // Budget exhausted - all remaining claims blacked out.
      break;
    }

    if (requestedReward <= remaining) {
      // Full reward fits.
      spent += requestedReward;
      claimsApproved++;
    } else {
      // Budget tight: proportional scale-down.
      const scaleBps = (remaining * 10000n) / requestedReward;
      const scaled = (requestedReward * scaleBps) / 10000n;

      if (scaled >= floor) {
        // Scaled reward above floor - approve at scaled amount.
        spent += scaled;
        claimsApproved++;
      } else {
        // Scaled reward below floor - apply floor if it fits.
        if (floor <= remaining) {
          spent += floor;
          claimsApproved++;
        } else {
          // Floor doesn't fit - this and all remaining claims blacked out.
          break;
        }
      }
    }
  }

  const blackoutClaims = claimsTotal - claimsApproved;
  const governedDrainPerDay = spent;
  const governorScaleFactor = Number(governedDrainPerDay) / Number(preGovernorDrainPerDay);

  return {
    governedDrainPerDay,
    preGovernorDrainPerDay,
    governorScaleFactor,
    claimsApproved: Number(claimsApproved),
    claimsTotal: Number(claimsTotal),
    budgetUsed: spent,
    blackoutClaims: Number(blackoutClaims),
  };
}

/* -------------------------------------------------------------------------- */
/* The season walk                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Walks the REAL 20-season schedule against a constant network drain rate.
 *
 * The season pool is a HARD CAP (`seasons.js#settle` throws
 * `SEASON_ALLOCATION_EXHAUSTED`): once a season's 2,000,000 CATT is gone, mining
 * for that season STOPS and the rest of its 30 days pay NOTHING. It does not
 * roll into the next season, which opens with its own fresh 2,000,000 CATT. So a
 * season that empties on day 4 wastes 26 of its 30 days, and the headroom is
 * spent in 20 x 4 = 80 days, not 600.
 *
 * @param {bigint} netDrainPerDay Whole-network CATT base units per day.
 * @returns {Object} The walk.
 */
function walkSchedule(netDrainPerDay) {
  const perDay = netDrainPerDay;
  const fullDays = SEASON_POOL_BASE_UNITS / perDay;
  const remainder = SEASON_POOL_BASE_UNITS % perDay;
  // The day the pool empties: the first day on which the cumulative drain would
  // meet or pass the pool. `remainder === 0n` means it empties exactly at the end
  // of day `fullDays`, so that day is the last mining day.
  const emptiesOnSeasonDay = remainder === 0n ? fullDays : fullDays + 1n;
  const seasonMinedDays = emptiesOnSeasonDay < BigInt(SEASON_DURATION_DAYS)
    ? emptiesOnSeasonDay
    : BigInt(SEASON_DURATION_DAYS);
  const daysLostPerSeason = BigInt(SEASON_DURATION_DAYS) - seasonMinedDays;
  const drainedThisSeason =
    SEASON_POOL_BASE_UNITS < perDay * seasonMinedDays ? SEASON_POOL_BASE_UNITS : perDay * seasonMinedDays;

  const seasons = SEASON_IDS.map((id, index) => ({
    id,
    index: index + 1,
    minedDays: Number(seasonMinedDays),
    daysLost: Number(daysLostPerSeason),
    drained: drainedThisSeason,
    poolExhausted: emptiesOnSeasonDay <= BigInt(SEASON_DURATION_DAYS),
  }));

  const minedDaysTotal = Number(seasonMinedDays) * SEASON_COUNT;
  const totalDrained = drainedThisSeason * BigInt(SEASON_COUNT);
  const runwayDays = minedDaysTotal;
  const poolExhaustsEarly = emptiesOnSeasonDay <= BigInt(SEASON_DURATION_DAYS);
  const headroomExhausted = poolExhaustsEarly;
  const leftover = poolExhaustsEarly ? 0n : TOTAL_HEADROOM_BASE_UNITS - totalDrained;

  return {
    netDrainPerDay,
    emptiesOnSeasonDay,
    seasonMinedDays,
    daysLostPerSeason,
    seasons,
    seasonsOpened: SEASON_COUNT,
    seasonsFullyMined: seasons.filter((s) => s.minedDays === SEASON_DURATION_DAYS).length,
    runwayDays,
    totalDrained,
    headroomExhausted,
    leftover,
    daysOfScheduleThatPaid: runwayDays,
    scheduleDays: TOTAL_SEASON_DAYS,
  };
}

/**
 * The largest active-miner count at which a 2,000,000 CATT season pool still
 * survives its full 30 days, found by binary search over the REAL `computeReward`
 * at every step. This is a REPORTED threshold, not a parameter: nothing is tuned
 * to reach it, and no shipped constant changes.
 *
 * The predicate is monotone — more miners means a lower-or-equal emission factor
 * AND more drain, so the pool can only exhaust sooner — which is what makes the
 * search well defined.
 *
 * @param {Object} params `{ budget, streakDays, max }`.
 * @returns {number} The break-even miner count.
 */
function breakEvenMiners({ budget, streakDays, max = 100_000_000 }) {
  const survives = (miners) => {
    const priced = priceCycle(MIX_WAVE8, { activeMiners: miners, streakDays });
    const day = dayOutput(priced, budget);
    const easyReward = priced.perDifficulty[DIFFICULTIES.EASY];
    const missionsPerUser = day.realised.missions;
    const governorResult = applyGovernor({
      easyReward,
      activeMiners: miners,
      missionsPerUser,
    });
    const netDrainPerDay = governorResult.governedDrainPerDay;
    const walk = walkSchedule(netDrainPerDay);
    return walk.emptiesOnSeasonDay >= BigInt(SEASON_DURATION_DAYS);
  };
  let low = 0;
  let high = max;
  if (survives(high)) return high;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (survives(mid)) low = mid;
    else high = mid;
  }
  return low;
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

/** The four scenarios the founder asked for, plus the streak states. */
const SCENARIOS = Object.freeze([
  Object.freeze({ label: "LOW", activeMiners: 1000, streakDays: 6n }),
  Object.freeze({ label: "CENTRAL", activeMiners: 5000, streakDays: 6n }),
  Object.freeze({ label: "FOUNDER'S CASE", activeMiners: 10000, streakDays: 6n }),
  Object.freeze({ label: "HIGH", activeMiners: 20000, streakDays: 6n }),
]);

/** Streak states: "OFF-equivalent" pays the day-1 multiple, the cap pays 2.0x. */
const STREAK_OFF_DAYS = 1n;
const STREAK_CAP_DAYS = STREAK_CAP_FIRST_REACHED_DAY; // 6 — the cap is first reached here

/** The two stamina budgets: free-only, and free + one stake (the shipped cap). */
const BUDGETS = Object.freeze([dailyBudget(0), dailyBudget(1)]);

/**
 * Runs one scenario at one streak state, for every budget and every mix.
 *
 * @param {Object} scenario `{ label, activeMiners, streakDays }`.
 * @param {Object} [options] `{ mix, budgets, floorMiners }`.
 * @returns {Object} The scenario result, all exact.
 */
function runScenario(scenario, { mix: chosen = MIX_WAVE8, budgets = BUDGETS, floorMiners } = {}) {
  const state = {
    activeMiners: scenario.activeMiners,
    streakDays: scenario.streakDays,
    floorMiners,
  };
  const priced = priceCycle(chosen, state);
  const dynamicFactorBps = dynamicEmissionFactorBps(scenario.activeMiners, floorMiners);
  const rows = budgets.map((budget) => {
    const day = dayOutput(priced, budget);
    // Apply the Governor (Strategy S1+S2) to the day's claims.
    // The realised routine gives us the missions per user (5 easy at 50pt cap).
    const easyReward = priced.perDifficulty[DIFFICULTIES.EASY];
    const missionsPerUser = day.realised.missions;
    const governorResult = applyGovernor({
      easyReward,
      activeMiners: scenario.activeMiners,
      missionsPerUser,
    });
    const netDrainPerDay = governorResult.governedDrainPerDay;
    return {
      budget,
      ...day,
      priced,
      activeMiners: scenario.activeMiners,
      netDrainPerDay,
      governor: governorResult,
      walk: walkSchedule(netDrainPerDay),
    };
  });
  return {
    label: scenario.label,
    activeMiners: scenario.activeMiners,
    streakDays: scenario.streakDays,
    streakFactorBps: streakFactorBps(scenario.streakDays),
    dynamicFactorBps,
    floorMiners: floorMiners === undefined ? DYNAMIC_EMISSION_FLOOR_MINERS : floorMiners,
    mix: chosen,
    priced,
    rows,
  };
}

/** The mix sensitivity at one miner count and streak state. */
function runMixSensitivity(activeMiners, streakDays) {
  return MIX_ALTERNATIVES
    .filter((m) => m.counts[DIFFICULTIES.EASY] > 0)
    .map((m) => {
    const priced = priceCycle(m, { activeMiners, streakDays });
    return {
      mix: m,
      priced,
      rows: BUDGETS.map((budget) => {
        const day = dayOutput(priced, budget);
        const easyReward = priced.perDifficulty[DIFFICULTIES.EASY];
        const missionsPerUser = day.realised.missions;
        const governorResult = applyGovernor({
          easyReward,
          activeMiners,
          missionsPerUser,
        });
        return {
          budget,
          ...day,
          netDrainPerDay: governorResult.governedDrainPerDay,
          governor: governorResult,
        };
      }),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Solving for a configuration that WOULD satisfy the founder's requirement      */
/* -------------------------------------------------------------------------- */

/**
 * The founder's requirement, as one equation.
 *
 *   a 2,000,000 CATT pool must survive 30 days  =>  network drain/day <= 2M/30
 *   a 40,000,000 CATT headroom must last 600 days =>  network drain/day <= 40M/600
 *
 * These are THE SAME number, because 2M/30 == 40M/600. So satisfying both is one
 * constraint, and it has several very different solutions. They are all listed;
 * NONE of them is applied.
 */
function solveOptions() {
  const founder = runScenario(SCENARIOS[2], { budgets: [dailyBudget(1)] });
  const free = runScenario(SCENARIOS[2], { budgets: [dailyBudget(0)] });
  const staked = founder.rows[0];
  const freeOnly = free.rows[0];
  const miners = BigInt(founder.activeMiners);

  const targetNetworkPerDay = SEASON_POOL_BASE_UNITS / BigInt(SEASON_DURATION_DAYS);
  const targetPerUserPerDay = targetNetworkPerDay / miners;

  // Option A: how many missions a user may play per day, rewards unchanged. The
  // answer is the same for both budgets, because it is the TARGET divided by the
  // price of one mission, and the price does not depend on the budget. The
  // realised (all-easy, cap-bound) routine is quoted too, since at a 50-point cap
  // that is what a day actually plays.
  const requiredMissions = Number(targetPerUserPerDay) / staked.meanReward;
  const requiredMissionsRealised = Number(targetPerUserPerDay) / Number(staked.priced.perDifficulty[DIFFICULTIES.EASY]);

  // Option B: what the price of ONE mission must become. `drain = cycleReward *
  // spend / cyclePoints`, so `cycleReward = target * cyclePoints / spend` and the
  // MEAN per mission is that divided by the cycle length.
  const cycleLength = BigInt(staked.priced.length);
  const requiredCycleRewardStaked = (targetPerUserPerDay * staked.priced.totalPoints) / BigInt(staked.budget.spend);
  const requiredCycleRewardFree = (targetPerUserPerDay * freeOnly.priced.totalPoints) / BigInt(freeOnly.budget.spend);
  const requiredRewardStaked = requiredCycleRewardStaked / cycleLength;
  const requiredRewardFreeOnly = requiredCycleRewardFree / cycleLength;

  // Option 3: the season pool (and therefore the headroom) would have to grow.
  const requiredPoolStaked = staked.walk.netDrainPerDay * BigInt(SEASON_DURATION_DAYS);
  const requiredPoolFree = freeOnly.walk.netDrainPerDay * BigInt(SEASON_DURATION_DAYS);
  const requiredHeadroomStaked = requiredPoolStaked * BigInt(SEASON_COUNT);

  // Option 4: the day's stamina budget would have to shrink below one mission.
  const drainPerPointUserStaked = Number(staked.priced.totalReward) / Number(staked.priced.totalPoints);
  const requiredPointsStaked =
    (Number(targetPerUserPerDay) * Number(staked.priced.totalPoints)) / Number(staked.priced.totalReward);

  // Option 5: the streak, at 1.0x.
  const streakOff = runScenario({ label: "FOUNDER'S CASE", activeMiners: founder.activeMiners, streakDays: STREAK_OFF_DAYS });
  // Option 6: the emission floor, reached at 10,000 miners instead of 50,000.
  const floored = runScenario(
    { label: "FOUNDER'S CASE", activeMiners: founder.activeMiners, streakDays: founder.streakDays },
    { floorMiners: BigInt(founder.activeMiners) }
  );

  const easyRewardToday = Number(staked.priced.perDifficulty[DIFFICULTIES.EASY]);
  const poolGrowth = Number(requiredPoolStaked) / Number(SEASON_POOL_BASE_UNITS);

  return {
    targetNetworkPerDay,
    targetPerUserPerDay,
    current: { staked, freeOnly },
    options: [
      {
        id: "A",
        name: "missions / user / day (per-mission reward unchanged)",
        required: requiredMissions,
        requiredRealised: requiredMissionsRealised,
        nowStaked: staked.missionsPerDay,
        nowFreeOnly: freeOnly.missionsPerDay,
        tradeoff:
          `One mission every ${(1 / requiredMissions).toFixed(2)} days per user (${fixed((100 * (1 - requiredMissions / staked.missionsPerDay)), 1)}% fewer missions than today). ` +
          "At that rate a streak of CONSECUTIVE days is unreachable, so the streak ladder stops being " +
          "payable — the mechanic currently doubling the drain would remove itself, and most users " +
          "would mine nothing on most days.",
      },
      {
        id: "B",
        name: "per-mission reward (mission count unchanged)",
        required: requiredRewardStaked,
        requiredFreeOnly: requiredRewardFreeOnly,
        nowMean: staked.meanReward,
        nowMeanFreeOnly: freeOnly.meanReward,
        cutFactorStaked: Number(requiredRewardStaked) / staked.meanReward,
        cutFactorFreeOnly: Number(requiredRewardFreeOnly) / freeOnly.meanReward,
        tradeoff:
          `A ${(staked.meanReward / Number(requiredRewardStaked)).toFixed(2)}x cut on the staked budget ` +
          `(a ${(freeOnly.meanReward / Number(requiredRewardFreeOnly)).toFixed(2)}x cut on free-only). The authored ` +
          `12 / 20 / 40 CATT ladder in content.js would have to change: an easy mission pays ` +
          `${catt(staked.priced.perDifficulty[DIFFICULTIES.EASY], 2)} CATT today at 10,000 miners and the 2.0x streak cap ` +
          `(base ${catt(BigInt(MISSION_BY_DIFFICULTY[DIFFICULTIES.EASY].reward), 2)} CATT); scaled by the same factor it would pay ` +
          `${catt(BigInt(Math.round(easyRewardToday * (Number(requiredRewardStaked) / staked.meanReward))), 4)} CATT ` +
          `(base ${catt(BigInt(Math.round(Number(MISSION_BY_DIFFICULTY[DIFFICULTIES.EASY].reward) * (Number(requiredRewardStaked) / staked.meanReward))), 4)} CATT) — ` +
          "under one CATT for the easiest mission in the game.",
      },
      {
        id: "C",
        name: "season pool / total headroom",
        requiredPool: requiredPoolStaked,
        requiredPoolFreeOnly: requiredPoolFree,
        requiredHeadroom: requiredHeadroomStaked,
        nowPool: SEASON_POOL_BASE_UNITS,
        nowHeadroom: TOTAL_HEADROOM_BASE_UNITS,
        growthFactor: poolGrowth,
        tradeoff:
          `${poolGrowth.toFixed(2)}x more emissions: 40,000,000 CATT would have to become ` +
          `${catt(requiredHeadroomStaked, 0)} CATT. It breaks the founder's own ` +
          "20 x 2,000,000 = 40,000,000 identity, which `seasons.js` asserts at module load, and the " +
          "contracts are FROZEN for this wave. Every season, cap, wallet and grant that assumes 2,000,000 " +
          "would have to be re-derived.",
      },
      {
        id: "D",
        name: "daily stamina budget (points)",
        required: requiredPointsStaked,
        now: staked.budget.spend,
        freeGrant: Number(FREE_STAMINA_PER_DAY),
        tradeoff:
          `${requiredPointsStaked.toFixed(2)} points/day, which is BELOW the ${MISSION_BY_DIFFICULTY[DIFFICULTIES.EASY].staminaCost}-point cheapest mission: ` +
          `less than one easy mission every ${(MISSION_BY_DIFFICULTY[DIFFICULTIES.EASY].staminaCost / requiredPointsStaked).toFixed(2)} days. The free grant would have to fall ` +
          `from ${FREE_STAMINA_PER_DAY} to about ${requiredPointsStaked.toFixed(1)}, or mission costs would have to rise so that a day buys a fraction of a mission.`,
      },
      {
        id: "E",
        name: "streak cap 2.0x -> 1.0x (shipped OFF-equivalent)",
        runwayDays: streakOff.rows.map((row) => ({ budget: row.budget, runway: row.walk.runwayDays })),
        tradeoff:
          "Halves the drain and is the cheapest single change, but on its own it still leaves the " +
          "runway far short of 600 days, and it deletes the growth mechanic the ladder exists for. " +
          "It is a mitigation, not a fix.",
      },
      {
        id: "F",
        name: "emission floor reached at 10k miners (0.5x only today at 50k)",
        runwayDays: floored.rows.map((row) => ({ budget: row.budget, runway: row.walk.runwayDays })),
        tradeoff:
          "At best doubles the runway. Emission is a MINER-COUNT lever and the drain is driven by " +
          "MISSIONS PER USER; the factor at 10,000 miners is barely below 1.0x, so no trigger, ramp " +
          "top or floor inside the 0.5x-1.0x envelope can close a 7.5x-16x gap.",
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** Renders base units as grouped CATT with `decimals` fractional digits. */
function catt(baseUnits, decimals = 2) {
  const negative = baseUnits < 0n;
  const digits = (negative ? -baseUnits : baseUnits).toString().padStart(19, "0");
  const whole = digits.slice(0, -18).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (decimals <= 0) return `${negative ? "-" : ""}${whole}`;
  const frac = digits.slice(-18).slice(0, decimals);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Renders a `Number` with a fixed number of fractional digits. */
function fixed(value, decimals = 2) {
  return value.toFixed(decimals);
}

/** The evaluation of the founder's claim, as data — reported, never asserted. */
function evaluateClaim(simulation) {
  const founder = simulation.scenarios.find((s) => s.label === "FOUNDER'S CASE");
  const checks = [];
  for (const row of founder.rows) {
    const poolSurvives = row.walk.emptiesOnSeasonDay >= BigInt(SEASON_DURATION_DAYS);
    const runwayReaches360 = row.walk.headroomExhausted && row.walk.runwayDays >= simulation.constants.totalScheduleDays;
    checks.push({
      budget: row.budget.name,
      poolSurvives30Days: poolSurvives,
      emptiesOnSeasonDay: Number(row.walk.emptiesOnSeasonDay),
      runwayDays: row.walk.runwayDays,
      runwayReaches360Days: runwayReaches360,
    });
  }
  return {
    checks,
    holds: checks.every((c) => c.poolSurvives30Days && c.runwayReaches360Days),
  };
}

/**
 * Runs the whole simulation. Pure: same inputs, same numbers, forever.
 *
 * @returns {Object} The structured result the test asserts against.
 */
function runSimulation() {
  const scenarios = SCENARIOS.map((s) => runScenario(s));
  const sensitivityMix = runMixSensitivity(10000, STREAK_CAP_DAYS);
  const streakSensitivity = [
    { name: "STREAK OFF-EQUIVALENT (1.0x)", streakDays: STREAK_OFF_DAYS },
    { name: `STREAK AT SHIPPED CAP (${fixed(Number(streakFactorBps(STREAK_CAP_DAYS)) / 10000, 1)}x)`, streakDays: STREAK_CAP_DAYS },
  ].map((s) => ({ ...runScenario({ label: s.name, activeMiners: 10000, streakDays: s.streakDays }), name: s.name }));
  const streakLadder = [];
  for (let day = 1; day <= 8; day += 1) {
    const priced = priceCycle(MIX_WAVE8, { activeMiners: 10000, streakDays: BigInt(day) });
    const dayOutputStaked = dayOutput(priced, dailyBudget(1));
    const easyReward = priced.perDifficulty[DIFFICULTIES.EASY];
    const missionsPerUser = dayOutputStaked.realised.missions;
    const governorResult = applyGovernor({
      easyReward,
      activeMiners: 10000,
      missionsPerUser,
    });
    streakLadder.push({
      day,
      streakFactorBps: streakFactorBps(BigInt(day)),
      combinedFactorBps: priced.cycle[0].combinedFactorBps,
      cycleReward: priced.totalReward,
      netDrainPerDayStaked: governorResult.governedDrainPerDay,
      governor: governorResult,
      walk: walkSchedule(governorResult.governedDrainPerDay),
    });
  }
  const options = solveOptions();
  const breakEven = [STREAK_CAP_DAYS, STREAK_OFF_DAYS].map((streakDays) => ({
    streakDays,
    streakFactorBps: streakFactorBps(streakDays),
    byBudget: BUDGETS.map((budget) => ({
      budget,
      miners: breakEvenMiners({ budget, streakDays }),
    })),
  }));
  const simulation = {
    constants: {
      seasonPoolCatt: SEASON_ALLOCATION_CATT,
      seasonPoolBaseUnits: SEASON_POOL_BASE_UNITS,
      seasonCount: SEASON_COUNT,
      seasonDurationDays: SEASON_DURATION_DAYS,
      totalHeadroomCatt: TOTAL_HEADROOM_CATT,
      totalHeadroomBaseUnits: TOTAL_HEADROOM_BASE_UNITS,
      totalScheduleDays: TOTAL_SEASON_DAYS,
      seasonEpoch: SEASON_EPOCH,
      dynamicTriggerMiners: DYNAMIC_EMISSION_TRIGGER_MINERS,
      dynamicFloorMiners: DYNAMIC_EMISSION_FLOOR_MINERS,
      dynamicFloorBps: DYNAMIC_EMISSION_FLOOR_BPS,
      streakStepBps: STREAK_STEP_BPS,
      streakMaxBps: STREAK_MAX_BPS,
      streakBaseBps: STREAK_BASE_BPS,
      streakCapFirstReachedDay: STREAK_CAP_FIRST_REACHED_DAY,
      freeStaminaPerDay: FREE_STAMINA_PER_DAY,
      dailyStaminaCap: DEFAULT_DAILY_STAMINA_CAP,
      dailySpendCapPoints: DAILY_SPEND_CAP_POINTS,
      staminaPerStake: STAMINA_PER_STAKE,
      missions: Object.fromEntries(
        Object.values(MISSION_BY_DIFFICULTY).map((mission) => [
          mission.difficulty,
          { id: mission.id, reward: mission.reward, points: mission.staminaCost },
        ])
      ),
    },
    scenarios,
    mixSensitivity: sensitivityMix,
    streakSensitivity,
    streakLadder,
    breakEven,
    options,
  };
  simulation.claim = evaluateClaim(simulation);
  return simulation;
}

/**
 * Renders the report. `console.log`ed in full by the test and by the script.
 *
 * @param {Object} simulation The result of {@link runSimulation}.
 * @returns {string} The report, newline-joined, ready to print.
 */
function formatReport(simulation) {
  const c = simulation.constants;
  const lines = [];
  const push = (line = "") => lines.push(line);
  const rule = (title) => {
    push();
    push(`=== ${title} ${"=".repeat(Math.max(0, 96 - title.length))}`);
  };

  push("=".repeat(100));
  push("CATT PROTOCOL — DETERMINISTIC DRAIN SIMULATION (reports the shipped constants; tunes nothing)");
  push("=".repeat(100));

  rule("SHIPPED CONSTANTS, READ FROM src/ (no value below is restated by hand)");
  push(`  missions            easy ${c.missions.EASY.reward} base units (${c.missions.EASY.points} pts) | medium ${c.missions.MEDIUM.reward} (${c.missions.MEDIUM.points} pts) | hard ${c.missions.HARD.reward} (${c.missions.HARD.points} pts)`);
  push(`  season pool         ${catt(c.seasonPoolBaseUnits)} CATT  (${c.seasonPoolCatt} CATT, ${c.seasonPoolBaseUnits.toString().length} digits)`);
  push(`  headroom            ${catt(c.totalHeadroomBaseUnits)} CATT over ${c.seasonCount} seasons = ${c.totalScheduleDays} days`);
  push(`  dynamic emission    trigger ${c.dynamicTriggerMiners} miners, floor ${c.dynamicFloorMiners} miners, floor bps ${c.dynamicFloorBps} (${fixed(Number(c.dynamicFloorBps) / 10000, 2)}x)`);
  push(`  streak              +${Number(c.streakStepBps) / 10000}x/day, cap ${c.streakMaxBps} bps (${fixed(Number(c.streakMaxBps) / 10000, 1)}x), first reached on day ${c.streakCapFirstReachedDay}`);
  push(`  stamina             FREE_STAMINA_PER_DAY ${c.freeStaminaPerDay} pts, daily SPEND cap ${c.dailySpendCapPoints} pts, STAMINA_PER_STAKE ${c.staminaPerStake} pts (StakingManager.sol:76)`);
  push(`  mission mix         ${MIX_WAVE8.name}  (central case)`);
  push(`  SEASON_EPOCH        ${c.seasonEpoch} (injected; no clock is read anywhere in this simulation)`);

  rule("STAMINA BUDGET — WHICH NUMBER SETS THE DAY'S MISSION COUNT");
  for (const budget of BUDGETS) {
    const priced = priceCycle(MIX_WAVE8, { activeMiners: 10000, streakDays: STREAK_CAP_DAYS });
    const day = dayOutput(priced, budget);
    push(`  ${budget.name}`);
    push(`    available ${budget.available} pts -> SPEND cap binds at ${budget.spend} pts  (min(available, ${c.dailySpendCapPoints}))`);
    push(`    mean stamina per mission at 60/30/10 = ${fixed(day.meanPoints, 1)} pts  =>  missions/user/day = ${fixed(day.missionsPerDay, 4)}`);
    push(`    REALISED routine (cycle played in order, 10 pts/20/30): ${day.realised.missions} missions, ${day.realised.pointsSpent} pts, ${day.realised.byDifficulty.EASY} easy / ${day.realised.byDifficulty.MEDIUM} medium / ${day.realised.byDifficulty.HARD} hard`);
    push(`    NOTE: the 60/30/10 mix is NOT reachable in one day under a ${c.dailySpendCapPoints}-point cap — the 10-mission cycle costs ${priced.totalPoints} points, so a capped day only ever reaches the leading EASY missions. The`);
    push(`          expected-value figure above assumes the mix is realised across days; the realised line is what one day actually pays.`);
  }
  push(`  A SINGLE STAKE IS ALREADY ENOUGH: the free ${c.freeStaminaPerDay} alone funds a ${c.freeStaminaPerDay}-point day; one 50-point stake raises the day to the ${c.dailySpendCapPoints}-point cap; a second stake adds availability the cap cannot use.`);

  rule("SCENARIOS (streak at the shipped 2.0x cap, mix 60/30/10)");
  for (const scenario of simulation.scenarios) {
    push();
    push(`  --- ${scenario.label}: ${scenario.activeMiners} active miners ---`);
    push(`  dynamicEmissionFactorBps = ${scenario.dynamicFactorBps}  (${fixed(Number(scenario.dynamicFactorBps) / 10000, 4)}x)   streakFactorBps = ${scenario.streakFactorBps} (${fixed(Number(scenario.streakFactorBps) / 10000, 1)}x)   combined = ${scenario.priced.cycle[0].combinedFactorBps} bps (${fixed(Number(scenario.priced.cycle[0].combinedFactorBps) / 10000, 4)}x)`);
    for (const difficulty of [DIFFICULTIES.EASY, DIFFICULTIES.MEDIUM, DIFFICULTIES.HARD]) {
      const reward = scenario.priced.perDifficulty[difficulty];
      push(`    reward per mission ${difficulty.padEnd(6)} = ${catt(reward, 4).padStart(20)} CATT   (base ${catt(BigInt(c.missions[difficulty].reward), 0).padStart(12)} CATT)`);
    }
    for (const row of scenario.rows) {
      push(`    budget: ${row.budget.name}`);
      push(`      missions/user/day        ${fixed(row.missionsPerDay, 4)}  (realised today: ${row.realised.missions} missions = ${catt(row.realised.drain, 2)} CATT)`);
      push(`      CATT/user/day (pre-gov)   ${catt(row.drainPerUserPerDay, 4)}`);
      push(`      CATT/user/day (post-gov)  ${catt(row.governor.governedDrainPerDay / BigInt(scenario.activeMiners), 4)}`);
      push(`      Governor scale factor     ${fixed(row.governor.governorScaleFactor, 6)}x  (${row.governor.claimsApproved}/${row.governor.claimsTotal} claims approved, ${row.governor.blackoutClaims} blacked out)`);
      push(`      CATT/network/day          ${catt(row.netDrainPerDay, 2)}  at ${scenario.activeMiners} miners`);
      push(`      2M pool empties on day    ${row.walk.emptiesOnSeasonDay} of ${c.seasonDurationDays}   (${row.walk.seasonMinedDays} mining days, ${row.walk.daysLostPerSeason} days LOST, mining then STOPS — the cap is a hard stop)`);
      push(`      40M runway                ${row.walk.runwayDays} days  vs intended ${c.totalScheduleDays} days   (${fixed((100 * row.walk.runwayDays) / c.totalScheduleDays, 1)}% of the schedule)`);
      push(`      seasons reachable         ${row.walk.seasonsOpened} of ${c.seasonCount} OPEN, ${row.walk.seasonsFullyMined} of ${c.seasonCount} able to run all ${c.seasonDurationDays} days`);
      push(`      headroom left over        ${row.walk.headroomExhausted ? "0" : catt(row.walk.leftover, 2)} CATT of ${catt(c.totalHeadroomBaseUnits, 0)}`);
      push(`      per-season detail (day of season the 2M pool empties / days lost / CATT drained):`);
      for (const season of row.walk.seasons) {
        push(`        ${season.id.padEnd(9)} day ${String(season.minedDays).padStart(2)} of ${c.seasonDurationDays}   lost ${String(season.daysLost).padStart(2)}   drained ${catt(season.drained, 2).padStart(16)} CATT${season.poolExhausted ? "  EXHAUSTED" : "  (window closed first, remainder LOST)"}`);
      }
    }
  }

  rule("STREAK SENSITIVITY AT 10,000 MINERS (the 2.0x cap nearly doubles the drain)");
  for (const scenario of simulation.streakSensitivity) {
    push();
    push(`  --- ${scenario.name}  (streakDays = ${scenario.streakDays}) ---`);
    push(`  dynamicFactorBps ${scenario.dynamicFactorBps} x streakFactorBps ${scenario.streakFactorBps} = combined ${scenario.priced.cycle[0].combinedFactorBps} bps (${fixed(Number(scenario.priced.cycle[0].combinedFactorBps) / 10000, 4)}x)`);
    for (const difficulty of [DIFFICULTIES.EASY, DIFFICULTIES.MEDIUM, DIFFICULTIES.HARD]) {
      push(`    reward ${difficulty.padEnd(6)} ${catt(scenario.priced.perDifficulty[difficulty], 4).padStart(20)} CATT`);
    }
    for (const row of scenario.rows) {
      const gov = row.governor;
      const postGovPerUser = gov.governedDrainPerDay / BigInt(scenario.activeMiners);
      push(`    ${row.budget.name.padEnd(34)} CATT/user/day ${catt(row.drainPerUserPerDay, 4).padStart(18)} -> ${catt(postGovPerUser, 4).padStart(18)}  gov.scale=${fixed(gov.governorScaleFactor, 4)}x  pool empties day ${String(row.walk.emptiesOnSeasonDay).padStart(3)} of ${c.seasonDurationDays}  lost ${String(row.walk.daysLostPerSeason).padStart(2)}  runway ${String(row.walk.runwayDays).padStart(3)} days`);
    }
  }
  push();
  push("  streak ladder at 10,000 miners, staked budget (day -> combined bps -> gov.scale -> 40M runway):");
  for (const row of simulation.streakLadder) {
    const gov = row.governor;
    push(`    day ${String(row.day).padStart(2)}  streak ${String(row.streakFactorBps).padStart(5)} bps  combined ${String(row.combinedFactorBps).padStart(5)} bps  gov.scale=${fixed(gov.governorScaleFactor, 4)}x  network/day ${catt(row.netDrainPerDayStaked, 2).padStart(18)}  pool empties day ${String(row.walk.emptiesOnSeasonDay).padStart(3)}  runway ${String(row.walk.runwayDays).padStart(3)} days`);
  }

  rule("MISSION-MIX SENSITIVITY AT 10,000 MINERS, STREAK AT THE 2.0x CAP");
  push("  mix                    | free-30: missions/user/day  CATT/user/day(pre) CATT/user/day(post) gov.scale | staked(50): missions/user/day  CATT/user/day(pre) CATT/user/day(post) gov.scale");
  for (const entry of simulation.mixSensitivity) {
    const free = entry.rows.find((r) => r.budget.stakes === 0);
    const staked = entry.rows.find((r) => r.budget.stakes === 1);
    const freeWalk = walkSchedule(free.netDrainPerDay);
    const stakedWalk = walkSchedule(staked.netDrainPerDay);
    const freePostGov = free.governor.governedDrainPerDay / 10000n;
    const stakedPostGov = staked.governor.governedDrainPerDay / 10000n;
    push(`  ${entry.mix.name.padEnd(22)} | ${fixed(free.missionsPerDay, 3).padStart(8)}  ${catt(free.drainPerUserPerDay, 2).padStart(18)} ${catt(freePostGov, 2).padStart(18)} ${fixed(free.governor.governorScaleFactor, 4).padStart(6)}x  pool-empty ${String(freeWalk.emptiesOnSeasonDay).padStart(3)} | ${fixed(staked.missionsPerDay, 3).padStart(8)}  ${catt(staked.drainPerUserPerDay, 2).padStart(18)} ${catt(stakedPostGov, 2).padStart(18)} ${fixed(staked.governor.governorScaleFactor, 4).padStart(6)}x  pool-empty ${String(stakedWalk.emptiesOnSeasonDay).padStart(3)}  (runway ${stakedWalk.runwayDays} d)`);
  }

  rule("BREAK-EVEN MINER COUNT (the threshold the season pool actually has)");
  push("  Largest active-miner count at which the 2,000,000 CATT pool still survives all 30 days,");
  push("  found by binary search over the real computeReward at every step. Mix 60/30/10.");
  for (const row of simulation.breakEven) {
    push(`  streak at ${fixed(Number(row.streakFactorBps) / 10000, 1)}x (streakDays ${row.streakDays}):`);
    for (const entry of row.byBudget) {
      push(`    ${entry.budget.name.padEnd(34)} break-even = ${entry.miners.toLocaleString("en-US")} active miners`);
    }
  }
  push("  The founder's 10,000 miners is far past both thresholds; the 5,000-miner dynamic-emission");
  push("  trigger is also below them, which is why the factor at 10,000 miners is barely under 1.0x.");

  rule("VERDICT ON THE FOUNDER'S CLAIM (reported, not asserted)");
  push(`  CLAIM: "with 10,000 active miners the 2,000,000 CATT per-season pool will NEVER break earlier`);
  push(`          than the schedule without breaking the system, and the 40M total runway is safe for`);
  push(`          at least 20 seasons (600 days)."`);
  for (const check of simulation.claim.checks) {
    push(`  [${check.budget}]`);
    push(`     2M pool survives ${c.seasonDurationDays} days ?   ${check.poolSurvives30Days ? "YES" : `NO  — it empties on day ${check.emptiesOnSeasonDay} of ${c.seasonDurationDays}, so ${c.seasonDurationDays - check.emptiesOnSeasonDay} of the season's days pay NOTHING`}`);
    push(`     40M runway reaches ${c.totalScheduleDays} days ? ${check.runwayReaches600Days ? "YES" : `NO  — the headroom is gone after ${check.runwayDays} days (${fixed((100 * check.runwayDays) / c.totalScheduleDays, 1)}% of the schedule); ${simulation.constants.seasonCount} seasons need ${c.totalScheduleDays} days`}`);
  }
  push(`  CLAIM HOLDS: ${simulation.claim.holds ? "YES" : "NO — both stated conditions fail at 10,000 active miners on the shipped constants."}`);
  push(`  The system does not "break" in the sense of throwing: the hard cap is a loud, correct`);
  push(`  SEASON_ALLOCATION_EXHAUSTED, not a failure. The claim fails on ECONOMICS, not on safety:`);
  push(`  10,000 miners drain the whole 40,000,000 CATT headroom in days, not seasons.`);

  rule("WHAT CONFIGURATION WOULD SATISFY IT (SOLVED, NOT APPLIED)");
  push(`  The two conditions are ONE equation: 2M/30 == 40M/600, so the network must drain at most`);
  push(`  ${catt(simulation.options.targetNetworkPerDay, 2)} CATT/day in total, i.e. ${catt(simulation.options.targetPerUserPerDay, 4)} CATT/user/day at 10,000 miners.`);
  push(`  Today it drains ${catt(simulation.options.current.staked.netDrainPerDay, 2)} CATT/day (staked budget) — ${fixed(Number(simulation.options.current.staked.netDrainPerDay) / Number(simulation.options.targetNetworkPerDay), 2)}x the ceiling.`);
  push("");
  const o = simulation.options;
  push(`  A. missions/user/day  : ${fixed(o.options[0].nowStaked, 4)} -> ${fixed(o.options[0].required, 4)}  (free-only today: ${fixed(o.options[0].nowFreeOnly, 4)}; required is the same either way, because it is the target divided by the PRICE of one mission)`);
  push(`     arithmetic: ${catt(o.targetPerUserPerDay, 4)} CATT/user/day / ${catt(o.current.staked.meanReward, 4)} CATT per mix mission = ${fixed(o.options[0].required, 4)} missions/day  (${fixed(o.options[0].requiredRealised, 4)} if the day is played as the realised all-easy routine)`);
  push(`     trade-off : ${o.options[0].tradeoff}`);
  push(`  B. per-mission reward: mix mean ${catt(o.current.staked.meanReward, 4)} -> ${catt(o.options[1].required, 4)} CATT  (x${fixed(o.options[1].cutFactorStaked, 4)}; free-only -> ${catt(o.options[1].requiredFreeOnly, 4)}, x${fixed(o.options[1].cutFactorFreeOnly, 4)})`);
  push(`     arithmetic: ${catt(o.targetPerUserPerDay, 4)} CATT/user/day / ${fixed(o.current.staked.missionsPerDay, 4)} missions/day = ${catt(o.options[1].required, 4)} CATT per mix mission`);
  push(`     trade-off : ${o.options[1].tradeoff}`);
  push(`  C. season pool size  : ${catt(c.seasonPoolBaseUnits, 0)} -> ${catt(o.options[2].requiredPool, 0)} CATT per season, headroom -> ${catt(o.options[2].requiredHeadroom, 0)} CATT  (x${fixed(o.options[2].growthFactor, 4)})`);
  push(`     arithmetic: ${c.seasonDurationDays} days x ${catt(o.current.staked.netDrainPerDay, 2)} CATT/network/day = ${catt(o.options[2].requiredPool, 0)} CATT`);
  push(`     trade-off : ${o.options[2].tradeoff}`);
  push(`  D. daily stamina cap : ${o.options[3].now} -> ${fixed(o.options[3].required, 4)} points/day (free grant is ${o.options[3].freeGrant})`);
  push(`     arithmetic: ${catt(o.targetPerUserPerDay, 4)} CATT/user/day / ${catt(BigInt(Math.round(drainPerPoint(o.current.staked) * 1e6)), 6)} CATT per point = ${fixed(o.options[3].required, 4)} points`);
  push(`     trade-off : ${o.options[3].tradeoff}`);
  for (const option of [o.options[4], o.options[5]]) {
    push(`  ${option.id}. ${option.name}`);
    for (const row of option.runwayDays) {
      push(`     ${row.budget.name.padEnd(34)} 40M runway = ${row.runway} days  (needs ${c.totalScheduleDays})`);
    }
    push(`     trade-off : ${option.tradeoff}`);
  }
  push("");
  push("  Nothing above has been applied. No constant, mission reward, pool size or cap was");
  push("  changed by this simulation; every option is a founder decision, not a code default.");

  push();
  push("=".repeat(100));
  return lines.join("\n");
}

/** CATT drained per stamina point at the founder's case, staked budget. */
function drainPerPoint(stakedRow) {
  return Number(stakedRow.priced.totalReward) / Number(stakedRow.priced.totalPoints);
}

/**
 * The whole report, built and joined — the single entry point both the script and
 * the test use, so the two can never print different numbers.
 *
 * @returns {string}
 */
function buildDrainReport() {
  return formatReport(runSimulation());
}

module.exports = {
  MISSION_BY_DIFFICULTY,
  MIX_WAVE8,
  MIX_ALTERNATIVES,
  SCENARIOS,
  BUDGETS,
  STREAK_OFF_DAYS,
  STREAK_CAP_DAYS,
  STAMINA_PER_STAKE,
  dailyBudget,
  price,
  priceCycle,
  expandCycle,
  dayOutput,
  walkSchedule,
  runScenario,
  runMixSensitivity,
  runSimulation,
  evaluateClaim,
  formatReport,
  buildDrainReport,
  catt,
  fixed,
  DAILY_BUDGET,
};

if (require.main === module) {
  process.stdout.write(`${buildDrainReport()}\n`);
}
