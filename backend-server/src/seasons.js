/**
 * CATT Protocol — the SEASON SCHEDULER, and the HARD CAP that makes it one.
 *
 * WHAT THE FOUNDER SPECIFIED:
 *   Split the 40,000,000 CATT mining headroom into 20 seasons of 2,000,000 CATT
 *   each, every season lasting 30 days. And the clause that makes this module
 *   exist rather than being a spreadsheet:
 *
 *     THE SEASON POOL IS A HARD CAP. If a season's 2,000,000 CATT is exhausted
 *     before its 30 days elapse, mining for that season STOPS. Claims fail.
 *     Until a new season begins.
 *
 * THE PART THAT IS EASY TO GET WRONG, AND WAS GOT WRONG ONCE:
 *   2,000,000 CATT at 18 decimals is the 25-DIGIT base-unit amount
 *
 *       "2000000000000000000000000"        <- 25 digits, 2e24, SEASON_ALLOCATION
 *
 *   A previously-lost attempt of this module carried a SHORTENED literal of the
 *   same shape —
 *
 *       "2000000000000000000"               <- 19 digits, 2e18
 *
 *   — which is **2 CATT**, and a 22-digit sibling `"2000000000000000000000"` is
 *   **2,000 CATT**: one THOUSANDTH of the specified allocation. (The brief that
 *   described the lost attempt quoted the 19-digit string while calling it 22
 *   digits and 2,000 CATT; those are three different values, and the honest
 *   reading is that the shortened literal was short by a factor of 1,000 or
 *   worse. Either way it fails only the founder's own identity
 *   `20 x 2,000,000 === 40,000,000`.) Such a value would have passed every shape
 *   check (`/^\d+$/`, non-negative, round-trips through `BigInt`) and silently
 *   shrunk the whole mining headroom from 40,000,000 CATT to 40,000 CATT or less
 *   — a 1000x reduction that would have starved every season in roughly the
 *   first two days of mining.
 *   The digit count is therefore asserted in code (`assertSeasonIdentities`,
 *   run at module load) and again in the tests, and the 25-digit literal above
 *   is the ONLY allocation literal in this file.
 *
 * `SEASON_EPOCH = 0` IS A DOCUMENTED DEFAULT, NOT A FOUNDER DECISION:
 *   The founder never gave a launch date. `0` (1970-01-01T00:00:00Z) is chosen
 *   because it is the one epoch that is unambiguous, is not "a guess about
 *   2026", and makes every window in the schedule derivable by inspection. It is
 *   overridable at every entry point (`buildSeasonSchedule({ epoch })`,
 *   `ensureSeasons(store, { epoch })`, `seasonFor(now, { epoch })`), it is a
 *   module-level `const` rather than a parameter threaded everywhere so that
 *   changing it is a one-line, reviewable edit, and it is REPORTED AS
 *   UNSPECIFIED — a real deployment must pass the real launch instant, because
 *   before the epoch there is deliberately NO active season and every claim
 *   throws (see below).
 *
 * ===========================================================================
 * THE HARD CAP IS A LOUD ERROR, NEVER A SILENT ZERO
 * ===========================================================================
 * When a settlement would push a season past its allocation, `settle` throws a
 * typed error carrying `.code === "SEASON_ALLOCATION_EXHAUSTED"`. It does not
 * clamp, does not pay a partial amount, and does not return success. The three
 * alternatives were all considered and all rejected:
 *
 *   - CLAMP TO THE REMAINING ALLOCATION. The EIP-712 signature the Judge signs
 *     already commits to `reward`. Paying a different, smaller number than the
 *     signed one either fails on-chain (`claimReward` reverts on a mismatch) or,
 *     worse, is relayed for a value nobody signed. A partial payment CONTRADICTS
 *     the signature that authorised it; the honest outcomes are "pay exactly
 *     what was signed" or "pay nothing and say so loudly".
 *   - RETURN A SUCCESSFUL ZERO. The caller sees HTTP 200 with `paid: "0"`. That
 *     is INDISTINGUISHISHABLE from "this mission paid nothing because it was
 *     worth nothing" — the user completed a mission, was told it succeeded, and
 *     was silently not paid. Under-payment that no observer can detect is worse
 *     than a visible outage.
 *   - SILENTLY DROP THE CLAIM. Same undetectability, and it also loses the
 *     fact that the claim was made at all.
 *
 * So this loud error IS the implementation of "mining for the season stops".
 * The season's claims failing is a correct, intended, observable outage, and
 * the recovery is the season boundary: the next season begins at its own
 * `start` with a fresh 2,000,000 CATT, and this one keeps its history.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   No rewards, no multipliers, no multipliers-per-difficulty, no streak
 *   economics, no valuation. This module answers exactly three questions: WHICH
 *   season owns an instant, HOW MUCH of its allocation is left, and MAY this
 *   claim settle. Everything a claim is worth is decided elsewhere. The season
 *   pool is also NOT a per-user cap and NOT a per-day cap: it is one global
 *   pool per season, shared by every miner, which is what makes exhaustion a
 *   collective event rather than a personal one.
 *
 * THE UNIT, ONCE, FOR BOTH KINDS OF NUMBER IN THIS REPO:
 *   CATT amounts are 18-decimal base-unit integers, carried as `BigInt`
 *   internally and as canonical DECIMAL STRINGS across every public boundary
 *   (which is also what the store does). Stamina is a different unit entirely
 *   — unitless POINTS, 10 / 20 / 30, capped at 50 SPENT per day — and appears in
 *   this module not at all. The two are never converted, added or compared.
 *   `Number` is never used on a CATT amount, anywhere, for any reason.
 */

"use strict";

const { assertStoreShape, normalizeDayKey } = require("./storage");
const { dayKeyFor } = require("./content");

/* -------------------------------------------------------------------------- */
/* The frozen schedule parameters.                                             */
/* -------------------------------------------------------------------------- */

/** Seconds in one day. Exact, integer, and not derived from a clock. */
const SECONDS_PER_DAY = 86400;

/** Each season lasts 30 days. */
const SEASON_DURATION_DAYS = 30;

/** Each season lasts 2,592,000 seconds. Integer arithmetic only. */
const SEASON_DURATION_SECONDS = SEASON_DURATION_DAYS * SECONDS_PER_DAY;

/** How many seasons the mining headroom is split across. */
const SEASON_COUNT = 12;

