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
 *   -- listRecentSubmissions() is exactly this index, newest first.
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
 *     PRIMARY KEY (user_address, nonce),
 *     CONSTRAINT issued_claims_unique_nonce UNIQUE (user_address, nonce)
 *   )
 *   -- The PRIMARY KEY is the DB-level equivalent of reserveNonce()'s
 *   -- guarantee: two concurrent transactions cannot obtain the same
 *   -- (user_address, nonce), so a reserved-but-never-signed nonce is burned
 *   -- the moment the row lands. The memory store mirrors this by advancing a
 *   -- per-user counter on EVERY reserveNonce() call, before the caller has
 *   -- had any chance to sign.
 *
 * No secret, key or credential is read, stored or logged by this module.
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
     * Lists recent submissions, NEWEST FIRST.
     *
     * When `userAddress` is supplied the list is scoped to that user;
     * when it is omitted the list spans ALL users, which is the mode syndicate
     * detection needs — a syndicate is a *group* of submitters copying each
     * other, so a per-user query can never see the copy. A per-user scope is
     * offered only for debugging and for any future "my submission history"
     * mobile screen.
     *
     * Postgres: `SELECT * FROM submissions ORDER BY submitted_at DESC, id DESC
     * LIMIT $1`, optionally `WHERE user_address = $2`. Ordering by `id DESC`
     * as a tiebreaker keeps the order total and deterministic when several
     * submissions land inside one clock tick.
     *
     * @param {Object} [params]
     * @param {string} [params.userAddress Restrict to one wallet; omit for all users.
     * @param {number} [params.limit] Maximum rows; defaults to 50.
     * @returns {Promise<Array<Object>>} Newest-first submission records.
     */
    async listRecentSubmissions({ userAddress, limit } = {}) {
      const max = Number.isInteger(limit) && limit > 0 ? limit : 50;
      const scoped =
        userAddress === undefined || userAddress === null
          ? submissionOrder
          : submissionOrder.filter((row) => row.userAddress === userAddress);
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
      };
      issuedClaims.set(`${record.userAddress}:${record.nonce}`, record);
      return clone(record);
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
     * @returns {{ sessions: number, telemetry: number, submissions: number, issuedClaims: number }}
     */
    _debugState() {
      let telemetryCount = 0;
      for (const bucket of telemetry.values()) telemetryCount += bucket.length;
      return {
        sessions: sessions.size,
        telemetry: telemetryCount,
        submissions: submissionOrder.length,
        issuedClaims: issuedClaims.size,
      };
    },
  };

  return assertStoreShape(store);
}

module.exports = {
  STORAGE_METHODS,
  assertStoreShape,
  createMemoryStore,
};
