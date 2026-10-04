/**
 * CATT Protocol — the DAILY BUDGET GOVERNOR: the normaliser that sits in the
 * reward path and decides what a mission is actually WORTH today.
 *
 * ===========================================================================
 * WHAT THIS MODULE IS, AND WHY IT IS PURE
 * ===========================================================================
 * `economics.js` decides what a reward is WORTH in terms of the NETWORK (miner
 * count, streak). This module decides what it is worth in terms of the MONEY:
 * the season's emission pool is finite, the founder divided it into a daily
 * budget, and a day that drains that budget faster than it was planned for has
 * to hand out less without ever handing out nothing.
 *
 * It is PURE, and the purity is the design, not a nicety: it takes NO store
 * handle, performs NO I/O, reads NO clock, uses NO randomness, touches NO
 * network and logs NOTHING. So it provably cannot persist, cannot double-count,
 * and may be called from a quote endpoint or a UI preview as freely as from the
 * settlement path. The caller supplies today's already-spent budget and the
 * requested reward; the governor returns the normalised reward plus enough
 * detail to decide whether to proceed, sign, or refuse.
 *
 * ===========================================================================
 * WHAT THIS MODULE NEVER DOES — READ THIS BEFORE CALLING IT
 * ===========================================================================
 * IT NEVER THROWS `SEASON_ALLOCATION_EXHAUSTED`. It does not even import
 * `seasons.js`. That error is the season pool's HARD CAP and belongs to the
 * settlement path; the governor only REPORTS the condition that should lead
 * there, via `blackout: true` and `callerMustSurface:
 * "SEASON_ALLOCATION_EXHAUSTED"`. This module never mints, never signs, never
 * settles, never advances a ledger, and never approves anything: `approved` is
 * advice, and the caller owns the refusal and the season-pool check.
 *
 * ===========================================================================
 * THE POLICY, IN THE FOUNDER'S OWN ORDER OF PRIORITY
 * ===========================================================================
 *   1. A HEALTHY DAY INTERFERES WITH NOTHING. If the day's claims fit inside
 *      the budget, the reward is returned BYTE-IDENTICAL, `scaleBps === 10000n`.
 *      Early users get the full 12 / 20 / 40. This is the most important
 *      behaviour in the file and the reason the fast path is checked first.
 *   2. AN OVERSOLD DAY SCALES DOWN PROPORTIONALLY, in basis points, in bigint.
 *   3. THE HARD FLOOR IS ABSOLUTE: 3 / 5 / 10 CATT by difficulty. Never below.
 *   4. BLACKOUT IS THE ABSOLUTE LAST RESORT: only when even the floor does not
 *      fit in what is left of the day.
 *
 * ===========================================================================
 * THE FLOOR MEANS EMISSION CAN OVERSHOOT THE DAILY BUDGET. THAT IS THE POINT,
 * AND IT IS NOT HIDDEN HERE.
 * ===========================================================================
 * The founder's choice is explicit: during a viral spike people keep getting a
 * NON-ZERO reward, because a completed lesson must never pay nothing for a
 * reason the user cannot see. If the proportional scale lands under the floor,
 * the floor wins and the day's true emission is `spentToday + floor` — which is
 * OVER the budget. The governor NORMALISES; it does not guarantee the daily
 * budget is never overshot, and any dashboard that reports "under budget" from
 * these numbers alone is reading the wrong field. The hard ceiling that is never
 * overshot is the SEASON pool's, enforced in `seasons.js`, not this one.
 *
 * ===========================================================================
 * THE ARITHMETIC — BIGINT BASIS POINTS, NO FLOATING POINT ANYWHERE
 * ===========================================================================
 * `BPS_ONE = 10000n` (1.0x == 10000 bps), the same scale `economics.js` uses.
 *
 *     remaining  = dailyBudget - spentToday      (clamped at 0)
 *     scaleBps   = remaining * 10000n / requestedReward    <- ONE floor
 *     reward     = requestedReward * scaleBps / 10000n      <- ONE floor
 *
 * TWO divisions, therefore TWO floors, and both truncate TOWARD ZERO on
 * non-negative operands, so both are floors. That is the whole rounding policy:
 * the truncation can only ever make the day's emission SMALLER than the exact
 * rational value, never larger, so the budget can be underspent by at most a
 * rounding artefact — it can never be overspent by rounding. Every intermediate
 * is a `bigint`: a CATT amount is a `uint256` in 18-decimal base units
 * (`12 CATT` is `12e18`, far above `Number.MAX_SAFE_INTEGER`), so a `Number`
 * would already be wrong before a single factor was applied. No CATT amount is
 * ever parsed with `Number` anywhere in this file.
 *
 * The scale is `remaining / requestedReward < 1` on the scaling path, so
 * `scaleBps < 10000n` always, and it is non-negative because `remaining >= 0`.
 * Both bounds are asserted rather than assumed.
 *
 * ===========================================================================
 * TWO DOCUMENTED JUDGEMENT CALLS, BOTH DELIBERATE
 * ===========================================================================
 * A. A REWARD ALREADY BELOW THE FLOOR IS NOT INFLATED. The floor is a floor on
 *    the GOVERNOR'S OUTPUT — the minimum it will not scale past — and never a
 *    reason to raise an authored reward upward. If `content.js` ever prices a
 *    mission at 2 CATT, the governor pays 2, not 3: a budget normaliser that
 *    can raise a payout is a minting function, and minting is `seasons.js`'s
 *    job to refuse. `floorSuppressed` reports this.
 * B. THE `floor` PARAMETER MAY RAISE THE POLICY FLOOR, NEVER LOWER IT. The
 *    founder's 3 / 5 / 10 are absolute; a caller may pass a stricter floor for
 *    a particular day, and a request to undercut the founder's value is
 *    silently clamped to it (and reported via `policyFloor`) rather than
 *    honoured. That is why the signature accepts a floor at all without the
 *    floor becoming a per-request knob.
 *
 * Pure module: no I/O, no clock, no randomness, no environment access, no store,
 * no network, no logging, no async.
 */

