/**
 * CATT Protocol — reward ECONOMICS: dynamic emission and the streak multiplier.
 *
 * This module owns exactly two economic factors and the one function that
 * composes them. It owns NO ledgers, NO clock, NO randomness and NO chain
 * access: every input arrives as an argument and every amount leaves as a
 * canonical decimal string. `storage.js` already holds the growth LEDGERS
 * (streak rows, the daily active-miner set) as pure mechanics; the question this
 * file answers is what those counts are WORTH.
 *
 * TWO FACTORS, COMPOSED MULTIPLICATIVELY, IN BASIS POINTS:
 *
 *   dynamic emission   how much a base reward shrinks once the network is busy
 *   streak multiplier  how much a base reward grows with consecutive graded days
 *
 *   1.0x == 10000 bps     0.5x == 5000 bps     2.0x == 20000 bps
 *
 * WHY BASIS POINTS AND BIGINT, LITERALLY:
 *   A multiplier written as a float (`0.5`, `1.2`, `1 - (miners / 5000)`) is
 *   inexact before a single factor is applied — `0.1 + 0.2 !== 0.3` in IEEE-754 —
 *   and a chain-side re-computation of the same policy would not reproduce the
 *   Judge's number. Basis points make every factor an INTEGER, so
 *   `emission * streak / BPS_ONE` is exact, the ladder values are literally
 *   readable (10000, 12000, 14000, ...), and there is no rounding policy to
 *   argue about. All intermediate arithmetic is `bigint`: a reward is a uint256
 *   in 18-decimal base units (12 CATT is `12e18`, far above
 *   `Number.MAX_SAFE_INTEGER`), so a `Number` reward would already be wrong
 *   before any multiplier was applied.
 *
 * THE COMPOSITION ORDER IS FIXED, AND THEREFORE ITS RESULT IS ORDER-INDEPENDENT:
 *   `combinedFactorBps = dynamicFactorBps * streakFactorBps / BPS_ONE`  (one floor)
 *   `reward             = baseReward * combinedFactorBps / BPS_ONE`    (one floor)
 *   The two factors are multiplied BEFORE the single division, so the composed
 *   factor does not depend on which factor was applied first: multiplying two
 *   bigints is commutative and the division happens exactly once, after the
 *   product. Applying them to the BASE one at a time instead would floor twice —
 *   and the bps product truncates on its own (9889 * 12000 -> 11,866 bps, not
 *   11,866.8) — so the two routes are different numbers, not merely differently
 *   rounded ones. `test/economics.test.js` pins both halves of that claim: the
 *   composed bps is order-independent exactly, and the reward is the explicit
 *   BigInt expectation of ONE floor rather than a two-step approximation.
 *
 * `computeReward` IS PURE, AND THAT IS THE POINT:
 *   It takes no store handle, performs no I/O, reads no clock, uses no
 *   randomness, touches no network and logs nothing. A reward function that
 *   could write would be a reward function that could be called twice to
 *   double-count, or called speculatively by a UI preview and thereby consume a
 *   season allocation. Because it cannot write, a caller may render a preview as
 *   freely as it likes. The test proves this against a REAL store: 25 calls with
 *   absurd inputs leave every streak row and `countActiveMiners` untouched,
 *   which is also the proof that a streak multiplier can only ever be paid on
 *   a streak the store actually earned.
 *
 * THE CALLER'S CONTRACT, which this module cannot enforce for you:
 *   1. READ THE STREAK BEFORE RECORDING THE COMPLETION. The ladder is evaluated
 *      from a day count, and `storage.js`'s `recordGradedCompletion` is what
 *      ADVANCES that count (first ever -> 1, same day -> unchanged, immediate
 *      next UTC day -> +1, any gap or retroactive day -> reset to 1). Record
 *      first and you will read tomorrow's streak for today's completion, paying
 *      a day-6 multiplier on day 1.
 *   2. RECORD ONLY ON A REAL PASS. `recordGradedCompletion` also maintains the
 *      daily active-miner LEDGER that `countActiveMiners` reads, so recording a
 *      FAIL would both inflate the streak and count a user who did not pass as
 *      an active miner — and that count is the input which shrinks everybody
 *      else's emission.
 *   3. THE MISSED-DAY RESET IS NOT REIMPLEMENTED HERE. It is mechanics and lives
 *      in the store, in one place, where it is auditable. A second, divergent
 *      copy of the same rule is how two disagree.
 *
 * Pure module: no I/O, no clock, no randomness, no environment access, no store.
 */

