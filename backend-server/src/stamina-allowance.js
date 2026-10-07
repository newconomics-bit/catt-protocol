/**
 * CATT Protocol — the DAILY FREE-STAMINA ALLOWANCE.
 *
 * WHAT IT IS: a user is granted 30 stamina POINTS per WIB BUSINESS DAY (the
 * 04:00 WIB / 21:00-UTC rollover owned by `reset-schedule.js`), once per day,
 * tracked in an off-chain per-day ledger. That is the entire mechanism. There is
 * no token minted, no balance held, no claim signed, no chain touched.
 *
 * ===========================================================================
 * THE UNIT IS POINTS, AND THIS MODULE NEVER KNOWS WHAT A POINT IS WORTH
 * ===========================================================================
 * Stamina is UNITLESS (`StakingManager.sol` states outright that it "is
 * unitless and has no monetary value"; `STAMINA_PER_STAKE = 50`). The shipped
 * mission costs are 10 / 20 / 30 points and the daily spend cap is 50 points.
 *
 * Nothing in this file converts points into anything. There is no scale factor,
 * no multiplier and no decimals: 30 points is the integer 30, written to the
 * ledger as the canonical decimal string `"30"`. A previous draft of this
 * feature carried an 18-decimal scale factor and multiplied the allowance by it,
 * which made "30 free stamina" mean 30 x (10^18) units of a thing stamina is
 * not measured in — the same unit conflation that once priced a 10-point mission
 * at 10^18 base units and made every claim unsettleable
 * (`test/growth-store.test.js`, section 1). No scale-factor literal appears
 * anywhere below, by construction, and the tests assert its absence from this
 * source file.
 *
 * ===========================================================================
 * REPORTED DISCREPANCY — 30 POINTS FUNDS THREE EASY MISSIONS, NOT ONE
 * ===========================================================================
 * The founder described the daily grant as "enough for one easy mission". At
 * the shipped costs it is not:
 *
 *     3 x 10 = 30   three EASY missions
 *     1 x 20 + 1 x 10 = 30   one MEDIUM plus one EASY
 *     1 x 30 = 30   one HARD mission
 *
 * So the implemented 30 points is three times the founder's stated intent, and
 * the cheapest mission costs a THIRD of the daily allowance rather than all of
 * it. This is REPORTED, not silently reconciled: the instruction was to
 * implement 30 exactly, so 30 is what `FREE_STAMINA_PER_DAY` is. If the intent
 * really was "one easy mission", the value is 10 — a one-character change to a
 * single exported constant, deliberately NOT made here because changing an
 * economic parameter without the founder's word is how a 30x error like the
 * season-allocation typo happens.
 *
 * ===========================================================================
 * HOW IT INTERACTS WITH `DEFAULT_DAILY_STAMINA_CAP = 50`
 * ===========================================================================
 * The 50 is a cap on stamina SPENT per business day, and the 30 is a grant of stamina
 * AVAILABLE. They are different quantities and they compose as:
 *
 *     daily staked stamina (say 50 from one stake) + 30 free
 *       = 80 points available on day 1 of the season
 *       -> but no more than 50 of them can be SPENT that day
 *
 * So the free grant is what makes a stamina-less, staking-less newcomer able to
 * play at all on day one, and it is BOUNDED BY the same 50-point spend cap as
 * everyone else: the free allowance buys ACCESS to the day's first missions, it
 * does not buy a way around the day's ceiling. `DAILY_SPEND_CAP_POINTS` is
 * exported here so the two numbers are always read side by side, and the
 * threshold above which the free grant stops increasing the day's reachable
 * missions (50, the cap itself) falls out of the arithmetic rather than being a
 * second policy.
 *
 * ===========================================================================
 * WHAT THIS IS NOT, AND THE HONEST LIMIT OF ITS ENFORCEMENT
 * ===========================================================================
 * THIS IS AN OFF-CHAIN LEDGER AND NOTHING MORE. Concretely, and this is the
 * part that must not be misread:
 *
 *   - NO `ethers`, NO provider, NO network, NO `process.env`, NO private key.
 *     Requiring `./storage` pulls in `better-sqlite3` through the SQLite adapter
 *     only when an adapter is selected; this module itself opens nothing.
 *   - NO exported function with a mint, pay, settle, consume or burn verb.
 *     The exports are a constant, two read functions and one GRANT. There is no
 *     `mintFreeStamina`, no `consumeStamina`, no `settle` — because this module
 *     has no power to do any of those things.
 *   - A user holding a full 30-point grant STILL CANNOT settle a claim. The
 *     chain check is untouched and still binding: `StakingManager.consumeStamina(user, staminaCost)`
 *     must succeed on-chain, or the claim reverts there regardless of what this
 *     ledger says. The grant tells the JUDGE how much free stamina a user is
 *     owed; it cannot make the contract spend stamina that does not exist.
 *   - THEREFORE: because this is off-chain, IT IS NOT INDEPENDENTLY ENFORCED
 *     ON-CHAIN. Nothing on the chain knows this ledger exists, so it cannot be
 *     audited against the chain, cannot be settled atomically with a claim, and
 *     cannot be made the authority on whether a user may spend stamina. If the
 *     Judge process that writes this ledger is wrong, the chain will still
 *     refuse the spend — the failure mode is a user who believes they have free
 *     stamina and does not, not a user who spends stamina they do not have.
 *     That direction of failure is the safe one, and it is a property of WHERE
 *     the check is, not of how carefully this file is written.
 *
 *   MAKING THE GRANT ON-CHAIN IS A SEPARATE FUTURE WAVE and is out of scope
 *   here: it needs a contract change (a free-stamina accrual that `consumeStamina`
 *   can draw on) and therefore a redeploy, and the contracts are FROZEN for
 *   this wave. This module is deliberately shaped so that wave can read it —
 *   same day key, same units, same idempotency rule — instead of replacing it.
 *
 * ===========================================================================
 * THE GRANT RULE, IN FULL
 * ===========================================================================
 *   ONCE per `dayKey`, NOT STACKABLE within a day, available again on a NEW
 *   `dayKey`, and day A's grant never leaks into day B. If part of the day's
 *   allowance was already granted, only the REMAINDER is granted, so the day's
 *   total can never exceed 30.
 *
 *   The remainder rule is why the ledger ACCUMULATES rather than being written
 *   with the full 30 every call: a naive "grant 30 on every call, record it as
 *   30" would hand a user 300 points a day after ten calls, and a naive
 *   "record it as 30, idempotent" would lose a legitimately partial grant. The
 *   store's `recordFreeStaminaGrant` ADDS, and this module computes the delta.
 *
 *   NOT STACKABLE also means not stackable across the other direction: two calls
 *   on the same day must not produce two 30-point grants, which is the same
 *   statement as "the day's total never exceeds 30".
 */

