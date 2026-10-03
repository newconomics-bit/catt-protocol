/**
 * CATT Protocol — Backend Judge HTTP layer (PRD 3.2 "The Judge", PRD 6.2
 * "Mining Loop").
 *
 * This is the Express wiring around three collaborators, all injected so the app
 * is testable without touching globals:
 *   - `content`   the content randomizer (article/quiz/highlight data)
 *   - `anticheat` the Proof-of-Attention engine (PRD 3.2 "Anti-Cheat Engine")
 *   - `signer`    the EIP-712 Signature Generator (PRD 3.2)
 *   - `store`     the persistence interface (see ./storage.js)
 *
 * It is a JUDGE and nothing else. It does not read articles, does not score
 * telemetry and does not implement any cryptography: it sequences those calls
 * in the only order that is safe and hands the result to the client.
 *
 * THE ORDER OF OPERATIONS IN `/api/submit` IS THE WHOLE POINT OF THIS FILE.
 * Reading it top-to-bottom, the sequence is:
 *
 *   1. Validate the request.            -> never let malformed input reach the
 *                                          engine; a 400 here is free.
 *   2. Resolve mission + article.       -> the judgement is always made against
 *                                          the mission the SESSION opened, not
 *                                          against one the client asks for, so a
 *                                          client cannot pick its own difficulty.
 *   3. Evaluate telemetry.              -> hardware truth first.
 *   4. Detect syndicate.                -> human-truth second, and it needs the
 *                                          other users' past answers, which is
 *                                          why the store is queried across ALL
 *                                          users rather than just this one.
 *   5. Evaluate the submission.         -> comprehension.
 *   6. AND the three verdicts together.  -> a pass requires all three.
 *   7. On FAIL: store it, sign nothing. -> no nonce is burned, no signature is
 *                                          produced, and the response contains
 *                                          no `claim` and no `signature` key at
 *                                          all, so there is nothing to replay
 *                                          even if the client keeps the body.
 *   8. On PASS: reserve a nonce, THEN sign, THEN record what was signed.
 *
 * Steps 3-5 are all "read-only" and are evaluated before ANY state is written,
 * because a submission that is going to fail must not consume a nonce (see
 * `storage.reserveNonce`: nonces are burned forever, on-chain, so burning one
 * for a quiz the user simply got wrong would be a self-inflicted denial of
 * service on the user's mining loop).
 *
 * Steps 7-8 are mutually exclusive on purpose: the signing key is touched on
 * exactly one code path, and that path is the last thing the handler does.
 *
 * SECURITY POSTURE (PRD Section 5, Rule 2):
 *   - The signer private key is injected, never read from a module-level global,
 *     and NEVER logged, echoed, or included in any response. The only signer
 *     value that leaves this process is its public ADDRESS.
 *   - The only environment values that are ever logged are non-secret
 *     configuration (port, chainId, verifyingContract).
 *   - Error responses are a fixed, opaque code. Stack traces and internal
 *     messages go to the injected `logger` and never to the client.
 *   - The answer key (`highlightTask.keySentences`, `quiz[].correctIndex`) is
 *     stripped from every response. A bot that could read the key out of
 *     `GET /api/article/:id` would satisfy the highlight check without ever
 *     reading the article, which would make the entire Proof-of-Attention
 *     mechanism decorative.
 */

const express = require("express");
const { ethers } = require("ethers");

const content = require("./content");
const anticheat = require("./anticheat");
const signer = require("../signer");
const { createMemoryStore, assertStoreShape } = require("./storage");

/**
 * Lifetime of a signed mining claim, in seconds.
 *
 * The deadline is part of the signed struct hash, so it is the backend's only
 * off-chain replay bound: on-chain, `MiningClaimer` treats a nonce as
 * single-use forever, but until it is spent a signature is a bearer token for
 * that reward, and a short window bounds how long a leaked one is worth. It
 * must be long enough for a user on mobile data to gather a transaction and
 * broadcast it, and short enough that a stored signature has little value.
 * Exported so the mobile client and the tests can reason about the window
 * instead of hardcoding their own guess.
 *
 * @type {number}
 */
const CLAIM_TTL_SECONDS = 600;