"use strict";

/* -------------------------------------------------------------------------- */
/* Scale                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Basis points in one whole multiple: 1.0x == 10000 bps.
 *
 * @type {bigint}
 */
const BPS_ONE = 10000n;

/* -------------------------------------------------------------------------- */
/* Dynamic emission                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The miner count at which emission begins to shrink: 5,000 ACTIVE MINERS.
 *
 * "Active" is the store's definition, not this file's: one row per
 * (UTC day, user) written by `recordGradedCompletion` and counted by
 * `countActiveMiners`. One user clearing four missions is ONE active miner.
 *
 * AT OR BELOW THIS COUNT THE FACTOR IS EXACTLY 1.0. That is deliberate and it is
 * the intent, not an oversight: early adopters are paid the FULL base reward, so
 * the emission curve runs in their favour at the low end and the shrinkage only
 * ever bites once the network is demonstrably busy.
 *
 * @type {bigint}
 */
const DYNAMIC_EMISSION_TRIGGER_MINERS = 5000n;

/**
 * The miner count at which emission has decayed to the 50% floor.
 *
 * =====================================================================
 * UNSPECIFIED FOUNDER PARAMETER — DEFAULTED HERE, OVERRIDABLE PER CALL.
 * =====================================================================
 * The founder specified the TRIGGER (5,000 active miners) and the FLOOR
 * (exactly 50% of base) but NOT the top of the ramp, and the two ends alone do
 * not determine a curve. This module therefore:
 *
 *   - defaults it to 50,000 miners, so it is one edit rather than a search;
 *   - makes it OVERRIDABLE PER CALL — `computeReward({ floorMiners })` and
 *     `dynamicEmissionFactorBps(activeMiners, floorMiners)` both take it — so a
 *     deployment can choose its own top without forking this file;
 *   - REJECTS a degenerate range loudly instead of misbehaving quietly.
 *
 * WHY 50,000 IS A DEFENSIBLE READING RATHER THAN AN INVENTED NUMBER: it makes
 * the shrink a 90% drop over one order of magnitude (5k -> 50k), puts the
 * midpoint (0.75x) at 27,500 miners, and makes "emission has halved" the
 * steady state rather than an emergency measure.
 *
 * A DEGENERATE RANGE THROWS (`ECONOMICS_INVALID_RANGE`) when
 * `floorMiners <= DYNAMIC_EMISSION_TRIGGER_MINERS`: with `floor == trigger` the
 * ramp has zero width and every miner above the trigger would divide by zero;
 * with `floor < trigger` the "floor" would sit ABOVE the trigger, so the factor
 * could jump discontinuously. Neither is a ramp, and a nonsense factor flowing
 * into a BigInt multiply throws a confusing error far from its cause, so the
 * check lives here, naming both numbers.
 *
 * @type {bigint}
 */
const DYNAMIC_EMISSION_FLOOR_MINERS = 50000n;

/**
 * The emission floor: exactly 50% of base, i.e. 5000 bps.
 *
 * NOT A POLICY CHOICE THIS FILE MAKES — it is the founder's floor, and it is why
 * the dynamic factor is a two-sided CLAMP rather than a curve: emission is
 * reduced by at most half, whatever the miner count does. The factor is never
 * below this value, at any miner count, for any floor.
 *
 * @type {bigint}
 */
const DYNAMIC_EMISSION_FLOOR_BPS = 5000n;

/* -------------------------------------------------------------------------- */
/* Streak multiplier                                                            */
/* -------------------------------------------------------------------------- */

/** 1.0x — the day-1 multiplier, and the value a reset streak pays. */
const STREAK_BASE_BPS = 10000n;

/** +0.2x per additional consecutive graded day: 2000 bps. */
const STREAK_STEP_BPS = 2000n;

/** 2.0x — the hard ceiling on the streak multiplier. */
const STREAK_MAX_BPS = 20000n;