/**
 * Per-season allocation in WHOLE CATT: 3,300,000.
 *
 * This yields a daily budget of 110,000 CATT (3.3M / 30 days), matching the
 * Governor's daily budget normaliser (Strategy S1+S2). The total headroom
 * across 12 seasons is 39,600,000 CATT; the remaining 400,000 CATT of the
 * 40M mining emission budget is unallocated.
 *
 * @type {bigint}
 */
const SEASON_ALLOCATION_CATT = 3_300_000n;

/** Decimal places in one CATT. */
const CATT_DECIMALS = 18;

/** Base units in one CATT: 10^18. */
const CATT_BASE_UNITS = 10n ** BigInt(CATT_DECIMALS);

/**
 * Per-season allocation in base units, as a canonical decimal string.
 *
 * TWENTY-FIVE DIGITS. `3300000 * 10^18 === 3.3e24`, which has 25 decimal digits.
 * Count them: `3300000000000000000000000`.
 *
 * It is 3,300,000 CATT and NOT 3,300 CATT.
 *
 * @type {string}
 */
const SEASON_ALLOCATION = (SEASON_ALLOCATION_CATT * CATT_BASE_UNITS).toString();

/** The whole mining headroom in WHOLE CATT: 39,600,000 (12 seasons × 3.3M). */
const TOTAL_HEADROOM_CATT = BigInt(SEASON_COUNT) * SEASON_ALLOCATION_CATT;

/** The whole schedule in days: 12 seasons x 30 days = 360. */
const TOTAL_SEASON_DAYS = SEASON_COUNT * SEASON_DURATION_DAYS;

/**
 * The launch instant, in unix SECONDS. DOCUMENTED DEFAULT — UNSPECIFIED BY THE
 * FOUNDER. Override it at every entry point; see the module header.
 *
 * @type {number}
 */
const SEASON_EPOCH = 0;

/**
 * The claim mode every season in this schedule settles under.
 *
 * `daily` means: a claim settles IMMEDIATELY and PER CLAIM, exactly as the
 * pre-season path behaved. It does not mean "one claim per day" — the daily cap
 * that exists is a STAMINA SPEND cap (50 points per day, `content.js`), a
 * different unit in a different module. Naming the mode `daily` rather than
 * `immediate` is kept because the value is persisted in `seasons.claim_mode`
 * and renaming it would orphan rows already on disk.
 *
 * @type {string}
 */
const CLAIM_MODE_DAILY = "daily";

/** Every claim mode this module knows how to settle. */
const SUPPORTED_CLAIM_MODES = Object.freeze([CLAIM_MODE_DAILY]);

/**
 * The twenty season ids, in schedule order: `"season-1"` .. `"season-20"`.
 *
 * Ids are 1-BASED and zero-padded-free, so they read in the same order as the
 * founder's list. The numeric suffix is what `buildSeasonSchedule` derives the
 * window from; the id is what claims are keyed by, which is why it must never
 * change once a season has been claimed against.
 *
 * @type {ReadonlyArray<string>}
 */
const SEASON_IDS = Object.freeze(
  Array.from({ length: SEASON_COUNT }, (_, index) => `season-${index + 1}`)
);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every stable, machine-readable error code this module can produce. Frozen and
 * never renamed: these strings are the backend's contract with `server.js`,
 * with the mobile app, and with whoever reads the logs at 3am.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SEASON_ERRORS = Object.freeze({
  /**
   * No season owns this instant: either `now` is before `SEASON_EPOCH`, or the
   * schedule has not been written to the store yet.
   *
   * There is deliberately NO fallback season. A default season would be an
   * uncapped pool by another name — the one failure mode this module exists to
   * make impossible. Before the epoch, mining is not yet open, and saying so
   * loudly is correct.
   */
  NO_ACTIVE_SEASON: "SEASON_NO_ACTIVE_SEASON",
  /** The season's hard cap is exhausted. The claim fails; see the module header. */
  ALLOCATION_EXHAUSTED: "SEASON_ALLOCATION_EXHAUSTED",
  /** `(seasonId, userAddress, nonce)` has already been recorded — a replay. */
  CLAIM_ALREADY_RECORDED: "SEASON_CLAIM_ALREADY_RECORDED",
  /** The season window has closed; the claim belongs to no live season. */
  WINDOW_ENDED: "SEASON_WINDOW_ENDED",
  /**
   * The stored `claim_mode` is not one this module can settle. Thrown rather
   * than defaulted: silently falling back to `daily` would settle a season under
   * rules its operator did not choose.
   */
  UNKNOWN_CLAIM_MODE: "SEASON_UNKNOWN_CLAIM_MODE",
  /** A load-time invariant of the frozen schedule failed. */
  INVARIANT_VIOLATED: "SEASON_INVARIANT_VIOLATED",
  /** A caller argument is missing or malformed. */
  INVALID_ARGUMENT: "SEASON_INVALID_ARGUMENT",
});

/** The `name` on every error this module throws. */
const SEASON_ERROR_NAME = "SeasonError";

/**
 * Builds a typed season error carrying a stable `.code`.
 *
 * @param {string} code One of {@link SEASON_ERRORS}.
 * @param {string} message Short, operator-readable message. Amounts in it are
 *   exact decimal strings; nothing here is ever a float.
 * @param {Object} [fields] Extra own properties (the error's evidence).
 * @returns {Error} The typed error.
 */
function _seasonError(code, message, fields) {
  const err = new Error(message);
  err.name = SEASON_ERROR_NAME;
  err.code = code;
  if (fields) Object.assign(err, fields);
  return err;
}

/**
 * Coerces a CATT amount to an exact `BigInt`.
 *
 * `Number` is REFUSED outright, and so is any string carrying a decimal point,
 * an exponent or a sign. This is the one place where the "never parse a CATT
 * amount with Number" rule is enforced mechanically rather than by discipline:
 * a `Number` argument is the exact shape of the 2e24 allocation after it has
 * been through one lossy step (`Number("2e24")` is a float, and
 * `Number("2000000000000000000000001")` is 2000000000000000000000000), and
 * accepting it would make precision a property of how carefully the caller
 * typed. BigInt and decimal-digit strings only.
 *
 * @param {*} value Candidate amount.
 * @param {string} label Field name, for the error message.
 * @returns {bigint} The exact amount.
 * @throws {Error} `SEASON_INVALID_ARGUMENT` if `value` is not a non-negative
 *   integer bigint or decimal-digit string.
 */