/** Default cap on a request body: 256 KiB is generous for telemetry batches. */
const BODY_LIMIT = "256kb";

/** How many recent submissions syndicate detection compares against. */
const SYNDICATE_LOOKBACK = 50;

/** Error codes this server emits. Clients may switch on them; they never change. */
const ERRORS = Object.freeze({
  ARTICLE_NOT_FOUND: "ARTICLE_NOT_FOUND",
  SESSION_REQUIRED: "SESSION_REQUIRED",
  INVALID_TELEMETRY: "INVALID_TELEMETRY",
  INVALID_SUBMISSION: "INVALID_SUBMISSION",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  MISSION_NOT_FOUND: "MISSION_NOT_FOUND",
  ARTICLE_MISSING: "ARTICLE_MISSING",
  SESSION_CONFLICT: "SESSION_CONFLICT",
  NOT_FOUND: "NOT_FOUND",
  INVALID_JSON: "INVALID_JSON",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/**
 * Extra flags the JUDGE adds on top of the anti-cheat engine's own flags.
 *
 * These exist for one reason: `anticheat.evaluateSubmission` cannot see the
 * other two verdicts. It judges comprehension (quiz, highlight, typing speed)
 * and the telemetry SCORE, but it has no view of the cross-user submission
 * log, so a perfect syndicated answer comes back from it as a PASS. The syndicate
 * check therefore has to be able to overturn an engine PASS, and when it does,
 * the response has to say so in the same vocabulary as every other failure —
 * a `status` of FAIL, a `reward` of 0, and a named reason. These constants are
 * the Judge's own and are deliberately distinct from `anticheat.FLAGS` /
 * `anticheat.SUBMISSION_FLAGS`, which are never re-implemented or renamed here.
 */
const JUDGE_FLAGS = Object.freeze({
  SYNDICATE_MATCH: "SYNDICATE_MATCH",
  TELEMETRY_UNACCEPTABLE: "TELEMETRY_UNACCEPTABLE",
});

/**
 * Deeply converts a value into something `JSON.stringify` can handle.
 *
 * The anti-cheat engine is entitled to work in `bigint` (rewards are
 * 18-decimal base units, and `bigint` is the only lossless way to represent
 * them). `JSON.stringify` THROWS on a `bigint`, which would turn every
 * successful mining claim into a 500. Bigints therefore become decimal strings
 * — lossless, and what a client would have to do anyway. The signature is
 * computed over the SAME normalised values, so what is signed and what is
 * returned stay byte-identical.
 *
 * @param {*} value Any value.
 * @returns {*} A JSON-serialisable equivalent.
 */
function toJsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  const out = {};
  for (const key of Object.keys(value)) out[key] = toJsonSafe(value[key]);
  return out;
}

/**
 * True for a non-empty string with at least one non-whitespace character.
 *
 * @param {*} value Candidate.
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Normalises a uint256-scale quantity to a decimal string for the wire.
 * Accepts bigint, number or decimal/bigint-ish string; anything else becomes
 * `"0"` rather than `undefined`, so the signed struct can never contain a
 * missing field (which would change the struct hash and produce a signature
 * the contract rejects).
 *
 * @param {*} value Candidate amount.
 * @returns {string} Decimal string.
 */
function toUintString(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value)).toString();
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();
  return "0";
}

/**
 * Wraps an async route handler so a rejected promise reaches the Express error
 * handler instead of becoming an unhandled rejection.
 *
 * THIS IS NOT OPTIONAL AND NOT DEFENSIVE POLISH. Express 4 invokes a handler
 * and only catches SYNCHRONOUS throws; a handler that is `async` returns a
 * promise, and a rejection from it escapes the router entirely. The request
 * then hangs until the client times out, the process gets an unhandled
 * rejection, and the JSON error handler below never runs — which is precisely
 * the case that matters here, because the most likely rejection is
 * `signer.signClaim` failing on a missing or malformed key. Without this
 * wrapper a misconfigured deployment would hang users' requests instead of
 * returning a clean 500 and logging an alert.
 *
 * (Express 5 fixes this natively; this project is deliberately on Express 4,
 * so the wrapper is the fix.)
 *
 * @param {Function} fn An `async (req, res, next)` handler.
 * @returns {Function} A safe `(req, res, next)` handler.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Sends a JSON error response with a fixed status.
 *
 * @param {Object} res Express response.
 * @param {number} status HTTP status code.
 * @param {string} code Stable machine-readable error code.
 * @returns {Object} The Express response, for chaining.
 */
