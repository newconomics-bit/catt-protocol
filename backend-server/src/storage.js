/**
 * CATT Protocol — Judge storage layer (PRD 3.2, PRD 6.2 "Mining Loop").
 *
 * This module is the ONLY place where mining state lives. It is deliberately
 * written against an explicit, frozen method contract (`STORAGE_METHODS`) so
 * that an in-memory implementation — the one shipped for the MVP — can be
 * swapped one-for-one by a Supabase/Postgres adapter later (PRD Section 4 lists
 * PostgreSQL for user data) without the HTTP layer noticing. The Express app
 * never reaches into a `Map`; it only ever calls the async methods below.
 *
 * WHY AN INTERFACE AND NOT JUST A MAP:
 *   The single hardest invariant in the whole Judge is the claim nonce.
 *   `MiningClaimer.usedNonces[user][nonce]` is written to `true` and can never
 *   go back to `false`: a nonce that has paid out once is burned FOR THE
 *   LIFETIME OF THE DEPLOYMENT. So a nonce that this backend hands out and then
 *   fails to sign must never be handed out again. Encoding that as an explicit
 *   `reserveNonce` primitive — rather than as "peek at the counter, then write
 *   later" — is what makes the guarantee testable and lets the DB version
 *   enforce it with a `UNIQUE(user_address, nonce)` constraint.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   No validation rules, no anti-cheat scoring, no content, no signing. This is
 *   a dumb, synchronous, in-process store. The Judge logic lives in
 *   `server.js`; the anti-cheat engine lives in `anticheat.js`; the EIP-712
 *   signing lives in `../signer.js` and is never re-implemented here.
 *
 * POSTGRES MIGRATION HINT (the schema this interface implies):
 *
 *   sessions(
 *     session_id   text PRIMARY KEY,
 *     user_address text NOT NULL,
 *     mission_id   text NOT NULL,
 *     created_at   timestamptz NOT NULL DEFAULT now()
 *   )
 *
 *   telemetry(
 *     id            bigserial PRIMARY KEY,
 *     session_id    text NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 *     ts            bigint NOT NULL,      -- client clock, ms since epoch
 *     battery_temp_c real,                -- degrees celsius
 *     touch_x       real,
 *     touch_y       real,
 *     scroll_delta  real,
 *     received_at   timestamptz NOT NULL DEFAULT now()
 *   )
 *   CREATE INDEX telemetry_session_id_id ON telemetry (session_id, id);
 *   -- "insertion order" is the surrogate `id`; the flat array returned by
 *   -- getTelemetry() is `SELECT ... ORDER BY id ASC`. Samples are APPENDED,
 *   -- never upserted, so a re-posted batch cannot rewrite history.
 *
 *   submissions(
 *     id           bigserial PRIMARY KEY,   -- monotonic, newest = highest
 *     session_id   text NOT NULL,
 *     user_address text NOT NULL,
 *     mission_id   text NOT NULL,
 *     submitted_at timestamptz NOT NULL DEFAULT now(),
 *     answers      jsonb NOT NULL,
 *     highlight    text NOT NULL,
 *     typing_ms    bigint NOT NULL,
 *     free_text    text NOT NULL,
 *     status       text NOT NULL,          -- 'PASS' | 'FAIL'
 *     reward       numeric NOT NULL,
 *     stamina_cost numeric NOT NULL,
 *     flags        jsonb NOT NULL,
 *     details      jsonb
 *   )
 *   CREATE INDEX submissions_recent ON submissions (submitted_at DESC);
 *   CREATE INDEX submissions_user_recent ON submissions (user_address, submitted_at DESC);
 *   -- listRecentSubmissions() is this index, newest first, plus a predicate:
 *   --
 *   --   user_address = $2             (the `userAddress` filter: ONLY that user)
 *   --   user_address <> $3             (the `excludeUserAddress` filter: everyone
 *   --                                 BUT that user — see the note below)
 *   --
 *   -- `submissions_recent` serves the unfiltered syndicate corpus: the
 *   -- `submitted_at DESC` prefix supplies the ORDER BY and, together with the
 *   -- LIMIT, bounds the scan. The `<>` predicate is a FILTER over that window,
 *   -- not a seek, so it deliberately does not change which index answers the
 *   -- query; `submissions_user_recent` is the index that lets the per-user
 *   -- form (`user_address = $2`) seek instead of scan. Both filters together
 *   -- keep only rows that satisfy both, which is exactly one address when the
 *   -- two differ and nothing at all when they are the same.
 *   --
 *   -- THE `excludeUserAddress` PREDICATE EXISTS FOR RESIDUAL RISK #3, AND IT
 *   -- DOES NOT CLOSE RESIDUAL RISK #2. Before it existed, the syndicate corpus
 *   -- spanned all users INCLUDING the submitter's own earlier submissions, so
 *   -- an honest user who re-mined an article and wrote the same summary twice
 *   -- was compared against their own text, matched at similarity 1.0, and
 *   -- refused as a syndicate. That is a false positive against an honest user
 *   -- and it is now closed.
 *   --
 *   -- What is NOT closed by it: the corpus is still a BOUNDED RECENT WINDOW
 *   -- (SYNDICATE_LOOKBACK = 50 submissions in `server.js`, the default limit
 *   -- here). A ring that waits for its copies to age out of that window, or
 *   -- that paraphrases past the 0.9 Dice threshold, is still undetected — the
 *   -- measurements for that are pinned in test/red-team.test.js (ATTACK 4d)
 *   -- and are unchanged by this predicate. Excluding one submitter's own rows
 *   -- widens the ring-detection footprint by nothing and narrows it by nothing:
 *   -- a ring of two or more DISTINCT addresses is still visible in full to
 *   -- every member after its own rows are removed. Do not read this index
 *   -- change as a paraphrase or lookback fix.
 *
 *   issued_claims(
 *     user_address text NOT NULL,
 *     nonce        numeric NOT NULL,
 *     session_id   text,
 *     digest       text NOT NULL,
 *     reward       numeric NOT NULL,
 *     stamina_cost numeric NOT NULL,
 *     deadline     bigint NOT NULL,
 *     signature    text NOT NULL,
 *     issued_at    timestamptz NOT NULL DEFAULT now(),
 *     relayed_tx_hash    text,              -- NULL until the gasless relay broadcasts
 *     relayed_at         timestamptz,       -- NULL until it does
 *     PRIMARY KEY (user_address, nonce),
 *     CONSTRAINT issued_claims_unique_nonce UNIQUE (user_address, nonce),
 *     CONSTRAINT issued_claims_unique_relay_tx UNIQUE (relayed_tx_hash)
 *   )
 *   -- The PRIMARY KEY is the DB-level equivalent of reserveNonce()'s
 *   -- guarantee: two concurrent transactions cannot obtain the same
 *   -- (user_address, nonce), so a reserved-but-never-signed nonce is burned
 *   -- the moment the row lands. The memory store mirrors this by advancing a
 *   -- per-user counter on EVERY reserveNonce() call, before the caller has
 *   -- had any chance to sign.
 *   -- The SECOND unique index is the relay double-spend guard. `markRelayed`
 *   --   is `UPDATE issued_claims SET relayed_tx_hash = $tx, relayed_at = now()
 *   --   WHERE user_address = $1 AND nonce = $2 AND relayed_tx_hash IS NULL`
 *   --   and the caller treats `rowCount === 0` as ALREADY RELAYED. Making the
 *   --   uniqueness of a relayed transaction hash a DATABASE constraint means
 *   --   two concurrent relayers of the same nonce cannot both succeed: the
 *   --   second one hits the index rather than winning a race in application
 *   --   code. The memory store below serialises the same check behind a
 *   --   synchronous read-modify-write, which is indivisible between awaits.
 *
 *   No secret, key or credential is read, stored or logged by this module.
 *
 * ===========================================================================
 * THE GROWTH LEDGERS (the `getStaminaConsumed` … `countActiveMiners` block)
 * ===========================================================================
 * These are the durable state the growth mechanisms need, and they are pure
 * MECHANICS: ledgers that count, and windows that resolve. NONE of them carries
 * an economic decision — no reward, no season split, no multiplier, no
 * free-stamina amount. The values that arrive here are recorded and totalled;
 * what they are WORTH is decided elsewhere.
 *
 * ONE RULE GOVERNS ALL OF THEM: `dayKey` IS ALWAYS A CALLER-SUPPLIED
 * `YYYY-MM-DD` STRING AND THE STORE NEVER READS A CLOCK.
 *   Every method that is day-scoped takes the day from its caller. That is what
 *   makes the store a pure function of its arguments: a test can drive a
 *   ten-day streak, a month boundary and a leap day without waiting for any of
 *   them, two Judge processes cannot disagree about which bucket an event lands
 *   in, and a timezone change on the host cannot move a ledger. `content.js`'s
 *   `dayKeyFor(now)` is where the clock is read — exactly once, at the edge,
 *   by the caller — and everything downstream is deterministic.
 *
 *   WHAT THAT DAY KEY IS: since the 04:00 WIB rule (`reset-schedule.js`) it is
 *   the PLAYER-FACING WIB BUSINESS DAY, which rolls at 21:00 UTC of the
 *   previous UTC date rather than at 00:00 UTC. The store does not need to know
 *   that, and this is the reason it does not have to: `isNextDayAfter` compares
 *   two day-KEY STRINGS as calendar dates, and business days are still calendar
 *   dates one-to-one — 24-hour buckets in a fixed-offset zone with no DST. The
 *   rollover was decided once, upstream, where the clock is read. So the streak
 *   arithmetic below is UNCHANGED and remains correct under the new rule: it
 *   never re-derives a day from an instant, and there is no UTC assumption left
 *   in it to break. The words "UTC" below that describe a calendar date are
 *   historical wording, not a rule this file enforces.
 *
 * WHAT IS DELIBERATELY NOT HERE, and why it matters that it is not:
 *   - No STAMINA BALANCE. Stamina is an on-chain balance (`StakingManager.stamina`);
 *     this ledger counts what was SPENT per day, it does not hold the balance and
 *     it cannot confiscate one. That is why the daily cap in `content.js` is a
 *     throttle rather than a clawback.
 *   - No STREAK CAP. `recordGradedCompletion` counts days; where a streak stops
 *     paying out is economic policy owned by another module, and a cap applied
 *     at WRITE time would be baked into rows already on disk — the policy would
 *     become retroactively unreviewable and un-auditable. The cap belongs at
 *     READ time, where it can change without rewriting history.
 *
 * ===========================================================================
 * THE GOVERNOR LEDGER (`getGovernorSpend` … `getGovernorSpendTotal`)
 * ===========================================================================
 * Founder Strategy S1+S2 adds a GOVERNOR: a season runs for a 30-day window
 * and emits at most a fixed DAILY budget (110,000 CATT/day against a
 * 3,300,000 CATT season allocation). Before the reward path scales a reward
 * down it must ask one question — HOW MUCH OF TODAY'S BUDGET IS ALREADY SPENT —
 * and that question is answered by exactly one row per (season, business day).
 *
 * GOVERNOR SPEND IS NOT `season_claims`. THE DISTINCTION IS LOAD-BEARING:
 *   `season_claims` (recordSeasonClaim / getSeasonClaimedTotal) is the
 *   SETTLEMENT RECORD: one immutable row per (season, user, nonce), the audit
 *   trail of what a specific wallet was actually credited, idempotent on its
 *   nonce, and the number reconciled against the season allocation at
 *   settlement.
 *   the governor ledger (getGovernorSpend / recordGovernorSpend) is the BUDGET
 *   COUNTER: one mutable running total per (season, day), with no user, no
 *   nonce and no idempotency, because what it answers is "how much of TODAY is
 *   gone", not "what did anyone claim".
 *   They are DIFFERENT QUANTITIES and are never derived from one another. A
 *   reward that is scaled down to fit the daily budget still lands in
 *   `season_claims` at its SCALED value, so the two can differ for the same
 *   event by exactly the amount the governor held back. Deriving the daily
 *   counter from `season_claims` would be wrong in both directions at once: a
 *   settlement record cannot answer "how much of today" (it is per user, and
 *   counting only graded claims would miss every other way emission leaves the
 *   Judge), and a budget counter cannot answer "what was this user credited"
 *   (it has no user dimension at all). This file keeps them as two tables with
 *   two jobs; the Postgres DDL for the new one is beside the migration list in
 *   `./sqlite-store.js`.
 *
 * SAME ONE RULE AS EVERY OTHER LEDGER HERE: `dayKey` IS A CALLER-SUPPLIED
 * `YYYY-MM-DD` WIB BUSINESS-DAY STRING (see `reset-schedule.js`, which rolls at
 * 21:00 UTC / 04:00 WIB) AND THE STORE NEVER READS A CLOCK. Nothing in this
 * ledger derives a day, expires a day, or carries a day forward: a new
 * `dayKey` starts at `"0"` by construction, which is why there is no reset
 * method (see `recordGovernorSpend` below) and why yesterday's spend can never
 * be mistaken for today's.
 *
 * `spent` is a CANONICAL DECIMAL STRING, never a number. A daily budget is an
 * 18-decimal CATT amount: 110,000 CATT is 1.1e23 base units, which is not
 * merely imprecise as a JavaScript double (it is past 2^53) but OUT OF RANGE
 * for a signed 64-bit SQLite INTEGER, which tops out at 9.22e18. A ledger that
 * rounds a daily budget can overshoot the very ceiling it exists to enforce.
 *
 * A `season_id` THAT NAMES NO SEASON IS REFUSED. A budget row for a season that
 * does not exist is a spend that reconciles against nothing and cannot be
 * scaled or audited, so the SQLite adapter enforces this with a FOREIGN KEY to
 * `seasons(id)` and the memory store checks the same thing in application code
 * — the two must agree, or a caller would get a working ledger on one adapter
 * and a refusal on the other.
 *
 * POSTGRES DDL for the governor table is documented beside the migration list
 * in `./sqlite-store.js`, next to the SQLite version it mirrors.
 *
 * ===========================================================================
 * STORAGE ADAPTERS (`STORAGE_ADAPTERS` below)
 * ===========================================================================
 * Two adapters implement the interface frozen in `STORAGE_METHODS`:
 *
 *   memory  `createMemoryStore()` — the default. Process-local, volatile, and
 *          what every test uses. Chosen unless an operator explicitly asks for
 *          something else, so the default behaviour of the Judge is unchanged.
 *
 *   sqlite  `./sqlite-store.js` — the same contract, backed by a single
 *          SQLite file through `better-sqlite3`. Sessions, telemetry,
 *          submissions, the per-user nonce counter, issued claims and relay
 *          records survive a process restart, and the nonce/relay invariants
 *          that the memory store only holds in application code are additionally
 *          enforced by `UNIQUE (user_address, nonce)` and
 *          `UNIQUE (relayed_tx_hash)` IN THE SCHEMA. This is the
 *          single-node / testnet persistence layer; the Postgres adapter the
 *          DDL above describes remains the production target, and the
 *          migration note at the top of `sqlite-store.js` covers moving data
 *          from one to the other.
 *
 * Neither adapter is imported eagerly here: `sqlite-store.js` requires this
 * module (for `STORAGE_METHODS` and `assertStoreShape`), so the reference is
 * lazy and lives in `STORAGE_ADAPTERS[].load()`. A process that never selects
 * the SQLite adapter therefore never loads the native module.
 */