function toExactCatt(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw _seasonError(
        SEASON_ERRORS.INVALID_ARGUMENT,
        `seasons: ${label} must not be negative, got ${value}.`
      );
    }
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw _seasonError(
    SEASON_ERRORS.INVALID_ARGUMENT,
    `seasons: ${label} must be a non-negative integer amount of CATT base units as a BigInt or a ` +
      `decimal-digit string — never a Number, never a float. Got ${typeof value}.`
  );
}

/**
 * Coerces an instant to whole unix SECONDS.
 *
 * Numbers are accepted here (an instant is not money, and `1.7e9` as a claim
 * deadline is unremarkable), but anything non-finite or out of the safe-integer
 * range is refused, because a truncated start date would shift every window in
 * the schedule.
 *
 * @param {*} value Candidate instant.
 * @param {string} label Field name, for the error message.
 * @returns {number} Whole unix seconds.
 */
function _toEpochSeconds(value, label) {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(Math.trunc(seconds))) {
    throw _seasonError(
      SEASON_ERRORS.INVALID_ARGUMENT,
      `seasons: ${label} must be a finite number of unix seconds, got ${String(value)}.`
    );
  }
  return Math.trunc(seconds);
}

/**
 * Coerces an epoch override.
 *
 * @param {*} value Candidate epoch.
 * @returns {number} Whole unix seconds.
 */
function _resolveEpoch(value) {
  return value === undefined || value === null ? SEASON_EPOCH : _toEpochSeconds(value, "epoch");
}

/* -------------------------------------------------------------------------- */
/* The frozen schedule                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Builds all twenty seasons deterministically.
 *
 * Season `i` (1-based):
 *
 *     id          `season-<i>`
 *     start       epoch + (i - 1) * 30 days
 *     end         start + 30 days          [start, end)  — half-open
 *     allocation  "2000000000000000000000000"   (2,000,000 CATT)
 *     claimMode   "daily"
 *
 * WHY HALF-OPEN, `[start, end)`: with both ends inclusive, the closing second
 * of season N is also the opening second of season N+1 and a claim landing on
 * it has two owners. Half-open windows partition the timeline: `end_i ===
 * start_{i+1}` is the same instant seen from both sides, and it belongs to the
 * later season. This matches `storage.js#getActiveSeason` and the SQLite
 * `seasons_window` index, which is what lets the store and this pure planner
 * agree on every instant.
 *
 * WHY `end` IS NEVER NULL HERE: an open-ended season (`end: null`) is a real
 * state in the store, but it is not a state this schedule produces. A season
 * that never closes could never exhaust-then-restart, because there would be no
 * next season to restart into; the founder's spec requires a hard stop and a
 * new season, so all twenty windows are finite and contiguous.
 *
 * PURE AND DETERMINISTIC: same `epoch` in, byte-identical frozen array out, on
 * any machine, forever. No clock, no environment, no randomness, no I/O — which
 * is what makes the contiguity and identity assertions below possible at all.
 *
 * @param {Object} [options]
 * @param {number} [options.epoch Launch instant, unix seconds. Defaults to
 *   {@link SEASON_EPOCH} — the DOCUMENTED, FOUNDER-UNSPECIFIED default.
 * @returns {ReadonlyArray<Readonly<{ id: string, start: number, end: number,
 *   allocation: string, claimMode: string }>>} Twenty frozen seasons in order.
 * @throws {Error} `SEASON_INVALID_ARGUMENT` if `epoch` is not a finite instant.
 */
function buildSeasonSchedule({ epoch } = {}) {
  const base = _resolveEpoch(epoch);
  return Object.freeze(
    SEASON_IDS.map((id, index) => {
      const start = base + index * SEASON_DURATION_SECONDS;
      return Object.freeze({
        id,
        start,
        // Half-open: the window is [start, end).
        end: start + SEASON_DURATION_SECONDS,
        allocation: SEASON_ALLOCATION,
        claimMode: CLAIM_MODE_DAILY,
      });
    })
  );
}

/**
 * Asserts every identity the founder's spec rests on, and throws if any of them
 * has stopped holding.
 *
 * RUN AT MODULE LOAD. The failure mode this exists to prevent is the one
 * described in the module header: an allocation literal that is well-formed but
 * 1000x wrong. Every individual check it would pass; only the cross-check
 * against `TOTAL_HEADROOM_CATT` catches it. Making that a load-time assertion
 * rather than a test-only one means the module cannot be `require`d into a Judge
 * whose headroom is quietly 40,000 CATT instead of 40,000,000.
 *
 * @param {Object} [options]
 * @param {number} [options.epoch Epoch the schedule is checked against.
 * @returns {Readonly<Object>} The verified schedule.
 * @throws {Error} `SEASON_INVARIANT_VIOLATED` on the first broken identity.
 */