"use strict";

const { CATT_BASE_UNITS } = require("./contract-constants.js");

/* -------------------------------------------------------------------------- */
/* Scale and the season's daily budget                                          */
/* -------------------------------------------------------------------------- */

/**
 * Basis points in one whole multiple: 1.0x == 10000 bps. Same scale, same
 * meaning as `economics.js`'s `BPS_ONE` (a scale factor in the reward pipeline,
 * not a mirror of `BPS_DENOMINATOR`; the two are equal by value and are
 * different quantities).
 *
 * @type {bigint}
 */
const BPS_ONE = 10000n;

/** Days in one season — the divisor behind {@link DAILY_BUDGET_CATT}. */
const SEASON_DURATION_DAYS = 30n;

/** The season allocation the daily budget is derived from, in WHOLE CATT. */
const SEASON_ALLOCATION_CATT = 3_300_000n;

/**
 * The default daily budget in WHOLE CATT: 110,000 CATT per day.
 *
 *     3,300,000 CATT per 30-day season  /  30 days  =  110,000 CATT per day
 *
 * This is the per-day share of the founder's season allocation, spread evenly
 * because nothing in the season schedule says a day is worth more than another.
 * It is the DEFAULT, and every call may override it — a day whose real drain is
 * known can be given the budget that day actually had, and a caller that has
 * already computed the day's remaining pool can pass `remainingBudget` instead.
 *
 * @type {bigint}
 */
const DAILY_BUDGET_CATT = SEASON_ALLOCATION_CATT / SEASON_DURATION_DAYS;

/**
 * The default daily budget in 18-decimal base units, as a canonical decimal
 * string: `"110000000000000000000000"` (110,000 CATT, 24 digits).
 *
 * A string, because that is the form every amount crosses the API in, and it is
 * derived from `CATT_BASE_UNITS` rather than typed as a literal — the
 * `1000x`-class typo this codebase has already paid for once (see
 * `SEASON_ALLOCATION` in `seasons.js`) cannot be introduced by retyping digits.
 *
 * @type {string}
 */
const DAILY_BUDGET = (DAILY_BUDGET_CATT * CATT_BASE_UNITS).toString();

/* -------------------------------------------------------------------------- */
/* The hard floors                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The founder's per-difficulty HARD FLOORS, in 18-decimal base units:
 * EASY 3 CATT, MEDIUM 5 CATT, HARD 10 CATT.
 *
 * ABSOLUTE AND NOT CONFIGURABLE PER REQUEST. These are the "never below"
 * values: once the day's budget is being exceeded, proportional scaling may take
 * the reward as low as the floor and NO lower, however extreme the spike. They
 * are derived from `CATT_BASE_UNITS` for the same reason `DAILY_BUDGET` is.
 *
 * All three are strictly POSITIVE, which matters for the blackout branch: with a
 * positive floor, a day with `remaining === 0n` can always be told apart from a
 * day where a floor of zero would make a zero payout look approved.
 *
 * @type {Readonly<Record<string, bigint>>}
 */
