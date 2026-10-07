/**
 * CATT Protocol — Judge storage adapter #2: persistent SQLite
 * (the single-node / testnet persistence layer behind the SAME interface).
 *
 * WHAT THIS FILE IS:
 *   A drop-in replacement for `createMemoryStore()` from `./storage.js`. It
 *   implements every name in `STORAGE_METHODS` and is accepted by
 *   `assertStoreShape`, so `createApp({ store })` cannot tell the difference.
 *   Nothing in `server.js` changes behaviour when this adapter is selected; the
 *   only thing that changes is whether the Judge forgets everything when the
 *   process is restarted.
 *
 * WHY IT EXISTS:
 *   The memory store loses sessions, telemetry, submissions, reserved nonces,
 *   issued claims and relay records the moment the process exits. That is
 *   acceptable for a demo and NOT acceptable for anything that issues real
 *   money, because of the single hardest invariant in the Judge: a nonce handed
 *   out and never signed must never be handed out again, and a claim relayed
 *   must never be relayed twice. On a restart with the memory store, both of
 *   those protections silently reset. This adapter makes them durable.
 *
 * WHY `better-sqlite3` AND NOT A DIFFERENT LIBRARY:
 *   It is a single native module with a synchronous API, bundled prebuilt
 *   binaries, and — critically — it exposes SQLite's real constraint machinery
 *   (`UNIQUE`, `CHECK`, foreign keys, transactions) instead of emulating it in
 *   JavaScript. The whole point of the "enforce the invariant in the schema, not
 *   in JS" requirement is that the invariant must survive a bug in application
 *   code; you cannot get that from an in-process Map.
 *
 * ---------------------------------------------------------------------------
 * MIGRATION NOTE
 * ---------------------------------------------------------------------------
 *
 * (a) SCHEMA VERSION STRATEGY
 *     The schema version lives in SQLite's own `PRAGMA user_version` — a
 *     32-bit integer stored IN the database file, so it is atomic with the data
 *     and cannot disagree with it (unlike a version row in a table, which can
 *     be lost or double-applied). `SCHEMA_VERSION` below is the version this
 *     build of the code expects. On open:
 *
 *       - `user_version === 0`  → fresh file: run every migration in order.
 *       - `0 < v < SCHEMA_VERSION` → an older file: run only the migrations
 *         after `v`, in order, each in its own transaction together with the
 *         `PRAGMA user_version = v+1` bump, so a crash mid-migration leaves the
 *         file at the last fully applied version rather than half-way.
 *       - `v === SCHEMA_VERSION` → nothing to do.
 *       - `v > SCHEMA_VERSION` → HARD FAIL at open. A file written by a newer
 *         build is never opened by an older one; silently accepting it would
 *         mean writing rows an old binary cannot understand.
 *
 *     TO ADD A MIGRATION: append one entry to `MIGRATIONS` — each entry is
 *     `{ version, up(db) }` where `version` is the version that entry PRODUCES.
 *     Bump `SCHEMA_VERSION` to the last entry's `version`. Never edit an
 *     existing entry (files already in the wild have applied it). Use
 *     `CREATE TABLE`/`CREATE INDEX IF NOT EXISTS` and additive column changes
 *     only; a table rewrite is a migration that copies rows.
 *
 *     (b) SQLITE IS NOT THE PRODUCTION TARGET
 *     The production target remains the Postgres/Supabase adapter whose DDL is
 *     documented in the header of `./storage.js`. SQLite here is the
 *     SINGLE-NODE persistence layer: a validator, a single Judge process, a
 *     testnet deployment, and CI. It deliberately has no pooling, no
 *     replication, no multi-writer story and no horizontal scale-out. Do not
 *     point two Judge processes at one SQLite file expecting them to be safe
 *     under write contention.
 *
 *     (c) MIGRATING SQLITE DATA TO POSTGRES
 *     The column-for-column mapping is the DDL in `./storage.js`; the differences
 *     are the two type widenings SQLite's dynamic typing forced on us:
 *       1. `issued_claims.reward`, `issued_claims.stamina_cost` are TEXT here
 *          because SQLite INTEGER is a 64-bit signed int and a wei-scaled
 *          reward (1e18-scale, up to uint256) can exceed 2^63-1. In Postgres
 *          they become `numeric(78,0)`; load them with `::numeric`, not
 *          `::bigint`.
 *       2. `issued_claims.nonce` and `nonce_counters.last_nonce` are INTEGER
 *          here (a nonce is a uint256 on-chain but the Judge only ever issues
 *          sequential small integers, so 64 bits is genuinely sufficient; if a
 *          future design issues uint256-scale nonces, widen to `numeric`).
 *       3. `telemetry.ts` is INTEGER here (ms epoch) and `bigint` in Postgres —
 *          same value, different type name.
 *       4. `*.created_at/submitted_at/issued_at/relayed_at` are INTEGER
 *          milliseconds here and `timestamptz` in Postgres: load with
 *          `to_timestamp(ms / 1000.0)`.
 *       5. The lossless `*_json` columns (telemetry `sample_json`, submissions
 *          `answers_json`/`result_json`) are TEXT holding `JSON.stringify`ped
 *          values and become `jsonb`; the scalar columns beside them are the
 *          indexable/queryable projection, and on a Postgres import the
 *          `jsonb` column is authoritative (it is what this adapter returns to
 *          callers verbatim).
 *     The load order, inside ONE transaction, with foreign keys deferred until
 *     the end: `sessions` → `telemetry` → `submissions` → `nonce_counters` →
 *     `issued_claims` → `stamina_ledger` → `streaks` →
 *     `daily_active_miners` → `free_stamina_grants` → `seasons` →
 *     `season_claims` → `governor_daily_spend`. The first five have no back-edges; the growth tables
 *     depend on nothing but the addresses the caller supplies, so appending them
 *     is safe. Nothing in `issued_claims` is needed to interpret
 *     anything in `submissions`, so the order has no back-edges. Because
 *     `user_address` is stored LOWERCASE here (see below), Postgres must
 *     receive lowercase too or the unique constraints stop lining up with the
 *     rows the Judge already issued; `citext`/lowercase normalisation on the
 *     application side is what keeps `getIssuedClaim` case-insensitive there.
 *
 *     (e) POSTGRES DDL FOR THE GROWTH LEDGERS (migrations 2, 3 and 4 below)
 *     Same tables, same constraints, two type widenings and one naming change:
 *
 *       stamina_ledger(               -- per-day stamina SPENT (not a balance)
 *         user_address text NOT NULL,
 *         day_key      date   NOT NULL,   -- SQLite: TEXT 'YYYY-MM-DD'
 *         consumed     numeric NOT NULL,  -- TEXT here; see precision note
 *         updated_at   bigint  NOT NULL,  -- INTEGER ms here
 *         PRIMARY KEY (user_address, day_key)
 *       );
 *       CREATE INDEX stamina_ledger_day ON stamina_ledger (day_key);
 *
 *       streaks(                      -- ONE row per user; no cap stored here
 *         user_address    text PRIMARY KEY NOT NULL,
 *         current_streak  integer NOT NULL,
 *         last_graded_day date,
 *         last_reward     numeric,
 *         last_mission_id text
 *       );
 *       CREATE INDEX streaks_last_graded_day ON streaks (last_graded_day);
 *
 *       daily_active_miners(          -- the countActiveMiners ledger
 *         day_key      date   NOT NULL,
 *         user_address text NOT NULL,
 *         PRIMARY KEY (day_key, user_address)
 *       );
 *       CREATE INDEX daily_active_miners_day ON daily_active_miners (day_key);
 *
 *       free_stamina_grants(          -- per-day grants; day isolation is the PK
 *         user_address text NOT NULL,
 *         day_key      date   NOT NULL,
 *         granted      numeric NOT NULL,
 *         updated_at   bigint  NOT NULL,
 *         PRIMARY KEY (user_address, day_key)
 *       );
 *
 *       seasons(
 *         id         text PRIMARY KEY NOT NULL,
 *         start_at   bigint  NOT NULL,  -- unix seconds, INCLUSIVE
 *         end_at     bigint,            -- unix seconds, EXCLUSIVE; NULL = open-ended
 *         allocation numeric NOT NULL,  -- 18-decimal CATT
 *         claim_mode text
 *       );
 *       CREATE INDEX seasons_window ON seasons (start_at DESC, id ASC);
 *       -- getActiveSeason is
 *       --   SELECT * FROM seasons
 *       --    WHERE start_at <= $1 AND (end_at IS NULL OR end_at > $1)
 *       --    ORDER BY start_at DESC, id ASC LIMIT 1;
 *       -- i.e. [start, end) with LATEST-start-wins overlap resolution and a
 *       -- deterministic id tiebreak. In Postgres the same ORDER BY is served by
 *       -- `seasons_window`; note that `start_at DESC, id ASC` is a mixed
 *       -- direction index, which Postgres can use for this exact ORDER BY but
 *       -- not for a bare `start_at` range scan — add a second index on
 *       -- (start_at) if an operator query ever needs one.
 *
 *       season_claims(
 *         season_id   text   NOT NULL,
 *         user_address text  NOT NULL,
 *         nonce       numeric NOT NULL,  -- TEXT here: idempotency, not a counter
 *         amount      numeric NOT NULL,
 *         claimed_at  bigint  NOT NULL,
 *         PRIMARY KEY (season_id, user_address, nonce)
 *       );
 *       CREATE INDEX season_claims_season ON season_claims (season_id);
 *       -- season_claims carries NO FOREIGN KEY, deliberately (see below).
 *
 *       governor_daily_spend(        -- the DAILY GOVERNOR BUDGET counter
 *         season_id  text   NOT NULL REFERENCES seasons(id),
 *         day_key    date   NOT NULL,  -- TEXT 'YYYY-MM-DD': a WIB BUSINESS day
 *         spent      numeric NOT NULL,  -- TEXT here; see the precision note
 *         updated_at bigint  NOT NULL,  -- INTEGER ms here
 *         PRIMARY KEY (season_id, day_key)
 *       );
 *       CREATE INDEX governor_daily_spend_day ON governor_daily_spend (day_key);
 *       -- ONE RUNNING TOTAL PER (season, business day). There is deliberately
 *       -- no user_address and no nonce here: the row answers "how much of
 *       -- TODAY's budget is already committed", which is a property of the
 *       -- bucket and of nothing else. That is also why it is NOT a view over
 *       -- season_claims — the two are different quantities (see storage.js),
 *       -- and a settled claim can be smaller than what was committed against
 *       -- the budget whenever the governor scaled a reward down.
 *       --
 *       -- THE FOREIGN KEY IS THE ONE PLACE THE GROWTH TABLES HAVE ONE, and it
 *       -- is a deliberate difference from `season_claims`. A claim that
 *       -- outlives its season row is a real historical settlement fact, so
 *       -- deleting a season must not delete it; a SPEND, by contrast, is a
 *       -- consumption of a budget that belongs to a season, and a spend row
 *       -- for a season that does not exist reconciles against nothing and
 *       -- cannot be scaled or audited. So the FK is kept here (with no
 *       -- ON DELETE clause: deleting a season is refused rather than silently
 *       -- erasing how much of its budget was already committed, which is the
 *       -- one direction this table can fail in that is worth failing).
 *       -- getGovernorSpendTotal is
 *       --   SELECT SUM(spent) FROM governor_daily_spend WHERE season_id = $1;
 *       -- summed in JavaScript as BigInt instead, for the same reason as the
 *       -- season totals above: SUM() over a TEXT column coerces to a double.
 *
 *     The type widenings, as above: `consumed`/`granted`/`allocation`/`amount`/
 *     `nonce`/`spent` are TEXT here and `numeric(78,0)` in Postgres — load with
 *     `::numeric`, NOT `::bigint`; `updated_at`/`claimed_at` are INTEGER
 *     milliseconds here and `bigint` there; `day_key` is a `date` in Postgres
 *     (the TEXT 'YYYY-MM-DD' here is already exactly that literal form, so the
 *     import is a direct cast). Load order for the growth tables is
 *     `stamina_ledger`, `streaks`, `daily_active_miners`,
 *     `free_stamina_grants`, `seasons`, `season_claims`,
 *     `governor_daily_spend` — the last one goes LAST because it is the only
 *     growth table with a foreign key, so its season rows must already be
 *     present. There are no other foreign keys among the growth tables by
 *     design: a claim row that outlives its season row is still a real
 *     historical fact, and a foreign key would make season deletion a data-loss
 *     operation.
 *
 *     GOVERNOR AMOUNTS ARE 1e23-SCALE, NOT 1e18-SCALE. The founder's daily
 *     budget is 110,000 CATT against a 3,300,000 CATT season allocation, and
 *     110,000 CATT in 18-decimal base units is 1.1e23 — which is not merely
 *     imprecise as a JavaScript double (it is far above 2^53) but OUT OF RANGE
 *     for a signed 64-bit SQLite INTEGER, whose ceiling is 9223372036854775807
 *     (9.22e18). `spent` is therefore TEXT for the same out-of-range reason
 *     `issued_claims.reward` is, and the daily budget counter is summed as
 *     BigInt in JavaScript rather than with SQL `SUM()`.
 *
 *     (d) NO MIGRATION FROM THE IN-MEMORY STORE IS POSSIBLE OR NEEDED
 *     The in-memory store is volatile by definition: it holds everything in two
 *     `Map`s that die with the process, and there is nothing on disk to read
 *     back. There is no upgrade path and none is wanted — the correct way to
 *     move a deployment from the memory adapter to this one is to start on an
 *     empty database, which is exactly the same state a fresh process with the
 *     memory store would have been in, except that from then on the Judge
 *     stops re-issuing nonces every time it is restarted.
 *
 * No secret, key or credential is read, stored or logged by this module. The
 * database contains session and wallet data, so the file is as sensitive as
 * the user table it replaces: it must never be committed.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { STORAGE_METHODS, assertStoreShape, normalizeDayKey, isNextDayAfter } = require("./storage");

/**
 * The schema version this build of the code creates and understands. Stored in
 * `PRAGMA user_version`; see the migration note (a) above.
 *
 * @type {number}
 */