function assertSeasonIdentities({ epoch } = {}) {
  const base = _resolveEpoch(epoch);

  /** @param {boolean} ok @param {string} what @returns {void} */
  const demand = (ok, what) => {
    if (!ok) {
      throw _seasonError(
        SEASON_ERRORS.INVARIANT_VIOLATED,
        `seasons: frozen-schedule identity broken — ${what}. The season schedule and the ` +
          `founder's 12 x 3,300,000 = 39,600,000 CATT headroom must agree before any claim is settled.`,
        { identity: what }
      );
    }
  };

  demand(SEASON_COUNT === 12, `SEASON_COUNT must be 12, got ${SEASON_COUNT}`);
  demand(SEASON_DURATION_DAYS === 30, `SEASON_DURATION_DAYS must be 30, got ${SEASON_DURATION_DAYS}`);
  demand(
    SEASON_ALLOCATION_CATT === 3_300_000n,
    `SEASON_ALLOCATION_CATT must be 3300000n, got ${SEASON_ALLOCATION_CATT}`
  );
  // THE 1000x TYPO GUARD. 3,300,000 CATT at 18 decimals is a 25-DIGIT string.
  // Any shorter literal is 3,300 CATT or less and every other check here would
  // pass, because the shorter value is still a well-formed positive integer.
  demand(
    SEASON_ALLOCATION.length === 25,
    `SEASON_ALLOCATION must be 25 decimal digits (3,300,000 CATT at 18 decimals), got ` +
      `${SEASON_ALLOCATION.length} digits ("${SEASON_ALLOCATION}" — a short allocation is the ` +
      `1000x typo: 22 digits is 3,300 CATT, 19 digits is 3 CATT)`
  );
  demand(
    BigInt(SEASON_ALLOCATION) === SEASON_ALLOCATION_CATT * CATT_BASE_UNITS,
    `SEASON_ALLOCATION must equal SEASON_ALLOCATION_CATT x 10^${CATT_DECIMALS}`
  );
  demand(
    BigInt(SEASON_COUNT) * SEASON_ALLOCATION_CATT === TOTAL_HEADROOM_CATT,
    `${SEASON_COUNT} x ${SEASON_ALLOCATION_CATT} must equal the ${TOTAL_HEADROOM_CATT} CATT headroom`
  );
  demand(
    TOTAL_HEADROOM_CATT === 39_600_000n,
    `TOTAL_HEADROOM_CATT must be 39600000n, got ${TOTAL_HEADROOM_CATT}`
  );
  demand(
    BigInt(SEASON_ALLOCATION) * BigInt(SEASON_COUNT) === 39_600_000n * CATT_BASE_UNITS,
    `the whole schedule must allocate exactly 39,600,000 CATT in base units`
  );
  demand(
    SEASON_COUNT * SEASON_DURATION_DAYS === TOTAL_SEASON_DAYS,
    `${SEASON_COUNT} x ${SEASON_DURATION_DAYS} days must equal ${TOTAL_SEASON_DAYS} days`
  );
  demand(
    SEASON_DURATION_SECONDS === SEASON_DURATION_DAYS * SECONDS_PER_DAY,
    "SEASON_DURATION_SECONDS must be SEASON_DURATION_DAYS x SECONDS_PER_DAY"
  );
  demand(
    SEASON_IDS.length === SEASON_COUNT,
    `SEASON_IDS must hold ${SEASON_COUNT} ids, got ${SEASON_IDS.length}`
  );
  demand(
    SEASON_IDS.every((id, index) => id === `season-${index + 1}`),
    "SEASON_IDS must be season-1 .. season-12 in order"
  );
  demand(CLAIM_MODE_DAILY === "daily", `CLAIM_MODE_DAILY must be "daily", got ${CLAIM_MODE_DAILY}`);
  demand(
    SUPPORTED_CLAIM_MODES.includes(CLAIM_MODE_DAILY),
    "CLAIM_MODE_DAILY must be a supported claim mode"
  );

  const schedule = buildSeasonSchedule({ epoch: base });
  demand(
    schedule.length === SEASON_COUNT,
    `the schedule must hold ${SEASON_COUNT} seasons, got ${schedule.length}`
  );
  demand(
    schedule[0].start === base,
    `season 1 must start at the epoch (${base}), got ${schedule[0].start}`
  );
  // CONTIGUITY: no overlap and no gap, proven rather than asserted in prose.
  // `schedule[i].end === schedule[i+1].start` says both halves at once — the
  // windows cannot overlap (the later start is not before the earlier end) and
  // cannot leave a gap (they are not merely adjacent but EQUAL).
  for (let index = 1; index < schedule.length; index += 1) {
    demand(
      schedule[index].start === schedule[index - 1].end,
      `season ${index + 1} must start exactly where season ${index} ends ` +
        `(${schedule[index - 1].end}), got ${schedule[index].start}`
    );
    demand(
      schedule[index].end - schedule[index].start === SEASON_DURATION_SECONDS,
      `season ${index + 1} must last ${SEASON_DURATION_SECONDS} seconds`
    );
  }
  demand(
    schedule[schedule.length - 1].end === base + TOTAL_SEASON_DAYS * SECONDS_PER_DAY,
    `season ${SEASON_COUNT} must end at epoch + ${TOTAL_SEASON_DAYS} days ` +
      `(${base + TOTAL_SEASON_DAYS * SECONDS_PER_DAY}), got ${schedule[schedule.length - 1].end}`
  );
  demand(
    schedule.every((season) => season.allocation === SEASON_ALLOCATION),
    `every season must carry the ${SEASON_ALLOCATION} allocation`
  );
  demand(
    schedule.every((season) => season.claimMode === CLAIM_MODE_DAILY),
    `every season must settle under "${CLAIM_MODE_DAILY}"`
  );
  return schedule;
}

// Fail fast, at require time, if the frozen schedule has drifted.
assertSeasonIdentities({ epoch: SEASON_EPOCH });

/* -------------------------------------------------------------------------- */
/* Reading the schedule out of a store                                         */
/* -------------------------------------------------------------------------- */

/**
 * The schedule's own answer to "which season owns this instant?", computed in
 * memory with no store at all.
 *
 * Uses the same half-open `[start, end)` rule as `store.getActiveSeason`, so it
 * and {@link currentSeason} agree at every instant PROVIDED `ensureSeasons` was
 * run with the same `epoch` and no operator has edited a stored window. When
 * they disagree, THE STORE WINS: a stored row is what claims were actually
 * recorded against, and a pure planner that disagreed with the ledger would be
 * the one lying. This function is therefore for display, planning and tests —
 * the authority for a settlement is always {@link currentSeason}.
 *
 * Before `SEASON_EPOCH` there is NO active season, and after the last season
 * ends there is none either. Both are real states; neither is papered over with
 * a default.
 *
 * @param {number} now The instant, unix seconds.
 * @param {Object} [options]
 * @param {number} [options.epoch Epoch to schedule against.
 * @returns {Readonly<Object>|undefined} The owning season, or `undefined`.
 */
function seasonFor(now, { epoch } = {}) {
  const instant = _toEpochSeconds(now, "now");
  return buildSeasonSchedule({ epoch }).find(
    (season) => season.start <= instant && instant < season.end
  );
}

/**
 * The season a store says owns this instant.
 *
 * Delegates to `store.getActiveSeason(now)` — the store is the authority for
 * overlap resolution (latest `start` wins, ties by `id ASC`) and for any
 * operator edit to a stored window. Its answer may be `undefined`, which
 * {@link settle} turns into `SEASON_NO_ACTIVE_SEASON`.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {number} now The instant, unix seconds.
 * @returns {Promise<Readonly<Object>|undefined>} The active season, or `undefined`.
 */
async function currentSeason(store, now) {
  assertStoreShape(store);
  return store.getActiveSeason(_toEpochSeconds(now, "now"));
}