/**
 * The first streak day on which the LITERAL +0.2x ladder reaches the 2.0x cap:
 * DAY 6, NOT DAY 7.
 *
 * =====================================================================
 * DOCUMENTED DISCREPANCY — WITH A +0.2x STEP, THE 2.0x CAP IS FIRST REACHED
 * ON DAY 6, NOT DAY 7. THE LADDER IS NOT RESCALED.
 * =====================================================================
 * Two parts of the specification disagree: "cap 2.0x" plus "day 1 = 1.0x,
 * day 2 = 1.2x, +0.2x/day" produces a ladder that lands on the cap one day
 * BEFORE a "2.0x from day 7" reading would:
 *
 *     day  1 -> 10000 bps (1.0x)     <- base
 *     day  2 -> 12000 bps (1.2x)
 *     day  3 -> 14000 bps (1.4x)
 *     day  4 -> 16000 bps (1.6x)
 *     day  5 -> 18000 bps (1.8x)
 *     day  6 -> 20000 bps (2.0x)     <- THE CAP IS FIRST REACHED HERE, ON DAY 6
 *     day  7 -> 20000 bps (2.0x)     <- already capped
 *     day  8+-> 20000 bps (2.0x)     <- clamped
 *
 * The arithmetic is unavoidable: after five +0.2x steps the ladder has added
 * 5 * 0.2 = 1.0 to a 1.0 base and is therefore AT 2.0 on day 6. Landing exactly
 * on day 7 needs a step of 10000 / 6 ~= 1666.67 bps (~0.1667x per day), which is
 * not a whole number of basis points, so "exactly +0.2x/day" and "first capped
 * on day 7" cannot both be true as written.
 *
 * THIS MODULE IMPLEMENTS THE LITERAL LADDER AND DOES NOT RESCALE THE STEP. A
 * rescale would have to invent a 1666 bps step or special-case day 7, and either
 * would silently change every other day's payout — day 2 would be 1.1667x
 * instead of the specified 1.2x. The discrepancy is therefore carried as a
 * documented difference plus a test, not papered over with a fix. The founder's
 * choice is: keep the literal 1.0/1.2/.../2.0 ladder on days 1-6 (cap first
 * reached on day 6), or adopt ~0.1667x/day and make day 7 the first capped day.
 *
 * @type {bigint}
 */
const STREAK_CAP_FIRST_REACHED_DAY = 6n;

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every stable, machine-readable code this module can produce, following the
 * codebase's single error idiom (a plain `Error` carrying `.code` plus the
 * offending values as own fields — see `_relayError` in relay.js and
 * `_contentError` in content.js). No Error subclass: `instanceof` across module
 * reloads is a footgun, and `.name` + `.code` is what every other failure in
 * this backend is matched on.
 *
 * @type {Readonly<Record<string, string>>}
 */
const ECONOMICS_ERRORS = Object.freeze({
  /** The dynamic-emission ramp has no width (floor at or below the trigger). */
  INVALID_RANGE: "ECONOMICS_INVALID_RANGE",
  /** `mission.reward` is missing, non-positive, or would be lossy as an integer. */
  INVALID_BASE_REWARD: "ECONOMICS_INVALID_BASE_REWARD",
  /** A basis-point factor is not a usable bigint (zero, negative, absurd). */
  INVALID_FACTOR_BPS: "ECONOMICS_INVALID_FACTOR_BPS",
});

/** The `name` every economics failure carries, so one check covers all codes. */
const ECONOMICS_ERROR_NAME = "EconomicsError";

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds an economics error with a stable `.code` and the offending values as
 * own properties.
 *
 * @param {string} code One of `ECONOMICS_ERRORS`.
 * @param {string} message Short, secret-free message naming the cause.
 * @param {Object} [fields] Additional own properties.
 * @returns {Error} The typed error.
 */
function _economicsError(code, message, fields) {
  const err = new Error(message);
  err.name = ECONOMICS_ERROR_NAME;
  err.code = code;
  if (fields) Object.assign(err, fields);
  return err;
}

/**
 * Renders a value for an error message without ever throwing (a Symbol's
 * implicit string conversion throws, and an error path must not throw).
 *
 * @param {*} value
 * @returns {string}
 */
function _describe(value) {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return "<unprintable>";
  }
}