const GOVERNOR_FLOORS = Object.freeze({
  EASY: 3n * CATT_BASE_UNITS,
  MEDIUM: 5n * CATT_BASE_UNITS,
  HARD: 10n * CATT_BASE_UNITS,
});

/**
 * The floor in WHOLE CATT, for humans and for tests. Not used by the arithmetic.
 *
 * @type {Readonly<Record<string, bigint>>}
 */
const GOVERNOR_FLOORS_CATT = Object.freeze({
  EASY: 3n,
  MEDIUM: 5n,
  HARD: 10n,
});

/** The difficulties the governor prices, keyed by `content.js`'s `DIFFICULTIES`. */
const GOVERNOR_DIFFICULTIES = Object.freeze(Object.keys(GOVERNOR_FLOORS));

/* -------------------------------------------------------------------------- */
/* Reasons                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every `reason` this module can return. A stable constant rather than a
 * sentence, so a caller (or a log parser) branches on it; the prose lives in the
 * docs and in `callerMustSurface`.
 *
 * @type {Readonly<Record<string, string>>}
 */
const GOVERNOR_REASONS = Object.freeze({
  /** The day's claims fit inside the budget: the reward is untouched. */
  WITHIN_DAILY_BUDGET: "GOVERNOR_WITHIN_DAILY_BUDGET",
  /** The budget is exceeded and the reward was scaled down proportionally. */
  SCALED_PROPORTIONALLY: "GOVERNOR_SCALED_PROPORTIONALLY",
  /** Proportional scaling would fall below the floor, so the floor was applied. */
  FLOOR_APPLIED: "GOVERNOR_FLOOR_APPLIED",
  /**
   * Even the floor does not fit in what is left of the day. The reward is NOT
   * approved; the caller is expected to surface the season hard cap.
   */
  BLACKOUT_SEASON_ALLOCATION_EXHAUSTED: "GOVERNOR_BLACKOUT_SEASON_ALLOCATION_EXHAUSTED",
});

/**
 * The error code the CALLER is expected to surface when `blackout` is true. It
 * is named here as a STRING, not imported: the governor does not depend on
 * `seasons.js`, and the pool that enforces the cap is the season pool, not the
 * daily budget.
 *
 * @type {string}
 */
const BLACKOUT_CALLER_ERROR_CODE = "SEASON_ALLOCATION_EXHAUSTED";

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every stable, machine-readable code this module can produce, following the
 * codebase's single error idiom (a plain `Error` carrying `.code` plus the
 * offending values as own fields — see `_seasonError` in seasons.js and
 * `_economicsError` in economics.js). No Error subclass: `instanceof` across
 * module reloads is a footgun, and `.name` + `.code` is what every other
 * failure in this backend is matched on.
 *
 * There is exactly ONE code, and it is deliberate. Every rejected input — a
 * negative spend, a non-numeric amount, an unknown difficulty, a malformed
 * reward string, a non-positive budget — is the same failure: the governor was
 * handed something it cannot price, and pricing it anyway would be a guess.
 * A guess in the reward path is a payout nobody can reconcile.
 *
 * @type {Readonly<Record<string, string>>}
 */
const GOVERNOR_ERRORS = Object.freeze({
  /**
   * An input is missing, malformed, non-numeric, negative where non-negative is
   * required, or zero where strictly positive is required. Thrown BEFORE any
   * arithmetic: a poisoned input must never be coerced into a payout, and a
   * silently zeroed or silently defaulted reward is indistinguishable from a
   * legitimate one at the call site.
   */
  INVALID_INPUT: "GOVERNOR_INVALID_INPUT",
});

/** The `name` every governor failure carries, so one check covers all codes. */
const GOVERNOR_ERROR_NAME = "GovernorError";

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds a governor error with a stable `.code` and the offending values as own
 * properties.
 *
 * @param {string} code One of `GOVERNOR_ERRORS`.
 * @param {string} message Short, secret-free message naming the cause.
 * @param {Object} [fields] Additional own properties.
 * @returns {Error} The typed error.
 */