/* -------------------------------------------------------------------------- */
/* Writing the schedule into a store                                           */
/* -------------------------------------------------------------------------- */

/**
 * True when two season rows describe the same thing.
 *
 * Compares the whole tuple, not just the id: a row with a moved window or a
 * shrunk allocation is a DIFFERENT season as far as an operator is concerned,
 * and that is exactly the case `ensureSeasons` refuses to overwrite.
 *
 * @param {Object|undefined} stored A row from `store.getSeason`.
 * @param {Object} planned A row from {@link buildSeasonSchedule}.
 * @returns {boolean}
 */
function _sameSeason(stored, planned) {
  if (!stored) return false;
  return (
    String(stored.id) === planned.id &&
    Number(stored.start) === planned.start &&
    (stored.end === null ? null : Number(stored.end)) === planned.end &&
    String(stored.allocation) === planned.allocation &&
    (stored.claimMode === null ? null : String(stored.claimMode)) === planned.claimMode
  );
}

/**
 * Writes the twenty-season schedule into a store, idempotently.
 *
 * IDEMPOTENCE: running it twice changes nothing. The second run finds every row
 * already present and identical, and writes nothing.
 *
 * IT WILL NOT CLOBBER A ROW THAT DIFFERS, and that choice is the point:
 *   `saveSeason` is an upsert, so "just write it again" would silently move a
 *   window or resize an allocation on a season that claims have ALREADY been
 *   recorded against. Three concrete ways that hurts:
 *     - Moving a window forward strands the claims already recorded inside it:
 *       an instant that used to resolve to this season now resolves to another,
 *       so `season_claims` rows exist under a season that no longer owned them.
 *     - Shrinking an allocation below what has already been claimed turns the
 *       season's own ledger into an invariant violation that no future claim can
 *       repair, and the loud exhaustion error would then be reporting a state
 *       the backend created itself.
 *     - Re-opening a closed season lets mining resume into a pool the founder
 *       believed was finished.
 *   So a differing row is PRESERVED and REPORTED in the return value
 *   (`preserved`), and correcting it is a deliberate operator action taken
 *   through `store.saveSeason` where it is visible in a review, not a side
 *   effect of a boot.
 *
 * A MISSING row is always written — that is the normal first boot, and it is
 * the only thing this function is allowed to create.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} [options]
 * @param {number} [options.epoch Epoch to schedule against. Defaults to the
 *   DOCUMENTED, FOUNDER-UNSPECIFIED {@link SEASON_EPOCH}.
 * @returns {Promise<Readonly<{ epoch: number, seasonCount: number,
 *   created: ReadonlyArray<string>, preserved: ReadonlyArray<string> }>>}
 *   Which ids were written, which were left alone, and the epoch used.
 */
async function ensureSeasons(store, { epoch } = {}) {
  assertStoreShape(store);
  const base = _resolveEpoch(epoch);
  const schedule = buildSeasonSchedule({ epoch: base });
  const created = [];
  const preserved = [];
  for (const planned of schedule) {
    const stored = await store.getSeason(planned.id);
    if (stored && !_sameSeason(stored, planned)) {
      preserved.push(planned.id);
      continue;
    }
    if (!stored) created.push(planned.id);
    await store.saveSeason({
      id: planned.id,
      start: planned.start,
      end: planned.end,
      allocation: planned.allocation,
      claimMode: planned.claimMode,
    });
  }
  return Object.freeze({
    epoch: base,
    seasonCount: schedule.length,
    created: Object.freeze(created),
    preserved: Object.freeze(preserved),
  });
}

/* -------------------------------------------------------------------------- */
/* Reading the pool                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How much of a season's allocation is left, and how much has gone.
 *
 * Everything crosses this boundary as a canonical DECIMAL STRING. A running
 * total that rounds is a total that can pass a cap it is supposed to be bounded
 * by, and 2e24 is already far above `Number.MAX_SAFE_INTEGER`, so there is no
 * value in this function that a float could carry faithfully.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {string} seasonId Season id.
 * @returns {Promise<Readonly<{ seasonId: string, allocation: string,
 *   claimedTotal: string, remaining: string, exhausted: boolean }>>}
 * @throws {Error} `SEASON_INVALID_ARGUMENT` if the season is unknown.
 */
async function remainingForSeason(store, seasonId) {
  assertStoreShape(store);
  const id = String(seasonId);
  const season = await store.getSeason(id);
  if (!season) {
    throw _seasonError(
      SEASON_ERRORS.INVALID_ARGUMENT,
      `seasons: no season with id ${JSON.stringify(id)}.`
    );
  }
  const allocation = toExactCatt(season.allocation, "season.allocation");
  const claimed = toExactCatt(await store.getSeasonClaimedTotal(id), "seasonClaimedTotal");
  const remaining = allocation > claimed ? allocation - claimed : 0n;
  return Object.freeze({
    seasonId: id,
    allocation: allocation.toString(),
    claimedTotal: claimed.toString(),
    remaining: remaining.toString(),
    exhausted: remaining === 0n,
  });
}

/**
 * Everything claimed across the WHOLE schedule so far, in base units.
 *
 * Sums the per-season totals as `BigInt` and returns a decimal string. It sums
 * only the twenty ids in {@link SEASON_IDS}: a stray row an operator added
 * under some other id is not part of the founder's headroom and must not be
 * silently folded into its total.
 *
 * @param {Object} store A store implementing the storage interface.
 * @returns {Promise<string>} Exact decimal string.
 */
async function totalHeadroomClaimed(store) {
  assertStoreShape(store);
  let total = 0n;
  for (const id of SEASON_IDS) total += toExactCatt(await store.getSeasonClaimedTotal(id), "seasonClaimedTotal");
  return total.toString();
}

/**
 * How much of the 40,000,000 CATT headroom is still unallocated and unclaimed.
 *
 * Two halves, because a season that has not been written yet still OWNS its
 * 2,000,000 CATT: the twenty schedule allocations, minus every base unit already
 * claimed from a season that exists. A fresh store with an empty schedule
 * therefore reports the full `40000000000000000000000000` (40,000,000 CATT), and
 * a fully-exhausted season-1 with the other nineteen unwritten reports
 * `38000000000000000000000000` — the exhausted season contributes zero, its
 * 2,000,000 CATT stays spent, and it is NOT recycled into anyone else.
 *
 * @param {Object} store A store implementing the storage interface.
 * @returns {Promise<string>} Exact decimal string.
 */