"use strict";

const { assertStoreShape, normalizeDayKey } = require("./storage");
const { DEFAULT_DAILY_STAMINA_CAP, dayKeyFor } = require("./content");

/* -------------------------------------------------------------------------- */
/* The allowance                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Free stamina granted per WIB BUSINESS DAY, in POINTS.
 *
 * `30`, the integer. See the module header for the reported discrepancy: at the
 * shipped costs of 10 / 20 / 30 points this funds three easy missions, one hard
 * mission, or one medium plus one easy — not "one easy mission" as originally
 * described. Implemented as instructed; reported rather than reconciled.
 *
 * @type {bigint}
 */
const FREE_STAMINA_PER_DAY = 30n;

/**
 * The daily cap on stamina SPENT, in POINTS — the same `50` as
 * `content.js#DEFAULT_DAILY_STAMINA_CAP`, re-exported from here.
 *
 * It is named explicitly rather than left to the reader to remember, because the
 * pairing is the whole design: the free grant is 30 points AVAILABLE, the cap is
 * 50 points SPENT, and the free grant can never lift a user above that ceiling.
 *
 * @type {number}
 */
const DAILY_SPEND_CAP_POINTS = DEFAULT_DAILY_STAMINA_CAP;

/**
 * Every stable, machine-readable error code this module can produce.
 *
 * @type {Readonly<Record<string, string>>}
 */