function sendError(res, status, code) {
  return res.status(status).json({ error: code });
}

/**
 * Runs `anticheat.evaluateTelemetry` defensively.
 *
 * Telemetry arrives straight from an untrusted client, so the array handed to
 * the engine can be empty, wrongly typed or adversarially huge. An engine
 * exception must not become a 500 for a legitimate-but-malformed session; it
 * must become an UNACCEPTABLE telemetry result, which fails the submission the
 * same way any other telemetry failure does.
 *
 * @param {Array<Object>} samples Stored samples.
 * @returns {{ score: number, flags: Array<string> }} Evaluation result.
 */
function safeEvaluateTelemetry(samples) {
  try {
    const result = anticheat.evaluateTelemetry(samples);
    if (result && typeof result.score === "number") {
      return { score: result.score, flags: Array.isArray(result.flags) ? result.flags : [] };
    }
  } catch (err) {
    /* fall through to the unusable verdict below */
  }
  return { score: 0, flags: ["TELEMETRY_UNUSABLE"] };
}

/**
 * Builds the express application.
 *
 * Every dependency is injected with a sane default, which is the whole reason
 * the app is testable: a test can pass a throwaway in-memory store, a throwaway
 * private key and a recording logger without touching `process.env` or any
 * module-level state.
 *
 * @param {Object} [params]
 * @param {Object} [params.store] Storage interface implementation; defaults to `createMemoryStore()`.
 * @param {string} [params.privateKey] Backend signer key. NEVER logged or returned.
 * @param {number|string} [params.chainId] EVM chain id for the EIP-712 domain.
 * @param {string} [params.verifyingContract] Deployed MiningClaimer address.
 * @param {Console|Object} [params.logger] Sink for server-side logs; defaults to `console`.
 * @returns {import("express").Express} The configured app.
 * @throws {Error} If the injected store does not implement the storage interface.
 */