function _governorError(code, message, fields) {
  const err = new Error(message);
  err.name = GOVERNOR_ERROR_NAME;
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
 * Coerces an amount to an EXACT `bigint` — a positive one, or a non-negative
 * one when `allowZero` — or throws.
 *
 * ACCEPTED, because all three are exact and lossless: a `bigint`; a decimal
 * digit string (`/^\d+$/`, so no sign, no point, no exponent — 18-decimal base
 * units cannot be fractional, and `"1e18"` would put a float back into an exact
 * pipeline); or a `number` that is a SAFE INTEGER, which is the only `number`
 * predicate that survives the 1e18 magnitudes this codebase uses.
 *
 * REJECTED: `NaN`, `Infinity`, a boolean, `null`, `undefined`, an object, a
 * negative value, a fraction, an exponent form, a `number` beyond
 * `Number.MAX_SAFE_INTEGER` (lossy by definition), and — unless `allowZero` —
 * `"0"`.
 *
 * @param {*} value Candidate amount.
 * @param {string} label Field name for the error message.
 * @param {boolean} allowZero Whether zero is a usable value here.
 * @returns {bigint} The exact amount.
 * @throws {Error} `GOVERNOR_INVALID_INPUT`.
 */
function _exactAmount(value, label, allowZero) {
  let exact = null;
  if (typeof value === "bigint") {
    exact = value;
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) exact = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    exact = BigInt(value.trim());
  }
  const usable = exact !== null && (allowZero ? exact >= 0n : exact > 0n);
  if (!usable) {
    throw _governorError(
      GOVERNOR_ERRORS.INVALID_INPUT,
      `governor: \`${label}\` must be ${allowZero ? "a non-negative" : "a strictly positive"}, ` +
        `exactly-representable integer amount of CATT base units — a decimal-digit string, a ` +
        `safe-integer number, or a bigint — got ${_describe(value)}. A value the governor ` +
        `cannot price exactly must fail loudly here: coercing it would turn a bad reading into a ` +
        `payout nobody can reconcile.`,
      { field: label, value: typeof value === "bigint" ? value.toString() : value }
    );
  }
  return exact;
}

/**
 * Validates the difficulty and returns the founder's absolute floor for it.
 *
 * @param {*} difficulty A `content.js` `DIFFICULTIES` value.
 * @returns {bigint} The policy floor in base units.
 * @throws {Error} `GOVERNOR_INVALID_INPUT` for a missing or unknown difficulty.
 */
function _policyFloorFor(difficulty) {
  if (typeof difficulty !== "string" || !Object.prototype.hasOwnProperty.call(GOVERNOR_FLOORS, difficulty)) {
    throw _governorError(
      GOVERNOR_ERRORS.INVALID_INPUT,
      `governor: \`difficulty\` must be one of ${GOVERNOR_DIFFICULTIES.join(", ")}, got ` +
        `${_describe(difficulty)}. The floor is keyed by difficulty, so an unknown difficulty has ` +
        `no floor to normalise against and guessing one would invent policy.`,
      { field: "difficulty", value: typeof difficulty === "string" ? difficulty : String(difficulty) }
    );
  }
  return GOVERNOR_FLOORS[difficulty];
}