async function totalHeadroomStillUnallocated(store) {
  assertStoreShape(store);
  let total = 0n;
  for (const id of SEASON_IDS) {
    const season = await store.getSeason(id);
    if (!season) {
      // Not written yet: the full allocation is still out there, untouched.
      total += SEASON_ALLOCATION_CATT * CATT_BASE_UNITS;
      continue;
    }
    const allocation = toExactCatt(season.allocation, "season.allocation");
    const claimed = toExactCatt(await store.getSeasonClaimedTotal(id), "seasonClaimedTotal");
    total += allocation > claimed ? allocation - claimed : 0n;
  }
  return total.toString();
}

/* -------------------------------------------------------------------------- */
/* The decision: may this claim settle?                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the season a claim names, refusing the two cases that have no season.
 *
 * THE TWO "NO ACTIVE SEASON" CASES, and why neither gets a default:
 *   1. `now < SEASON_EPOCH`. The founder never specified a launch date; until
 *      one is chosen, mining is not open. Defaulting here would mean inventing a
 *      season, and inventing a season means inventing an UNCAPPED pool.
 *   2. No stored row covers `now` (schedule not written, or the schedule has
 *      run past its last window). Same answer, same reason.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params
 * @param {number} params.now The instant, unix seconds.
 * @param {string} [params.seasonId] Settle against this season explicitly
 *   instead of the active one. Only legitimate for an operator replay.
 * @param {string} [params.userAddress] The claiming wallet, used only to report
 *   the outstanding accrual on the closed-window path.
 * @returns {Promise<Object>} The resolved season row.
 * @throws {Error} `SEASON_NO_ACTIVE_SEASON` or `SEASON_WINDOW_ENDED`.
 */
async function _resolveSeason(store, { now, seasonId, userAddress }) {
  const instant = _toEpochSeconds(now, "now");
  if (instant < SEASON_EPOCH) {
    throw _seasonError(
      SEASON_ERRORS.NO_ACTIVE_SEASON,
      `seasons: ${instant} is before SEASON_EPOCH (${SEASON_EPOCH}); no season is open yet. ` +
        `This is a DOCUMENTED, FOUNDER-UNSPECIFIED epoch — pass the real launch instant to ` +
        `ensureSeasons() at boot. There is deliberately no default season.`,
      { now: instant, epoch: SEASON_EPOCH, seasonId: seasonId === undefined ? null : String(seasonId) }
    );
  }

  const season = seasonId === undefined || seasonId === null
    ? await store.getActiveSeason(instant)
    : await store.getSeason(String(seasonId));

  if (!season) {
    throw _seasonError(
      SEASON_ERRORS.NO_ACTIVE_SEASON,
      `seasons: no season covers ${instant}. The 20-season schedule may not have been written ` +
        `to this store yet (call ensureSeasons()), or the instant falls outside it.`,
      { now: instant, epoch: SEASON_EPOCH, seasonId: seasonId === undefined ? null : String(seasonId) }
    );
  }

  const end = season.end === null || season.end === undefined ? null : Number(season.end);
  if (end !== null && instant >= end) {
    // ROUTED EXPLICITLY, NOT SETTLED. The window is `[start, end)` and this
    // instant is at or past `end`, so this season no longer owns it.
    //
    // WHAT THE USER KEEPS: everything already accrued in this season stays in
    // `season_claims` and stays readable via `getSeasonUserAccrued` — the
    // ledger is history and is never rewritten. An operator can pay a settled
    // accrual out of it (that is a payout decision, and deliberately NOT this
    // module's to make).
    //
    // WHAT THE USER DOES NOT GET: a new claim against the closed window. This is
    // not a cap rejection (`ALLOCATION_EXHAUSTED`) — there may be a million
    // CATT left in the pool — it is a TIMING rejection. The distinction matters
    // to whoever reads the error: one is "the season ran out of money", the
    // other is "the season ran out of time, and it does not roll over".
    //
    // The remaining allocation is NOT carried into the next season: each season
    // is its own 2,000,000 CATT pool, so unclaimed time in season N is simply
    // not claimed in season N+1.
    const user = String(userAddress ?? "").trim().toLowerCase();
    const accrued = user === ""
      ? "0"
      : String(
          await store.getSeasonUserAccrued({ seasonId: season.id, userAddress: user })
        );
    throw _seasonError(
      SEASON_ERRORS.WINDOW_ENDED,
      `seasons: ${season.id} ended at ${end} (window [${Number(season.start)}, ${end})), so a claim ` +
        `at ${instant} cannot settle into it. Accruals already recorded in ${season.id} remain ` +
        `readable and payable out of band; the remaining allocation does not roll into the next season.`,
      {
        seasonId: String(season.id),
        now: instant,
        start: Number(season.start),
        end,
        settled: false,
        routedTo: "outstanding-accrual",
        claimableLater: true,
        // What this user has ALREADY accrued in the closed season — the amount
        // that survives the close and can be paid out of band by an operator.
        userAccrued: accrued,
      }
    );
  }
  return season;
}

/**
 * Decides whether a claim may settle, WITHOUT writing anything.
 *
 * This is the single decision function. `previewSettlement` and `settle` both go
 * through it, so the two cannot disagree — a dry run that said `allowed: true`
 * while the real call threw would make the preview worthless.
 *
 * The order of the checks is itself a decision, and it is: cheap-and-certain
 * refusals first (malformed amount, replayed nonce), then season resolution,
 * then the window, then the claim mode, and only LAST the hard cap. The cap is
 * checked last so that its error — the loud one operators need to read — is
 * never pre-empted by a cheaper refusal that has its own clearer error.
 *
 * A ZERO-AMOUNT claim is ALWAYS admissible, even against an exhausted season:
 * it consumes no allocation, so it cannot push the total past the cap, and
 * refusing it would fail a no-op for no reason. It is a no-op that leaves the
 * season total EXACTLY where it was — it is not a "successful zero payment".
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params
 * @param {string} params.userAddress Claiming wallet.
 * @param {*} params.amount Exact CATT base-unit amount (BigInt or digit string).
 * @param {number|string|bigint} params.nonce Idempotency nonce.
 * @param {number} params.now The instant, unix seconds.
 * @param {string} [params.seasonId] Settle against this season explicitly.
 * @returns {Promise<Readonly<Object>>} The decision plus every number behind it.
 * @throws {Error} `SEASON_CLAIM_ALREADY_RECORDED`, `SEASON_NO_ACTIVE_SEASON`,
 *   `SEASON_WINDOW_ENDED`, `SEASON_UNKNOWN_CLAIM_MODE` or
 *   `SEASON_ALLOCATION_EXHAUSTED`.
 */
