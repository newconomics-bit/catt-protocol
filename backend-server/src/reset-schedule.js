/**
 * CATT Protocol — THE "GENSHIN RULE": EVERY DAILY RESET AT 04:00 WIB.
 *
 * ===========================================================================
 * THE PRODUCT DECISION, IN ONE PARAGRAPH
 * ===========================================================================
 * The Judge and the database run in UTC. The PLAYERS do not. The founder has
 * fixed the player-facing timezone as WIB (UTC+7, Asia/Jakarta) and requires
 * EVERY daily rollover — the stamina refresh, the streak calculation and (from
 * the next wave) the daily governor budget — to happen at 04:00 WIB. 04:00 WIB
 * is 21:00 UTC of the PREVIOUS calendar day. So the whole backend agrees on one
 * instant: `21:00:00 UTC`.
 *
 * ===========================================================================
 * WHY THE 21:00 UTC CONSTANT IS HARDCODED, AND WHY IT IS NOT A BUG
 * ===========================================================================
 * WIB IS UTC+7 ALL YEAR, WITH NO DAYLIGHT-SAVING TRANSITION. Indonesia has
 * never observed DST in the modern era, so WIB is a FIXED offset and
 * `04:00 WIB === 21:00 UTC previous day` holds on every single day of every
 * year, forever. That is the ONLY reason the hour below is a literal.
 *
 * DO NOT "FIX" THIS INTO A `Date`-BASED LOCAL-TIME COMPUTATION. A future
 * reader will be tempted: it looks like hardcoding an offset is a bug, and
 * usually it is. Here it is not, and the general rule is worth stating so the
 * temptation is met with the counter-argument instead of a rewrite:
 *
 *   - For WIB, a fixed offset is EXACT. There is no DST date to look up, no
 *     IANA tz database (`Intl`/`Temporal`/ICU) needed at runtime, and no
 *     possibility of a mid-flight change of government changing the answer.
 *   - For almost any OTHER timezone the same hardcoding would be WRONG: Europe
 *     and North America shift their UTC offset across DST (a 21:00 UTC rollover
 *     is 22:00 or 23:00 local for part of the year, so "04:00 local" silently
 *     becomes 03:00 or 04:00), and the Southern Hemisphere has the transition
 *     on the opposite date. If the audience is ever changed, the correct move is
 *     to replace this module with a real timezone-aware computation — NOT to
 *     tweak the literal.
 *   - A local-time computation would also make the backend depend on the HOST's
 *     timezone, which is precisely the bug the old UTC day key was written to
 *     avoid (see `content.js#dayKeyFor`). Two Judges in two regions would then
 *     write different ledger buckets for the same instant.
 *
 * ===========================================================================
 * WHAT "BUSINESS DAY" MEANS HERE, EXACTLY
 * ===========================================================================
 * A WIB business day runs from 21:00:00 UTC on one UTC calendar date to
 * 21:00:00 UTC on the NEXT one. Concretely, for `2026-01-02`:
 *
 *     2026-01-01T20:59:59Z  (2026-01-02 03:59:59 WIB) -> business day 2026-01-02
 *     2026-01-01T21:00:00Z  (2026-01-02 04:00:00 WIB) -> business day 2026-01-03
 *
 * So the boundary is HALF-OPEN `[21:00 UTC, 21:00 UTC next day)`: at exactly
 * 21:00:00 UTC the day has ALREADY rolled over. One second earlier it has not.
 *
 * The player-visible consequence is the whole point of this module: a user
 * reading at 23:55 WIB on the 2nd (16:55 UTC on the 2nd) is still on business
 * day `2026-01-02` — the same day they were on at 09:00 WIB — so a graded
 * completion at 23:55 WIB does NOT reset their streak. Under the old 00:00 UTC
 * rule, that user had already "lost" their day by breakfast.
 *
 * ===========================================================================
 * UNITS: EPOCH SECONDS, NEVER MILLISECONDS
 * ===========================================================================
 * Every instant-taking export here takes SECONDS since the Unix epoch, as a
 * finite number. That is the unit the contracts, `seasons.js` and every claim
 * signature use. `content.js#dayKeyFor` is the one boundary that speaks
 * milliseconds (`Date` / epoch ms) and it converts here.
 *
 * The confusion is guarded, not documented-and-hoped-for: a value large enough
 * to only make sense as MILLISECONDS is rejected outright rather than silently
 * resolving to a 1970 business day. `1767225600000` (2026-01-01T00:00:00Z in
 * ms) throws `RESET_INVALID_INSTANT`; it does NOT quietly produce
 * `"1970-01-21"` or `"1970-01-01"`, which is the failure that would be
 * invisible in a log and ruinous in a ledger.
 *
 * PURE: no clock, no environment, no I/O, no randomness. The instant is always
 * an argument, exactly as in `content.js`.
 */