/**
 * The frozen list of method names the storage interface requires. An
 * implementation is only accepted by `assertStoreShape` if it exposes a
 * function for every one of these, and `createApp()` calls that check exactly
 * once at construction time so a half-implemented Postgres adapter fails at
 * boot with a precise message instead of at the first claim.
 *
 * @type {ReadonlyArray<string>}
 */
const STORAGE_METHODS = Object.freeze([
  "init",
  "createSession",
  "getSession",
  "appendTelemetry",
  "getTelemetry",
  "saveSubmission",
  "listRecentSubmissions",
  "reserveNonce",
  "isNonceUsed",
  "recordIssuedClaim",
  "getIssuedClaim",
  "markRelayed",
  // Growth ledgers: per-day stamina spend, streaks, free-stamina grants,
  // seasons and their claims, and the daily active-miner count.
  "getStaminaConsumed",
  "recordStaminaConsumption",
  "getStreak",
  "recordGradedCompletion",
  "getFreeStaminaGranted",
  "recordFreeStaminaGrant",
  "getSeason",
  "saveSeason",
  "getActiveSeason",
  "recordSeasonClaim",
  "getSeasonClaimedTotal",
  "getSeasonUserAccrued",
  "isSeasonClaimUsed",
  "countActiveMiners",
  // Governor ledger: the per-DAY, per-SEASON emission budget counter. A
  // different quantity from the season claimed total above — see the header
  // note on why the two are never derived from one another.
  "getGovernorSpend",
  "recordGovernorSpend",
  "getGovernorSpendTotal",
  "close",
  "dispose",
]);

/**
 * Canonical form of a `dayKey`: a trimmed `YYYY-MM-DD` that names a REAL
 * calendar day. The day is a WIB BUSINESS day (it rolls at 04:00 WIB / 21:00
 * UTC — see `reset-schedule.js`), but the check below is frame-independent: a
 * business day is still a calendar date, so this validates the same strings it
 * always did.
 *
 * Shared by both adapters on purpose. The alternative — each adapter
 * reimplementing "is this a day key" — is how two adapters end up accepting
 * slightly different keys and silently writing to different buckets, which is
 * precisely the divergence the parity test exists to prevent.
 *
 * The calendar check is real, not just a shape check: `2026-02-30` is a
 * well-formed string that no day ever names, and a ledger bucket keyed by it
 * would be a bucket nothing can ever roll over into. It is refused here instead
 * of being discovered as a streak that mysteriously never advances.
 *
 * @param {*} value Candidate day key.
 * @returns {string} The canonical `YYYY-MM-DD`.
 * @throws {TypeError} If `value` is not a real `YYYY-MM-DD` calendar day.
 */
function normalizeDayKey(value) {
  if (typeof value !== "string") {
    throw new TypeError("dayKey must be a caller-supplied YYYY-MM-DD string.");
  }
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new TypeError(`dayKey must be a YYYY-MM-DD string, got ${JSON.stringify(value)}.`);
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
    throw new TypeError(`dayKey ${JSON.stringify(value)} is not a real calendar day.`);
  }
  return text;
}

