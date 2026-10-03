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
 * No secret, key or credential is read, stored or logged by this module.
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
  "close",
  "dispose",
]);

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
};