/* -------------------------------------------------------------------------- */
/* The normaliser                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalises one requested reward against one day's budget.
 *
 * PURE: no store handle, no I/O, no clock, no network, no randomness, no
 * logging. Therefore it cannot persist anything, which is what makes it safe to
 * call from a preview as well as from the settlement path.
 *
 * THE DECISION ORDER, in exactly this sequence:
 *   1. VALIDATE. Every amount and the difficulty. Any nonsense throws
 *      `GOVERNOR_INVALID_INPUT` before a single byte of arithmetic — a bad
 *      input is never coerced into a payout.
 *   2. WITHIN BUDGET -> return the request UNCHANGED: `scaleBps === 10000n`,
 *      `floorApplied: false`, `blackout: false`, `approved: true`. This branch
 *      is checked FIRST and is the one that pays early users the full 12 / 20 /
 *      40; a governor that scaled "a little" on a healthy day would tax every
 *      early adopter to smooth a problem nobody has yet.
 *   3. OVER BUDGET -> scale proportionally:
 *          scaleBps = remaining * 10000n / requestedReward      (one floor)
 *          reward   = requestedReward * scaleBps / 10000n        (one floor)
 *   4. HARD FLOOR. If that reward is below the floor, RAISE it to the floor and
 *      set `floorApplied: true`. The day's emission may now exceed the daily
 *      budget — see the module header; that is the founder's explicit choice and
 *      it is why `wouldExceedBudget` is reported honestly rather than hidden.
 *   5. BLACKOUT, THE ABSOLUTE LAST RESORT. If even the floor does not fit in
 *      what is left of the day, set `blackout: true`, return the floor as the
 *      reward, and set `approved: false`. The caller is expected to surface
 *      `SEASON_ALLOCATION_EXHAUSTED` (see `callerMustSurface`); this module does
 *      not throw it, does not import `seasons.js`, and does not settle anything.
 *
 * A request already BELOW the floor is not inflated (see judgement call A in
 * the header): `floorSuppressed` reports that the floor did not apply because
 * the authored reward was smaller than it.
 *
 * @param {Object} params
 * @param {string} params.difficulty One of `EASY` / `MEDIUM` / `HARD`.
 * @param {*} params.requestedReward The authored reward, exactly.
 * @param {*} params.spentToday What the day has ALREADY committed. Zero is
 *   valid and is the early-user case; negative is not.
 * @param {*} [params.dailyBudget] The day's budget. Defaults to
 *   {@link DAILY_BUDGET}; strictly positive.
 * @param {*} [params.floor] A STRICTER floor for this call. It may raise the
 *   founder's floor and is clamped so it can never undercut it (judgement call
 *   B in the header).
 * @param {*} [params.remainingBudget] An explicit "what is left of today"
 *   reading, for a caller that has already computed it. Non-negative; overrides
 *   `dailyBudget - spentToday`.
 * @returns {Readonly<{
 *   difficulty: string,
 *   requestedReward: string,
 *   reward: string,
 *   scaleBps: bigint,
 *   floorApplied: boolean,
 *   floor: bigint,
 *   floorUsed: bigint,
 *   floorSuppressed: boolean,
 *   spentToday: string,
 *   dailyBudget: string,
 *   remainingBudget: string,
 *   wouldExceedBudget: boolean,
 *   blackout: boolean,
 *   approved: boolean,
 *   reason: string,
 *   callerMustSurface: string|undefined,
 *   breakdown: Readonly<Object>,
 * }>} A frozen decision. `reward` is a canonical decimal string; `scaleBps` is
 *   a `bigint` in `[0, 10000n]`.
 * @throws {Error} `GOVERNOR_INVALID_INPUT` for any unusable input.
 */