/**
 * True when `to` is the IMMEDIATE NEXT business day after `from`.
 *
 * "Immediate next day" is computed through `Date.UTC` on the parsed parts, which
 * is what makes month, year and leap boundaries fall out correctly instead of
 * being a special case: `2024-02-28 -> 2024-02-29` is next, `2023-02-28 ->
 * 2023-03-01` is next, `2024-12-31 -> 2025-01-01` is next, and `2024-03-01` is
 * NOT the next day after `2024-02-28` (there is a leap day in between).
 *
 * `Date.UTC` is a pure function of its arguments — it is not a clock read, so
 * using it here keeps the store's "never read a clock" promise intact.
 *
 * WIB NOTE (REPORTED, NOT REWRITTEN): this is pure calendar arithmetic on two
 * day-KEY STRINGS, and that is exactly why it needs no change for the 04:00 WIB
 * rule. The 21:00-UTC rollover is applied once, upstream, when the caller turns
 * an instant into a day key (`content.js#dayKeyFor` -> `reset-schedule.js`);
 * once a key is in hand, "the next day" is a property of the calendar, not of a
 * timezone. Consecutive WIB keys differ by exactly 86400 s because WIB is a
 * fixed UTC+7 with no DST, so the 24-hour test below remains the right test. The
 * alternative — routing this through an instant-aware helper — would add a
 * timezone dependency to a layer whose whole design principle is that it has
 * none, and would change nothing observable.
 *
 * @param {string} from The earlier day key.
 * @param {string} to The later day key.
 * @returns {boolean}
 */