function createApp({ store, privateKey, chainId, verifyingContract, logger } = {}) {
  const activeStore = store || createMemoryStore();

  // Fail fast and loudly: a Postgres adapter that forgets a method must not be
  // able to boot and then discover the gap on a user's mining claim.
  assertStoreShape(activeStore);

  const log = logger || console;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: BODY_LIMIT, strict: true }));

  /* ---------------------------------------------------------------- *
   * GET /api/health                                                      *
   * ---------------------------------------------------------------- */

  /**
   * Liveness probe. Deliberately dependency-free: it reports that the process
   * is up and its JSON stack is working. It does NOT report whether the signer
   * key is present or whether the database is reachable, because that is
   * information an unauthenticated caller has no business learning.
   */
  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------- *
   * GET /api/missions — the bounty board                                 *
   * ---------------------------------------------------------------- */

  /**
   * Lists the missions a user may pick from.
   *
   * SECRETS SHOWN: the board shows only what a user needs to make a choice —
   * `id`, `articleId`, `difficulty`, `reward`, `staminaCost`. It is built by
   * explicit projection, never by deleting keys from the full mission, so a
   * field added to the content module later cannot silently start being served.
   * In particular the quiz, its `correctIndex`, the article prose and the
   * highlight `keySentences` are all answers rather than content and are never
   * included.
   */
  app.get("/api/missions", (req, res) => {
    const missions = content.listMissions().map((mission) => ({
      id: mission.id,
      articleId: mission.articleId,
      difficulty: mission.difficulty,
      reward: toUintString(mission.reward),
      staminaCost: toUintString(mission.staminaCost),
    }));
    res.json(missions);
  });

  /* ---------------------------------------------------------------- *
   * GET /api/article/:id — the randomized reading material               *
   * ---------------------------------------------------------------- */

  /**
   * Returns the per-session article layout: shuffled paragraphs and a
   * randomized focus trap, deterministically derived from `session`, so a
   * reload cannot reshuffle the page under the reader and a bot cannot
   * pre-learn a single canonical ordering.
   *
   * `session` is MANDATORY because it is the seed. Without it there is nothing
   * to randomize against, and serving one fixed ordering would hand every bot
   * the same target.
   *
   * The layout is a COPY with two answer keys removed:
   *
   *   - `highlightTask.keySentences` — the sentences the highlight task is
   *     looking for. Shipping them would let any client satisfy the highlight
   *     check without reading a word.
   *   - `quiz[].correctIndex` — which option is right, per question. Shipping it
   *     would let any client satisfy the comprehension check without reading a
   *     word, by simply answering every question correctly. It is removed for
   *     the same reason as the key sentences and by the same threat model: a bot
   *     that can read the answer key out of the reading endpoint has not read
   *     anything, and every reward it claims afterwards is unearned. The client
   *     still receives the question text and its options, which is all a real
   *     reader needs.
   *
   * The server keeps both internally and scores against them at submit time.
   */
  app.get("/api/article/:id", (req, res) => {
    const sessionId = req.query.session;
    if (!isNonEmptyString(sessionId)) return sendError(res, 400, ERRORS.SESSION_REQUIRED);

    const layout = content.getArticleLayout(req.params.id, sessionId);
    if (!layout) return sendError(res, 404, ERRORS.ARTICLE_NOT_FOUND);

    const body = toJsonSafe(layout);
    if (body.highlightTask && typeof body.highlightTask === "object") {
      const { keySentences, ...rest } = body.highlightTask;
      body.highlightTask = rest;
    }
    if (Array.isArray(body.quiz)) {
      body.quiz = body.quiz.map((question) => {
        if (!question || typeof question !== "object") return question;
        const { correctIndex, ...rest } = question;
        return rest;
      });
    }
    res.json(body);
  });

  /* ---------------------------------------------------------------- *
   * POST /api/session — session registration                            *
   * ---------------------------------------------------------------- */

  /**
   * Registers a mining session. The app calls this before it starts streaming
   * telemetry so the backend knows which mission this session is being judged
   * against; `/api/telemetry` also auto-creates the record, so this is about
   * correctness of attribution rather than about not losing data.
   *
   * A re-registration by the SAME user is idempotent (it must not wipe the
   * telemetry already streamed — see `store.createSession`). A re-registration
   * by a DIFFERENT user is a 409: a session id is a capability to add
   * telemetry and, ultimately, to submit, so it must not be re-pointable at a
   * different wallet.
   */
  app.post("/api/session", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { sessionId, user, missionId } = body;
    if (!isNonEmptyString(sessionId) || !isNonEmptyString(user) || !isNonEmptyString(missionId)) {
      return sendError(res, 400, ERRORS.INVALID_SUBMISSION);
    }
    if (!ethers.isAddress(user)) return sendError(res, 400, ERRORS.INVALID_SUBMISSION);

    const existing = await activeStore.getSession(sessionId);
    if (existing && existing.userAddress && existing.userAddress.toLowerCase() !== user.toLowerCase()) {
      return sendError(res, 409, ERRORS.SESSION_CONFLICT);
    }

    const session = await activeStore.createSession({ sessionId, userAddress: user, missionId });
    res.status(201).json({ sessionId: session.sessionId, user: session.userAddress, missionId: session.missionId });
  }));

  /* ---------------------------------------------------------------- *
   * POST /api/telemetry — Proof-of-Attention stream                      *
   * ---------------------------------------------------------------- */

  /**
   * Appends a batch of telemetry samples to a session (the mobile client posts
   * every 5 seconds, PRD 3.1) and returns the LIVE evaluation so the client can
   * see its own standing. Surfacing the score is a product decision, not a
   * leak: the flags are coarse ("battery temperature flatlined") and the score
   * is a continuous function of data the client already holds, so publishing it
   * tells a bot nothing it does not already know, while a user who is about to
   * be rejected for an invisible reason is not left guessing.
   *
   * `accepted` is the number of samples in THIS batch and `total` is the number
   * stored for the session so far. The two are different on purpose: clients
   * detect a dropped batch by comparing them.
   */
  app.post("/api/telemetry", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { sessionId, samples } = body;
    if (!isNonEmptyString(sessionId) || !Array.isArray(samples) || samples.length === 0) {
      return sendError(res, 400, ERRORS.INVALID_TELEMETRY);
    }

    const total = await activeStore.appendTelemetry(sessionId, samples);
    const telemetry = safeEvaluateTelemetry(await activeStore.getTelemetry(sessionId));
    res.json({
      accepted: samples.length,
      total,
      telemetry: { score: telemetry.score, flags: telemetry.flags },
    });
  }));

  /* ---------------------------------------------------------------- *
   * GET /api/session/:id/telemetry — debug view                           *
   * ---------------------------------------------------------------- */

  /** Read-only view of a session's telemetry, for support and debugging. */
  app.get("/api/session/:id/telemetry", asyncHandler(async (req, res) => {
    const samples = await activeStore.getTelemetry(req.params.id);
    const telemetry = safeEvaluateTelemetry(samples);
    res.json({ sessionId: req.params.id, count: samples.length, score: telemetry.score, flags: telemetry.flags });
  }));

  /* ---------------------------------------------------------------- *
   * POST /api/submit — the Judge                                        *
   * ---------------------------------------------------------------- */

  /**
   * Judges one mining attempt and, on a pass, issues the EIP-712 signature that
   * closes the loop into `MiningClaimer.claimReward`.
   *
   * See the file header for the full rationale of the ordering. The invariant
   * worth restating here: the private key is used on exactly one line, the
   * signing line, and nothing in the FAIL path can reach it.
   */
  app.post("/api/submit", asyncHandler(async (req, res) => {
    /* --- 1. Validate. Nothing malformed reaches the engine. --- */
    const body = req.body || {};
    const { sessionId, user, answers, highlight, typingMs, freeText } = body;
    if (
      !isNonEmptyString(sessionId) ||
      !isNonEmptyString(user) ||
      !ethers.isAddress(user) ||
      (highlight !== undefined && typeof highlight !== "string") ||
      (freeText !== undefined && freeText !== null && typeof freeText !== "string") ||
      (typingMs !== undefined && typingMs !== null && typeof typingMs !== "number")
    ) {
      return sendError(res, 400, ERRORS.INVALID_SUBMISSION);
    }
    const answerList = answers === undefined || answers === null ? [] : answers;

    /* --- 2. Resolve the mission and article from the SESSION. --- */
    const session = await activeStore.getSession(sessionId);
    if (!session || !isNonEmptyString(session.missionId)) {
      return sendError(res, 400, ERRORS.SESSION_NOT_FOUND);
    }
    const mission = content.getMission(session.missionId);
    if (!mission) return sendError(res, 400, ERRORS.MISSION_NOT_FOUND);
    const article = content.getArticle(mission.articleId);
    if (!article) return sendError(res, 400, ERRORS.ARTICLE_MISSING);

    /* --- 3. Hardware truth: telemetry accumulated over the session. --- */
    const telemetry = safeEvaluateTelemetry(await activeStore.getTelemetry(sessionId));
    const telemetryOk = anticheat.isTelemetryAcceptable(telemetry);

    /* --- 4. Human truth: syndicate detection over RECENT SUBMISSIONS. --- *
     * The lookup deliberately spans ALL users. A syndicate is a group of     *
     * submitters copying one another, so a per-user query could not see the  *
     * copy at all: user B's answer would only ever be compared against      *
     * B's own history. No entry is excluded for being the current user's   *
     * own — that is precisely the text an accomplice is imitating.           *
     * Empty free-texts are dropped: they carry no content and comparing      *
     * against "" would either always or never match, depending on the        *
     * implementation.                                                        */
    const recent = await activeStore.listRecentSubmissions({ limit: SYNDICATE_LOOKBACK });
    const previousTexts = recent
      .map((row) => (typeof row.freeText === "string" ? row.freeText : ""))
      .filter((text) => text.trim() !== "");
    let syndicate = { syndicate: false, similarity: 0 };
    if (typeof freeText === "string" && freeText.trim() !== "") {
      try {
        syndicate = anticheat.detectSyndicate({ previousTexts, currentText: freeText });
      } catch (err) {
        /* A detector failure must not hand out a signature; treat as a miss
         * and let the other two verdicts still be reported. */
        syndicate = { syndicate: false, similarity: 0 };
      }
    }

    /* --- 5. Comprehension: quiz + highlight + reading speed. --- */
    const result = anticheat.evaluateSubmission({
      answers: answerList,
      highlight: typeof highlight === "string" ? highlight : "",
      typingMs: typeof typingMs === "number" ? typingMs : 0,
      telemetryScore: telemetry.score,
      mission,
      article,
    });
    const resultJson = toJsonSafe(result);

    /* --- 6. A pass requires ALL THREE verdicts. --- *
     * A syndicate hit is a FAIL even with a perfect quiz, and so is         *
     * unacceptable telemetry: those two checks exist precisely to catch a    *
     * submission that the comprehension checks CANNOT see, so letting a good *
     * quiz override them would defeat their entire purpose.                  *
     *                                                                       *
     * The engine cannot enforce that itself — it has no view of the other    *
     * users' submissions — so the Judge re-states the verdict here. When    *
     * the engine said PASS but the Judge blocks it, the reported result is  *
     * rewritten to FAIL with a zero reward and a named reason, so that a     *
     * client reading `result.reward` and `result.status` is never told that *
     * a rejected submission was worth the full mission reward.              */
    const blockingFlags = [];
    if (result.status !== anticheat.PASS) blockingFlags.push(...(resultJson.flags || []));
    if (syndicate.syndicate) blockingFlags.push(JUDGE_FLAGS.SYNDICATE_MATCH);
    if (!telemetryOk) blockingFlags.push(JUDGE_FLAGS.TELEMETRY_UNACCEPTABLE);
    const failed = result.status !== anticheat.PASS || syndicate.syndicate || !telemetryOk;
    const effectiveResult = failed
      ? { ...resultJson, status: anticheat.FAIL, reward: 0, flags: blockingFlags }
      : { ...resultJson, status: anticheat.PASS };

    /* Always store the attempt, pass or fail: the FAIL rows are the corpus
     * syndicate detection reads next, and the audit trail for disputes. */
    await activeStore.saveSubmission({
      sessionId,
      userAddress: user,
      missionId: mission.id,
      answers: answerList,
      highlight: typeof highlight === "string" ? highlight : "",
      typingMs: typeof typingMs === "number" ? typingMs : 0,
      freeText: typeof freeText === "string" ? freeText : "",
      result: effectiveResult,
    });

    const syndicateJson = toJsonSafe(syndicate);
    const telemetryJson = { score: telemetry.score, flags: telemetry.flags };

    /* --- 7. FAIL: no nonce, no signature, no `claim` key at all. --- */
    if (failed) {
      return res.status(200).json({
        status: anticheat.FAIL,
        result: effectiveResult,
        syndicate: syndicateJson,
        telemetry: telemetryJson,
      });
    }

    /* --- 8. PASS: reserve a nonce, then sign it. --- *
     * The nonce is reserved BEFORE signing and before responding, because    *
     * the contract burns whatever nonce it sees forever: if the process died *
     * between here and the response, that nonce must already be retired.     */
    const nonce = await activeStore.reserveNonce(user);
    const deadline = Math.floor(Date.now() / 1000) + CLAIM_TTL_SECONDS;

    // The signed claim is built from the SAME normalised values that are
    // returned to the client, so `claim` in the response is byte-for-byte the
    // struct that was hashed. `signClaim` throws when the key is missing; that
    // error is deliberately NOT caught here, so a missing key surfaces as a
    // 500 and an alert rather than as a silent "no signature for you".
    const claim = {
      user,
      reward: toUintString(effectiveResult.reward),
      staminaCost: toUintString(effectiveResult.staminaCost),
      nonce: String(nonce),
      deadline: String(deadline),
    };
    const signed = signer.signClaim({
      privateKey,
      chainId,
      verifyingContract,
      user: claim.user,
      reward: claim.reward,
      staminaCost: claim.staminaCost,
      nonce: claim.nonce,
      deadline: claim.deadline,
    });

    await activeStore.recordIssuedClaim({
      userAddress: user,
      nonce,
      sessionId,
      digest: signed.digest,
      reward: claim.reward,
      staminaCost: claim.staminaCost,
      deadline,
      signature: signed.signature,
    });

    res.status(200).json({
      status: anticheat.PASS,
      result: effectiveResult,
      syndicate: syndicateJson,
      telemetry: telemetryJson,
      claim,
      signature: signed.signature,
      digest: signed.digest,
      // The signer's PUBLIC address. This is the only signer-derived value
      // that ever leaves the process; the key never does.
      signer: signed.signer,
    });
  }));

  /* ---------------------------------------------------------------- *
   * Error handling                                                      *
   * ---------------------------------------------------------------- */

  /** JSON 404. A catch-all after every route, so the app never returns HTML. */
  app.use((req, res) => {
    sendError(res, 404, ERRORS.NOT_FOUND);
  });

  /**
   * JSON error handler. Distinguishes only the two shapes a client can act on:
   * a malformed JSON body (the client's fault, 400) and anything else (our
   * fault, 500). The message and stack go to the injected logger and are never
   * echoed back — an echoed stack can carry file paths, config values and,
   * in the worst case, fragments of a value that came from the environment.
   */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
      return sendError(res, 400, ERRORS.INVALID_JSON);
    }
    if (err && err.type === "entity.too.large") {
      return sendError(res, 413, "PAYLOAD_TOO_LARGE");
    }
    if (log && typeof log.error === "function") {
      log.error("catt-judge: unhandled error", err && err.message ? err.message : String(err));
    }
    return sendError(res, 500, ERRORS.INTERNAL_ERROR);
  });

  return app;
}