"use strict";

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/**
 * WIB's offset from UTC, in hours. Fixed, with no DST transition — see the
 * module header for why hardcoding this is correct HERE and wrong almost
 * everywhere else.
 *
 * @type {number}
 */
const WIB_OFFSET_HOURS = 7;

/**
 * The UTC hour at which every WIB day rolls over: 21:00 UTC.
 *
 * 21:00 UTC + 7 hours = 04:00 of the FOLLOWING UTC calendar date, which is
 * 04:00 WIB. This is the single instant every daily reset keys off.
 *
 * @type {number}
 */
const DAILY_RESET_UTC_HOUR = 21;

/** {@link WIB_OFFSET_HOURS} in seconds. */
const WIB_OFFSET_SECONDS = WIB_OFFSET_HOURS * 3600;

/**
 * {@link DAILY_RESET_UTC_HOUR} expressed in seconds from UTC midnight — i.e. how
 * far into a UTC day the rollover sits. 21 * 3600. Named "offset in day" rather
 * than "seconds in day" so it can never be confused with {@link SECONDS_PER_DAY}.
 */
const RESET_OFFSET_IN_DAY = DAILY_RESET_UTC_HOUR * 3600;

/** Seconds in one day. Exact integer; every day is 86400 s in a fixed-offset zone. */
const SECONDS_PER_DAY = 86400;

/**
 * The largest instant accepted as SECONDS.
 *
 * 1e11 seconds is 1973-03-03 … year 5138. It is chosen because the smallest
 * plausible epoch-MILLISECONDS value for a real date (~1e12 for 2001) is an
 * order of magnitude above it, so anything above this threshold is
 * milliseconds with certainty rather than by guesswork.
 *
 * @type {number}
 */
const MAX_EPOCH_SECONDS = 1e11;

/**
 * Stable, machine-readable error codes. Frozen, never renamed: they are part of
 * the backend's contract with its own callers and with the test suite.
 *
 * @type {Readonly<Record<string, string>>}
 */
const RESET_ERRORS = Object.freeze({
  /** The instant is missing, non-numeric, negative, non-finite, or in milliseconds. */
  INVALID_INSTANT: "RESET_INVALID_INSTANT",
  /** A day key is not a real `YYYY-MM-DD` calendar date (e.g. `2026-02-30`). */
  INVALID_DAY_KEY: "RESET_INVALID_DAY_KEY",
  /** A month key is not a real `YYYY-MM` calendar month (e.g. `2026-13`). */
  INVALID_MONTH_KEY: "RESET_INVALID_MONTH_KEY",
});

/** The `name` carried by every error this module throws. */
const RESET_ERROR_NAME = "ResetScheduleError";

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the module's typed error: a real `TypeError` (so every caller and test
 * that guards an argument can catch `TypeError`, the conventional choice for
 * bad input in this codebase) carrying a stable `.code`.
 *
 * @param {string} code One of {@link RESET_ERRORS}.
 * @param {string} message Short, operator-readable message.
 * @param {Object} [fields] Extra own properties (e.g. `{ value }`).
 * @returns {TypeError} The typed error.
 */