function governorReward({
  difficulty,
  requestedReward,
  spentToday,
  dailyBudget,
  floor,
  remainingBudget,
} = {}) {
  /* -- 1. VALIDATE. Nothing below this line can be reached with junk. -------- */
  const policyFloor = _policyFloorFor(difficulty);
  const requested = _exactAmount(requestedReward, "requestedReward", false);
  const spent = _exactAmount(spentToday, "spentToday", true);
  const budget =
    dailyBudget === undefined || dailyBudget === null
      ? BigInt(DAILY_BUDGET)
      : _exactAmount(dailyBudget, "dailyBudget", false);

  // A stricter floor may be raised per call; the founder's value is a floor on
  // the floor itself, so an attempt to undercut it is clamped, not honoured.
  const requestedFloor = floor === undefined || floor === null ? 0n : _exactAmount(floor, "floor", true);
  const resolvedFloor = requestedFloor > policyFloor ? requestedFloor : policyFloor;

  // What is left of today. Derived from the budget unless the caller already
  // knows, and CLAMPED AT ZERO: a day already over its budget has no headroom,
  // and `dailyBudget - spentToday` must never be allowed to go negative and
  // invert the comparison.
  const remaining =
    remainingBudget === undefined || remainingBudget === null
      ? budget > spent
        ? budget - spent
        : 0n
      : _exactAmount(remainingBudget, "remainingBudget", true);

  /* -- 2. WITHIN BUDGET: the request is returned BYTE-IDENTICAL. ----------- */
  const withinBudget = requested <= remaining;
  if (withinBudget) {
    return Object.freeze({
      difficulty,
      requestedReward: requested.toString(),
      reward: requested.toString(),
      scaleBps: BPS_ONE,
      floorApplied: false,
      floor: resolvedFloor,
      floorUsed: requested < resolvedFloor ? requested : resolvedFloor,
      floorSuppressed: requested < resolvedFloor,
      spentToday: spent.toString(),
      dailyBudget: budget.toString(),
      remainingBudget: remaining.toString(),
      wouldExceedBudget: false,
      blackout: false,
      approved: true,
      reason: GOVERNOR_REASONS.WITHIN_DAILY_BUDGET,
      callerMustSurface: undefined,
      breakdown: Object.freeze({
        requestedReward: requested.toString(),
        remainingBudget: remaining.toString(),
        scaleBps: BPS_ONE.toString(),
        rewardNumerator: requested.toString(),
        reward: requested.toString(),
      }),
    });
  }

  /* -- 3. PROPORTIONAL SCALE-DOWN, in basis points, with the two floors. ----- */
  // `remaining < requested` on this path, so `scaleBps < BPS_ONE`; `remaining`
  // is non-negative, so `scaleBps >= 0`. Both asserted rather than assumed.
  const scaleBps = (remaining * BPS_ONE) / requested;
  if (scaleBps < 0n || scaleBps > BPS_ONE) {
    throw _governorError(
      GOVERNOR_ERRORS.INVALID_INPUT,
      `governor: the proportional scale left [0, 10000n] (got ${scaleBps}). The scale is ` +
        `remaining * 10000n / requestedReward with 0 <= remaining < requestedReward, so this is ` +
        `unreachable; a breach means the arithmetic above was edited.`,
      { field: "scaleBps", value: scaleBps.toString() }
    );
  }
  const scaled = (requested * scaleBps) / BPS_ONE;

  /* -- 4. THE HARD FLOOR: never below it. ---------------------------------- */
  // Judgement call A: a request already under the floor is NOT raised.
  const floorSuppressed = requested < resolvedFloor;
  const floorUsed = floorSuppressed ? requested : resolvedFloor;
  const floored = scaled < floorUsed;
  const reward = floored ? floorUsed : scaled;

  /* -- 5. BLACKOUT: the absolute last resort. ------------------------------ */
  const blackout = floorUsed > remaining;

  return Object.freeze({
    difficulty,
    requestedReward: requested.toString(),
    reward: reward.toString(),
    scaleBps,
    floorApplied: floored,
    floor: resolvedFloor,
    floorUsed,
    floorSuppressed,
    spentToday: spent.toString(),
    dailyBudget: budget.toString(),
    remainingBudget: remaining.toString(),
    /** True when this claim, at the request, does not fit in what is left. */
    wouldExceedBudget: true,
    blackout,
    /** `false` ONLY when blacked out: the reward is priced but not endorsed. */
    approved: !blackout,
    reason: blackout
      ? GOVERNOR_REASONS.BLACKOUT_SEASON_ALLOCATION_EXHAUSTED
      : floored
        ? GOVERNOR_REASONS.FLOOR_APPLIED
        : GOVERNOR_REASONS.SCALED_PROPORTIONALLY,
    /** The season hard cap the CALLER should surface once `blackout` is true. */
    callerMustSurface: blackout ? BLACKOUT_CALLER_ERROR_CODE : undefined,
    breakdown: Object.freeze({
      requestedReward: requested.toString(),
      remainingBudget: remaining.toString(),
      /** `remaining * 10000n`, before the single division producing `scaleBps`. */
      scaleNumerator: (remaining * BPS_ONE).toString(),
      scaleBps: scaleBps.toString(),
      /** The proportionally scaled reward, BEFORE the floor was considered. */
      scaledReward: scaled.toString(),
      floorApplied: floored,
      floorUsed: floorUsed.toString(),
      reward: reward.toString(),
      /** True when the floor pushed the day's emission past its budget. */
      emissionOvershootsDailyBudget: reward > remaining,
    }),
  });
}

module.exports = {
  // Scale.
  BPS_ONE,
  // The daily budget.
  SEASON_DURATION_DAYS,
  SEASON_ALLOCATION_CATT,
  DAILY_BUDGET_CATT,
  DAILY_BUDGET,
  // The floors.
  GOVERNOR_FLOORS,
  GOVERNOR_FLOORS_CATT,
  GOVERNOR_DIFFICULTIES,
  // Reasons.
  GOVERNOR_REASONS,
  BLACKOUT_CALLER_ERROR_CODE,
  // Errors.
  GOVERNOR_ERRORS,
  GOVERNOR_ERROR_NAME,
  // The normaliser.
  governorReward,
};