const SCHEMA_VERSION = 4;

/**
 * The default database path used when `CATT_STORE=sqlite` and `SQLITE_PATH` is
 * unset. Deliberately OUTSIDE the repository working tree: the file holds
 * session and wallet data, must never be committed, and a default that lands
 * inside the checkout would be one `git add -A` away from a leak on a box whose
 * `.gitignore` nobody extended. Operators who want the file inside their own
 * deployment tree must set `SQLITE_PATH` and gitignore it themselves.
 *
 * @type {string}
 */
const DEFAULT_SQLITE_PATH = "/var/lib/catt-judge/judge.db";

/**
 * Ordered, append-only list of migrations. Entry `i` upgrades a file from
 * `version - 1` to `version`. NEVER edit an entry that has shipped: a deployed
 * file has already applied it, and re-applying a different definition of the
 * same version is how schemas diverge between nodes.
 *
 * @type {ReadonlyArray<{ version: number, up: (db: Object) => void }>}
 */
const MIGRATIONS = Object.freeze([
  {
    version: 1,
    /**
     * Initial schema. Mirrors the Postgres DDL documented in `storage.js`, with
     * three SQLite-specific additions, each commented inline below.
     *
     * @param {Object} db An open `better-sqlite3` database.
     * @returns {void}
     */
    up(db) {
      db.exec(`
        -- A registered mining session. A repeat POST /api/session for the same
        -- id is a no-op (see createSession), which is what the primary key
        -- makes structural rather than a code convention.
        CREATE TABLE IF NOT EXISTS sessions (
          session_id   TEXT PRIMARY KEY,
          user_address TEXT,
          mission_id   TEXT,
          created_at   INTEGER NOT NULL
        );

        -- One row per telemetry SAMPLE. Samples are APPENDED, never upserted,
        -- so a re-posted batch cannot rewrite the Proof-of-Attention history.
        --
        -- sample_index is the per-session monotonic counter that IS the
        -- insertion order (getTelemetry is ORDER BY sample_index ASC). It is
        -- unique per session, so two writers cannot claim the same slot and the
        -- order is a property of the DATA rather than of the query plan.
        --
        -- The scalar columns are the queryable projection (they mirror the
        -- Postgres DDL). sample_json is the LOSSLESS record of the sample as
        -- the client sent it — including touch as a nested { x, y } object and
        -- any field a future client adds — and it is what getTelemetry returns
        -- verbatim, which is what makes this adapter a byte-for-byte drop-in
        -- for the memory store. The scalar columns are always derived from the
        -- same value in the same statement, so the two can never disagree.
        CREATE TABLE IF NOT EXISTS telemetry (
          row_id        INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          sample_index  INTEGER NOT NULL,
          ts            INTEGER,
          battery_temp_c REAL,
          touch_x       REAL,
          touch_y       REAL,
          scroll_delta  REAL,
          sample_json   TEXT NOT NULL,
          received_at   INTEGER NOT NULL,
          UNIQUE (session_id, sample_index)
        );
        CREATE INDEX IF NOT EXISTS telemetry_session_id_id
          ON telemetry (session_id, sample_index);

        -- Every judged attempt, PASS or FAIL. The FAIL rows are the corpus
        -- syndicate detection reads and the audit trail for a dispute, so a
        -- status of FAIL is data, never a reason to skip the insert.
        -- id is the monotonic key; listRecentSubmissions is newest-first by
        -- (submitted_at DESC, id DESC) so the order stays total even when
        -- several submissions land inside one clock tick.
        CREATE TABLE IF NOT EXISTS submissions (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT,
          user_address  TEXT,
          mission_id    TEXT,
          submitted_at  INTEGER NOT NULL,
          answers_json  TEXT,
          highlight     TEXT NOT NULL,
          typing_ms     INTEGER NOT NULL,
          free_text     TEXT NOT NULL,
          status        TEXT,
          result_json   TEXT,
          reward_json   TEXT,
          stamina_cost_json TEXT
        );
        CREATE INDEX IF NOT EXISTS submissions_recent
          ON submissions (submitted_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS submissions_user_recent
          ON submissions (user_address, submitted_at DESC, id DESC);

        -- The per-user nonce counter. This table exists ONLY so that a nonce
        -- reserved and then abandoned (crash, 500, dropped request) is still
        -- burned: without a durable counter the next reserveNonce after a
        -- restart would reissue it, and reissuing is a duplicate payment
        -- waiting to be claimed twice. The row is written inside the same
        -- transaction that hands the nonce out, so a reservation and its
        -- counter move are atomic.
        CREATE TABLE IF NOT EXISTS nonce_counters (
          -- NOT NULL is spelled out because of a SQLite quirk: a TEXT PRIMARY
          -- KEY does NOT imply NOT NULL (only an INTEGER PRIMARY KEY does), and
          -- a NULL key would let several "users" share one nonce sequence.
          -- Refusing a null address is the safe direction: every call site
          -- validates the address before it gets here.
          user_address TEXT PRIMARY KEY NOT NULL,
          last_nonce   INTEGER NOT NULL
        );

        -- What was actually SIGNED, plus relay bookkeeping. reward and
        -- stamina_cost are TEXT, not INTEGER: see the precision note below.
        CREATE TABLE IF NOT EXISTS issued_claims (
          user_address   TEXT NOT NULL,
          nonce          INTEGER NOT NULL,
          session_id     TEXT,
          digest         TEXT,
          reward         TEXT,
          stamina_cost   TEXT,
          deadline       TEXT,
          signature      TEXT,
          issued_at      INTEGER NOT NULL,
          relayed_tx_hash TEXT,
          relayed_at     INTEGER,
          -- THE DOUBLE-SPEND GUARD, enforced by the database and not by
          -- application code: a (user, nonce) pair can exist at most once, so
          -- two concurrent issuances of the same nonce cannot both land, and
          -- markRelayed can only ever find ONE row to mark.
          UNIQUE (user_address, nonce),
          -- A relayed transaction hash belongs to exactly one claim. This is
          -- what makes "a nonce is relayed at most once" hold even if two
          -- relayers race, and it also stops the same broadcast from being
          -- recorded against two different nonces.
          -- NULL hashes are excluded so the many un-relayed claims do not
          -- collide with each other (a plain UNIQUE column would allow only
          -- one NULL in older SQLite).
          -- Two CHECK constraints make a half-written relay record
          -- unrepresentable:
          --   relayed_tx_hash IS NULL OR length(relayed_tx_hash) > 0
          --     an empty string is not a transaction hash, and it would pass
          --     both getIssuedClaim's "already relayed" test and the unique
          --     index while relaying nothing.
          --   relayed_tx_hash IS NULL OR relayed_at IS NOT NULL
          --     a hash always has a timestamp, so "was this relayed?" is never
          --     answered by a row that is half of an answer. The converse
          --     (a timestamp with no hash) IS representable on purpose: that is
          --     what a broadcast whose hash the provider did not return looks
          --     like, and the memory store records it the same way — the claim
          --     stays relayable rather than being silently burned.
          CHECK (relayed_tx_hash IS NULL OR length(relayed_tx_hash) > 0),
          CHECK (relayed_tx_hash IS NULL OR relayed_at IS NOT NULL)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS issued_claims_unique_relay_tx
          ON issued_claims (relayed_tx_hash) WHERE relayed_tx_hash IS NOT NULL;
      `);
    },
  },
  {
    version: 2,
    /**
     * The per-day growth ledgers: stamina SPENT, streaks, and free-stamina
     * grants, plus the daily active-miner set.
     *
     * Pure ADDITIVE DDL: new tables, new indexes, no column added to or changed
     * on any existing table, so applying this to a live v1 file is a pure append
     * and a rollback is "open a file that predates it". Every statement is
     * `IF NOT EXISTS`, which is what makes re-running the whole migration list
     * (a fresh `init()`, a re-open, a re-run after a crash) a no-op instead of an
     * error.
     *
     * THE PRIMARY KEYS ARE THE CONSTRAINTS, NOT A CONVENTION. Every one of these
     * tables is "one row per key", so the key IS the primary key and a duplicate
     * insert is refused by SQLite itself — the test suite proves that with raw
     * SQL, bypassing this adapter entirely. `day_key` is TEXT 'YYYY-MM-DD' (see
     * the header note): a caller-supplied string, never derived from a timestamp
     * in here.
     *
     * @param {Object} db An open `better-sqlite3` database.
     * @returns {void}
     */
    up(db) {
      db.exec(`
        -- Per-day stamina SPENT by one user. NOT a balance: stamina lives
        -- on-chain in StakingManager.stamina, and this table only answers "how
        -- much did this wallet spend today", which is what the daily cap is
        -- re-derived from. Accumulated in JS (BigInt) and written whole, so two
        -- concurrent spends cannot lose a delta to a read-modify-write race in
        -- application code — the transaction plus the upsert is the guard.
        -- consumed is TEXT for the out-of-range reason in the header note.
        CREATE TABLE IF NOT EXISTS stamina_ledger (
          user_address TEXT NOT NULL,
          day_key      TEXT NOT NULL,
          consumed     TEXT NOT NULL,
          updated_at   INTEGER NOT NULL,
          -- NOT NULL is spelled out on every TEXT key because of a SQLite quirk:
          -- a TEXT PRIMARY KEY does NOT imply NOT NULL (only an INTEGER PRIMARY
          -- KEY does), and a NULL key would let every NULL address share one
          -- bucket per day.
          PRIMARY KEY (user_address, day_key)
        );
        CREATE INDEX IF NOT EXISTS stamina_ledger_day
          ON stamina_ledger (day_key);

        -- ONE row per user. current_streak is a plain day COUNT (INTEGER is
        -- ample and it is a count, not an amount), and NO CAP IS STORED: capping
        -- is economic policy owned by another module and belongs at read time,
        -- because a cap applied here would be baked into rows already written.
        -- last_reward/last_mission_id are the audit trail of the last graded
        -- completion; they are deliberately not part of the streak VIEW.
        CREATE TABLE IF NOT EXISTS streaks (
          user_address    TEXT PRIMARY KEY NOT NULL,
          current_streak  INTEGER NOT NULL,
          last_graded_day TEXT,
          last_reward     TEXT,
          last_mission_id TEXT
        );
        CREATE INDEX IF NOT EXISTS streaks_last_graded_day
          ON streaks (last_graded_day);

        -- The daily active-miner LEDGER, one row per (day, user). It exists as
        -- its own table rather than as a projection of streaks because a streak
        -- row holds only the user's LATEST graded day: deriving yesterday's count
        -- from it would shrink as soon as the same user completed something
        -- today. Written with INSERT OR IGNORE, so re-recording a completion in
        -- the same day is idempotent and the primary key is what makes it so.
        -- countActiveMiners is a COUNT(*) over day_key = ?, served
        -- by daily_active_miners_day: an index-only count over one day's rows,
        -- with no table scan and no clock read.
        CREATE TABLE IF NOT EXISTS daily_active_miners (
          day_key      TEXT NOT NULL,
          user_address TEXT NOT NULL,
          PRIMARY KEY (day_key, user_address)
        );
        CREATE INDEX IF NOT EXISTS daily_active_miners_day
          ON daily_active_miners (day_key);

        -- Per-day FREE stamina grants. Same shape and same day-isolation
        -- guarantee as stamina_ledger: a grant made on day A is unreachable from
        -- day B, because the key is (user, day) and never user alone.
        CREATE TABLE IF NOT EXISTS free_stamina_grants (
          user_address TEXT NOT NULL,
          day_key      TEXT NOT NULL,
          granted      TEXT NOT NULL,
          updated_at   INTEGER NOT NULL,
          PRIMARY KEY (user_address, day_key)
        );
        CREATE INDEX IF NOT EXISTS free_stamina_grants_day
          ON free_stamina_grants (day_key);
      `);
    },
  },
  {
    version: 3,
    /**
     * Seasons and their claims.
     *
     * `seasons.start_at`/`end_at` are unix SECONDS, start-INCLUSIVE and
     * end-EXCLUSIVE, with `end_at IS NULL` meaning an OPEN-ENDED season. That
     * half-open window is what makes back-to-back seasons well defined: with both
     * ends inclusive the closing second of season N would also be the opening
     * second of season N+1 and a claim landing there would have two owners.
     *
     * `seasons_window (start_at DESC, id ASC)` is not decoration — it is the
     * exact ORDER BY of getActiveSeason, whose overlap rule is "the candidate
     * with the LATEST start wins, ties broken by id ascending". Overlapping
     * windows are an operator mistake rather than a design, and resolving them by
     * row order instead would make an allocation depend on insertion order.
     *
     * `season_claims` is keyed by (season_id, user_address, nonce) because `nonce`
     * is part of the claim's IDENTITY, not decoration: one user claims many times
     * in a season, and the nonce is what makes a retried request idempotent
     * instead of accruing twice. There are deliberately NO FOREIGN KEYS among the
     -- growth tables: a claim row that outlives its season row is a real
     -- historical fact, and a foreign key would turn season deletion into data
     * loss.
     *
     * @param {Object} db An open `better-sqlite3` database.
     * @returns {void}
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS seasons (
          id         TEXT PRIMARY KEY NOT NULL,
          start_at   INTEGER NOT NULL,
          end_at     INTEGER,
          allocation TEXT NOT NULL,
          claim_mode TEXT
        );
        CREATE INDEX IF NOT EXISTS seasons_window
          ON seasons (start_at DESC, id ASC);

        CREATE TABLE IF NOT EXISTS season_claims (
          season_id   TEXT NOT NULL,
          user_address TEXT NOT NULL,
          nonce       TEXT NOT NULL,
          amount      TEXT NOT NULL,
          claimed_at  INTEGER NOT NULL,
          PRIMARY KEY (season_id, user_address, nonce)
        );
        CREATE INDEX IF NOT EXISTS season_claims_season
          ON season_claims (season_id);
      `);
    },
  },
  {
    version: 4,
    /**
     * The DAILY GOVERNOR BUDGET ledger: one row per (season, business day).
     *
     * Pure ADDITIVE DDL — one new table and one new index, nothing added to or
     * changed on any existing table — and every statement is `IF NOT EXISTS`, so
     * re-running the whole migration list is a no-op. Migration 3's tables are
     * untouched, which is what makes a v3 file upgrade in place with its data
     * intact rather than being rewritten.
     *
     * THE PRIMARY KEY IS THE CONSTRAINT, NOT A CONVENTION: one row per
     * (season, day), so a duplicate insert is refused by SQLite itself and the
     * upsert path can never leave a second row behind for one day. The test
     * suite proves that with raw SQL, bypassing this adapter entirely.
     *
     * NOT A VIEW OVER `season_claims`. The two are DIFFERENT QUANTITIES and are
     * never derived from one another (see the note in `storage.js`): this table
     * is the running emission budget consumed per day, keyed by day and with no
     * user and no nonce, while `season_claims` is the immutable per-user
     * settlement record with an idempotency nonce. A reward the governor scaled
     * down is committed here at full size and settles there at the scaled size,
     * so the two are not expected to agree for the same event.
     *
     * `day_key` is the caller-supplied WIB BUSINESS day (04:00 WIB / 21:00 UTC
     * rollover, `reset-schedule.js`), stored verbatim as TEXT. The store never
     * derives it from a timestamp: a new day is a new bucket that starts at zero
     * by construction, which is why there is no reset method and no "expire
     * yesterday" step anywhere.
     *
     * `spent` is TEXT, not INTEGER: a daily budget is 110,000 CATT = 1.1e23
     * base units, which is OUT OF RANGE for a signed 64-bit SQLite INTEGER
     * (ceiling 9223372036854775807) rather than merely imprecise, and a daily
     * budget that rounds can overshoot the ceiling it exists to enforce.
     *
     * THE FOREIGN KEY IS DELIBERATE AND IS THE ONLY ONE AMONG THE GROWTH
     * TABLES. A spend row for a season that does not exist reconciles against
     * nothing and cannot be scaled or audited, so it is refused by the DATABASE
     * rather than by a JavaScript check — and the memory store enforces the same
     * rule in application code, because the two adapters must agree about
     * whether an unknown season is writable. There is no `ON DELETE` clause on
     * purpose: deleting a season is refused rather than silently erasing how
     * much of its budget was already committed.
     *
     * @param {Object} db An open `better-sqlite3` database.
     * @returns {void}
     */
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS governor_daily_spend (
          season_id  TEXT NOT NULL REFERENCES seasons(id),
          day_key    TEXT NOT NULL,
          spent      TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          -- NOT NULL is spelled out on the TEXT key because of a SQLite quirk:
          -- a TEXT PRIMARY KEY does NOT imply NOT NULL (only an INTEGER PRIMARY
          -- KEY does), and a NULL day would collapse every day's spend for that
          -- season into one unreadable bucket.
          PRIMARY KEY (season_id, day_key)
        );
        CREATE INDEX IF NOT EXISTS governor_daily_spend_day
          ON governor_daily_spend (day_key);
      `);
    },
  },
]);

/* ------------------------------------------------------------------------ *
 * Value normalisation helpers.
 *
 * WHY EVERY BIG NUMBER IS TEXT:
 *   A mining reward is an 18-decimal base-unit amount, i.e. a uint256 on-chain.
 *   SQLite's only numeric type is INTEGER, a signed 64-bit int, so it tops out
 *   at 9223372036854775807. Two separate traps follow from that:
 *     1. A reward of 1000000000000000000000001 (1e24) does not merely lose
 *        precision as an INTEGER, it is OUT OF RANGE and would either throw or
 *        be stored as a REAL — silently, and with a value that no longer equals
 *        what was signed.
 *     2. Even inside range, JavaScript's own number type dies above 2^53
 *        (9007199254740992), so anything that round-tripped through a JS number
 *        would already be wrong before SQLite saw it.
 *   Storing reward / stamina_cost / deadline / nonce as TEXT and converting on
 *   read is the only lossless option: `BigInt("1000000000000000000000001")` is
 *   exact, and every call site already goes through `BigInt(record.reward)` or
 *   `Number(record.deadline)`, both of which accept a decimal string.
 *   `deadline` and `nonce` are stored as TEXT too — deadlines are unix seconds
 *   today but are uint256 in the signed struct, so they get the same treatment
 *   rather than a special case that a future change would have to remember.
 *
*   THE GROWTH LEDGERS FOLLOW THE SAME RULE WHERE IT COSTS NOTHING:
*   `consumed`, `granted`, `allocation`, `amount`, the season-claim `nonce` and
*   the governor's `spent` are all TEXT, all returned as canonical decimal
*   strings, for the same out-of-range reason — a season allocation is
*   18-decimal CATT and a running total that rounds is a total that can exceed
*   the very allocation it is meant to be bounded by. (The governor's daily
*   budget is 1e23 base units, i.e. it is out of INTEGER range outright rather
*   than merely inexact.) Stamina POINTS themselves are single-digit integers
*   (see the unit note in `content.js`), but the ledger that SUMS them is
*   stored as text anyway: a counter that silently rounds above 2^53 is a
*   counter that lies, and the cost of being exact is one `toDecimalText` call.
 *
 * WHY ADDRESSES ARE LOWERCASE:
 *   One form, always. `storage.js` already made issued-claim LOOKUPS
 *   case-insensitive (a client may present the checksummed form it got from
 *   /api/submit while another call site uses the lowercase form, and they are
 *   the same wallet). Persisting a single canonical lowercase form makes that
 *   property structural: a `UNIQUE (user_address, nonce)` constraint over
 *   mixed-case text would let `0xAbC` and `0xabc` be two different users with
 *   the same nonce, which is precisely the double-spend the constraint exists
 *   to prevent. EIP-55 checksumming is a DISPLAY concern; the wire form from
 *   /api/submit is unaffected because this store never re-serialises an
 *   address back to a client that did not ask.
 * ------------------------------------------------------------------------ */

/**
 * Canonical storage form of a wallet address: lowercase, or `null`.
 *
 * @param {*} value Candidate address.
 * @returns {string|null}
 */
function normalizeAddress(value) {
  if (value === null || value === undefined) return null;
  return String(value).toLowerCase();
}

/**
 * Canonical comparison form of an address FILTER, or `null` for "no filter".
 *
 * Distinct from `normalizeAddress` above, which is about STORED values and
 * preserves `null` as a legitimate "no address recorded". A filter is different:
 * an absent filter and a blank one (`""`, whitespace) both mean "do not filter
 * by address", so this returns `null` for both. Returning `null` matters most
 * for `excludeUserAddress`, where a blank value must not turn into a predicate
 * that silently drops nothing — or, worse, into a filter that matches no one.
 *
 * `storage.js` documents the four filter combinations and the reasons; this is
 * the SQLite half of that same specification, and the parity test runs both
 * halves against the same script.
 *
 * @param {*} value Candidate address filter.
 * @returns {string|null} Lowercase address, or `null` for "no filter".
 */
function addressScope(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return text === "" ? null : text;
}

/**
 * Canonical storage form of a uint256-ish quantity: a decimal string with no
 * sign, exponent, padding or leading zeroes, or `null`.
 *
 * Accepts what the Judge actually produces — a `bigint`, a `number` that is an
 * exact integer, or a decimal string from `toUintString`.
 *
 * It never THROWS. A value it cannot canonicalise is stored verbatim as text
 * rather than rejected, because throwing here would turn a weird-but-signed
 * amount into a 500 on a user's mining claim, and the memory store would have
 * stored the raw value without complaint. Storing it verbatim keeps it
 * auditable and keeps the failure at the point that actually matters
 * (`BigInt(record.reward)` in the relay cross-check), which is where the memory
 * store fails identically.
 *
 * @param {*} value Candidate quantity.
 * @returns {string|null}
 */
function toDecimalText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? BigInt(trimmed).toString() : trimmed;
  }
  return String(value);
}

/**
 * A quantity for `Number(...)`-based call sites (the relay's deadline
 * comparison) comes back as a number when that is EXACT, and as the decimal
 * string otherwise. Nothing is ever rounded into a number it does not fit in.
 *
 * @param {string|null} text Canonical decimal text.
 * @returns {number|string|null}
 */
function decimalToNumberIfExact(text) {
  if (text === null) return null;
  const asNumber = Number(text);
  return Number.isSafeInteger(asNumber) ? asNumber : text;
}

/**
 * `JSON.stringify` that survives a `bigint`.
 *
 * A column has to hold text, and `JSON.stringify(1n)` THROWS ("Do not know how
 * to serialize a BigInt") — which would turn a submission whose verdict carries
 * a bigint reward into a 500. The memory store has no serialisation boundary
 * and simply keeps the bigint, so this is the one place a JSON-encoded column
 * is lossy in the same way the wire is: a bigint comes back as its exact
 * decimal string, which is what `server.js` already does to every response
 * (`toJsonSafe`) and what a client receives anyway.
 *
 * @param {*} value Any value.
 * @returns {string|null} JSON text, or `null` for `undefined`.
 */
function jsonText(value) {
  if (value === undefined) return null;
  return JSON.stringify(value, (key, inner) => (typeof inner === "bigint" ? inner.toString() : inner));
}

/**
 * Turns a client telemetry sample into the scalar columns the schema declares,
 * without losing the shape the memory store would have returned. `touch` is a
 * NESTED object on the wire (`{ x, y }`, which is what `anticheat.js` reads),
 * so it is flattened into two columns here and rebuilt from `sample_json` on
 * the way out.
 *
 * @param {Object} sample One telemetry sample.
 * @returns {{ ts: number|null, battery_temp_c: number|null, touch_x: number|null, touch_y: number|null, scroll_delta: number|null }}
 */
function toTelemetryColumns(sample) {
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const touch = sample && typeof sample.touch === "object" && sample.touch !== null ? sample.touch : null;
  return {
    ts: num(sample && sample.ts),
    battery_temp_c: num(sample && sample.batteryTempC),
    touch_x: num(touch && touch.x),
    touch_y: num(touch && touch.y),
    scroll_delta: num(sample && sample.scrollDelta),
  };
}

/**
 * Opens (or creates) the SQLite database, applies every outstanding migration
 * and returns a store implementing `STORAGE_METHODS`.
 *
 * The database is opened EAGERLY here, so a bad path or a corrupt file fails at
 * construction (which is where `createApp` calls `assertStoreShape`) rather than
 * on the first mining claim. `init()` re-applies the migration check, which is
 * what a caller with a warm-up hook expects.
 *
 * @param {Object} [options]
 * @param {string} [options.filename] Database file path; `":memory:"` for an
 *   ephemeral database and the documented default outside the repository when
 *   omitted.
 * @param {Console|Object} [options.logger] Sink for non-fatal warnings; defaults
 *   to `console`. Never receives data, only diagnostics.
 * @param {boolean} [options.createDirectory] Create the parent directory when it
 *   is missing (default `true`). Only ever applied to the parent of `filename`.
 * @returns {Object} A store implementing `STORAGE_METHODS`.
 * @throws {Error} If the file cannot be opened, the schema cannot be applied, or
 *   the file's `user_version` is newer than this build understands.
 */
function createSqliteStore({ filename, logger, createDirectory } = {}) {
  const log = logger || console;
  const target = filename === undefined || filename === null || filename === "" ? DEFAULT_SQLITE_PATH : String(filename);
  const inMemory = target === ":memory:";

  if (!inMemory && createDirectory !== false) {
    const dir = path.dirname(path.resolve(target));
    // The ONLY directory this module ever creates, and only ever the parent of
    // an explicitly configured path.
    fs.mkdirSync(dir, { recursive: true });
  }

  const Database = require("better-sqlite3");
  const db = new Database(target);

  // WAL: the default rollback journal makes every commit rewrite the whole
  // database file, and a crash mid-write can leave the file needing recovery.
  // WAL lets readers run while a writer commits and, crucially for THIS
  // adapter's job, a committed transaction is durable the moment better-sqlite3
  // returns from `run()` rather than at some later fsync boundary — so a
  // process that dies (or is SIGKILLed) right after a nonce is handed out comes
  // back up with that nonce burned. The `-wal` and `-shm` sidecar files are part
  // of the database: they must sit on the same filesystem and be kept next to
  // the .db file, which is why the default path is a dedicated directory.
  db.pragma("journal_mode = WAL");
  // Foreign keys are OFF by default in SQLite (for historical reasons) and must
  // be enabled per connection, not once at install. With them on, telemetry
  // rows cannot outlive the session they belong to, and a hand-written INSERT
  // with a bogus session_id fails loudly instead of orphaning samples.
  db.pragma("foreign_keys = ON");

  /* --- schema version, then migrations --------------------------------- */

  /**
   * Applies every migration between the file's current `user_version` and
   * `SCHEMA_VERSION`. Each migration and the `user_version` bump that publishes
   * it share one transaction, so an interrupted upgrade is retried in full
   * rather than half-applied.
   *
   * @returns {void}
   * @throws {Error} On a newer-than-known file, or a migration that fails.
   */
  function migrate() {
    const current = Number(db.pragma("user_version", { simple: true }));
    if (!Number.isInteger(current) || current < 0) {
      throw new Error(`sqlite-store: ${target} has an unreadable user_version (${current}).`);
    }
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `sqlite-store: ${target} is at schema version ${current}, but this build only understands ` +
          `version ${SCHEMA_VERSION}. Refusing to open a database written by a newer Judge.`
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.transaction(() => {
        migration.up(db);
        // `user_version = N` is not a parameterisable statement, so the integer
        // is interpolated from a Number this module computed — never from input.
        db.pragma(`user_version = ${Number(migration.version)}`);
      })();
    }
  }

  migrate();

  /* --- prepared statements, compiled once ------------------------------ */

  const stmt = {
    selectSession: db.prepare("SELECT session_id, user_address, mission_id, created_at FROM sessions WHERE session_id = ?"),
    insertSession: db.prepare(
      "INSERT INTO sessions (session_id, user_address, mission_id, created_at) VALUES (?, ?, ?, ?)"
    ),
    fillSessionMission: db.prepare("UPDATE sessions SET mission_id = ? WHERE session_id = ? AND mission_id IS NULL"),
    nextSampleIndex: db.prepare("SELECT COALESCE(MAX(sample_index), 0) AS last FROM telemetry WHERE session_id = ?"),
    insertTelemetry: db.prepare(
      `INSERT INTO telemetry
         (session_id, sample_index, ts, battery_temp_c, touch_x, touch_y, scroll_delta, sample_json, received_at)
       VALUES (@sessionId, @sampleIndex, @ts, @batteryTempC, @touchX, @touchY, @scrollDelta, @sampleJson, @receivedAt)`
    ),
    selectTelemetry: db.prepare(
      "SELECT sample_json FROM telemetry WHERE session_id = ? ORDER BY sample_index ASC"
    ),
    countTelemetry: db.prepare("SELECT COUNT(*) AS total FROM telemetry WHERE session_id = ?"),
    insertSubmission: db.prepare(
      `INSERT INTO submissions
         (session_id, user_address, mission_id, submitted_at, answers_json, highlight, typing_ms, free_text, status, result_json, reward_json, stamina_cost_json)
       VALUES (@sessionId, @userAddress, @missionId, @submittedAt, @answersJson, @highlight, @typingMs, @freeText, @status, @resultJson, @rewardJson, @staminaCostJson)`
    ),
    lastInsertId: db.prepare("SELECT last_insert_rowid() AS id"),
    selectRecentAll: db.prepare(
      `SELECT id, session_id, user_address, mission_id, submitted_at, answers_json, highlight, typing_ms,
              free_text, status, result_json, reward_json, stamina_cost_json
         FROM submissions ORDER BY submitted_at DESC, id DESC LIMIT ?`
    ),
    selectRecentForUser: db.prepare(
      `SELECT id, session_id, user_address, mission_id, submitted_at, answers_json, highlight, typing_ms,
              free_text, status, result_json, reward_json, stamina_cost_json
         FROM submissions WHERE user_address = ? ORDER BY submitted_at DESC, id DESC LIMIT ?`
    ),
    // The exclusive filter for the syndicate corpus (residual risk #3): every
    // OTHER user. `user_address IS NULL` is kept deliberately — a submission
    // with no recorded address belongs to nobody, so it is nobody's own
    // history and the memory adapter's `who !== exclude` comparison keeps it
    // too. The predicate is a FILTER over the `submissions_recent` index (a
    // `<>` cannot seek), which is exactly why the corpus stays a bounded
    // window; see the risk #2 note in storage.js.
    selectRecentExcludingUser: db.prepare(
      `SELECT id, session_id, user_address, mission_id, submitted_at, answers_json, highlight, typing_ms,
              free_text, status, result_json, reward_json, stamina_cost_json
         FROM submissions WHERE user_address IS NULL OR user_address <> ?
         ORDER BY submitted_at DESC, id DESC LIMIT ?`
    ),
    // Both filters at once. Distinct addresses: that user's rows (no row can
    // be both). Identical addresses: nothing, the documented degenerate case —
    // never "that user's rows" and never "everyone".
    selectRecentForUserExcludingUser: db.prepare(
      `SELECT id, session_id, user_address, mission_id, submitted_at, answers_json, highlight, typing_ms,
              free_text, status, result_json, reward_json, stamina_cost_json
         FROM submissions WHERE user_address = ? AND user_address <> ?
         ORDER BY submitted_at DESC, id DESC LIMIT ?`
    ),
    selectCounter: db.prepare("SELECT last_nonce FROM nonce_counters WHERE user_address = ?"),
    upsertCounter: db.prepare(
      `INSERT INTO nonce_counters (user_address, last_nonce) VALUES (?, ?)
       ON CONFLICT (user_address) DO UPDATE SET last_nonce = excluded.last_nonce`
    ),
    selectClaim: db.prepare(
      `SELECT user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature,
              issued_at, relayed_tx_hash, relayed_at
         FROM issued_claims WHERE user_address = ? AND nonce = ?`
    ),
    insertClaim: db.prepare(
      `INSERT INTO issued_claims
         (user_address, nonce, session_id, digest, reward, stamina_cost, deadline, signature, issued_at, relayed_tx_hash, relayed_at)
       VALUES (@userAddress, @nonce, @sessionId, @digest, @reward, @staminaCost, @deadline, @signature, @issuedAt, @relayedTxHash, @relayedAt)`
    ),
    markRelayed: db.prepare(
      `UPDATE issued_claims SET relayed_tx_hash = @txHash, relayed_at = @relayedAt
        WHERE user_address = @userAddress AND nonce = @nonce AND relayed_tx_hash IS NULL`
    ),

    /* --- growth ledgers ------------------------------------------------- */

    selectStaminaConsumed: db.prepare(
      "SELECT consumed FROM stamina_ledger WHERE user_address = ? AND day_key = ?"
    ),
    upsertStaminaConsumption: db.prepare(
      `INSERT INTO stamina_ledger (user_address, day_key, consumed, updated_at)
         VALUES (@userAddress, @dayKey, @consumed, @updatedAt)
       ON CONFLICT (user_address, day_key) DO UPDATE SET consumed = excluded.consumed, updated_at = excluded.updated_at`
    ),
    selectStreak: db.prepare(
      "SELECT current_streak, last_graded_day FROM streaks WHERE user_address = ?"
    ),
    upsertStreak: db.prepare(
      `INSERT INTO streaks (user_address, current_streak, last_graded_day, last_reward, last_mission_id)
         VALUES (@userAddress, @currentStreak, @lastGradedDay, @lastReward, @lastMissionId)
       ON CONFLICT (user_address) DO UPDATE SET
         current_streak  = excluded.current_streak,
         last_graded_day = excluded.last_graded_day,
         last_reward     = excluded.last_reward,
         last_mission_id = excluded.last_mission_id`
    ),
    markActiveMiner: db.prepare(
      "INSERT OR IGNORE INTO daily_active_miners (day_key, user_address) VALUES (?, ?)"
    ),
    countActiveMiners: db.prepare(
      "SELECT COUNT(*) AS total FROM daily_active_miners WHERE day_key = ?"
    ),
    selectFreeStaminaGranted: db.prepare(
      "SELECT granted FROM free_stamina_grants WHERE user_address = ? AND day_key = ?"
    ),
    upsertFreeStaminaGrant: db.prepare(
      `INSERT INTO free_stamina_grants (user_address, day_key, granted, updated_at)
         VALUES (@userAddress, @dayKey, @granted, @updatedAt)
       ON CONFLICT (user_address, day_key) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at`
    ),
    selectSeason: db.prepare("SELECT id, start_at, end_at, allocation, claim_mode FROM seasons WHERE id = ?"),
    upsertSeason: db.prepare(
      `INSERT INTO seasons (id, start_at, end_at, allocation, claim_mode)
         VALUES (@id, @startAt, @endAt, @allocation, @claimMode)
       ON CONFLICT (id) DO UPDATE SET
         start_at = excluded.start_at, end_at = excluded.end_at,
         allocation = excluded.allocation, claim_mode = excluded.claim_mode`
    ),
    // `[start, end)` with LATEST-start-wins overlap resolution and an `id ASC`
    // tiebreak — the index `seasons_window (start_at DESC, id ASC)` matches this
    // ORDER BY exactly, and `end_at IS NULL` is the open-ended season.
    selectActiveSeason: db.prepare(
      `SELECT id, start_at, end_at, allocation, claim_mode
         FROM seasons
        WHERE start_at <= ? AND (end_at IS NULL OR end_at > ?)
        ORDER BY start_at DESC, id ASC
        LIMIT 1`
    ),
    selectSeasonClaim: db.prepare(
      "SELECT amount FROM season_claims WHERE season_id = ? AND user_address = ? AND nonce = ?"
    ),
    insertSeasonClaim: db.prepare(
      `INSERT INTO season_claims (season_id, user_address, nonce, amount, claimed_at)
         VALUES (@seasonId, @userAddress, @nonce, @amount, @claimedAt)`
    ),
    // Season and per-user totals are SUMMED IN JAVASCRIPT as BigInt, not with
    // SQL `SUM()`. SQLite's SUM() coerces a TEXT column to a double, which is
    // exactly the rounding the TEXT columns exist to prevent — a total computed
    // that way could exceed the allocation it is meant to be bounded by. Both
    // queries are index-served by `season_claims_season` /
    // the (season_id, user_address, nonce) primary key.
    selectSeasonClaimAmounts: db.prepare(
      "SELECT amount FROM season_claims WHERE season_id = ?"
    ),
    selectUserClaimAmounts: db.prepare(
      "SELECT amount FROM season_claims WHERE season_id = ? AND user_address = ?"
    ),

    /* --- the governor ledger (migration 4) ------------------------------ */

    // One row per (season, business day): the amount committed against TODAY's
    // daily emission budget. Primary-key lookup, so it is a single index seek
    // with no clock read and no table scan.
    selectGovernorSpend: db.prepare(
      "SELECT spent FROM governor_daily_spend WHERE season_id = ? AND day_key = ?"
    ),
    // The `ON CONFLICT` clause writes the WHOLE new total rather than doing a
    // SQL `+=`: `+=` on a TEXT column would be SQLite's floating-point addition,
    // which is exactly the rounding the TEXT column exists to prevent.
    upsertGovernorSpend: db.prepare(
      `INSERT INTO governor_daily_spend (season_id, day_key, spent, updated_at)
         VALUES (@seasonId, @dayKey, @spent, @updatedAt)
       ON CONFLICT (season_id, day_key) DO UPDATE SET spent = excluded.spent, updated_at = excluded.updated_at`
    ),
    // The season total, like every other total here, is SUMMED IN JAVASCRIPT as
    // BigInt: SQLite's SUM() coerces a TEXT column to a double. Served by the
    // (season_id, day_key) primary key.
    selectGovernorSpendAmounts: db.prepare(
      "SELECT spent FROM governor_daily_spend WHERE season_id = ?"
    ),
    // The governor reads ask whether the season EXISTS before answering, so an
    // unknown season is a refusal in BOTH adapters instead of a silent "nothing
    // spent" here and an error in the memory store. On the WRITE path the
    // FOREIGN KEY does this job in the database; this statement is what makes
    // the READ path agree with it.
    selectSeasonExists: db.prepare("SELECT id FROM seasons WHERE id = ?"),
  };

  /* --- row -> view mappers --------------------------------------------- */

  /**
   * @param {Object} row A `sessions` row.
   * @returns {Object} The session view the memory store returns.
   */
  function toSession(row) {
    return {
      sessionId: row.session_id,
      userAddress: row.user_address === null ? null : String(row.user_address).toLowerCase(),
      missionId: row.mission_id,
      createdAt: Number(row.created_at),
    };
  }

  /**
   * @param {Object} row A `submissions` row.
   * @returns {Object} The submission view the memory store returns.
   */
  function toSubmission(row) {
    return {
      id: Number(row.id),
      sessionId: row.session_id,
      userAddress: row.user_address === null ? null : String(row.user_address).toLowerCase(),
      missionId: row.mission_id,
      submittedAt: Number(row.submitted_at),
      answers: row.answers_json === null ? null : JSON.parse(row.answers_json),
      highlight: row.highlight,
      typingMs: Number(row.typing_ms),
      freeText: row.free_text,
      // `result` is returned from its lossless JSON column; the scalar
      // status/reward/stamina_cost columns exist for SQL consumers (an operator
      // query, the future Postgres adapter) and are never used to rebuild it.
      result: row.result_json === null ? null : JSON.parse(row.result_json),
    };
  }

  /**
   * @param {Object} row An `issued_claims` row.
   * @returns {Object} The claim view the memory store returns.
   */
  function toClaim(row) {
    return {
      userAddress: row.user_address === null ? null : String(row.user_address).toLowerCase(),
      nonce: Number(row.nonce),
      sessionId: row.session_id,
      digest: row.digest,
      reward: row.reward,
      staminaCost: row.stamina_cost,
      deadline: decimalToNumberIfExact(row.deadline),
      signature: row.signature,
      issuedAt: Number(row.issued_at),
      relayerTxHash: row.relayed_tx_hash,
      relayedAt: row.relayed_at === null ? null : Number(row.relayed_at),
    };
  }

  let closed = false;

  /* --- growth-ledger helpers ------------------------------------------- */

  /**
   * Exact `bigint` of a non-negative integer amount, from whatever the caller
   * passed. Same acceptance rules as the memory store's `toExactAmount`, so the
   * two adapters agree on what a valid amount is.
   *
   * @param {*} value Candidate amount.
   * @param {string} label Field name for the error message.
   * @returns {bigint}
   * @throws {TypeError} If `value` is not a non-negative integer amount.
   */
  function exactAmount(value, label) {
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
   * Sum of a season's claimed amounts, exactly.
   *
   * @param {string} seasonId Season id.
   * @returns {bigint}
   */
  function seasonTotal(seasonId) {
    let total = 0n;
    for (const row of stmt.selectSeasonClaimAmounts.all(seasonId)) {
      total += BigInt(row.amount);
    }
    return total;
  }

  /**
   * Sum of ONE user's claimed amounts in a season, exactly.
   *
   * @param {string} seasonId Season id.
   * @param {string} userAddress Lowercased wallet address.
   * @returns {bigint}
   */
  function userAccrued(seasonId, userAddress) {
    let total = 0n;
    for (const row of stmt.selectUserClaimAmounts.all(seasonId, userAddress)) {
      total += BigInt(row.amount);
    }
    return total;
  }

  /**
   * Canonical season id for a governor call, refusing one that names no season.
   *
   * The WRITE path is guarded twice: this check gives a readable message, and the
   * FOREIGN KEY to `seasons(id)` is the guarantee that survives a bug in
   * application code (a raw INSERT bypassing every line of this module still
   * fails — the test suite proves it). The memory store enforces the same rule in
   * application code, because the two adapters must agree about whether an
   * unknown season is writable or readable.
   *
   * @param {*} seasonId Candidate season id.
   * @returns {string} The canonical season id.
   * @throws {Error} If no such season has been saved.
   */
  function requireSeason(seasonId) {
    const season = String(seasonId);
    if (!stmt.selectSeasonExists.get(season)) {
      throw new Error(
        `sqlite-store: governor spend references unknown season ${JSON.stringify(season)}. ` +
          "A daily emission budget belongs to a season row that exists."
      );
    }
    return season;
  }

  /**
   * A season's committed governor spend across every day, exactly.
   *
   * NOT the same number as `seasonTotal()` above, and the difference is the
   * point: `seasonTotal` is what was SETTLED to users (per-user, per-nonce
   * rows), this is what was COMMITTED against the daily budget (per-day rows,
   * no user). A reward the governor scaled down is committed at full size and
   * settles at the scaled size, so the two differ by exactly what the governor
   * held back. Neither is derived from the other.
   *
   * @param {string} seasonId Season id.
   * @returns {bigint}
   */
  function governorTotal(seasonId) {
    let total = 0n;
    for (const row of stmt.selectGovernorSpendAmounts.all(seasonId)) {
      total += BigInt(row.spent);
    }
    return total;
  }

  /**
   * @param {Object} row A `seasons` row.
   * @returns {Object} The season view the memory store returns.
   */
  function toSeason(row) {
    return {
      id: row.id,
      start: Number(row.start_at),
      end: row.end_at === null ? null : Number(row.end_at),
      allocation: row.allocation,
      claimMode: row.claim_mode,
    };
  }

  const store = {
    /**
     * Warm-up hook. The schema is already applied at construction so that a bad
     * path fails fast; re-running the migration check here is idempotent and
     * exists because a Postgres adapter would `await pool.query` here.
     *
     * @returns {Promise<void>}
     */
    async init() {
      migrate();
    },

    /**
     * Registers a mining session. A repeat call for the SAME `sessionId` is a
     * no-op: it never wipes telemetry already streamed (the mobile app
     * re-registers on resume), and it only fills in a mission id that is
     * missing — matching the memory store exactly. A repeat call carrying a
     * DIFFERENT `userAddress` is left to the HTTP layer to reject with 409.
     *
     * @param {Object} params
     * @param {string} params.sessionId Client-generated session id.
     * @param {string} params.userAddress Wallet the session belongs to.
     * @param {string} params.missionId Mission the user opened.
     * @returns {Promise<Object>} The stored session record.
     */
    async createSession({ sessionId, userAddress, missionId } = {}) {
      const id = String(sessionId);
      const existing = stmt.selectSession.get(id);
      if (existing) {
        if (missionId && !existing.mission_id) {
          stmt.fillSessionMission.run(String(missionId), id);
          const refreshed = stmt.selectSession.get(id);
          return toSession(refreshed);
        }
        return toSession(existing);
      }
      stmt.insertSession.run(id, normalizeAddress(userAddress), missionId == null ? null : String(missionId), Date.now());
      return toSession(stmt.selectSession.get(id));
    },

    /**
     * @param {string} sessionId Session identifier.
     * @returns {Promise<Object|undefined>} The session, or `undefined` if unknown.
     */
    async getSession(sessionId) {
      const row = stmt.selectSession.get(String(sessionId));
      return row ? toSession(row) : undefined;
    },

    /**
     * Appends a batch of samples, auto-creating the session record if the
     * client never registered one. Returns the TOTAL stored for the session, not
     * the size of this batch, so the client can detect a dropped batch.
     *
     * @param {string} sessionId Session identifier.
     * @param {Array<Object>} samples Samples in client order.
     * @returns {Promise<number>} Total samples now stored for the session.
     */
    async appendTelemetry(sessionId, samples) {
      const id = String(sessionId);
      const list = Array.isArray(samples) ? samples : [];
      const now = Date.now();
      // The counter read, the session auto-create and every insert share one
      // transaction: two concurrent batches for the same session must not be
      // able to pick the same sample_index (the UNIQUE constraint would reject
      // the second, which would lose a batch).
      const append = db.transaction((batch) => {
        if (!stmt.selectSession.get(id)) {
          stmt.insertSession.run(id, null, null, now);
        }
        let nextIndex = Number(stmt.nextSampleIndex.get(id).last) + 1;
        for (const sample of batch) {
          const columns = toTelemetryColumns(sample);
          stmt.insertTelemetry.run({
            sessionId: id,
            sampleIndex: nextIndex,
            ts: columns.ts,
            batteryTempC: columns.battery_temp_c,
            touchX: columns.touch_x,
            touchY: columns.touch_y,
            scrollDelta: columns.scroll_delta,
            sampleJson: jsonText(sample),
            receivedAt: now,
          });
          nextIndex += 1;
        }
      });
      append(list);
      return Number(stmt.countTelemetry.get(id).total);
    },

    /**
     * The flat, insertion-ordered samples for a session — exactly what
     * `anticheat.evaluateTelemetry` consumes, and exactly what the memory store
     * returns (samples are stored as JSON so nested `touch: {x, y}` and any
     * future field survive the round trip unchanged).
     *
     * @param {string} sessionId Session identifier.
     * @returns {Promise<Array<Object>>} Samples in insertion order; `[]` if unknown.
     */
    async getTelemetry(sessionId) {
      return stmt.selectTelemetry.all(String(sessionId)).map((row) => JSON.parse(row.sample_json));
    },

    /**
     * Persists a judged attempt, PASS or FAIL, and returns it with its `id`.
     *
     * @param {Object} params See `storage.js`.
     * @returns {Promise<Object>} The stored record, including `id`/`submittedAt`.
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
    } = {}) {
      const row = {
        sessionId: sessionId == null ? null : String(sessionId),
        userAddress: normalizeAddress(userAddress),
        missionId: missionId == null ? null : String(missionId),
        submittedAt: Date.now(),
        answersJson: jsonText(answers),
        highlight: typeof highlight === "string" ? highlight : "",
        typingMs: typeof typingMs === "number" ? typingMs : 0,
        freeText: typeof freeText === "string" ? freeText : "",
        status: result && typeof result.status === "string" ? result.status : null,
        resultJson: jsonText(result),
        // Mirrors of the verdict's money fields, stored as TEXT for the same
        // reason the claim's are: a reward is uint256-scale and an INTEGER
        // column would either overflow or round.
        rewardJson: result && result.reward !== undefined ? toDecimalText(result.reward) : null,
        staminaCostJson: result && result.staminaCost !== undefined ? toDecimalText(result.staminaCost) : null,
      };
      const saved = db.transaction(() => {
        stmt.insertSubmission.run(row);
        return Number(stmt.lastInsertId.get().id);
      })();
      const record = {
        id: saved,
        sessionId: row.sessionId,
        userAddress: row.userAddress,
        missionId: row.missionId,
        submittedAt: row.submittedAt,
        answers: row.answersJson === null ? null : JSON.parse(row.answersJson),
        highlight: row.highlight,
        typingMs: row.typingMs,
        freeText: row.freeText,
        result: row.resultJson === null ? null : JSON.parse(row.resultJson),
      };
      return record;
    },

    /**
     * Newest-first submission list, filtered by address. WITHOUT any address
     * filter the list spans ALL users — still the shape any admin/debug view
     * wants, and unchanged for every existing caller.
     *
     * `userAddress` is INCLUSIVE ("only this user") and `excludeUserAddress` is
     * EXCLUSIVE ("everyone but this user"). The exclusive form is the SYNDICATE
     * CORPUS: a syndicate is a group of submitters copying each other, so the
     * query has to span users — but the submitter's OWN rows must come out, or
     * an honest user who writes the same summary twice is refused by their own
     * text at similarity 1.0 (residual risk #3). The two filters are
     * independent and composable; all four combinations, including the
     * degenerate one where both names are the same address and the answer is
     * legitimately nothing, are specified in `storage.js` and asserted in
     * test/sqlite-store.test.js against BOTH adapters.
     *
     * Addresses are normalised (lowercased) on the way in and are stored
     * lowercase, so both predicates compare in one canonical form. A
     * `user_address` of NULL is kept by the exclusive filter and dropped by the
     * inclusive one, matching the memory adapter exactly.
     *
     * @param {Object} [params]
     * @param {string} [params.userAddress INCLUSIVE filter: ONLY this wallet.
     * @param {string} [params.excludeUserAddress EXCLUSIVE filter: everyone but
     *   this wallet. The syndicate corpus.
     * @param {number} [params.limit] Maximum rows AFTER filtering; defaults to 50.
     * @returns {Promise<Array<Object>>} Newest-first submission records.
     */
    async listRecentSubmissions({ userAddress, excludeUserAddress, limit } = {}) {
      const max = Number.isInteger(limit) && limit > 0 ? limit : 50;
      const include = addressScope(userAddress);
      const exclude = addressScope(excludeUserAddress);
      let rows;
      if (include === null && exclude === null) {
        rows = stmt.selectRecentAll.all(max);
      } else if (include === null) {
        rows = stmt.selectRecentExcludingUser.all(exclude, max);
      } else if (exclude === null) {
        rows = stmt.selectRecentForUser.all(include, max);
      } else {
        // The same address on both sides is the documented degenerate case:
        // `user_address = ? AND user_address <> ?` is unsatisfiable and yields
        // no rows, which is the honest answer rather than "everyone".
        rows = stmt.selectRecentForUserExcludingUser.all(include, exclude, max);
      }
      return rows.map(toSubmission);
    },

    /**
     * Reserves and returns the next never-before-used nonce for a user, and
     * BURNS it. The counter is advanced in the same transaction that hands the
     * nonce out, so a process that dies immediately afterwards still leaves the
     * nonce retired — that is the whole reason this adapter exists. Reissuing it
     * would be a duplicate payment: the contract would accept the first claim and
     * reject the second, leaving the user holding a signature that can never
     * settle.
     *
     * @param {string} userAddress Wallet address.
     * @returns {Promise<number>} The reserved nonce; 1 for a user's first claim.
     */
    async reserveNonce(userAddress) {
      const key = normalizeAddress(userAddress);
      const reserve = db.transaction(() => {
        const current = stmt.selectCounter.get(key);
        // `0` is never handed out, so "no nonce ever issued" stays
        // distinguishable from "nonce 0 was issued".
        const next = (current ? Number(current.last_nonce) : 0) + 1;
        stmt.upsertCounter.run(key, next);
        return next;
      })();
      return reserve;
    },

    /**
     * @param {string} userAddress Wallet address.
     * @param {number|string} nonce Nonce to test.
     * @returns {Promise<boolean>} True if the nonce was already reserved.
     */
    async isNonceUsed(userAddress, nonce) {
      const key = normalizeAddress(userAddress);
      const current = stmt.selectCounter.get(key);
      if (!current) return false;
      const value = Number(nonce);
      return Number.isFinite(value) && value > 0 && value <= Number(current.last_nonce);
    },

    /**
     * Records what was actually SIGNED for a nonce. Deliberately separate from
     * `reserveNonce`: reserving is the "this nonce is spent forever" promise,
     * recording is the "here is the artefact" fact.
     *
     * A repeat call for a (user, nonce) that is already recorded UPDATES the
     * artefact but never touches the relay bookkeeping or the original
     * `issuedAt` — a re-issued claim must not make an already-relayed nonce look
     * relayable again. (The memory store overwrites the record wholesale and
     * carries the relay fields across by hand; the `ON CONFLICT` clause below
     * leaves those columns out of the update entirely, so there is no code path
     * that can clear them.)
     *
     * @param {Object} params See `storage.js`.
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
    } = {}) {
      const key = normalizeAddress(userAddress);
      const nonceNumber = Number(nonce);
      const now = Date.now();
      const save = db.transaction(() => {
        const existing = stmt.selectClaim.get(key, nonceNumber);
        const row = {
          userAddress: key,
          nonce: nonceNumber,
          sessionId: sessionId == null ? null : String(sessionId),
          digest: digest == null ? null : String(digest),
          reward: toDecimalText(reward),
          staminaCost: toDecimalText(staminaCost),
          deadline: toDecimalText(deadline),
          signature: signature == null ? null : String(signature),
          issuedAt: existing ? Number(existing.issued_at) : now,
          relayedTxHash: null,
          relayedAt: null,
        };
        if (existing) {
          db.prepare(
            `UPDATE issued_claims
                SET session_id = @sessionId, digest = @digest, reward = @reward, stamina_cost = @staminaCost,
                    deadline = @deadline, signature = @signature
              WHERE user_address = @userAddress AND nonce = @nonce`
          ).run(row);
        } else {
          stmt.insertClaim.run(row);
        }
        return toClaim(stmt.selectClaim.get(key, nonceNumber));
      })();
      return save;
    },

    /**
     * Reads back the issuance record for a nonce, or `undefined` when this
     * backend never issued it. Case-insensitive in the user address, exactly as
     * the memory store is.
     *
     * @param {string} userAddress Wallet address.
     * @param {number|string} nonce Claim nonce.
     * @returns {Promise<Object|undefined>} The claim record, or `undefined`.
     */
    async getIssuedClaim(userAddress, nonce) {
      const row = stmt.selectClaim.get(normalizeAddress(userAddress), Number(nonce));
      return row ? toClaim(row) : undefined;
    },

    /**
     * Records that the gasless relay broadcast a claim, ONCE.
     *
     * THE DOUBLE-SPEND GUARD. A nonce may be relayed at most once: the mobile
     * app retries `POST /api/relay` whenever the first attempt looks like it
     * failed (which it may well have succeeded), and without this a retry would
     * broadcast the same signature twice.
     *
     * `relay.js`/`server.js` treat `false` as ALREADY RELAYED, so this is
     * idempotent by NON-REPETITION rather than by ignoring the second call: the
     * `WHERE relayed_tx_hash IS NULL` predicate is what refuses, and
     * `UNIQUE(relayed_tx_hash)` is what makes it true even if two relayers race
     * in separate processes. The winning hash is never overwritten.
     *
     * A nonce with NO issuance record still gets a relay-only row, so an
     * unrecorded-but-relayed claim is just as un-relayable as a recorded one.
     * If the transaction hash is already attached to a DIFFERENT claim, the
     * insert is refused and `false` is returned rather than recording a
     * broadcast that does not belong to this nonce.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet the claim is for.
     * @param {number|string} params.nonce Claim nonce.
     * @param {string} params.txHash Transaction hash the relayer broadcast.
     * @returns {Promise<boolean>} True if THIS call recorded it; false if the
     *   nonce was already relayed (or the hash belongs to another claim).
     */
    async markRelayed({ userAddress, nonce, txHash } = {}) {
      const key = normalizeAddress(userAddress);
      const nonceNumber = Number(nonce);
      const now = Date.now();
      const mark = db.transaction(() => {
        const changed = stmt.markRelayed.run({
          userAddress: key,
          nonce: nonceNumber,
          txHash: txHash == null ? null : String(txHash),
          relayedAt: now,
        });
        if (changed.changes === 1) return true;
        if (!stmt.selectClaim.get(key, nonceNumber)) {
          try {
            stmt.insertClaim.run({
              userAddress: key,
              nonce: nonceNumber,
              sessionId: null,
              digest: null,
              reward: null,
              staminaCost: null,
              deadline: null,
              signature: null,
              issuedAt: now,
              relayedTxHash: txHash == null ? null : String(txHash),
              relayedAt: now,
            });
            return true;
          } catch (err) {
            // The partial unique index refused this transaction hash because it
            // is already recorded against another claim.
            if (log && typeof log.warn === "function") {
              log.warn("catt-judge: refusing relay record - tx hash already recorded against another nonce", {
                nonce: nonceNumber,
              });
            }
            return false;
          }
        }
        return false;
      })();
      return mark;
    },

    /* ------------------------------------------------------------------ *
     * Growth ledgers. Pure mechanics, caller-supplied day keys, no clock  *
     * and no economics. The full specification of every method below is   *
     * in `storage.js`, which both adapters implement verbatim.            *
     * ------------------------------------------------------------------ */

    /**
     * Stamina SPENT by one user on one UTC day, as a canonical decimal string.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<{ userAddress: string, dayKey: string, consumed: string }>}
     */
    async getStaminaConsumed({ userAddress, dayKey } = {}) {
      const day = normalizeDayKey(dayKey);
      const row = stmt.selectStaminaConsumed.get(normalizeAddress(userAddress), day);
      return {
        userAddress: normalizeAddress(userAddress),
        dayKey: day,
        consumed: row ? row.consumed : "0",
      };
    },

    /**
     * ADDS to the day's spent total — never replaces it. The read, the add and
     * the upsert share one transaction, so two concurrent spends for the same
     * (user, day) cannot both read the same total and one of them lose its
     * delta; the `ON CONFLICT DO UPDATE` writes the WHOLE new total rather than
     * a SQL `+=`, because `+=` on a TEXT column would be SQLite's floating-point
     * addition and the whole reason this column is text is that it is not.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @param {number|string|bigint} params.amount Points spent by this claim.
     * @returns {Promise<{ userAddress: string, dayKey: string, consumed: string }>}
     */
    async recordStaminaConsumption({ userAddress, dayKey, amount } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = normalizeAddress(userAddress);
      const spent = exactAmount(amount, "amount");
      const total = db.transaction(() => {
        const existing = stmt.selectStaminaConsumed.get(key, day);
        const next = (existing ? BigInt(existing.consumed) : 0n) + spent;
        stmt.upsertStaminaConsumption.run({
          userAddress: key,
          dayKey: day,
          consumed: next.toString(),
          updatedAt: Date.now(),
        });
        return next;
      })();
      return { userAddress: key, dayKey: day, consumed: total.toString() };
    },

    /**
     * The user's current streak. `current: 0` with `lastGradedDay: null` means
     * "never completed anything", which is a different state from a streak of 1
     * and must stay distinguishable.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @returns {Promise<{ userAddress: string, current: number, lastGradedDay: string|null }>}
     */
    async getStreak({ userAddress } = {}) {
      const key = normalizeAddress(userAddress);
      const row = stmt.selectStreak.get(key);
      return {
        userAddress: key,
        current: row ? Number(row.current_streak) : 0,
        lastGradedDay: row && row.last_graded_day !== null ? row.last_graded_day : null,
      };
    },

    /**
     * Records one graded completion and advances the streak. The four cases —
     * first ever → 1, same day again → unchanged, immediate next UTC day → +1,
     * anything else (gap OR a retroactive earlier day) → reset to 1 — are
     * specified, with their reasons, in `storage.js`. `isNextDayAfter` is the
     * SHARED helper, so the memory adapter's rollover cannot differ from this
     * one; and no cap is applied here, because capping is economic policy owned
     * by another module and a cap applied at write time would be baked into rows
     * already on disk.
     *
     * The daily active-miner row is written in the SAME transaction as the
     * streak update, so a graded completion can never leave the streak advanced
     * while the day fails to be counted.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day of the completion.
     * @param {number|string|bigint} [params.reward] Audit fact only.
     * @param {string} [params.missionId] Audit fact only.
     * @returns {Promise<{ userAddress: string, current: number, lastGradedDay: string|null }>}
     */
    async recordGradedCompletion({ userAddress, dayKey, reward, missionId } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = normalizeAddress(userAddress);
      const rewardText = reward === undefined ? null : exactAmount(reward, "reward").toString();
      const missionText = missionId === undefined || missionId === null ? null : String(missionId);
      const current = db.transaction(() => {
        const existing = stmt.selectStreak.get(key);
        let next;
        if (!existing) {
          next = 1;
        } else if (existing.last_graded_day === day) {
          next = Number(existing.current_streak);
        } else if (isNextDayAfter(existing.last_graded_day, day)) {
          next = Number(existing.current_streak) + 1;
        } else {
          next = 1;
        }
        stmt.upsertStreak.run({
          userAddress: key,
          currentStreak: next,
          lastGradedDay: day,
          lastReward: rewardText,
          lastMissionId: missionText,
        });
        // Idempotent: re-recording the same day must not create a second row,
        // and the primary key is what enforces that rather than a JS check.
        stmt.markActiveMiner.run(day, key);
        return next;
      })();
      return { userAddress: key, current, lastGradedDay: day };
    },

    /**
     * Free stamina GRANTED to one user on one UTC day, as a decimal string.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<{ userAddress: string, dayKey: string, granted: string }>}
     */
    async getFreeStaminaGranted({ userAddress, dayKey } = {}) {
      const day = normalizeDayKey(dayKey);
      const row = stmt.selectFreeStaminaGranted.get(normalizeAddress(userAddress), day);
      return { userAddress: normalizeAddress(userAddress), dayKey: day, granted: row ? row.granted : "0" };
    },

    /**
     * Records a free-stamina grant against ONE day, accumulating within it. Day
     * isolation is structural: the key is (user_address, day_key) and there is no
     * code path that reads a grant without naming its day.
     *
     * @param {Object} params
     * @param {string} params.userAddress Wallet address.
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @param {number|string|bigint} params.amount Points granted.
     * @returns {Promise<{ userAddress: string, dayKey: string, granted: string }>}
     */
    async recordFreeStaminaGrant({ userAddress, dayKey, amount } = {}) {
      const day = normalizeDayKey(dayKey);
      const key = normalizeAddress(userAddress);
      const granted = exactAmount(amount, "amount");
      const total = db.transaction(() => {
        const existing = stmt.selectFreeStaminaGranted.get(key, day);
        const next = (existing ? BigInt(existing.granted) : 0n) + granted;
        stmt.upsertFreeStaminaGrant.run({
          userAddress: key,
          dayKey: day,
          granted: next.toString(),
          updatedAt: Date.now(),
        });
        return next;
      })();
      return { userAddress: key, dayKey: day, granted: total.toString() };
    },

    /**
     * Reads one season by id, or `undefined` when there is no such season.
     *
     * @param {string} id Season id.
     * @returns {Promise<Object|undefined>} `{ id, start, end, allocation, claimMode }`.
     */
    async getSeason(id) {
      const row = stmt.selectSeason.get(String(id));
      return row ? toSeason(row) : undefined;
    },

    /**
     * Creates or replaces a season, keyed by `id`. `end: null` is the
     * OPEN-ENDED season and is stored as SQL NULL, not as a sentinel.
     *
     * @param {Object} season See `storage.js`.
     * @returns {Promise<Object>} The stored season.
     */
    async saveSeason({ id, start, end, allocation, claimMode } = {}) {
      const startSeconds = Math.trunc(Number(start));
      if (!Number.isFinite(startSeconds)) throw new TypeError("season.start must be unix seconds.");
      const endSeconds = end === null || end === undefined ? null : Math.trunc(Number(end));
      if (endSeconds !== null && !Number.isFinite(endSeconds)) {
        throw new TypeError("season.end must be unix seconds or null.");
      }
      const row = {
        id: String(id),
        startAt: startSeconds,
        endAt: endSeconds,
        allocation: exactAmount(allocation, "allocation").toString(),
        claimMode: claimMode === null || claimMode === undefined ? null : String(claimMode),
      };
      stmt.upsertSeason.run(row);
      return toSeason(stmt.selectSeason.get(row.id));
    },

    /**
     * The season covering an instant, or `undefined` when none does.
     *
     * `[start, end)`, start-INCLUSIVE and end-EXCLUSIVE, with overlap resolved to
     * the LATEST `start` and ties broken by `id` ASC. Both properties are argued,
     * and the index that serves the ORDER BY, in the migration comment above and
     * in `storage.js`.
     *
     * @param {number} nowEpochSeconds The instant, unix seconds.
     * @returns {Promise<Object|undefined>} The covering season, or `undefined`.
     */
    async getActiveSeason(nowEpochSeconds) {
      const now = Math.trunc(Number(nowEpochSeconds));
      if (!Number.isFinite(now)) throw new TypeError("getActiveSeason(nowEpochSeconds) requires a number.");
      const row = stmt.selectActiveSeason.get(now, now);
      return row ? toSeason(row) : undefined;
    },

    /**
     * Records one season claim and returns the running totals.
     *
     * A duplicate `(seasonId, userAddress, nonce)` is refused BY THE SCHEMA — the
     * composite primary key raises `UNIQUE constraint failed` — rather than by a
     * check here, and the refusal is allowed to propagate. Turning it into a
     * boolean would mean a caller that ignores the return value silently
     * double-accrues, and the whole point of the nonce is that a retried request
     * must not pay twice.
     *
     * Totals are summed in JavaScript as `BigInt` (not SQL `SUM`, which coerces
     * TEXT to a double) and returned as canonical decimal strings.
     *
     * @param {Object} params See `storage.js`.
     * @returns {Promise<{ seasonClaimedTotal: string, userAccrued: string }>}
     */
    async recordSeasonClaim({ seasonId, userAddress, amount, nonce } = {}) {
      const season = String(seasonId);
      const user = normalizeAddress(userAddress);
      const nonceText = exactAmount(nonce, "nonce").toString();
      const value = exactAmount(amount, "amount");
      db.transaction(() => {
        stmt.insertSeasonClaim.run({
          seasonId: season,
          userAddress: user,
          nonce: nonceText,
          amount: value.toString(),
          claimedAt: Date.now(),
        });
      })();
      return { seasonClaimedTotal: seasonTotal(season).toString(), userAccrued: userAccrued(season, user).toString() };
    },

    /**
     * Everything claimed from a season so far, across all users.
     *
     * @param {string} seasonId Season id.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     */
    async getSeasonClaimedTotal(seasonId) {
      return seasonTotal(String(seasonId)).toString();
    },

    /**
     * Everything ONE user has accrued from a season.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season id.
     * @param {string} params.userAddress Wallet address.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     */
    async getSeasonUserAccrued({ seasonId, userAddress } = {}) {
      return userAccrued(String(seasonId), normalizeAddress(userAddress)).toString();
    },

    /**
     * Whether a `(season, user, nonce)` claim has already been recorded.
     *
     * @param {Object} params See `storage.js`.
     * @returns {Promise<boolean>}
     */
    async isSeasonClaimUsed({ seasonId, userAddress, nonce } = {}) {
      const key = exactAmount(nonce, "nonce").toString();
      const row = stmt.selectSeasonClaim.get(String(seasonId), normalizeAddress(userAddress), key);
      return row !== undefined;
    },

    /**
     * How many DISTINCT users were active on a day, counted from the dedicated
     * `daily_active_miners` ledger. `COUNT(*)` over a primary key whose leading
     * column is `day_key`, so the distinctness is structural and the count is an
     * index range scan — no table scan, and no clock read to derive a day from a
     * timestamp. The specification, including why graded completions and not
     * telemetry are the counted population, is in `storage.js`.
     *
     * @param {Object} params
     * @param {string} params.dayKey `YYYY-MM-DD` UTC day.
     * @returns {Promise<number>}
     */
    async countActiveMiners({ dayKey } = {}) {
      return Number(stmt.countActiveMiners.get(normalizeDayKey(dayKey)).total);
    },

    /* ------------------------------------------------------------------ *
     * The GOVERNOR LEDGER (migration 4): one running total per           *
     * (season, business day). NOT the season claimed total.               *
     * ------------------------------------------------------------------ */

    /**
     * How much of TODAY's season emission budget is already committed, as a
     * canonical decimal string. `"0"` when nothing has been committed.
     *
     * The number the reward path scales a reward DOWN by. It is read from the
     * governor ledger rather than derived from `season_claims` because those are
     * different quantities: `season_claims` records what was SETTLED to a
     * specific wallet (per user, per nonce, idempotent), while this records what
     * was COMMITTED against the day's budget (per day, no user). The full
     * argument is in `storage.js`.
     *
     * `dayKey` is the caller-supplied WIB BUSINESS day (04:00 WIB / 21:00 UTC,
     * `reset-schedule.js`) and is stored verbatim. The store never derives it
     * from a timestamp and never expires it, which is why a brand-new day reads
     * `"0"` with no reset step and why yesterday's spend cannot be mistaken for
     * today's.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season whose budget is being measured.
     * @param {string} params.dayKey `YYYY-MM-DD` WIB business day.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     * @throws {TypeError} If `dayKey` is not a real `YYYY-MM-DD` calendar day.
     * @throws {Error} If `seasonId` names no season.
     */
    async getGovernorSpend({ seasonId, dayKey } = {}) {
      const season = requireSeason(seasonId);
      const day = normalizeDayKey(dayKey);
      const row = stmt.selectGovernorSpend.get(season, day);
      return row ? row.spent : "0";
    },

    /**
     * ADDS `amount` to the day's committed budget and returns the new running
     * total for that day.
     *
     * The read, the add and the upsert share ONE transaction, so two concurrent
     * writes for the same (season, day) cannot both read the same total and one
     * of them lose its delta; the `ON CONFLICT DO UPDATE` then writes the whole
     * new total, so a duplicate (season, day) can never produce a second row.
     *
     * NO RESET METHOD EXISTS, AND THAT IS THE DESIGN. The caller derives
     * `dayKey` from the WIB clock, so a new business day is a new bucket that
     * starts at zero by construction — there is nothing to clear. A reset would
     * be worse than useless: it would let a day that already emitted be zeroed
     * and re-spent, so the audit trail of a season's emission could be erased by
     * any caller. The full argument is in `storage.js`.
     *
     * A `seasonId` THAT NAMES NO SEASON IS REFUSED BY THE DATABASE, not by a
     * check here: the FOREIGN KEY to `seasons(id)` is what makes the refusal
     * survive a bug in application code. The memory store enforces the same rule
     * in application code, because the two adapters must agree about whether an
     * unknown season is writable.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season whose budget is consumed.
     * @param {string} params.dayKey `YYYY-MM-DD` WIB business day.
     * @param {number|string|bigint} params.amount 18-decimal CATT base units.
     * @returns {Promise<string>} The day's new total, as a canonical decimal
     *   string.
     * @throws {TypeError} On a malformed `amount` or `dayKey`.
     * @throws {Error} If `seasonId` names no season — `FOREIGN KEY constraint
     *   failed`.
     */
    async recordGovernorSpend({ seasonId, dayKey, amount } = {}) {
      const season = requireSeason(seasonId);
      const day = normalizeDayKey(dayKey);
      const spent = exactAmount(amount, "amount");
      const total = db.transaction(() => {
        const existing = stmt.selectGovernorSpend.get(season, day);
        const next = (existing ? BigInt(existing.spent) : 0n) + spent;
        stmt.upsertGovernorSpend.run({
          seasonId: season,
          dayKey: day,
          spent: next.toString(),
          updatedAt: Date.now(),
        });
        return next;
      })();
      return total.toString();
    },

    /**
     * Everything a season has committed against its daily budgets across EVERY
     * day, as a canonical decimal string. `"0"` when nothing.
     *
     * THE RECONCILIATION FIGURE, and explicitly not
     * `getSeasonClaimedTotal()`: the founder's allocation is 3,300,000 CATT and
     * this is what was committed against it, whereas the claimed total is what
     * was actually settled. A reward the governor scaled down is committed at
     * full size here and settles at the scaled size there, so the two are not
     * expected to agree. Summed as BigInt in JavaScript, never with SQL `SUM()`,
     * which would coerce this TEXT column to a double.
     *
     * @param {Object} params
     * @param {string} params.seasonId Season id.
     * @returns {Promise<string>} Canonical decimal string; `"0"` when nothing.
     */
    async getGovernorSpendTotal({ seasonId } = {}) {
      return governorTotal(requireSeason(seasonId)).toString();
    },

    /**
     * Closes the database. Safe to call twice, and safe to call when the store
     * was never opened successfully. The final call also checkpoints the WAL, so
     * a clean shutdown leaves a single self-contained `.db` file.
     *
     * @returns {Promise<void>}
     */
    async close() {
      if (closed) return;
      closed = true;
      if (db.open) {
        try {
          if (!inMemory) db.pragma("wal_checkpoint(TRUNCATE)");
        } catch (err) {
          /* a checkpoint failure must not stop the handle from being released */
        }
        db.close();
      }
    },

    /**
     * Alias of {@link close}, kept in `STORAGE_METHODS` so an adapter has to
     * provide both spellings explicitly.
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      await store.close();
    },

    /* ------------------------------------------------------------------ *
     * Test / debugging affordances. NOT part of STORAGE_METHODS.          *
     * ------------------------------------------------------------------ */

    /**
     * Snapshot of stored state, mirroring the memory store's `_debugState()` so
     * the two adapters can be compared with one assertion.
     *
     * @returns {{ sessions: number, telemetry: number, submissions: number, issuedClaims: number, relayedClaims: number }}
     */
    _debugState() {
      const one = (sql) => Number(db.prepare(sql).get().n);
      return {
        sessions: one("SELECT COUNT(*) AS n FROM sessions"),
        telemetry: one("SELECT COUNT(*) AS n FROM telemetry"),
        submissions: one("SELECT COUNT(*) AS n FROM submissions"),
        issuedClaims: one("SELECT COUNT(*) AS n FROM issued_claims"),
        relayedClaims: one("SELECT COUNT(*) AS n FROM issued_claims WHERE relayed_tx_hash IS NOT NULL"),
      };
    },

    /**
     * Row counts for every GROWTH/GOVERNOR table — the SQLite half of the memory
     * store's `_debugGrowth()`, so the parity assertion can compare the two with
     * one `deepEqual`. Counting the tables (rather than trusting the public
     * totals) is what proves the upsert path left exactly one row per
     * (season, day) instead of quietly inserting a second.
     *
     * NOT part of `STORAGE_METHODS`.
     *
     * @returns {{ staminaLedger: number, streaks: number, activeMiners: number,
     *   freeGrants: number, seasons: number, seasonClaims: number,
     *   governorSpend: number }}
     */
    _debugGrowth() {
      const one = (sql) => Number(db.prepare(sql).get().n);
      return {
        staminaLedger: one("SELECT COUNT(*) AS n FROM stamina_ledger"),
        streaks: one("SELECT COUNT(*) AS n FROM streaks"),
        activeMiners: one("SELECT COUNT(*) AS n FROM daily_active_miners"),
        freeGrants: one("SELECT COUNT(*) AS n FROM free_stamina_grants"),
        seasons: one("SELECT COUNT(*) AS n FROM seasons"),
        seasonClaims: one("SELECT COUNT(*) AS n FROM season_claims"),
        governorSpend: one("SELECT COUNT(*) AS n FROM governor_daily_spend"),
      };
    },

    /* ------------------------------------------------------------------ *
     * Pilot telemetry aggregates (privacy-minimal: counts/distributions)
     * ------------------------------------------------------------------ */

    /**
     * Telemetry score distribution across all sessions.
     * Returns histogram buckets: 0-19, 20-39, 40-59, 60-79, 80-100.
     * @returns {Promise<Record<string, number>>}
     */
    async getTelemetryScoreDistribution() {
      const buckets = { "0-19": 0, "20-39": 0, "40-59": 0, "60-79": 0, "80-100": 0 };
      const rows = db.prepare("SELECT sample_json FROM telemetry").all();
      for (const row of rows) {
        try {
          const sample = JSON.parse(row.sample_json);
          const score = sample.score ?? 0;
          if (score < 20) buckets["0-19"]++;
          else if (score < 40) buckets["20-39"]++;
          else if (score < 60) buckets["40-59"]++;
          else if (score < 80) buckets["60-79"]++;
          else buckets["80-100"]++;
        } catch (_) {
          // Ignore malformed JSON
        }
      }
      return buckets;
    },

    /**
     * BATTERY_NOT_REPORTED rate across all sessions with telemetry.
     * @returns {Promise<{ totalSamples: number, batteryNotReported: number, rate: number }>}
     */
    async getBatteryNotReportedRate() {
      let totalSamples = 0;
      let batteryNotReported = 0;
      const rows = db.prepare("SELECT sample_json FROM telemetry").all();
      for (const row of rows) {
        try {
          const sample = JSON.parse(row.sample_json);
          totalSamples++;
          if (sample.batteryTempC === undefined || sample.batteryTempC === null) {
            batteryNotReported++;
          }
        } catch (_) {
          // Ignore malformed JSON
        }
      }
      return {
        totalSamples,
        batteryNotReported,
        rate: totalSamples > 0 ? batteryNotReported / totalSamples : 0,
      };
    },

    /**
     * FAIL reason counts from submissions.
     * Returns counts per failure flag/reason.
     * @returns {Promise<Record<string, number>>}
     */
    async getFailReasonCounts() {
      const counts = {};
      const rows = db.prepare("SELECT result_json FROM submissions WHERE status = 'FAIL'").all();
      for (const row of rows) {
        try {
          const result = JSON.parse(row.result_json);
          const flags = result?.flags || [];
          for (const flag of flags) {
            counts[flag] = (counts[flag] || 0) + 1;
          }
        } catch (_) {
          // Ignore malformed JSON
        }
      }
      return counts;
    },

    /**
     * Missions per user per day (average across active users).
     * Only counts graded completions (PASS submissions).
     * @returns {Promise<{ average: number, perUser: Record<string, number> }>}
     */
    async getMissionsPerUserPerDay() {
      const userDayCounts = {};
      const rows = db.prepare("SELECT user_address, submitted_at FROM submissions WHERE status = 'PASS'").all();
      for (const row of rows) {
        const user = row.user_address;
        if (!user) continue;
        userDayCounts[user] = (userDayCounts[user] || 0) + 1;
      }
      const perUser = userDayCounts;
      const values = Object.values(perUser);
      const average = values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
      return { average, perUser };
    },

    /**
     * Governor engagement counts: daily spend totals from the governor ledger.
     * @returns {Promise<{ dailySpendTotals: Record<string, string>, scaled: number, floored: number, blackedOut: number }>}
     */
    async getGovernorEngagements() {
      const dailySpendTotals = {};
      const rows = db.prepare("SELECT season_id, day_key, spent FROM governor_daily_spend").all();
      for (const row of rows) {
        dailySpendTotals[`${row.season_id}|${row.day_key}`] = row.spent;
      }
      return {
        dailySpendTotals,
        scaled: 0,
        floored: 0,
        blackedOut: 0,
      };
    },

    /**
     * The database's current `PRAGMA user_version`. Exposed so an operator (or a
     * test) can confirm which schema a file is on.
     *
     * @returns {number}
     */
    _schemaVersion() {
      return Number(db.pragma("user_version", { simple: true }));
    },

    /**
     * Escape hatch for the tests: the live `better-sqlite3` handle, so a test
     * can attempt raw SQL and prove the constraints are in the SCHEMA rather
     * than only in JavaScript.
     *
     * @returns {Object} The `better-sqlite3` database.
     */
    _raw() {
      return db;
    },
  };

  return assertStoreShape(store);
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_SQLITE_PATH,
  MIGRATIONS,
  createSqliteStore,
  STORAGE_METHODS,
};