/**
 * Coerces an authoritative amount to an exact, strictly positive `bigint`, or
 * throws.
 *
 * ACCEPTED, because all three are exact: a positive `bigint`; a positive
 * `number` that is a SAFE INTEGER (`Number.isSafeInteger` is the only `number`
 * predicate that survives the 1e18 magnitudes this codebase uses); a decimal
 * digit string. The authored missions carry the digit-string form, so the
 * returned reward can be byte-identical to what `content.js` declares.
 *
 * REJECTED, and these are the interesting half: `0` and `"0"` (a mission that
 * pays nothing is not a mission); a negative value (a `uint256` the ABI encoder
 * would refuse, AFTER the signature had already been issued); a fraction
 * (`"1.5"` — 18-decimal base units cannot be fractional); an exponent form
 * (`"1e18"`, which `BigInt` rejects outright, and which silently accepting via
 * `Number` would put a float back into an exact pipeline); `NaN`, `Infinity`,
 * a boolean, `null`, `undefined`, an object; and a `number` beyond
 * `Number.MAX_SAFE_INTEGER`, which is lossy by definition.
 *
 * A LOSSY OR NON-POSITIVE BASE THROWS AND NEVER PAYS ZERO. This is the important
 * behaviour: a silently zeroed reward is INDISTINGUISHABLE from a legitimately
 * tiny reward at the call site (the user did the work, the Judge said "0 CATT",
 * and nothing in the response says why), and it sails straight through the
 * common `if (reward > 0)` sanity check. A loud throw at least reaches an
 * operator.
 *
 * @param {*} value Candidate amount.
 * @param {string} label Field name for the error message.
 * @returns {bigint} The exact amount.
 * @throws {Error} `ECONOMICS_INVALID_BASE_REWARD`.
 */
function _exactPositiveAmount(value, label) {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    if (parsed > 0n) return parsed;
  }
  throw _economicsError(
    ECONOMICS_ERRORS.INVALID_BASE_REWARD,
    `economics: \`${label}\` must be a strictly positive, exactly-representable integer amount in ` +
      `18-decimal base units (a decimal string, a safe-integer number, or a bigint), got ` +
      `${_describe(value)}. A non-positive or lossy base reward must fail loudly here: paying 0 ` +
      `is indistinguishable from a legitimately tiny payout, so a poisoned reward would be an ` +
      `undetectable zero-pay rather than a visible failure.`,
    { field: label, value: typeof value === "bigint" ? value.toString() : value }
  );
}

/** The largest count this module will carry as a bigint, so displays stay exact. */
const _MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Normalises an active-miner reading to a non-negative `bigint`.
 *
 * `0`, `null`, `undefined`, `NaN`, `Infinity`, a negative, a fraction and any
 * non-count are all ZERO ACTIVE MINERS — which is the maximum-emission end of
 * the range: exactly the base reward. That is the correct reading of a missing
 * reading rather than an error. The caller could not determine the miner count,
 * and the honest "I do not know" is the same as the pre-launch state, not a
 * guess at "busy".
 *
 * The alternative — throwing on a missing count — would make a bonus endpoint
 * fail for every caller that has not yet reached 5,000 miners, which is every
 * caller for the entire period the early-adopter policy is protecting.
 *
 * A NON-INTEGER COUNT IS ALSO ZERO (`6000.7 -> 0`), not a floored `6000`. A
 * count of people is a cardinality: a fractional reading is not a busy network,
 * it is a broken reading, and rounding it UP would shrink everyone's emission on
 * the strength of a bad input while rounding it DOWN would invent miners that
 * do not exist. Zero is the only reading of a fraction that invents nothing.
 * Counts are clamped at `Number.MAX_SAFE_INTEGER` so the bigint cast is always
 * exact.
 *
 * @param {*} value Candidate miner count.
 * @returns {bigint} A non-negative integer count.
 */
function normalizeActiveMiners(value) {
  if (typeof value === "bigint") {
    return value < 0n ? 0n : value > _MAX_SAFE_BIGINT ? _MAX_SAFE_BIGINT : value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return 0n;
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return _stringToBigIntCapped(value.trim());
  }
  return 0n;
}

/**
 * Parses a decimal digit string into a `bigint`, saturating at
 * `Number.MAX_SAFE_INTEGER` so the result is always safe to display as a count.
 *
 * @param {string} digits A `/^\d+$/` string.
 * @returns {bigint}
 */
function _stringToBigIntCapped(digits) {
  const parsed = BigInt(digits);
  return parsed > _MAX_SAFE_BIGINT ? _MAX_SAFE_BIGINT : parsed;
}

/**
 * Validates the top of the dynamic-emission ramp.
 *
 * @param {*} floorMiners Candidate top-of-ramp miner count.
 * @returns {bigint} A positive integer strictly greater than the trigger.
 * @throws {Error} `ECONOMICS_INVALID_RANGE`.
 */