const STAMINA_ALLOWANCE_ERRORS = Object.freeze({
  /** A caller argument is missing or is not a non-negative integer point count. */
  INVALID_AMOUNT: "FREE_STAMINA_INVALID_AMOUNT",
  /** `now` could not be turned into a UTC day key. */
  INVALID_INSTANT: "FREE_STAMINA_INVALID_INSTANT",
  /** The day key is not a real `YYYY-MM-DD` UTC calendar day. */
  INVALID_DAY_KEY: "FREE_STAMINA_INVALID_DAY_KEY",
});

/** The `name` on every error this module throws. */
const STAMINA_ALLOWANCE_ERROR_NAME = "FreeStaminaAllowanceError";

/**
 * Builds a typed allowance error carrying a stable `.code`.
 *
 * @param {string} code One of {@link STAMINA_ALLOWANCE_ERRORS}.
 * @param {string} message Short, operator-readable message.
 * @param {Object} [fields] Extra own properties.
 * @returns {Error} The typed error.
 */
function _allowanceError(code, message, fields) {
  const err = new Error(message);
  err.name = STAMINA_ALLOWANCE_ERROR_NAME;
  err.code = code;
  if (fields) Object.assign(err, fields);
  return err;
}

/**
 * Coerces a point count to an exact `BigInt`.
 *
 * `Number` is accepted here, unlike in `seasons.js`, and the difference is the
 * unit: points are single- and double-digit integers and are never scaled, so
 * there is no precision to lose below 2^53 and refusing `30` would be
 * unfriendly theatre. Anything non-integral, negative, non-finite or
 * non-numeric is refused — points are indivisible, and a fractional allowance is
 * not a thing the contract could ever spend.
 *
 * @param {*} value Candidate point count.
 * @param {string} label Field name, for the error message.
 * @returns {bigint} The exact point count.
 * @throws {Error} `FREE_STAMINA_INVALID_AMOUNT` if `value` is not a
 *   non-negative integer.
 */
function _toPoints(value, label) {
  let points = value;
  if (typeof points === "string" && /^\d+$/.test(points.trim())) {
    points = BigInt(points.trim());
  } else if (typeof points === "bigint") {
    points = value;
  } else if (typeof points === "number") {
    points = Number.isSafeInteger(points) && points >= 0 ? BigInt(points) : null;
  } else {
    points = null;
  }
  if (points === null || points < 0n) {
    throw _allowanceError(
      STAMINA_ALLOWANCE_ERRORS.INVALID_AMOUNT,
      `${label} must be a non-negative integer number of stamina POINTS, got ` +
        `${typeof value === "string" ? JSON.stringify(value) : String(value)}.`
    );
  }
  return points;
}

/**
 * Resolves the UTC day key a call is about.
 *
 * `now` may be a `Date`, epoch milliseconds, or an already-formed `YYYY-MM-DD`
 * string (handy for a replay). A `YYYY-MM-DD` string is passed through
 * `normalizeDayKey`, which checks it names a REAL UTC calendar day — `2026-02-30`
 * is a well-formed string no day ever has, and a ledger bucket keyed by it would
 * be a bucket nothing can roll over into.
 *
 * @param {Date|number|string} now The instant, or the day key itself.
 * @returns {string} Canonical `YYYY-MM-DD`.
 * @throws {Error} `FREE_STAMINA_INVALID_INSTANT` or `FREE_STAMINA_INVALID_DAY_KEY`.
 */
