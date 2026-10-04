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
 *     `issued_claims`. Nothing in `issued_claims` is needed to interpret
 *     anything in `submissions`, so the order has no back-edges. Because
 *     `user_address` is stored LOWERCASE here (see below), Postgres must
 *     receive lowercase too or the unique constraints stop lining up with the
 *     rows the Judge already issued; `citext`/lowercase normalisation on the
 *     application side is what keeps `getIssuedClaim` case-insensitive there.
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

const { STORAGE_METHODS, assertStoreShape } = require("./storage");

/**
 * The schema version this build of the code creates and understands. Stored in
 * `PRAGMA user_version`; see the migration note (a) above.
 *
 * @type {number}
 */
const SCHEMA_VERSION = 1;

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