function _resetError(code, message, fields) {
  const err = new TypeError(message);
  err.name = RESET_ERROR_NAME;
  err.code = code;
  if (fields) Object.assign(err, fields);
  return err;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validates and returns an instant in EPOCH SECONDS.
 *
 * Refused, with {@link RESET_ERRORS.INVALID_INSTANT}: `undefined`, `null`,
 * `NaN`, `Infinity`, a non-number (a string, a `Date`, an object — this module
 * takes seconds, not milliseconds and not a `Date`), a negative value, a
 * non-integer value, and any value at or above {@link MAX_EPOCH_SECONDS}, which
 * is the milliseconds guard.
 *
 * @param {*} value Candidate instant, in epoch SECONDS.
 * @param {string} [label] Function name for the error message.
 * @returns {number} The same value, as a safe integer.
 * @throws {TypeError} If `value` is not a non-negative integer epoch-seconds value.
 */
function epochSeconds(value, label = "instant") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw _resetError(
      RESET_ERRORS.INVALID_INSTANT,
      `${label} must be a finite NUMBER of epoch SECONDS (not milliseconds, not a Date, ` +
        `not a string), got ${value === null ? "null" : typeof value}.`,
      { value }
    );
  }
  if (value < 0) {
    throw _resetError(
      RESET_ERRORS.INVALID_INSTANT,
      `${label} must be a non-negative epoch-seconds value, got ${value}.`,
      { value }
    );
  }
  if (value >= MAX_EPOCH_SECONDS) {
    throw _resetError(
      RESET_ERRORS.INVALID_INSTANT,
      `${label} looks like epoch MILLISECONDS (${value} >= ${MAX_EPOCH_SECONDS}). This module ` +
        `takes epoch SECONDS; passing milliseconds would silently resolve to a 1970 business day.`,
      { value }
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw _resetError(
      RESET_ERRORS.INVALID_INSTANT,
      `${label} must be a whole number of epoch seconds, got ${value}.`,
      { value }
    );
  }
  return value;
}

/**
 * Parses a `YYYY-MM-DD` string and asserts it names a REAL calendar date.
 *
 * Shape AND calendar: `2026-02-30` and `2025-02-29` are well-formed strings
 * that no day ever names. A ledger bucket keyed by one is a bucket nothing can
 * roll over into, so it is refused here rather than discovered later as a
 * streak that mysteriously never advances.
 *
 * @param {*} value Candidate day key.
 * @param {string} [label] Function name for the error message.
 * @returns {{ year: number, month: number, day: number }} The parsed parts.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if `value` is not a
 *   real `YYYY-MM-DD` calendar date.
 */
function parseDayKey(value, label = "dayKey") {
  if (typeof value !== "string") {
    throw _resetError(
      RESET_ERRORS.INVALID_DAY_KEY,
      `${label} must be a caller-supplied YYYY-MM-DD string, got ${value === null ? "null" : typeof value}.`,
      { value }
    );
  }
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw _resetError(
      RESET_ERRORS.INVALID_DAY_KEY,
      `${label} must be a YYYY-MM-DD string, got ${JSON.stringify(value)}.`,
      { value }
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    throw _resetError(
      RESET_ERRORS.INVALID_DAY_KEY,
      `${label} ${JSON.stringify(value)} is not a real calendar day.`,
      { value }
    );
  }
  return { year, month, day };
}

/**
 * Parses a `YYYY-MM` string and asserts it names a REAL calendar month.
 *
 * @param {*} value Candidate month key.
 * @param {string} [label] Function name for the error message.
 * @returns {{ year: number, month: number }} The parsed parts.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_MONTH_KEY} if `value` is not a
 *   real `YYYY-MM` calendar month.
 */