function _resolveDayKey(now) {
  if (typeof now === "string") {
    try {
      return normalizeDayKey(now);
    } catch (cause) {
      throw _allowanceError(
        STAMINA_ALLOWANCE_ERRORS.INVALID_DAY_KEY,
        `free stamina: ${cause.message}`,
        { dayKey: now }
      );
    }
  }
  // The type is checked HERE rather than left to `dayKeyFor`, which coerces
  // whatever it is given with `Number(...)`. That coercion makes `[]` the
  // instant 0 and `["2026-01-02"]` the NaN of `Date("2026-01-02")`, neither of
  // which is a caller's intent; refusing the types outright is the honest
  // reading of `Date | number | YYYY-MM-DD`.
  const isInstant = now instanceof Date || (typeof now === "number" && Number.isFinite(now));
  if (!isInstant) {
    throw _allowanceError(
      STAMINA_ALLOWANCE_ERRORS.INVALID_INSTANT,
      `free stamina: \`now\` must be a Date, epoch milliseconds, or a YYYY-MM-DD day key, got ` +
        `${typeof now}. The clock is injected, never read inside this module.`
    );
  }
  try {
    return dayKeyFor(now);
  } catch (cause) {
    throw _allowanceError(
      STAMINA_ALLOWANCE_ERRORS.INVALID_INSTANT,
      `free stamina: ${cause.message} The clock is injected, never read inside this module.`
    );
  }
}

/**
 * Resolves and validates the caller's wallet address.
 *
 * @param {*} userAddress Candidate address.
 * @returns {string} Lowercase address, matching the store's ledger key form.
 * @throws {Error} `FREE_STAMINA_INVALID_AMOUNT` if absent.
 */
function _resolveUser(userAddress) {
  const user = String(userAddress ?? "").trim().toLowerCase();
  if (user === "") {
    throw _allowanceError(
      STAMINA_ALLOWANCE_ERRORS.INVALID_AMOUNT,
      "free stamina: userAddress is required."
    );
  }
  return user;
}

/**
 * The read-only view of a user's free-stamina position for one day.
 *
 * WRITES NOTHING. Safe to call from a screen that polls.
 *
 * `remaining` is `allowance - granted`, floored at zero — so it is `0` on a day
 * that has already handed out all 30 points, and it never goes negative even if
 * an operator has over-granted. `exhausted` is the same fact as a boolean,
 * present so a caller does not have to compare decimal strings to learn whether
 * a day is spent.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params
 * @param {string} params.userAddress Wallet address.
 * @param {Date|number|string} params.now The instant, or the day key itself.
 * @returns {Promise<Readonly<Object>>} `{ userAddress, dayKey, allowance,
 *   granted, remaining, exhausted, dailySpendCapPoints }` — every point figure a
 *   canonical decimal string.
 */
async function freeStaminaAllowance(store, { userAddress, now } = {}) {
  assertStoreShape(store);
  const user = _resolveUser(userAddress);
  const dayKey = _resolveDayKey(now);
  const row = await store.getFreeStaminaGranted({ userAddress: user, dayKey });
  const granted = _toPoints(row.granted, "granted");
  const allowance = FREE_STAMINA_PER_DAY;
  const remaining = granted >= allowance ? 0n : allowance - granted;
  return Object.freeze({
    userAddress: user,
    dayKey,
    allowance: allowance.toString(),
    granted: granted.toString(),
    remaining: remaining.toString(),
    exhausted: remaining === 0n,
    // Carried alongside so a caller never has to reach into content.js to
    // remember that the day's SPEND ceiling is 50 points regardless.
    dailySpendCapPoints: DAILY_SPEND_CAP_POINTS,
  });
}

/**
 * How many free stamina points the user can still be granted today.
 *
 * The narrowest possible read: one decimal string, `"30"` on a fresh day and
 * `"0"` once the day's grant is used up.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params See {@link freeStaminaAllowance}.
 * @returns {Promise<string>} Exact decimal string of points.
 */
async function freeStaminaRemaining(store, { userAddress, now } = {}) {
  const view = await freeStaminaAllowance(store, { userAddress, now });
  return view.remaining;
}