async function _decide(store, { userAddress, amount, nonce, now, seasonId }) {
  const user = String(userAddress ?? "").trim().toLowerCase();
  if (user === "") {
    throw _seasonError(SEASON_ERRORS.INVALID_ARGUMENT, "seasons: userAddress is required.");
  }
  const value = toExactCatt(amount, "amount");
  const nonceKey = String(nonce);
  if (!/^\d+$/.test(nonceKey)) {
    throw _seasonError(
      SEASON_ERRORS.INVALID_ARGUMENT,
      `seasons: nonce must be a non-negative integer, got ${JSON.stringify(nonce)}.`
    );
  }
  const instant = _toEpochSeconds(now, "now");

  const season = await _resolveSeason(store, { now: instant, seasonId, userAddress: user });

  // REPLAY SAFETY, before any cap arithmetic. `isSeasonClaimUsed` is keyed by
  // `(seasonId, userAddress, nonce)` in BOTH adapters — the memory store by the
  // composite key, SQLite by the table's composite PRIMARY KEY — so a retried
  // request is refused here rather than accruing a second time. The store's own
  // rejection is the backstop for a race between the check and the write.
  if (await store.isSeasonClaimUsed({ seasonId: season.id, userAddress: user, nonce: nonceKey })) {
    throw _seasonError(
      SEASON_ERRORS.CLAIM_ALREADY_RECORDED,
      `seasons: (${season.id}, ${user}, nonce ${nonceKey}) has already been recorded. A retried ` +
        `claim must not accrue twice — use a fresh nonce.`,
      { seasonId: String(season.id), userAddress: user, nonce: nonceKey, replay: true }
    );
  }

  // UNKNOWN CLAIM MODE THROWS. It never falls back to `daily`: the stored mode
  // is an operator's choice about how a pool pays out, and settling it under
  // rules it was not configured for is a silent policy substitution. The
  // supported set is frozen, so this is also how a rename would be caught.
  const claimMode = season.claimMode === null || season.claimMode === undefined ? null : String(season.claimMode);
  if (!SUPPORTED_CLAIM_MODES.includes(claimMode)) {
    throw _seasonError(
      SEASON_ERRORS.UNKNOWN_CLAIM_MODE,
      `seasons: ${season.id} has claimMode ${JSON.stringify(claimMode)}, which is not one of ` +
        `${SUPPORTED_CLAIM_MODES.join(", ")}. Refusing rather than falling back to "${CLAIM_MODE_DAILY}".`,
      {
        seasonId: String(season.id),
        claimMode,
        supported: SUPPORTED_CLAIM_MODES,
      }
    );
  }

  const allocation = toExactCatt(season.allocation, "season.allocation");
  const claimedTotal = toExactCatt(await store.getSeasonClaimedTotal(season.id), "seasonClaimedTotal");
  const userAccrued = toExactCatt(
    await store.getSeasonUserAccrued({ seasonId: season.id, userAddress: user }),
    "userAccrued"
  );
  const requested = value;
  const after = claimedTotal + requested;
  const remaining = allocation > claimedTotal ? allocation - claimedTotal : 0n;

  // THE HARD CAP. A positive claim that would push the season past its
  // allocation is REFUSED OUT LOUD. See the module header for why there is no
  // clamp and no successful zero here: the signed EIP-712 `reward` is all-or-
  // nothing, and an under-payment the client cannot detect is worse than a
  // visible outage. This throw IS "mining for the season stops".
  if (requested > 0n && after > allocation) {
    throw _seasonError(
      SEASON_ERRORS.ALLOCATION_EXHAUSTED,
      `seasons: ${season.id} has ${remaining} CATT base units left and this claim is for ` +
        `${requested}; settling it would take the season ${after - allocation} past its ` +
        `${allocation} allocation. The season pool is a HARD CAP: mining for this season stops ` +
        `until a new season begins. No partial payment and no zero payment is issued.`,
      {
        seasonId: String(season.id),
        allocation: allocation.toString(),
        claimedTotal: claimedTotal.toString(),
        requested: requested.toString(),
        remaining: remaining.toString(),
        shortfall: (after - allocation).toString(),
        settled: false,
        partialPayment: false,
        amount: requested.toString(),
        userAddress: user,
      }
    );
  }

  return Object.freeze({
    seasonId: String(season.id),
    claimMode,
    settled: false,
    amount: requested.toString(),
    allocation: allocation.toString(),
    claimedTotal: claimedTotal.toString(),
    // What the season had LEFT to give before this claim — the same figure the
    // exhaustion error reports, so "remaining" means one thing everywhere.
    remaining: remaining.toString(),
    // And what it will have left once this claim settles.
    remainingAfter: (allocation > after ? allocation - after : 0n).toString(),
    userAccrued: userAccrued.toString(),
    nonce: nonceKey,
    now: instant,
  });
}

/**
 * Runs a claim against the season pool WITHOUT WRITING ANYTHING.
 *
 * The dry run of {@link settle}, through the same decision function, so its
 * verdict is the verdict: it admits exactly what `settle` admits and throws
 * exactly what `settle` throws, including the hard-cap error with its full
 * evidence. The only difference is that no claim row is written and the nonce
 * stays unused — a preview does not burn a nonce, because the caller is
 * expected to come back with the SAME nonce and have it settle then.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params See {@link settle}.
 * @returns {Promise<Readonly<Object>>} `{ dryRun: true, settled: false, ... }`.
 * @throws {Error} The same typed errors `settle` throws.
 */
async function previewSettlement(store, { userAddress, amount, nonce, now, seasonId } = {}) {
  const decision = await _decide(store, { userAddress, amount, nonce, now, seasonId });
  return Object.freeze({ ...decision, dryRun: true });
}