function _resolveFloorMiners(floorMiners) {
  const top =
    floorMiners === undefined || floorMiners === null
      ? DYNAMIC_EMISSION_FLOOR_MINERS
      : normalizeActiveMiners(floorMiners);
  if (top <= DYNAMIC_EMISSION_TRIGGER_MINERS) {
    throw _economicsError(
      ECONOMICS_ERRORS.INVALID_RANGE,
      `economics: the dynamic-emission ramp needs floorMiners > triggerMiners, got ` +
        `floorMiners=${_describe(floorMiners)} and triggerMiners=${DYNAMIC_EMISSION_TRIGGER_MINERS}. ` +
        `A floor at or below the trigger has no width: above the trigger it divides by zero, and ` +
        `below the trigger the "floor" sits above the trigger so the factor would jump ` +
        `discontinuously. See DYNAMIC_EMISSION_FLOOR_MINERS for why the default top of the ramp ` +
        `is an unspecified founder parameter.`,
      {
        field: "floorMiners",
        value: typeof floorMiners === "bigint" ? floorMiners.toString() : floorMiners,
        triggerMiners: DYNAMIC_EMISSION_TRIGGER_MINERS.toString(),
      }
    );
  }
  return top;
}

/** Largest accepted factor: 100x, far above anything either factor can produce. */
const MAX_FACTOR_BPS = 1000000n;

/**
 * Validates a basis-point factor.
 *
 * A factor must be a positive `bigint` (or a decimal digit string / safe-integer
 * number naming one) that is not absurd: `0n` is REFUSED rather than honoured,
 * because a zero factor silently pays nothing and this module's whole thesis is
 * that a zero payout must be a loud failure. The upper bound of 100x is far
 * above anything the two factors can produce (`dynamicEmission <= 10000n`,
 * `streak <= 20000n`) and exists to catch a unit mistake — a multiple passed
 * where basis points were expected, i.e. `2` meaning "2x" arriving as `20000`.
 *
 * @param {*} factorBps Candidate factor.
 * @param {string} label Field name for the error message.
 * @returns {bigint} The exact factor.
 * @throws {Error} `ECONOMICS_INVALID_FACTOR_BPS`.
 */
function _exactFactorBps(factorBps, label) {
  let exact;
  if (typeof factorBps === "bigint") {
    exact = factorBps;
  } else if (typeof factorBps === "number" && Number.isSafeInteger(factorBps)) {
    exact = BigInt(factorBps);
  } else if (typeof factorBps === "string" && /^\d+$/.test(factorBps.trim())) {
    exact = BigInt(factorBps.trim());
  } else {
    exact = null;
  }
  if (exact === null || exact <= 0n || exact > MAX_FACTOR_BPS) {
    throw _economicsError(
      ECONOMICS_ERRORS.INVALID_FACTOR_BPS,
      `economics: \`${label}\` must be a positive bigint in [1, ${MAX_FACTOR_BPS}] basis points ` +
        `(1.0x == ${BPS_ONE}), got ${_describe(factorBps)}. A zero factor is refused because it ` +
        `would silently pay nothing; an absurd factor is refused because it is almost certainly a ` +
        `multiple passed where basis points were expected.`,
      { field: label, value: typeof factorBps === "bigint" ? factorBps.toString() : factorBps }
    );
  }
  return exact;
}

/* -------------------------------------------------------------------------- */
/* Public factors                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The dynamic-emission factor, in basis points, for a given active-miner count.
 *
 *     factorBps = 10000n                                             if m <= 5000n
 *               = 5000n                                              if m >= floorMiners
 *               = clamp(10000n - 5000n * (m - 5000n) / (F - 5000n),
 *                       5000n, 10000n)                             otherwise
 *
 * A LINEAR ramp between the two ends, clamped at both. Linear (not exponential,
 * not logistic) because the founder said "decreases linearly": a curve with a
 * gentler middle would be a different policy wearing the same floor, and the
 * linearity is what makes the factor at any miner count readable by hand.
 *
 * MONOTONICITY AND BOUNDS — THE TWO PROPERTIES THIS FUNCTION MUST NEVER LOSE.
 *
 * Let `g(m) = floor( 5000n * (m - T) / (F - T) )` be the drop in bps, with
 * `T = 5000n` the trigger and `F > T` the floor. Consider the EXACT rational
 * `q(m) = 5000n * (m - T) / (F - T)`. As `m` increases, the numerator
 * `(m - T)` is non-decreasing and the denominator `(F - T)` is a POSITIVE
 * CONSTANT, so `q(m)` is non-decreasing: formally, for `m1 <= m2`,
 * `q(m2) - q(m1) = 5000n * (m2 - m1) / (F - T) >= 0`. Integer division by a
 * positive divisor truncates toward zero, which is a MONOTONE map on
 * non-negative operands (if `a <= b` then `floor(a) <= floor(b)`), so the
 * truncated `g(m)` is non-decreasing too. The factor is `10000n - g(m)`, hence
 * NON-INCREASING in `m`. The clamps cannot break this: both outer branches
 * return a CONSTANT (10000n at or below the trigger, 5000n at or above the
 * floor), and a constant is monotone, so the piecewise function is monotone
 * across all three regions — which is why the final clamp is redundant and is
 * kept only as a loud assertion.
 *
 * BOUNDS. For `m <= T` the result is exactly 10000n. For `T < m < F` the exact
 * rational drop satisfies `0 < q(m) < 5000n`, so truncation yields
 * `0 <= g(m) <= 4999n` and therefore `5001n <= factor <= 10000n`. For `m >= F`
 * the result is exactly 5000n. The reachable set is therefore contained in
 * `[5000n, 10000n]` — emission is NEVER below 50% of base, for any miner count
 * and any floor. The trailing clamp is belt-and-braces: a future edit to the
 * formula must fail LOUDLY here rather than quietly pay 40% of base.
 *
 * @param {*} activeMiners Active miners on the day. Anything that is not a
 *   usable count is ZERO (see {@link normalizeActiveMiners}).
 * @param {number|bigint|string} [floorMiners] Top of the ramp. Defaults to
 *   {@link DYNAMIC_EMISSION_FLOOR_MINERS}.
 * @returns {bigint} The factor in basis points, in `[5000n, 10000n]`.
 * @throws {Error} `ECONOMICS_INVALID_RANGE` for a degenerate ramp.
 */