/**
 * Grants the day's free stamina, up to the day's allowance.
 *
 * IDEMPOTENT WITHIN A DAY BY ARITHMETIC, NOT BY A FLAG: the day's ledger total
 * is read first and only the REMAINDER is written, so the day's total can never
 * pass 30 no matter how many times this is called, and a partial prior grant is
 * completed rather than either duplicated or discarded.
 *
 * A call with nothing left to give WRITES NOTHING AT ALL — not a zero row, not a
 * timestamp bump. The day key `(user, day)` already exists and already carries
 * the full 30; writing "0" to it would be a no-op with a write, and this module
 * has no reason to touch disk when the answer is already recorded. The returned
 * `granted` is `"0"` and `wrote` is `false`, so the caller can tell "gave you
 * nothing" from "gave you something" without inferring it.
 *
 * `amount` may cap the grant (`amount: 10` on a fresh day grants 10 and leaves
 * 20 for a later call the same day). It is a REQUEST CEILING, never a way to
 * exceed the day: `grant = min(requested, remaining)`. Omitting it — passing
 * `undefined`, and ONLY `undefined` — grants the whole remaining allowance,
 * which is the common case. An explicit `null` is REFUSED rather than read as
 * "omitted": a null in a JSON body is a client saying something about the value,
 * and quietly treating it as the default would make a malformed request look
 * like a successful full grant.
 *
 * IT IS NOT A MINT AND NOT A PAYMENT. It records what the user is OWED free
 * stamina for the day in an off-chain ledger. It creates no balance, spends
 * nothing, and does not weaken the on-chain `StakingManager.consumeStamina`
 * check, which must still succeed before any claim settles. See the module
 * header for why that limit is honest rather than a caveat.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params
 * @param {string} params.userAddress Wallet address.
 * @param {Date|number|string} params.now The instant, or the day key itself.
 * @param {number|string|bigint} [params.amount] Optional ceiling on this grant,
 *   in points.
 * @returns {Promise<Readonly<Object>>} `{ userAddress, dayKey, granted,
 *   dayTotal, remaining, exhausted, wrote }` — `granted` is THIS call's points,
 *   `dayTotal` is the day's new (or unchanged) total.
 * @throws {Error} `FREE_STAMINA_INVALID_AMOUNT` for a malformed `amount`.
 */
async function grantFreeStamina(store, { userAddress, now, amount } = {}) {
  assertStoreShape(store);
  const view = await freeStaminaAllowance(store, { userAddress, now });
  const remaining = _toPoints(view.remaining, "remaining");
  const requested = amount === undefined ? remaining : _toPoints(amount, "amount");
  const grant = requested < remaining ? requested : remaining;

  if (grant === 0n) {
    // Nothing left to give today (or a zero was explicitly requested): the
    // day's total is already correct, so write NOTHING.
    return Object.freeze({
      userAddress: view.userAddress,
      dayKey: view.dayKey,
      granted: "0",
      dayTotal: view.granted,
      remaining: view.remaining,
      exhausted: true,
      wrote: false,
      dailySpendCapPoints: DAILY_SPEND_CAP_POINTS,
    });
  }

  const row = await store.recordFreeStaminaGrant({
    userAddress: view.userAddress,
    dayKey: view.dayKey,
    amount: grant.toString(),
  });
  const dayTotal = _toPoints(row.granted, "granted");
  return Object.freeze({
    userAddress: view.userAddress,
    dayKey: view.dayKey,
    granted: grant.toString(),
    dayTotal: dayTotal.toString(),
    remaining: (dayTotal >= FREE_STAMINA_PER_DAY ? 0n : FREE_STAMINA_PER_DAY - dayTotal).toString(),
    exhausted: dayTotal >= FREE_STAMINA_PER_DAY,
    wrote: true,
    dailySpendCapPoints: DAILY_SPEND_CAP_POINTS,
  });
}

module.exports = {
  /** 30 stamina POINTS per UTC day. Not CATT, not scaled, not per mission. */
  FREE_STAMINA_PER_DAY,
  /** 50 — `content.js#DEFAULT_DAILY_STAMINA_CAP`, the daily SPENT ceiling. */
  DAILY_SPEND_CAP_POINTS,
  STAMINA_ALLOWANCE_ERRORS,
  STAMINA_ALLOWANCE_ERROR_NAME,
  /** Read-only. Never writes. */
  freeStaminaAllowance,
  /** Read-only. Never writes. One decimal string of points. */
  freeStaminaRemaining,
  /** Writes at most the day's REMAINDER. Not a mint, not a payment. */
  grantFreeStamina,
};