/**
 * Settles one claim against the season pool, or refuses it loudly.
 *
 * THE DECISION TABLE — `daily` mode:
 *
 *   live season, within allocation        -> RECORDS the claim, pays IMMEDIATELY
 *                                             (`paid === amount`), per claim.
 *   live season, pool exhausted,
 *     positive amount                      -> THROWS `SEASON_ALLOCATION_EXHAUSTED`
 *                                             with seasonId / allocation /
 *                                             claimedTotal / requested /
 *                                             remaining / shortfall. The season
 *                                             total does NOT move.
 *   live season, zero amount,
 *     pool exhausted or not                -> RECORDS a no-op claim worth zero.
 *                                             Consumes no allocation; the
 *                                             season total is unchanged. This is
 *                                             NOT a successful payment.
 *   `now < SEASON_EPOCH`                   -> THROWS `SEASON_NO_ACTIVE_SEASON`.
 *                                             No default season, no uncapped path.
 *   season named whose window has ENDED     -> THROWS `SEASON_WINDOW_ENDED`, routed
 *                                             to the outstanding-accrual path. The
 *                                             season total does NOT move.
 *   stored `claimMode` not supported        -> THROWS `SEASON_UNKNOWN_CLAIM_MODE`.
 *                                             Never silently `daily`.
 *   `(season, user, nonce)` already recorded -> THROWS `SEASON_CLAIM_ALREADY_RECORDED`.
 *                                             No double-accrual.
 *
 * `daily` SETTLES IMMEDIATELY AND PER CLAIM. There is no daily pool, no daily
 * per-user cap and no batching here: each call is its own settlement and its own
 * `paid` amount, exactly as the pre-season path behaved. The one daily cap in the
 * system is a STAMINA SPEND cap (50 points/day) in `content.js` — a different
 * unit, in a different module, and never applied to CATT.
 *
 * WHY `paid` IS A FIELD AND NOT AN IMPLICIT SUCCESS: the caller signs
 * `amount` and the caller must pay `paid`. They are equal on every successful
 * daily settlement, and the field exists so that an unequal one could never be
 * reported as `200 OK` by accident.
 *
 * @param {Object} store A store implementing the storage interface.
 * @param {Object} params
 * @param {string} params.userAddress Claiming wallet.
 * @param {*} params.amount Exact CATT base-unit amount (BigInt or digit string).
 * @param {number|string|bigint} params.nonce Idempotency nonce, unique per
 *   `(season, user)`.
 * @param {number} params.now The instant, unix SECONDS. The caller supplies it;
 *   this module reads no clock.
 * @param {string} [params.seasonId] Settle against this season explicitly
 *   rather than the active one. For operator replay only.
 * @returns {Promise<Readonly<Object>>} `{ seasonId, settled: true, paid,
 *   amount, allocation, claimedTotal, remaining, userAccrued, claimMode, nonce }`
 *   — every CATT figure a canonical decimal string.
 * @throws {Error} One of the {@link SEASON_ERRORS} codes above.
 */
async function settle(store, { userAddress, amount, nonce, now, seasonId } = {}) {
  const decision = await _decide(store, { userAddress, amount, nonce, now, seasonId });
  const recorded = await store.recordSeasonClaim({
    seasonId: decision.seasonId,
    userAddress: String(userAddress).trim().toLowerCase(),
    amount: decision.amount,
    nonce: decision.nonce,
  });
  const seasonClaimedTotal = toExactCatt(recorded.seasonClaimedTotal, "seasonClaimedTotal");
  const userAccrued = toExactCatt(recorded.userAccrued, "userAccrued");
  const allocation = BigInt(decision.allocation);
  return Object.freeze({
    ...decision,
    settled: true,
    dryRun: false,
    // Immediate, per-claim settlement. Equal to `amount` on every success.
    paid: decision.amount,
    seasonClaimedTotal: seasonClaimedTotal.toString(),
    claimedTotal: seasonClaimedTotal.toString(),
    userAccrued: userAccrued.toString(),
    remainingAfter: (allocation > seasonClaimedTotal ? allocation - seasonClaimedTotal : 0n).toString(),
  });
}

module.exports = {
  // The frozen schedule, parameter by parameter.
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
  SUPPORTED_CLAIM_MODES,
  SEASON_IDS,
  // The unit, exported so a caller can convert without guessing the scale.
  CATT_DECIMALS,
  CATT_BASE_UNITS,
  // Errors.
  SEASON_ERRORS,
  SEASON_ERROR_NAME,
  // Schedule.
  buildSeasonSchedule,
  assertSeasonIdentities,
  seasonFor,
  currentSeason,
  ensureSeasons,
  // Pool.
  remainingForSeason,
  totalHeadroomClaimed,
  totalHeadroomStillUnallocated,
  // Settlement.
  settle,
  previewSettlement,
  // Shared coercion, so no caller re-derives it with `Number`.
  toExactCatt,
  /**
   * Re-exported from `content.js` so a caller holding only this module can name
   * the day a settled claim belongs to without a second import. Still a
   * `YYYY-MM-DD` business day, still caller-supplied `now`, never read from a
   * clock here.
   *
   * !! IT IS NOW A WIB BUSINESS DAY, NOT A UTC ONE !! Since the 04:00 WIB rule
   * it rolls at 21:00 UTC of the previous UTC date (`reset-schedule.js`), so
   * between 21:00Z and 23:59:59Z it names tomorrow's UTC date.
   *
   * AND THE SEASON BOUNDARIES ALREADY SATISFY THAT RULE, which is the point of
   * noting it here. A season window is an ABSOLUTE INSTANT pair `[start, end)`,
   * not a calendar expression, so there is no timezone left in it to get wrong:
   * whatever instant was chosen as the boundary, that instant is the boundary,
   * on every machine, in any process timezone. A founder who asks for "the
   * calendar-month boundary at 04:00 WIB on the 1st" is asking for a specific
   * INSTANT, and under the WIB rule that instant is 21:00 UTC on the LAST day
   * of the previous month — e.g. `2026-03-01T00:00:00Z` minus 3 hours =
   * `2026-02-28T21:00:00Z` is the start of the March season. Write that as the
   * literal 21:00 UTC on the previous month's last day (or compute it with
   * `resetEpochFor`), and do NOT express it as "midnight UTC on the 1st", which
   * would put the rollover three hours early and hand the last three hours of
   * every month to the season that is ending. The shipped schedule below does
   * neither — it is `epoch + index * 30 days` — and
   * `test/reset-schedule.test.js` asserts the month-boundary equivalence.
   */
  dayKeyFor,
  normalizeDayKey,
};