function parseMonthKey(value, label = "monthKey") {
  if (typeof value !== "string") {
    throw _resetError(
      RESET_ERRORS.INVALID_MONTH_KEY,
      `${label} must be a caller-supplied YYYY-MM string, got ${value === null ? "null" : typeof value}.`,
      { value }
    );
  }
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  if (!match) {
    throw _resetError(
      RESET_ERRORS.INVALID_MONTH_KEY,
      `${label} must be a YYYY-MM string, got ${JSON.stringify(value)}.`,
      { value }
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw _resetError(
      RESET_ERRORS.INVALID_MONTH_KEY,
      `${label} ${JSON.stringify(value)} is not a real calendar month.`,
      { value }
    );
  }
  return { year, month };
}

/**
 * Renders a UTC instant as `YYYY-MM-DD` from its calendar parts.
 *
 * @param {number} utcMs Milliseconds since the epoch.
 * @returns {string} `YYYY-MM-DD`.
 */
function _isoDay(utcMs) {
  const date = new Date(utcMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Renders a UTC instant as `YYYY-MM` from its calendar parts.
 *
 * @param {number} utcMs Milliseconds since the epoch.
 * @returns {string} `YYYY-MM`.
 */
function _isoMonth(utcMs) {
  const date = new Date(utcMs);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The UTC instant at which the given business day STARTS, i.e. 21:00 UTC on the
 * UTC calendar date immediately BEFORE `dayKey`.
 *
 * This is the inverse of {@link wibDayKey}: for every instant in the half-open
 * window `[start, start + 24h)`, `wibDayKey(t) === dayKey`.
 *
 * @param {string} dayKey A real `YYYY-MM-DD` business day.
 * @returns {number} Epoch seconds of the rollover that began that day.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if `dayKey` is not a
 *   real calendar date.
 */
function startOfWibDay(dayKey) {
  const { year, month, day } = parseDayKey(dayKey);
  // The business day `K` runs [21:00 UTC on the previous calendar date,
  // 21:00 UTC on `K`), so it opens 3 hours BEFORE midnight UTC of `K` — those 3
  // hours are the 21:00-24:00 of the previous date. `Date.UTC` is in ms.
  const midnightUtc = Date.UTC(year, month - 1, day);
  return Math.floor((midnightUtc - (SECONDS_PER_DAY - RESET_OFFSET_IN_DAY) * 1000) / 1000);
}

/**
 * The UTC instant at which the given business day ENDS (exclusive).
 *
 * That is 21:00 UTC ON `dayKey` itself — the same rollover that starts the next
 * business day. The window of the day is therefore
 * `[startOfWibDay(dayKey), endOfWibDay(dayKey))`, half-open, 86400 seconds wide.
 *
 * @param {string} dayKey A real `YYYY-MM-DD` business day.
 * @returns {number} Epoch seconds of the rollover that closes that day.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if `dayKey` is not a
 *   real calendar date.
 */
function endOfWibDay(dayKey) {
  const { year, month, day } = parseDayKey(dayKey);
  // 21:00 UTC ON `dayKey` itself — 21 hours after its midnight. `Date.UTC` is
  // in ms.
  return Math.floor((Date.UTC(year, month - 1, day) + RESET_OFFSET_IN_DAY * 1000) / 1000);
}

/* -------------------------------------------------------------------------- */
/* The business-day keys                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The PLAYER-FACING business day an instant belongs to, as `YYYY-MM-DD`.
 *
 * THE RULE, exactly:
 *
 *   - At or before 20:59:59 UTC the instant belongs to the CURRENT UTC calendar
 *     date (it is the small hours of the following morning in WIB).
 *   - From 21:00:00 UTC onward it belongs to the NEXT UTC calendar date (04:00
 *     WIB the following morning).
 *
 * The implementation is one comparison and one conditional day shift, so month,
 * year and leap boundaries are ordinary cases rather than special ones — and
 * they are ordinary in the right order: `2028-02-29T21:00:00Z` is
 * `2028-03-01`, because the leap day is shifted forward before it is rendered.
 *
 * @param {number} nowEpochSeconds The instant, in epoch SECONDS.
 * @returns {string} `YYYY-MM-DD` — the business day, which reads as a date one
 *   day ahead of the UTC date between 21:00 UTC and UTC midnight.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_INSTANT} on a missing,
 *   non-numeric, negative, non-integer or milliseconds-looking value.
 */
function wibDayKey(nowEpochSeconds) {
  const seconds = epochSeconds(nowEpochSeconds, "wibDayKey(nowEpochSeconds)");
  const utcSecondsIntoDay = seconds % SECONDS_PER_DAY;
  // `>=`, not `>`: the window is half-open, so 21:00:00 sharp has ALREADY
  // rolled over. 20:59:59 has not.
  const shifted = utcSecondsIntoDay >= RESET_OFFSET_IN_DAY ? seconds + SECONDS_PER_DAY : seconds;
  return _isoDay(shifted * 1000);
}

/**
 * The PLAYER-FACING business MONTH an instant belongs to, as `YYYY-MM`.
 *
 * SAME 21:00 UTC BOUNDARY as {@link wibDayKey}, so the business month rolls at
 * 04:00 WIB on the 1st — which is 21:00 UTC on the LAST day of the previous
 * month. The shift is the same one, so the month is always the month of the
 * (possibly shifted) business day; `2026-02-28T21:00:00Z` is `2026-03`.
 *
 * @param {number} nowEpochSeconds The instant, in epoch SECONDS.
 * @returns {string} `YYYY-MM`.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_INSTANT} on bad input.
 */
function wibMonthKey(nowEpochSeconds) {
  const seconds = epochSeconds(nowEpochSeconds, "wibMonthKey(nowEpochSeconds)");
  const utcSecondsIntoDay = seconds % SECONDS_PER_DAY;
  const shifted = utcSecondsIntoDay >= RESET_OFFSET_IN_DAY ? seconds + SECONDS_PER_DAY : seconds;
  return _isoMonth(shifted * 1000);
}

/**
 * The business day immediately BEFORE `dayKey`, as `YYYY-MM-DD`.
 *
 * Calendar arithmetic on the parsed parts via `Date.UTC`, so `2026-03-01` ->
 * `2026-02-28`, `2028-03-01` -> `2028-02-29`, `2026-01-01` -> `2025-12-31` all
 * fall out without a single special case. `Date.UTC` is a pure function of its
 * arguments — it is not a clock read.
 *
 * @param {string} dayKey A real `YYYY-MM-DD` business day.
 * @returns {string} The previous business day.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if `dayKey` is not a
 *   real calendar date (so `2026-02-30` and `2025-02-29` are refused).
 */
function previousWibDayKey(dayKey) {
  const { year, month, day } = parseDayKey(dayKey, "previousWibDayKey(dayKey)");
  return _isoDay(Date.UTC(year, month - 1, day) - SECONDS_PER_DAY * 1000);
}

/**
 * The business day immediately AFTER `dayKey`, as `YYYY-MM-DD`.
 *
 * @param {string} dayKey A real `YYYY-MM-DD` business day.
 * @returns {string} The next business day.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if `dayKey` is not a
 *   real calendar date.
 */
function nextWibDayKey(dayKey) {
  const { year, month, day } = parseDayKey(dayKey, "nextWibDayKey(dayKey)");
  return _isoDay(Date.UTC(year, month - 1, day) + SECONDS_PER_DAY * 1000);
}

/**
 * True when `next` is the IMMEDIATE NEXT business day after `previous`.
 *
 * Direction-sensitive on purpose: `isConsecutiveWibDay("2026-01-02",
 * "2026-01-01")` is `false`. That is what stops a caller back-filling an OLD
 * day and being paid as though it were "yesterday".
 *
 * Because business days are 24 hours of a fixed-offset zone with no DST, this
 * is plain calendar arithmetic on the day keys — the day keys already carry the
 * WIB boundary, so there is nothing instant-shaped left to decide here.
 *
 * @param {string} previous The earlier business day.
 * @param {string} next The later business day.
 * @returns {boolean}
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} if either argument is
 *   not a real calendar date.
 */
function isConsecutiveWibDay(previous, next) {
  const from = parseDayKey(previous, "isConsecutiveWibDay(previous)");
  const to = parseDayKey(next, "isConsecutiveWibDay(next)");
  return Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day) === SECONDS_PER_DAY * 1000;
}

/* -------------------------------------------------------------------------- */
/* Instants around the rollover                                                */
/* -------------------------------------------------------------------------- */

/**
 * The next daily rollover, in one of the two forms a caller may want.
 *
 *   - `resetEpochFor(DAY_KEY)` — a `YYYY-MM-DD` string — returns the instant
 *     that rollover which STARTED that business day: 21:00 UTC on the previous
 *     UTC calendar date. This is the "a calendar-month season boundary at 04:00
 *     WIB on the 1st is 21:00 UTC on the last day of the previous month"
 *     translation.
 *   - `resetEpochFor(INSTANT)` — an epoch-seconds number — returns the next
 *     rollover STRICTLY AFTER that instant, which is therefore in the future
 *     even when the instant is exactly on the boundary.
 *
 * @param {string|number} dayKeyOrInstant A business day key, or an instant in
 *   epoch SECONDS.
 * @returns {number} Epoch seconds of the rollover.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_DAY_KEY} /
 *   {@link RESET_ERRORS.INVALID_INSTANT} if the argument is neither.
 */
function resetEpochFor(dayKeyOrInstant) {
  if (typeof dayKeyOrInstant === "string") return startOfWibDay(dayKeyOrInstant);
  const seconds = epochSeconds(dayKeyOrInstant, "resetEpochFor(instant)");
  // Positive after 21:00 UTC, negative before it — the shift aligns the instant
  // onto the rollover grid, and adding a day makes the result the next one.
  const elapsed = seconds % SECONDS_PER_DAY - RESET_OFFSET_IN_DAY;
  return seconds - elapsed + SECONDS_PER_DAY;
}

/**
 * The UTC hour-of-day of the rollover this schedule uses, echoed as a number:
 * `21`. Present so a caller can assert the wiring without restating the literal.
 *
 * @returns {number} {@link DAILY_RESET_UTC_HOUR}.
 */
function utcHourOfReset() {
  return DAILY_RESET_UTC_HOUR;
}

/**
 * Seconds from `nowEpochSeconds` until the next daily rollover, in
 * `(0, 86400]`.
 *
 * 86400 — a full day, not zero — is returned exactly ON the boundary
 * (`21:00:00.000 UTC`), because at that instant the reset has just happened and
 * the next one is 24 hours away. One second earlier the answer is 1.
 *
 * @param {number} nowEpochSeconds The instant, in epoch SECONDS.
 * @returns {number} Whole seconds, strictly greater than 0 and at most 86400.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_INSTANT} on bad input.
 */
function secondsUntilReset(nowEpochSeconds) {
  const seconds = epochSeconds(nowEpochSeconds, "secondsUntilReset(nowEpochSeconds)");
  // Seconds since the last 21:00 UTC rollover. The double modulo is what makes
  // this correct BEFORE the rollover too: at 20:59:59 UTC the raw difference is
  // -1, and -1 mod 86400 is 86399 — one second ago, i.e. 1 second to go.
  const elapsed = (((seconds - RESET_OFFSET_IN_DAY) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return elapsed === 0 ? SECONDS_PER_DAY : SECONDS_PER_DAY - elapsed;
}

/**
 * A human-readable WIB wall clock for a log line or a diagnostics payload.
 *
 * Returns the business day, the local time and the UTC equivalent together,
 * because a bug report about "the day did not roll over" is unreadable unless
 * you can see both ends of the offset.
 *
 * @param {number} epochSecondsValue The instant, in epoch SECONDS.
 * @returns {string} e.g. `"2026-01-03 04:00:00 WIB (2026-01-02T21:00:00Z, business day 2026-01-03)"`.
 * @throws {TypeError} {@link RESET_ERRORS.INVALID_INSTANT} on bad input.
 */
function formatWib(epochSecondsValue) {
  const seconds = epochSeconds(epochSecondsValue, "formatWib(epochSeconds)");
  const wib = new Date((seconds + WIB_OFFSET_SECONDS) * 1000);
  const wibDay = `${String(wib.getUTCFullYear()).padStart(4, "0")}-${String(wib.getUTCMonth() + 1).padStart(2, "0")}-${String(wib.getUTCDate()).padStart(2, "0")}`;
  const clock = [wib.getUTCHours(), wib.getUTCMinutes(), wib.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${wibDay} ${clock} WIB (${new Date(seconds * 1000).toISOString()}, business day ${wibDayKey(seconds)})`;
}

module.exports = {
  // Constants.
  WIB_OFFSET_HOURS,
  DAILY_RESET_UTC_HOUR,
  SECONDS_PER_DAY,
  MAX_EPOCH_SECONDS,
  // Keys.
  wibDayKey,
  wibMonthKey,
  previousWibDayKey,
  nextWibDayKey,
  isConsecutiveWibDay,
  // Instants.
  resetEpochFor,
  utcHourOfReset,
  secondsUntilReset,
  startOfWibDay,
  endOfWibDay,
  // Diagnostics.
  formatWib,
  // Validation (exported so other modules reuse ONE definition of "is this a
  // real day key" rather than growing a second one).
  parseDayKey,
  parseMonthKey,
  // Errors.
  RESET_ERRORS,
  RESET_ERROR_NAME,
};