/**
 * Boots the Judge from the environment and starts listening.
 *
 * Only called when the file is executed directly, so `require`-ing the module
 * (as the tests do) has no side effects at all.
 *
 * Two settings are REQUIRED and the process refuses to start without them:
 * `SIGNER_PRIVATE_KEY` (without a key the Judge cannot do its one job) and
 * `MINING_CLAIMER_ADDRESS` (without it every signature would be issued against
 * a zero domain separator and would silently fail to verify on-chain — the
 * worst possible failure mode, because it looks like it worked). Both are read
 * from `process.env` and NEVER logged; only the signer's public ADDRESS, the
 * chain id, the contract address and the port are reported, all of which are
 * public by definition.
 *
 * @returns {import("http").Server} The listening server.
 * @throws {Error} If a required environment variable is missing.
 */
function startServer() {
  const { PORT, SIGNER_PRIVATE_KEY, CHAIN_ID, MINING_CLAIMER_ADDRESS } = process.env;

  const missing = [];
  if (!isNonEmptyString(SIGNER_PRIVATE_KEY)) missing.push("SIGNER_PRIVATE_KEY");
  if (!isNonEmptyString(MINING_CLAIMER_ADDRESS)) missing.push("MINING_CLAIMER_ADDRESS");
  if (missing.length > 0) {
    // Names only. The VALUES are never interpolated into a message: a
    // misconfiguration must not be able to print a secret into a log file.
    throw new Error(
      `catt-judge: refusing to start, missing required environment variable(s): ${missing.join(", ")}. ` +
        "See backend-server/.env.example."
    );
  }

  const port = Number(PORT) || 3000;
  const chainId = CHAIN_ID ? Number(CHAIN_ID) : undefined;
  const store = createMemoryStore();
  const app = createApp({
    store,
    privateKey: SIGNER_PRIVATE_KEY,
    chainId,
    verifyingContract: MINING_CLAIMER_ADDRESS,
  });

  // logger.info with PUBLIC values only.
  const address = signer.signerAddressFromEnv();
  console.log("catt-judge: signer", address);
  console.log("catt-judge: chainId", chainId);
  console.log("catt-judge: verifyingContract", MINING_CLAIMER_ADDRESS);
  console.log("catt-judge: listening on port", port);

  return app.listen(port);
}

module.exports = {
  CLAIM_TTL_SECONDS,
  ERRORS,
  JUDGE_FLAGS,
  createApp,
  startServer,
};

if (require.main === module) {
  try {
    startServer();
  } catch (err) {
    console.error("catt-judge: startup aborted -", err && err.message ? err.message : String(err));
    process.exit(1);
  }
}