function dynamicEmissionFactorBps(activeMiners, floorMiners) {
  const top = _resolveFloorMiners(floorMiners);
  const miners = normalizeActiveMiners(activeMiners);

  if (miners <= DYNAMIC_EMISSION_TRIGGER_MINERS) return BPS_ONE;
  if (miners >= top) return DYNAMIC_EMISSION_FLOOR_BPS;

  const span = top - DYNAMIC_EMISSION_TRIGGER_MINERS; // strictly positive
  const progress = miners - DYNAMIC_EMISSION_TRIGGER_MINERS;
  // The whole drop is `BPS_ONE - DYNAMIC_EMISSION_FLOOR_BPS` == 5000n bps,
  // distributed linearly across the ramp. ONE integer division: one truncation.
  const drop = ((BPS_ONE - DYNAMIC_EMISSION_FLOOR_BPS) * progress) / span;
  const factor = BPS_ONE - drop;
  if (factor < DYNAMIC_EMISSION_FLOOR_BPS) return DYNAMIC_EMISSION_FLOOR_BPS;
  if (factor > BPS_ONE) return BPS_ONE;
  return factor;
}

/**
 * Normalises a streak-day count to a non-negative `bigint`.
 *
 * Anything that is not a usable count is `0n`, which pays the base multiple —
 * the same value a reset streak pays, and the same value day 1 pays. Zero days
 * and "never completed" are therefore not distinguished, which is correct: this
 * module's input is a day COUNT and it prices the count; deciding whether the
 * count is real is the store's job. A NON-INTEGER count is zero for the same
 * reason a non-integer miner count is (see {@link normalizeActiveMiners}): a
 * fractional reading is a broken reading, not a rounding question.
 *
 * @param {*} streakDays Consecutive graded days.
 * @returns {bigint} A non-negative integer day count.
 */
function normalizeStreakDays(streakDays) {
  if (typeof streakDays === "bigint") {
    if (streakDays < 0n) return 0n;
    return streakDays > _MAX_SAFE_BIGINT ? _MAX_SAFE_BIGINT : streakDays;
  }
  if (typeof streakDays === "number") {
    if (!Number.isSafeInteger(streakDays) || streakDays <= 0) return 0n;
    return BigInt(streakDays);
  }
  if (typeof streakDays === "string" && /^\d+$/.test(streakDays.trim())) {
    return _stringToBigIntCapped(streakDays.trim());
  }
  return 0n;
}

/**
 * The streak multiplier, in basis points, for a streak of N consecutive graded
 * days. See {@link STREAK_CAP_FIRST_REACHED_DAY} for the day-6-vs-day-7
 * discrepancy this ladder documents, and for why the step is NOT rescaled.
 *
 *     factorBps = 10000n                                        if days < 1
 *               = min(20000n, 10000n + 2000n * (days - 1n))      otherwise
 *
 * which reads: day 1 -> 1.0x, day 2 -> 1.2x, day 3 -> 1.4x, day 4 -> 1.6x,
 * day 5 -> 1.8x, day 6 -> 2.0x (cap FIRST REACHED HERE, not on day 7),
 * day 7 and every day after -> 2.0x.
 *
 * THE MISSED-DAY RESET IS NOT IMPLEMENTED HERE. A gap resets the streak to 1 in
 * `storage.js`'s `recordGradedCompletion`, which owns the rule; this function
 * prices whatever day count it is handed and has no notion of "today".
 *
 * @param {*} streakDays Consecutive graded days BEFORE this completion.
 * @returns {bigint} The factor in basis points, in `[10000n, 20000n]`.
 */