function isNextDayAfter(from, to) {
  const start = Date.parse(`${normalizeDayKey(from)}T00:00:00.000Z`);
  const end = Date.parse(`${normalizeDayKey(to)}T00:00:00.000Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end - start === 86400000;
}

/**
 * Throws if `store` does not implement every method named in
 * `STORAGE_METHODS`. Called from `createApp()` so a future database adapter
 * that forgets, say, `isNonceUsed` cannot start serving traffic.
 *
 * @param {Object} store Candidate store implementation.
 * @returns {Object} The same `store`, for convenient chaining.
 * @throws {Error} If `store` is not an object, or any required method is missing.
 */
function assertStoreShape(store) {
  if (store === null || typeof store !== "object") {
    throw new Error("assertStoreShape: store must be an object exposing the storage interface.");
  }
  const missing = STORAGE_METHODS.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      "assertStoreShape: store is missing required method(s): " + missing.join(", ") + ". " +
        "A storage adapter must implement all of: " + STORAGE_METHODS.join(", ") + "."
    );
  }
  return store;
}

/**
 * Deep-copies a value so that a caller mutating what it handed to the store
 * (or a store handing back a stored object) cannot corrupt stored state. The
 * memory store has no serialisation boundary, so this stands in for the copy
 * Postgres gives for free.
 *
 * @param {*} value Any JSON-ish value.
 * @returns {*} A structurally independent copy.
 */
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

/**
 * Canonical comparison form of an address filter: lowercase text, or `null` for
 * "no filter".
 *
 * `listRecentSubmissions` compares addresses with `===`, and `0xAbC…` and
 * `0xabc…` are the same wallet — the same reason `claimKey` lowercases its key.
 * Without this, an honest user who submits once with a checksummed address and
 * once with the lowercase form would have their own earlier text back in their
 * own corpus (the exclusive filter would miss), which is exactly residual risk
 * #3 reappearing through casing.
 *
 * ABSENT IS `null`, and so is anything that cannot be an address (`""`, a
 * whitespace-only string). A blank filter must mean "do not filter", never
 * "match nothing": the syndicate corpus asking for "everyone except ''" must
 * still get everyone.
 *
 * @param {*} value Candidate address, or an absent/null filter.
 * @returns {string|null} Lowercase address, or `null` for "no filter".
 */
function _addressScope(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text === "" ? null : text;
}

/**
 * Creates an isolated in-memory store.
 *
 * Every call returns fresh state, so two stores (or two test cases sharing a
 * helper) can never see each other's sessions, telemetry, nonces or claims.
 * Every method is `async` even though nothing here awaits: the interface is
 * async on purpose so that swapping in a real network-backed client requires
 * no change at the call sites.
 *
 * @returns {Object} A store implementing `STORAGE_METHODS`.
 */
function createMemoryStore() {
  /** @type {Map<string, { sessionId: string, userAddress: string, missionId: string, createdAt: number }>} */
  const sessions = new Map();
  /** @type {Map<string, Array<Object>>} Insertion-ordered sample arrays, keyed by sessionId. */
  const telemetry = new Map();
  /** @type {Map<string, Object>} Raw submission records keyed by the internal id string. */
  const submissions = new Map();
  /** @type {Array<Object>} All submissions newest-first; index 0 is the newest. */
  const submissionOrder = [];
  /** @type {Map<string, number>} Per-user nonce counter; the value is the LAST nonce handed out. */
  const nonceCounters = new Map();
  /** @type {Map<string, Object>} Issued claims keyed by `${userAddress}:${nonce}`. */
  const issuedClaims = new Map();
  /** @type {Map<string, bigint>} Per-day stamina SPENT, keyed `${userAddress}|${dayKey}`. */
  const staminaLedger = new Map();
  /** @type {Map<string, Object>} One streak row per user, keyed by lowercase address. */
  const streaks = new Map();
  /** @type {Map<string, bigint>} Per-day free-stamina grants, keyed `${userAddress}|${dayKey}`. */
  const freeGrants = new Map();
  /** @type {Map<string, Object>} Season rows keyed by season id. */
  const seasons = new Map();
  /** @type {Map<string, bigint>} Season claims keyed `${seasonId}|${userAddress}|${nonce}`. */
  const seasonClaims = new Map();
  /** @type {Map<string, Set<string>>} Distinct users active per day, keyed by day key. */
  const activeMiners = new Map();
  /** @type {Map<string, bigint>} Governor emission SPENT per day, keyed `${seasonId}|${dayKey}`. */
  const governorSpend = new Map();
  /** Monotonic submission id. Starts at 1 so id 0 is never a valid id. */
  let nextSubmissionId = 1;
  /** Monotonic insertion counter used to give telemetry a stable order. */
  let telemetrySeq = 0;

  /**
   * The key an issued claim is stored under.
   *
   * Addresses are compared case-INSENSITIVELY: a client may present the
   * checksummed form it received from `/api/submit` while a lookup elsewhere
   * uses the lowercase form, and those are the same user. Normalising here
   * means a relay attempt can never miss the issuance record (and therefore
   * skip the cross-check) purely because of address casing. The nonce is
   * normalised to a number for the same reason.
   *
   * @param {string} userAddress Wallet address.
   * @param {number|string} nonce Claim nonce.
   * @returns {string} Storage key.
   */
  function claimKey(userAddress, nonce) {
    return `${String(userAddress).toLowerCase()}:${Number(nonce)}`;
  }

  /**
   * The key a per-day ledger row is stored under. Addresses are lowercased for
   * the same reason `claimKey` does it: `0xAbC…` and `0xabc…` are one wallet,
   * and two buckets per wallet would halve every cap that reads the ledger.
   *
   * @param {string} userAddress Wallet address.
   * @param {string} dayKey Canonical `YYYY-MM-DD`.
   * @returns {string}
   */
  function dayBucketKey(userAddress, dayKey) {
    return `${String(userAddress).toLowerCase()}|${dayKey}`;
  }

  /**
   * Coerces a ledger amount to an exact `bigint`.
   *
   * `bigint` is used rather than `Number` for the ACCUMULATOR even though real
   * stamina amounts are single-digit points, because a ledger that silently
   * rounds is a ledger that cannot be trusted: a runaway caller must produce an
   * exact number or an error, never a plausible-looking total that is wrong.
   *
   * @param {*} value Candidate amount.
   * @param {string} label Field name for the error message.
   * @returns {bigint}
   * @throws {TypeError} If `value` is not a non-negative integer amount.
   */
  function toExactAmount(value, label) {
    if (value === null || value === undefined) {
      throw new TypeError(`${label} is required and must be a non-negative integer amount.`);
    }
    if (typeof value === "bigint") {
      if (value < 0n) throw new TypeError(`${label} must not be negative, got ${value}.`);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new TypeError(`${label} must be a non-negative integer amount, got ${String(value)}.`);
      }
      return BigInt(value);
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return BigInt(value.trim());
    }
    throw new TypeError(`${label} must be a non-negative integer amount, got ${JSON.stringify(value)}.`);
  }

  /**
   * Marks one user active on one day, idempotently. Used by
   * `recordGradedCompletion` to maintain the durable per-day active set that
   * `countActiveMiners` reads.
   *
   * @param {string} userAddress Lowercased wallet address.
   * @param {string} dayKey Canonical `YYYY-MM-DD`.
   * @returns {void}
   */
  function markActive(userAddress, dayKey) {
    const bucket = activeMiners.get(dayKey) || new Set();
    bucket.add(userAddress);
    activeMiners.set(dayKey, bucket);
  }

  /**
   * The total claimed from a season across every user.
   *
   * @param {string} seasonId Season id.
   * @returns {bigint}
   */
  function getSeasonTotal(seasonId) {
    let total = 0n;
    for (const [key, value] of seasonClaims.entries()) {
      if (key.startsWith(`${seasonId}|`)) total += value;
    }
    return total;
  }

  /**
   * Everything one user has accrued from a season.
   *
   * @param {string} seasonId Season id.
   * @param {string} userAddress Lowercased wallet address.
   * @returns {bigint}
   */
  function getUserAccrued(seasonId, userAddress) {
    let total = 0n;
    for (const [key, value] of seasonClaims.entries()) {
      if (key.startsWith(`${seasonId}|${userAddress}|`)) total += value;
    }
    return total;
  }

  /**
   * The key a governor ledger row is stored under.
   *
   * There is NO user dimension here and that is deliberate: the counter answers
   * "how much of TODAY'S season budget is already committed", which is a
   * property of the (season, day) bucket and nothing else. There is no
   * address to normalise, and no nonce, so there is nothing here that two
   * spellings of the same value could disagree about.
   *
   * @param {string} seasonId Season id.
   * @param {string} dayKey Canonical `YYYY-MM-DD` WIB business day.
   * @returns {string} Storage key.
   */
  function governorKey(seasonId, dayKey) {
    return `${seasonId}|${dayKey}`;
  }

  /**
   * Canonical season id, refusing one that names no season.
   *
   * The SQLite adapter gets this from a FOREIGN KEY to `seasons(id)`; the
   * memory store has to say the same thing in application code, or the two
   * adapters would disagree about whether an unknown season is writable. The
   * refusal is the safe direction: a budget row for a season that does not
   * exist reconciles against nothing.
   *
   * @param {*} seasonId Candidate season id.
   * @returns {string} The canonical season id.
   * @throws {Error} If no such season has been saved.
   */
  function knownSeason(seasonId) {
    const season = String(seasonId);
    if (!seasons.has(season)) {
      throw new Error(
        `store: governor spend references unknown season ${JSON.stringify(season)}. ` +
          "A daily emission budget belongs to a season row that exists."
      );
    }
    return season;
  }

  /**
   * Everything one season has spent against its daily budgets, across every day.
   *
   * @param {string} seasonId Season id.
   * @returns {bigint}
   */
  function governorSeasonTotal(seasonId) {
    let total = 0n;
    for (const [key, value] of governorSpend.entries()) {
      if (key.startsWith(`${seasonId}|`)) total += value;
    }
    return total;
  }

  /**
   * Ensures a session row exists. Telemetry is allowed to arrive before (or
   * entirely without) an explicit `POST /api/session`, so this auto-creates a
   * minimal record rather than dropping data on the floor.
   *
   * @param {string} sessionId Session identifier.
   * @returns {Object} The stored session record.
   */
  function ensureSession(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        userAddress: null,
        missionId: null,
        createdAt: Date.now(),
      };
      sessions.set(sessionId, session);
    }
    return session;
  }

  const store = {
    /**
     * Optional warm-up hook (a Postgres adapter would `await pool.query` /
     * run migrations here). A no-op for the memory store.
     *
     * @returns {Promise<void>}
     */
    async init() {
      /* nothing to warm up */
    },

    /**
     * Registers a mining session.
     *
     * A repeat call for the SAME `sessionId` and the SAME `userAddress` is a
     * no-op beyond refreshing `createdAt`: it must NOT wipe the telemetry that
     * the client has already streamed, because the mobile app re-registers on
     * app resume / navigation and dropping samples there would silently
     * destroy the Proof-of-Attention record the user is still earning against.
     * A repeat call that carries a DIFFERENT `userAddress` is left to the HTTP
     * layer to reject with 409 — the store records, it does not adjudicate.
     *
     * Postgres: `INSERT ... ON CONFLICT (session_id) DO NOTHING` (the unique
     * index on `session_id` is what makes the insert idempotent).
     *
     * @param {Object} params
     * @param {string} params.sessionId Client-generated session id.
     * @param {string} params.userAddress Wallet address the session belongs to.
     * @param {string} params.missionId Mission the user opened.
     * @returns {Promise<Object>} The stored session record.
     */
    async createSession({ sessionId, userAddress, missionId }) {
      const existing = sessions.get(sessionId);
      if (existing) {
        if (missionId && !existing.missionId) existing.missionId = missionId;
        return clone(existing);
      }
      const session = {
        sessionId,
        userAddress: userAddress ?? null,
        missionId: missionId ?? null,
        createdAt: Date.now(),
      };
      sessions.set(sessionId, session);
      return clone(session);
    },

    /**
     * Reads back a session.
     *
     * Postgres: `SELECT * FROM sessions WHERE session_id = $1`.
     *
     * @param {string} sessionId Session identifier.
     * @returns {Promise<Object|undefined>} The session, or `undefined` if unknown.
     */
    async getSession(sessionId) {
      const session = sessions.get(sessionId);
      return session ? clone(session) : undefined;
    },

    /**
     * Appends a batch of telemetry samples to a session. APPENDS, never
     * replaces: the client POSTs every 5 seconds (PRD 3.1) and each batch must
     * extend the record. A client that never called the create endpoint still
     * gets its samples stored, because the session record is auto-created.
     *
     * Postgres: a multi-row `INSERT INTO telemetry (...) VALUES ...` inside one
     * transaction; the surrogate `id` supplies the ordering.
     *
     * @param {string} sessionId Session identifier.
     * @param {Array<Object>} samples Telemetry samples in client order.
     * @returns {Promise<number>} The total number of samples now stored for the session.
     */
    async appendTelemetry(sessionId, samples) {
      ensureSession(sessionId);
      const bucket = telemetry.get(sessionId) || [];
      for (const sample of samples || []) {
        telemetrySeq += 1;
        bucket.push({ _seq: telemetrySeq, ...clone(sample) });
      }
      telemetry.set(sessionId, bucket);
      return bucket.length;
    },

    /**
     * Returns the flat, insertion-ordered sample array for a session. The
     * Judge hands this straight to `anticheat.evaluateTelemetry`, which is why
     * it is flat (not grouped per batch) and ordered: reading-speed analysis is
     * meaningless out of order.
     *
     * Postgres: `SELECT ts, battery_temp_c, touch_x, touch_y, scroll_delta
     * FROM telemetry WHERE session_id = $1 ORDER BY id ASC`.
     *
     * @param {string} sessionId Session identifier.
     * @returns {Promise<Array<Object>>} Samples in insertion order; `[]` if unknown.
     */
    async getTelemetry(sessionId) {
      const bucket = telemetry.get(sessionId);
      return bucket ? bucket.map(clone) : [];
    },

    /**
     * Persists a judged submission, PASS or FAIL. Every submit is stored,
     * including failures: the FAIL rows are what syndicate detection reads,
     * and they are the audit trail for a dispute.
     *
     * Postgres: a single `INSERT INTO submissions (...)` with a
     * `bigserial PRIMARY KEY`; the returned `id` is the monotonic ordering key
     * and `submitted_at` (server clock) is the recency key.
     *
     * @param {Object} params
     * @param {string} params.sessionId Session the submission came from.
     * @param {string} params.userAddress Submitting wallet.
     * @param {string} params.missionId Mission judged.
     * @param {*} params.answers Raw quiz answers.
     * @param {string} params.highlight Raw highlight text.
     * @param {number} params.typingMs Total typing time reported by the client.
     * @param {string} params.freeText Optional free-text answer (syndicate input).
     * @param {Object} params.result Verdict from `anticheat.evaluateSubmission`.
     * @returns {Promise<Object>} The stored record, including `id` and `submittedAt`.
     */
    async saveSubmission({
      sessionId,
      userAddress,
      missionId,
      answers,
      highlight,
      typingMs,
      freeText,
      result,
    }) {
      const record = {
        id: nextSubmissionId,
        sessionId: sessionId ?? null,
        userAddress: userAddress ?? null,
        missionId: missionId ?? null,
        submittedAt: Date.now(),
        answers: clone(answers ?? null),
        highlight: typeof highlight === "string" ? highlight : "",
        typingMs: typeof typingMs === "number" ? typingMs : 0,
        freeText: typeof freeText === "string" ? freeText : "",
        result: clone(result ?? null),
      };
      nextSubmissionId += 1;
      submissions.set(String(record.id), record);
      submissionOrder.unshift(record);
      return clone(record);
    },

    /**
     * Lists recent submissions, NEWEST FIRST, optionally filtered by address.
     *
     * TWO INDEPENDENT, COMPOSABLE FILTERS, both applied to the SAME
     * newest-first ordering:
     *
     *   `userAddress`         INCLUSIVE  — "ONLY this user". Offered for
     *                                    debugging and for a future "my
     *                                    submission history" screen. NOT the
     *                                    syndicate mode on its own: a syndicate
     *                                    is a GROUP of submitters copying each
     *                                    other, and a per-user query can never
     *                                    see the copy.
     *
     *   `excludeUserAddress`  EXCLUSIVE  — "everyone BUT this user". This is
     *                                    the syndicate corpus: the recent
     *                                    submissions of OTHER users. It exists
     *                                    for RESIDUAL RISK #3, the self-
     *                                    comparison false positive. With only
     *                                    the inclusive filter available, the
     *                                    syndicate path either (a) kept the
     *                                    submitter's own earlier rows in the
     *                                    corpus and refused an honest user who
     *                                    wrote the same summary twice
     *                                    (similarity 1.0 against themselves), or
     *                                    (b) restricted the corpus to the
     *                                    submitter alone and saw no ring at all.
     *                                    Neither is acceptable, so the corpus is
     *                                    the cross-user window MINUS ONE
     *                                    ADDRESS — not "other users I share
     *                                    something with", and not "one user".
     *
     * THE FOUR COMBINATIONS, all independent and all meaningful:
     *
     *   neither              EVERY user. The pre-existing behaviour, and the
     *                         one the relay path and any future admin view
     *                         depend on. Unchanged.
     *   `userAddress` only   ONLY that user.
     *   `excludeUserAddress` EVERY user except that one. The syndicate case.
     *   BOTH, and the two
     *   addresses DIFFER     ONLY `userAddress`, and the exclusion is then a
     *                         no-op because no row can be both. Returned as
     *                         that user's rows.
     *   BOTH, and the two
     *   addresses are EQUAL  DEGENERATE, and it returns NOTHING. "Only this
     *                         user, but not this user" is the empty set; it is
     *                         NOT silently downgraded to "only this user" (that
     *                         would quietly turn a caller's intent inside out)
     *                         and NOT silently dropped (that would return
     *                         everyone, the one interpretation that leaks the
     *                         very history the caller excluded). Callers that
     *                         want one user's rows must not pass the same
     *                         address as both filters.
     *
     * ADDRESSES ARE COMPARED CASE-INSENSITIVELY, like `claimKey` above and
     * unlike the raw `===` a naive implementation would use. An honest user
     * who submits once with a checksummed address and once with the lowercase
     * form is the SAME wallet, and a case-sensitive exclusion would let their
     * own earlier text back into their own corpus — which is precisely the
     * false positive this parameter exists to remove, reintroduced through
     * address casing.
     *
     * `limit` is applied AFTER filtering, so it always counts rows the caller
     * actually receives: excluding the submitter's own rows never silently
     * shrinks the window from 50 to fewer. A submission row with no recorded
     * address (`userAddress === null`) belongs to nobody and is therefore kept
     * by the exclusive filter and dropped by the inclusive one, in both
     * adapters.
     *
     * THE EXCLUSION DOES NOT CLOSE RESIDUAL RISK #2. The corpus is still a
     * BOUNDED RECENT WINDOW (50 submissions), so the paraphrase and
     * lookback-evasion weakness measured in `test/red-team.test.js` (ATTACK 4d)
     * survives this parameter unchanged, and a ring of two or more distinct
     * addresses is still fully visible to every member after its own rows are
     * removed. This is a false-positive fix, not a syndicate-detection fix.
     *
     * Postgres:
     * `SELECT * FROM submissions [WHERE user_address = $2] [AND user_address <> $3]
     *  ORDER BY submitted_at DESC, id DESC LIMIT $1`. Ordering by `id DESC` as a
     * tiebreaker keeps the order total and deterministic when several
     * submissions land inside one clock tick.
     *
     * @param {Object} [params]
     * @param {string} [params.userAddress INCLUSIVE filter: ONLY this wallet.
     * @param {string} [params.excludeUserAddress EXCLUSIVE filter: everyone but
     *   this wallet. The syndicate corpus. See the four combinations above.
     * @param {number} [params.limit] Maximum rows AFTER filtering; defaults to 50.
     * @returns {Promise<Array<Object>>} Newest-first submission records.
     */
    async listRecentSubmissions({ userAddress, excludeUserAddress, limit } = {}) {
      const max = Number.isInteger(limit) && limit > 0 ? limit : 50;
      const include = _addressScope(userAddress);
      const exclude = _addressScope(excludeUserAddress);
      const scoped =
        include === null && exclude === null
          ? submissionOrder
          : submissionOrder.filter((row) => {
              const who = _addressScope(row.userAddress);
              if (include !== null && who !== include) return false;
              if (exclude !== null && who === exclude) return false;
              return true;
            });
      return scoped.slice(0, max).map(clone);
    },

    /**
     * Reserves and returns the next NEVER-BEFORE-USED nonce for a user.
     *
     * This is the security-critical method. The counter is advanced on every
     * call, before the caller has signed anything, so a nonce handed out and
     * then abandoned (crash, 500, dropped request) is permanently retired and
     * can never be reissued. Reissuing it would be a duplicate payment waiting
     * to be claimed twice: `MiningClaimer` would accept the first claim and
     * reject the second, but the user would be stuck holding a signature that
     * can never settle, and the accounting would disagree with the chain.
     * Burning the nonce is the safe direction: a gap in a user's nonce
     * sequence costs nothing (the contract only requires uniqueness, not
     * consecutiveness — see the `usedNonces` doc comment in MiningClaimer.sol).
     *
     * Atomicity: in this process the read-modify-write below is synchronous
     * and therefore indivisible between awaits, which is what makes concurrent
     * submits safe. In Postgres the same guarantee comes from the sequence
     * row lock / `UNIQUE(user_address, nonce)` on `issued_claims`, and the
     * caller would insert the row in the SAME transaction that reserved it.
     *
     * @param {string} userAddress Wallet address.
     * @returns {Promise<number>} The reserved nonce. 1 for a user's first claim.
     */
    async reserveNonce(userAddress) {
      // The counter itself starts at 0 and is incremented on every call, so the
      // first nonce a user ever receives is 1. `0` is therefore never handed
      // out, which keeps "no nonce has ever been issued" distinguishable from
      // "nonce 0 was issued".
      const next = (nonceCounters.get(userAddress) || 0) + 1;
      nonceCounters.set(userAddress, next);
      return next;
    },

    /**
     * Reports whether a nonce has already been reserved for a user.
     *
     * This mirrors `MiningClaimer.isNonceUsed(user, nonce)` so an operator can
     * compare the backend's view against the chain's. The two are expected to
     * DIVERGE in exactly one direction: the backend may hold a reserved nonce
     * the chain has not seen (reserved, signed, never claimed), but the chain
     * must never hold a used nonce the backend has not handed out.
     *
     * Postgres: `SELECT 1 FROM issued_claims WHERE user_address = $1 AND nonce = $2`.
     *
     * @param {string} userAddress Wallet address.
     * @param {number|string} nonce Nonce to test.
     * @returns {Promise<boolean>} True if the nonce was already reserved.
     */
    async isNonceUsed(userAddress, nonce) {
      const current = nonceCounters.get(userAddress);
      if (current === undefined) return false;
      return Number(nonce) > 0 && Number(nonce) <= current;
    },

    /**
     * Records what was ACTUALLY signed for a nonce, so a disputed claim can be
     * replayed, audited and compared against the chain's event log without
     * re-signing. Deliberately separate from `reserveNonce`: reserving is a
     * "this nonce is spent forever" promise, recording is the "here is the
     * artefact" fact. A reservation with no record is expected (signed but
     * never claimed, or reserved and abandoned); a record with no reservation
     * is a bug and would be caught by the DB's foreign key.
     *
     * Postgres: `INSERT INTO issued_claims (...) VALUES (...)`, whose
     * `UNIQUE(user_address, nonce)` doubles as the nonce-reuse backstop.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet the claim is for.
     * @param {number|string} params.nonce Reserved nonce.
     * @param {string} [params.sessionId] Session that produced the claim.
     * @param {string} params.digest EIP-712 digest that was signed.
     * @param {*} params.reward Signed reward amount.
     * @param {*} params.staminaCost Signed stamina cost.
     * @param {number} params.deadline Signed expiry, unix seconds.
     * @param {string} params.signature 65-byte ECDSA signature.
     * @returns {Promise<Object>} The stored claim record.
     */
    async recordIssuedClaim({
      userAddress,
      nonce,
      sessionId,
      digest,
      reward,
      staminaCost,
      deadline,
      signature,
    }) {
      const record = {
        userAddress: userAddress ?? null,
        nonce: Number(nonce),
        sessionId: sessionId ?? null,
        digest: digest ?? null,
        reward: reward ?? null,
        staminaCost: staminaCost ?? null,
        deadline: deadline ?? null,
        signature: signature ?? null,
        issuedAt: Date.now(),
        // Relay bookkeeping: null until a gasless relay broadcast settles.
        relayerTxHash: null,
        relayedAt: null,
      };
      const key = claimKey(record.userAddress, record.nonce);
      const existing = issuedClaims.get(key);
      if (existing) {
        // Re-issuing an existing (user, nonce) must never silently discard the
        // relay record: if the claim was already relayed, that fact survives.
        record.relayerTxHash = existing.relayerTxHash ?? null;
        record.relayedAt = existing.relayedAt ?? null;
        record.issuedAt = existing.issuedAt;
      }
      issuedClaims.set(key, record);
      return clone(record);
    },

    /**
     * Reads back the issuance record for a nonce, or `undefined` when this
     * backend never issued it.
     *
     * Used by `POST /api/relay` as a CROSS-CHECK: a claim the Judge issued
     * must carry exactly the reward, stamina cost and deadline that were
     * signed. Absence is not an error — a user claiming from a different
     * client, or against a backend that restarted with an empty store, has no
     * record here and is still allowed through, because the signature check
     * (`relay.validateClaimPayload`) is the actual authority on what was
     * signed. The record exists to catch a caller substituting different
     * amounts for an issuance it can name.
     *
     * @param {string} userAddress Wallet address.
     * @param {number|string} nonce Claim nonce.
     * @returns {Promise<Object|undefined>} `{ userAddress, nonce, sessionId, digest,
     *   reward, staminaCost, deadline, signature, relayerTxHash }`, or `undefined`.
     */
    async getIssuedClaim(userAddress, nonce) {
      const record = issuedClaims.get(claimKey(userAddress, nonce));
      return record ? clone(record) : undefined;
    },

    /**
     * Records that a gasless relay broadcast a claim's transaction, ONCE.
     *
     * THE DOUBLE-SPEND GUARD. A nonce may be relayed AT MOST ONCE. This is
     * not an optimisation — it is what stops a mobile app on a flaky
     * connection from paying out twice: the app retries `POST /api/relay`
     * whenever the first request looks like it failed (which it may well have
     * succeeded), and without this the retry would broadcast the same
     * signature a second time. On-chain `usedNonces` would reject the second
     * one and revert it, so the user would lose the gas and get a confusing
     * failure; here it is a clean, detectable `false` the HTTP layer turns into
     * a 409. The guard is deliberately placed AFTER the broadcast in the route
     * (so a lost connection is recorded rather than repeated) and re-checked
     * on the way in.
     *
     * Idempotent by NON-repetition, not by ignoring the second call: a nonce
     * that already carries a `relayerTxHash` is left untouched and `false` is
     * returned, so the caller can distinguish "I recorded this" from "somebody
     * else already did".
     *
     * A nonce with NO existing issuance record still gets one, carrying only
     * the relay fields: an unrecorded-but-relayed claim must be just as
     * un-relayable as a recorded one.
     *
     * Postgres:
     * `UPDATE issued_claims SET relayed_tx_hash = $3, relayed_at = now()
     *  WHERE user_address = $1 AND nonce = $2 AND relayed_tx_hash IS NULL`
     * returning `rowCount === 1`; `rowCount === 0` is the already-relayed case.
     * `UNIQUE(relayed_tx_hash)` backstops it at the database level.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet the claim is for.
     * @param {number|string} params.nonce Claim nonce.
     * @param {string} params.txHash Transaction hash the relayer broadcast.
     * @returns {Promise<boolean>} True if this call performed the recording;
     *   false if the nonce had already been relayed.
     */
    async markRelayed({ userAddress, nonce, txHash } = {}) {
      const key = claimKey(userAddress, nonce);
      const record = issuedClaims.get(key);
      if (record && record.relayerTxHash) {
        // Already relayed: refuse, and do not overwrite the winning hash.
        return false;
      }
      const target = record || {
        userAddress: userAddress ?? null,
        nonce: Number(nonce),
        sessionId: null,
        digest: null,
        reward: null,
        staminaCost: null,
        deadline: null,
        signature: null,
        issuedAt: Date.now(),
      };
      target.relayerTxHash = txHash ?? null;
      target.relayedAt = Date.now();
      issuedClaims.set(key, target);
      return true;
    },

    /* ------------------------------------------------------------------ *
     * Growth ledgers. Pure mechanics, caller-supplied day keys, no clock  *
     * and no economics — see the header note above.                        *
     * ------------------------------------------------------------------ */

    /**
     * Stamina SPENT by one user on one UTC day.
     *
     * This is a SPEND counter, not a balance. Stamina itself is an on-chain
     * quantity (`StakingManager.stamina[account]`); this row exists so the daily
     * cap in `content.js` can be re-derived per day instead of being applied to
     * a lifetime total — which is exactly what makes unspent stamina roll over
     * instead of being confiscated.
     *
     * The returned amount is a canonical DECIMAL STRING, not a number. Points
     * are small in practice, but a counter that must be summed without loss
     * above 2^53 has one honest representation and it is text; returning a
     * number here would make exactness a property of how much a user spent.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<{ userAddress: string, dayKey: string, consumed: string }>}
     */
    async getStaminaConsumed({ userAddress, dayKey } = {}) {
      const key = dayBucketKey(userAddress, normalizeDayKey(dayKey));
      const consumed = staminaLedger.get(key) || 0n;
      return {
        userAddress: String(userAddress).toLowerCase(),
        dayKey: normalizeDayKey(dayKey),
        consumed: consumed.toString(),
      };
    },

    /**
     * ADDS `amount` to the day's spent total. It accumulates and never replaces:
     * three claims in one day must read back as the sum of all three, because the
     * cap is about the total a user spends, not about the last thing they did.
     *
     * A second write for the same (user, day) never erases the first, and the
     * day's row is keyed so that it CANNOT be duplicated — in the SQLite adapter
     * that is a PRIMARY KEY, so the constraint is in the schema rather than in
     * this line.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @param {number|string|bigint} params.amount Points spent by this claim.
     * @returns {Promise<{ userAddress: string, dayKey: string, consumed: string }>}
     *   The day's new total.
     */
    async recordStaminaConsumption({ userAddress, dayKey, amount } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = dayBucketKey(userAddress, day);
      const spent = toExactAmount(amount, "amount");
      const total = (staminaLedger.get(key) || 0n) + spent;
      staminaLedger.set(key, total);
      return {
        userAddress: String(userAddress).toLowerCase(),
        dayKey: day,
        consumed: total.toString(),
      };
    },

    /**
     * The user's current streak.
     *
     * `current` is 0 and `lastGradedDay` is `null` for a user who has never
     * completed a graded mission: zero and "one day" are different states and a
     * caller must be able to tell them apart.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @returns {Promise<{ userAddress: string, current: number, lastGradedDay: string|null }>}
     */
    async getStreak({ userAddress } = {}) {
      const row = streaks.get(String(userAddress).toLowerCase());
      return {
        userAddress: String(userAddress).toLowerCase(),
        current: row ? Number(row.current) : 0,
        lastGradedDay: row && row.lastGradedDay ? row.lastGradedDay : null,
      };
    },

    /**
     * Records one GRADED completion (a mission the Judge passed) and advances the
     * streak. The four cases, and why each is the only sane answer:
     *
     *   FIRST EVER         -> `1`. A streak of days is 1 long on the first day.
     *   SAME DAY AGAIN     -> UNCHANGED. Two missions in one calendar day must
     *                         not be two streak days; without this a user could
     *                         double their streak in a single UTC day and the
     *                         "consecutive days" claim would be false.
     *   IMMEDIATE NEXT DAY -> `+1`. A real rollover of the caller's day key,
     *                         computed from the parsed calendar parts, so month,
     *                         year and leap boundaries are ordinary cases rather
     *                         than special ones. The day key is already the WIB
     *                         business day (04:00 WIB rollover), so consecutive
     *                         keys are consecutive business days — see
     *                         `isNextDayAfter`.
     *   ANY OTHER DAY      -> reset to `1`. A gap breaks the chain. So does a
     *                         RETROACTIVE earlier day (`isNextDayAfter` is
     *                         direction-sensitive): back-filling an old day is
     *                         not "yesterday", and honouring it would let a
     *                         caller reconstruct a streak that never happened.
     *
     * NO CAP IS APPLIED HERE, DELIBERATELY. A cap on streak length is economic
     * policy owned by another module, and applying it at WRITE time would bake
     * the cap into rows that are already on disk — the policy would become
     * unreviewable and impossible to change without rewriting history. The store
     * counts; the policy decides what counting is worth.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day of the completion.
     * @param {number|string|bigint} [params.reward] Reward for the completion.
     *   Recorded as an audit fact only; nothing is derived from it here.
     * @param {string} [params.missionId] Mission completed. Audit fact only.
     * @returns {Promise<{ userAddress: string, current: number, lastGradedDay: string|null }>}
     */
    async recordGradedCompletion({ userAddress, dayKey, reward, missionId } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = String(userAddress).toLowerCase();
      const existing = streaks.get(key);
      let current;
      if (!existing) {
        current = 1;
      } else if (existing.lastGradedDay === day) {
        current = Number(existing.current);
      } else if (isNextDayAfter(existing.lastGradedDay, day)) {
        current = Number(existing.current) + 1;
      } else {
        current = 1;
      }
      streaks.set(key, {
        current,
        lastGradedDay: day,
        // Audit facts. Deliberately NOT part of the streak view: the view is the
        // mechanics, and the audit trail is the store's business.
        lastReward: reward === undefined ? null : toExactAmount(reward, "reward").toString(),
        lastMissionId: missionId === undefined || missionId === null ? null : String(missionId),
      });
      // The daily active set is a LEDGER, not a projection of the streak row:
      // yesterday must still count yesterday's users after today's completion has
      // moved `lastGradedDay` forward.
      markActive(key, day);
      return { userAddress: key, current, lastGradedDay: day };
    },

    /**
     * Free stamina GRANTED to one user on one UTC day, as a decimal string.
     * Zero when nothing was granted.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<{ userAddress: string, dayKey: string, granted: string }>}
     */
    async getFreeStaminaGranted({ userAddress, dayKey } = {}) {
      const day = normalizeDayKey(dayKey);
      const granted = freeGrants.get(dayBucketKey(userAddress, day)) || 0n;
      return { userAddress: String(userAddress).toLowerCase(), dayKey: day, granted: granted.toString() };
    },

    /**
     * Records a free-stamina grant against ONE day, accumulating within it.
     *
     * DAY ISOLATION IS THE WHOLE POINT. A grant made on day A must be invisible
     * on day B: the key is (user, day), never user alone, so there is no code
     * path by which "yesterday's free stamina" can be read as "today's". This is
     * also what lets a future daily-grant mechanism be replayed or audited a day
     * at a time without a ledger that has to be rewound.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @param {number|string|bigint} params.amount Points granted.
     * @returns {Promise<{ userAddress: string, dayKey: string, granted: string }>}
     *   That day's new total.
     */
    async recordFreeStaminaGrant({ userAddress, dayKey, amount } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = dayBucketKey(userAddress, day);
      const granted = toExactAmount(amount, "amount");
      const total = (freeGrants.get(key) || 0n) + granted;
      freeGrants.set(key, total);
      return { userAddress: String(userAddress).toLowerCase(), dayKey: day, granted: total.toString() };
    },

    /**
     * Reads one season by id, or `undefined` when there is no such season.
     *
     * @param {string} id Season id.
     * @returns {Promise<Object|undefined>} `{ id, start, end, allocation, claimMode }`.
     */
    async getSeason(id) {
      const season = seasons.get(String(id));
      return season ? clone(season) : undefined;
    },

    /**
     * Creates or REPLACES a season, keyed by `id`.
     *
     * Upsert, not insert-or-fail: an operator correcting a window or a claim mode
     * must not be blocked by the row already existing, and the id is the identity
     * so a repeat call with the same id is the same season by definition.
     *
     * `end: null` means OPEN-ENDED: the season has no closing instant, which is a
     * real state and not "missing" — so it is represented by `null` on both sides
     * rather than by a sentinel like `0` that `getActiveSeason` would have to
     * special-case.
     *
     * @param {Object} season
     * @param {string} season.id Season id.
     * @param {number} season.start Window start, unix SECONDS.
     * @param {number|null} [season.end] Window end, unix seconds, exclusive; `null`
     *   for an open-ended season.
     * @param {number|string|bigint} season.allocation Season allocation, an
     *   18-decimal CATT amount (stored and returned as an exact decimal string).
     * @param {string} season.claimMode Claim mode for the season.
     * @returns {Promise<Object>} The stored season.
     */
    async saveSeason({ id, start, end, allocation, claimMode } = {}) {
      const startSeconds = Math.trunc(Number(start));
      if (!Number.isFinite(startSeconds)) throw new TypeError("season.start must be unix seconds.");
      const endSeconds = end === null || end === undefined ? null : Math.trunc(Number(end));
      if (endSeconds !== null && !Number.isFinite(endSeconds)) {
        throw new TypeError("season.end must be unix seconds or null.");
      }
      const season = {
        id: String(id),
        start: startSeconds,
        end: endSeconds,
        allocation: toExactAmount(allocation, "allocation").toString(),
        claimMode: claimMode === null || claimMode === undefined ? null : String(claimMode),
      };
      seasons.set(season.id, season);
      return clone(season);
    },

    /**
     * The season covering an instant, or `undefined` when none does.
     *
     * THE WINDOW IS START-INCLUSIVE AND END-EXCLUSIVE: `[start, end)`. That is
     * not a preference, it is what makes BACK-TO-BACK SEASONS well defined. If
     * both windows were inclusive, season N's closing second would also be
     * season N+1's opening second and a claim landing there would have two
     * owners. With `[start, end)` the instants partition cleanly, and an open
     * ended season (`end === null`) is the one that owns everything from its
     * start onward.
     *
     * OVERLAP IS RESOLVED DETERMINISTICALLY: the candidate with the LATEST `start`
     * wins, ties broken by `id` ascending. Overlapping windows are an operator
     * mistake, not a design, and the alternative — returning whichever row the
     * planner happened to emit first — would make an allocation depend on
     * insertion order, which is exactly the kind of invisible difference between
     * two Judge processes that the rest of this file goes to such lengths to
     * prevent. "The most recently started season owns the instant" is also the
     * answer that matches the intuition of an operator who opened a new season
     * and forgot to close the old one.
     *
     * @param {number} nowEpochSeconds The instant, unix seconds.
     * @returns {Promise<Object|undefined>} The covering season, or `undefined`.
     */
    async getActiveSeason(nowEpochSeconds) {
      const now = Math.trunc(Number(nowEpochSeconds));
      if (!Number.isFinite(now)) throw new TypeError("getActiveSeason(nowEpochSeconds) requires a number.");
      const covering = [...seasons.values()]
        .filter((season) => season.start <= now && (season.end === null || now < season.end))
        .sort((left, right) => (right.start - left.start) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      return covering.length > 0 ? clone(covering[0]) : undefined;
    },

    /**
     * Records one season claim and returns the running totals.
     *
     * `nonce` is part of the IDENTITY, not decoration: the same user may claim in
     * the same season many times, so `(seasonId, userAddress)` alone would collide
     * and refuse the second claim. `(seasonId, userAddress, nonce)` is what makes
     * a claim idempotent — a retried request with the same nonce is refused as a
     * duplicate rather than accruing a second time — while still letting one user
     * accrue across many nonces.
     *
     * The totals are exact decimal strings, because a season allocation is
     * 18-decimal CATT and a running total that rounds is a total that can exceed
     * the allocation it is supposed to be bounded by.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season claimed.
     * @param {string} params.userAddress Claiming wallet.
     * @param {number|string|bigint} params.amount Amount claimed.
     * @param {number|string|bigint} params.nonce Caller's idempotency nonce.
     * @returns {Promise<{ seasonClaimedTotal: string, userAccrued: string }>}
     */
    async recordSeasonClaim({ seasonId, userAddress, amount, nonce } = {}) {
      const season = String(seasonId);
      const user = String(userAddress).toLowerCase();
      const nonceText = toExactAmount(nonce, "nonce").toString();
      const key = `${season}|${user}|${nonceText}`;
      if (seasonClaims.has(key)) {
        throw new Error(`store: season claim already recorded for ${season}/${user}/${nonceText}.`);
      }
      const value = toExactAmount(amount, "amount");
      seasonClaims.set(key, value);
      return {
        seasonClaimedTotal: getSeasonTotal(season).toString(),
        userAccrued: getUserAccrued(season, user).toString(),
      };
    },

    /**
     * Everything claimed from a season so far, across all users, as a decimal
     * string. `"0"` when nothing has been claimed.
     *
     * @param {string} seasonId Season id.
     * @returns {Promise<string>}
     */
    async getSeasonClaimedTotal(seasonId) {
      return getSeasonTotal(String(seasonId)).toString();
    },

    /**
     * Everything ONE user has accrued from a season, as a decimal string.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season id.
     * @param {string} params.userAddress Wallet address.
     * @returns {Promise<string>}
     */
    async getSeasonUserAccrued({ seasonId, userAddress } = {}) {
      return getUserAccrued(String(seasonId), String(userAddress).toLowerCase()).toString();
    },

    /**
     * Whether a `(season, user, nonce)` claim has already been recorded.
     *
     * This is the check an idempotent caller makes BEFORE claiming: the store's
     * own rejection is the backstop, but a caller that can ask first does not
     * have to turn a duplicate into an error at all.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season id.
     * @param {string} params.userAddress Wallet address.
     * @param {number|string|bigint} params.nonce Claim nonce.
     * @returns {Promise<boolean>}
     */
    async isSeasonClaimUsed({ seasonId, userAddress, nonce } = {}) {
      const key = `${String(seasonId)}|${String(userAddress).toLowerCase()}|${toExactAmount(nonce, "nonce").toString()}`;
      return seasonClaims.has(key);
    },

    /**
     * How many DISTINCT users were active (i.e. completed a graded mission) on a
     * day. `0` for a day nobody was active.
     *
     * READ FROM A DEDICATED LEDGER (`daily_active_miners`), NOT DERIVED FROM THE
     * STREAK ROW. That distinction is load-bearing: a streak row holds only the
     * user's LATEST graded day, so a projection would silently shrink yesterday's
     * count the moment the same user completed something today — and yesterday's
     * number is exactly the number an operator is looking at. The ledger has one
     * row per (day, user), written by `recordGradedCompletion`.
     *
     * GRADED COMPLETIONS ONLY, and that is a deliberate boundary rather than a
     * simplification: the `telemetry` table has NO `day_key` column and its link to
     * a user runs through `sessions.session_id`, whose `user_address` may be NULL
     * (it is deliberately not back-filled — `createSession` refuses to attribute a
     * session to a wallet it was not registered with). Counting telemetry would
     * therefore require the store to derive a day from a timestamp, which is
     * exactly the clock read this interface forbids. It would also count a user
     * who opened an article and left as "active", which is not what "active" means
     * for a mining metric.
     *
     * Distinctness matters as much as the day: one enthusiastic user completing
     * four missions is ONE active user.
     *
     * @param {Object} params
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<number>}
     */
    async countActiveMiners({ dayKey } = {}) {
      const bucket = activeMiners.get(normalizeDayKey(dayKey));
      return bucket ? bucket.size : 0;
    },

    /* ------------------------------------------------------------------ *
     * The GOVERNOR LEDGER: one running total per (season, day).           *
     * NOT the season claimed total — see the header note.                  *
     * ------------------------------------------------------------------ */

    /**
     * How much of TODAY's season emission budget is already committed, as a
     * canonical decimal string. `"0"` when nothing has been committed.
     *
     * This is the number the reward path scales a reward DOWN by, so it must be
     * the budget counter and nothing else: `season_claims` cannot answer it (it
     * is per user and per nonce, and it records what was SETTLED rather than
     * what was committed), and conflating the two would make a day's budget
     * depend on which wallets happened to settle.
     *
     * `dayKey` is the caller-supplied WIB BUSINESS day (`wibDayKey`, which rolls
     * at 21:00 UTC / 04:00 WIB). The store never derives it and never expires
     * it, which is exactly why a brand-new day is `"0"` with no reset step:
     * there is no row to clear and no code path by which yesterday's spend can
     * be read as today's.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season whose budget is being measured.
     * @param {string} params.dayKey `YYYY-MM-DD` WIB business day.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     * @throws {TypeError} If `dayKey` is not a real `YYYY-MM-DD` calendar day.
     * @throws {Error} If `seasonId` names no season.
     */
    async getGovernorSpend({ seasonId, dayKey } = {}) {
      const season = knownSeason(seasonId);
      const day = normalizeDayKey(dayKey);
      return (governorSpend.get(governorKey(season, day)) || 0n).toString();
    },

    /**
     * ADDS `amount` to the day's committed budget and returns the new running
     * total for that day.
     *
     * ACCUMULATES, NEVER REPLACES. A day's emission is many rewards, and the
     * budget is measured against the sum of all of them; a second write for the
     * same (season, day) must be unable to erase the first. In the SQLite
     * adapter that is structural — the primary key plus an `ON CONFLICT DO
     * UPDATE` that writes the WHOLE new total, never a SQL `+=` (which on a
     * TEXT column would be SQLite's floating-point addition, i.e. exactly the
     * rounding this column exists to prevent).
     *
     * THERE IS NO `resetGovernorDay`, AND ITS ABSENCE IS THE DESIGN. The caller
     * derives `dayKey` from the WIB clock, so a new business day is a new
     * bucket that starts at zero by construction — there is nothing to clear.
     * A reset method would be worse than useless: it would let a day that has
     * already emitted be zeroed and re-spent, turning the audit trail of a
     * season's emission into something any caller can erase. (A genuine
     * correction — a reward that was committed and then never settled — is a
     * different operation and belongs to whatever owns settlement, not here.)
     *
     * @param {Object} params
     * @param {string} params.seasonId Season whose budget is consumed.
     * @param {string} params.dayKey `YYYY-MM-DD` WIB business day.
     * @param {number|string|bigint} params.amount 18-decimal CATT base units.
     * @returns {Promise<string>} The day's new total, as a canonical decimal
     *   string.
     * @throws {TypeError} If `amount` is not a non-negative integer, or `dayKey`
     *   is not a real `YYYY-MM-DD` calendar day.
     * @throws {Error} If `seasonId` names no season.
     */
    async recordGovernorSpend({ seasonId, dayKey, amount } = {}) {
      const season = knownSeason(seasonId);
      const day = normalizeDayKey(dayKey);
      const key = governorKey(season, day);
      const total = (governorSpend.get(key) || 0n) + toExactAmount(amount, "amount");
      governorSpend.set(key, total);
      return total.toString();
    },

    /**
     * Everything a season has committed against its daily budgets across EVERY
     * day, as a canonical decimal string. `"0"` when nothing.
     *
     * This is the reconciliation figure: the founder's season allocation is
     * 3,300,000 CATT, and this is what has actually been committed against it.
     * It is deliberately NOT `getSeasonClaimedTotal`, and the two are not
     * expected to agree: a reward the governor scaled down is committed at full
     * size here and settled at the scaled size there.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season id.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     */
    async getGovernorSpendTotal({ seasonId } = {}) {
      const season = knownSeason(seasonId);
      return governorSeasonTotal(season).toString();
    },

    /**
     * Releases every resource the store holds. A no-op here because there is
     * nothing to release in-process, but it exists so the caller code (server
     * shutdown, test teardown) does not have to special-case the memory store —
     * and so a Postgres adapter has an obvious home for `await pool.end()`.
     *
     * @returns {Promise<void>}
     */
    async close() {
      /* no pool, no handles, nothing to close */
    },

    /**
     * Alias of {@link close} for callers that think in terms of disposal
     * (DI containers, test harnesses). Kept separate in `STORAGE_METHODS` so an
     * adapter must provide both spellings explicitly rather than by accident.
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      /* identical to close() */
    },

    /* ------------------------------------------------------------------ *
     * Test / debugging affordances. NOT part of STORAGE_METHODS: a Postgres *
     * adapter has no equivalent and must not be expected to provide them.   *
     * ------------------------------------------------------------------ */

    /**
     * Snapshot of the full in-memory state, for assertions in tests.
     *
     * @returns {{ sessions: number, telemetry: number, submissions: number, issuedClaims: number, relayedClaims: number }}
     */
    _debugState() {
      let telemetryCount = 0;
      for (const bucket of telemetry.values()) telemetryCount += bucket.length;
      let relayedClaims = 0;
      for (const record of issuedClaims.values()) {
        if (record.relayerTxHash) relayedClaims += 1;
      }
      return {
        sessions: sessions.size,
        telemetry: telemetryCount,
        submissions: submissionOrder.length,
        issuedClaims: issuedClaims.size,
        relayedClaims,
      };
    },

    /**
     * Row counts for every GROWTH/GOVERNOR table, for the parity assertion.
     *
     * The memory store keeps each ledger in a `Map`, so "one row" is one entry;
     * the SQLite adapter counts the same rows with `COUNT(*)`. Comparing these
     * is what proves the upsert path did not quietly leave a second row behind
     * for one (season, day) — a duplicate would still total correctly through
     * the public API if the sum happened to walk it, so the row count is
     * evidence the totals do NOT have.
     *
     * NOT part of `STORAGE_METHODS`: a Postgres adapter has no equivalent and
     * must not be expected to provide one.
     *
     * @returns {{ staminaLedger: number, streaks: number, activeMiners: number,
     *   freeGrants: number, seasons: number, seasonClaims: number,
     *   governorSpend: number }}
     */
    _debugGrowth() {
      let minerRows = 0;
      for (const bucket of activeMiners.values()) minerRows += bucket.size;
      return {
        staminaLedger: staminaLedger.size,
        streaks: streaks.size,
        activeMiners: minerRows,
        freeGrants: freeGrants.size,
        seasons: seasons.size,
        seasonClaims: seasonClaims.size,
        governorSpend: governorSpend.size,
      };
    },
  };

  return assertStoreShape(store);
}

/**
 * Every adapter that implements `STORAGE_METHODS`, described in one place so
 * that selecting one is a lookup rather than a `require` the caller has to
 * know about.
 *
 * `load()` is called with whatever options the adapter accepts and returns a
 * store that has already passed `assertStoreShape`. It is a function, not a
 * module reference, so requiring THIS module does not pull in `better-sqlite3`:
 * the SQLite adapter is loaded only when something actually selects it.
 *
 * @type {ReadonlyArray<{ id: string, persistent: boolean, description: string, load: (options?: Object) => Object }>}
 */
const STORAGE_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "memory",
    persistent: false,
    description:
      "Process-local Maps. The default: volatile by definition, and what every test uses. " +
      "Correct only for a process that never restarts and never issues real money.",
    load: (options) => createMemoryStore(options),
  }),
  Object.freeze({
    id: "sqlite",
    persistent: true,
    description:
      "SQLite file via better-sqlite3 (see ./sqlite-store.js). Survives a restart and enforces the " +
      "nonce-uniqueness and relay-once invariants in the schema. Single-node/testnet; Postgres " +
      "remains the production target.",
    load: (options) => require("./sqlite-store").createSqliteStore(options),
  }),
]);

/**
 * Looks an adapter up by id.
 *
 * @param {string} id Adapter id (case-insensitive).
 * @returns {Object|undefined} The adapter descriptor, or `undefined` if unknown.
 */
function getStorageAdapter(id) {
  const wanted = String(id || "").trim().toLowerCase();
  return STORAGE_ADAPTERS.find((adapter) => adapter.id === wanted);
}

module.exports = {
  STORAGE_METHODS,
  STORAGE_ADAPTERS,
  assertStoreShape,
  createMemoryStore,
  getStorageAdapter,
  // Shared day-key helpers, used by BOTH adapters so the two cannot drift on
  // what a valid day key is or what "the next day" means. Not part of the store
  // contract — they are pure functions.
  normalizeDayKey,
  isNextDayAfter,
};