function streakFactorBps(streakDays) {
  const days = normalizeStreakDays(streakDays);
  if (days < 1n) return STREAK_BASE_BPS;
  const stepped = STREAK_BASE_BPS + STREAK_STEP_BPS * (days - 1n);
  return stepped > STREAK_MAX_BPS ? STREAK_MAX_BPS : stepped;
}

/**
 * Scales an exact amount by a basis-point factor, with ONE floor.
 *
 *     scaled = amount * factorBps / 10000n
 *
 * The amount is validated as a strictly positive exact integer and the factor as
 * a positive bps value, so a poisoned input cannot turn into a silent zero.
 * `scaled` is returned as a `bigint`; `computeReward` is what renders it as a
 * canonical decimal string.
 *
 * THE SINGLE FLOOR IS THE POINT. Applying two factors in two calls would floor
 * twice, so the two-step route is a DIFFERENT number from the composed route
 * (the bps product truncates on its own: 9889 * 12000 -> 11,866 bps, not
 * 11,866.8). `computeReward` therefore multiplies the two bps factors together
 * and calls this ONCE on the base.
 *
 * @param {bigint|number|string} amount Exact amount in 18-decimal base units.
 * @param {bigint|number|string} factorBps The factor, where 10000n == 1.0x.
 * @returns {bigint} The scaled amount, floored toward zero.
 * @throws {Error} `ECONOMICS_INVALID_BASE_REWARD` for a non-positive or lossy
 *   amount; `ECONOMICS_INVALID_FACTOR_BPS` for an unusable factor.
 */
function applyFactorBps(amount, factorBps) {
  const exactAmount = _exactPositiveAmount(amount, "amount");
  const exactFactor = _exactFactorBps(factorBps, "factorBps");
  return (exactAmount * exactFactor) / BPS_ONE;
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Computes the payable reward for one graded completion.
 *
 * PURE: no store handle, no I/O, no clock, no network, no randomness, no
 * logging. It therefore CANNOT persist anything, which is the property that
 * makes it safe to call from a preview, a quote endpoint or a UI render as well
 * as from the settlement path.
 *
 * THE COMPOSITION, in exactly this order:
 *   1. `dynamicFactorBps = dynamicEmissionFactorBps(activeMiners, floorMiners)`
 *   2. `streakFactorBps  = streakFactorBps(streakDays)`
 *   3. `combinedFactorBps = dynamicFactorBps * streakFactorBps / BPS_ONE`
 *      — the two factors are multiplied FIRST and divided ONCE, so the composed
 *      factor is independent of which order the two factors were computed in
 *      and the bps-level rounding happens a single time.
 *   4. `reward = baseReward * combinedFactorBps / BPS_ONE`
 *      — the base is scaled exactly once, so the reward has ONE floor rather
 *      than the two floors a factor-at-a-time application would take.
 *
 * `reward` and `baseReward` are canonical DECIMAL STRINGS (digits only, no sign,
 * no exponent, no decimal point), because that is the form `ethers` encodes
 * identically to a bigint and the form the claim signature is computed over.
 *
 * @param {Object} params
 * @param {Object} params.mission The mission being graded. Only `reward` is
 *   read; `id` and `difficulty` are echoed back for the caller's audit trail.
 * @param {*} [params.activeMiners] Active miners on the day, for dynamic
 *   emission. Anything unusable means ZERO.
 * @param {*} [params.streakDays] Consecutive graded days BEFORE this
 *   completion. See the caller contract in the file header.
 * @param {number|bigint|string} [params.floorMiners] Top of the
 *   dynamic-emission ramp. Defaults to {@link DYNAMIC_EMISSION_FLOOR_MINERS}.
 * @returns {Readonly<{
 *   missionId: string|undefined,
 *   difficulty: string|undefined,
 *   baseReward: string,
 *   reward: string,
 *   dynamicFactorBps: bigint,
 *   streakFactorBps: bigint,
 *   combinedFactorBps: bigint,
 *   applied: Readonly<{ dynamicEmission: boolean, streakMultiplier: boolean }>,
 *   breakdown: Readonly<Object>,
 * }>} A frozen decision, with every amount a canonical decimal string.
 * @throws {Error} `ECONOMICS_INVALID_BASE_REWARD` for a non-positive or lossy
 *   `mission.reward`; `ECONOMICS_INVALID_RANGE` for a degenerate ramp.
 */
function computeReward({ mission, activeMiners, streakDays, floorMiners } = {}) {
  const source = mission === null || typeof mission !== "object" ? {} : mission;
  const baseReward = _exactPositiveAmount(source.reward, "mission.reward");

  const resolvedFloor = _resolveFloorMiners(floorMiners);
  const miners = normalizeActiveMiners(activeMiners);
  const days = normalizeStreakDays(streakDays);

  const dynamicBps = dynamicEmissionFactorBps(miners, resolvedFloor);
  const streakBps = streakFactorBps(days);

  // Multiply the two factors together, then divide ONCE. All operands are
  // non-negative, so this truncation is a floor.
  const combinedBps = (dynamicBps * streakBps) / BPS_ONE;
  const reward = (baseReward * combinedBps) / BPS_ONE;

  return Object.freeze({
    missionId: typeof source.id === "string" ? source.id : undefined,
    difficulty: typeof source.difficulty === "string" ? source.difficulty : undefined,
    /** The authored base reward, byte-identical to `mission.reward` when given as a string. */
    baseReward: baseReward.toString(),
    /** The payable amount: a canonical 18-decimal decimal string. */
    reward: reward.toString(),
    /** What dynamic emission did, in basis points. `<= 10000n`, `>= 5000n`. */
    dynamicFactorBps: dynamicBps,
    /** What the streak did, in basis points. `>= 10000n`, `<= 20000n`. */
    streakFactorBps: streakBps,
    /** The two factors composed: `(dynamic * streak) / 10000n`, already in bps. */
    combinedFactorBps: combinedBps,
    /**
     * Whether each mechanism actually MOVED the number on this call. Both
     * mechanisms are ON as policy; these flags report whether a particular
     * settlement was actually affected, so a caller can log "no emission
     * pressure today" without re-deriving the factors.
     */
    applied: Object.freeze({
      /** True when the miner count actually shrank the base below 1.0x. */
      dynamicEmission: dynamicBps < BPS_ONE,
      /** True when consecutive graded days actually paid a bonus above 1.0x. */
      streakMultiplier: streakBps > STREAK_BASE_BPS,
    }),
    /** Every intermediate, so a settlement can be audited by hand. */
    breakdown: Object.freeze({
      baseReward: baseReward.toString(),
      activeMiners: miners.toString(),
      triggerMiners: DYNAMIC_EMISSION_TRIGGER_MINERS.toString(),
      floorMiners: resolvedFloor.toString(),
      /** How many bps dynamic emission removed: `10000n - dynamicFactorBps`. */
      dynamicReductionBps: (BPS_ONE - dynamicBps).toString(),
      dynamicFactorBps: dynamicBps.toString(),
      streakDays: days.toString(),
      /** How many bps the streak added: `streakFactorBps - 10000n`. */
      streakBonusBps: (streakBps - STREAK_BASE_BPS).toString(),
      streakFactorBps: streakBps.toString(),
      /** The bps product BEFORE the single division that produced `combinedFactorBps`. */
      factorProductBps: (dynamicBps * streakBps).toString(),
      /** The exact unrounded reward numerator, for comparing against `reward`. */
      rewardNumerator: (baseReward * combinedBps).toString(),
      combinedFactorBps: combinedBps.toString(),
      reward: reward.toString(),
    }),
  });
}

module.exports = {
  // Scale.
  BPS_ONE,
  // Dynamic emission.
  DYNAMIC_EMISSION_TRIGGER_MINERS,
  DYNAMIC_EMISSION_FLOOR_MINERS,
  DYNAMIC_EMISSION_FLOOR_BPS,
  // Streak multiplier.
  STREAK_BASE_BPS,
  STREAK_STEP_BPS,
  STREAK_MAX_BPS,
  STREAK_CAP_FIRST_REACHED_DAY,
  // Factors and normalisation.
  normalizeActiveMiners,
  normalizeStreakDays,
  dynamicEmissionFactorBps,
  streakFactorBps,
  applyFactorBps,
  // Composition.
  computeReward,
  // Errors.
  ECONOMICS_ERRORS,
  ECONOMICS_ERROR_NAME,
  MAX_FACTOR_BPS,
};