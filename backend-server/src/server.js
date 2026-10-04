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
 *   7. THE LIVE ECONOMY, on a PASS only: free stamina -> dynamic emission and
 *      streak pricing -> daily stamina cap -> season hard cap. -> see the block
 *      in the handler; two invariants matter beyond the arithmetic: the STREAK
 *      IS READ BEFORE THE COMPLETION IS RECORDED (step 10) or the Judge would
 *      pay tomorrow's streak for today's completion, and the season cap is
 *      checked BEFORE the nonce is reserved (step 11) so an exhausted season
 *      burns nothing at all.
 *   8. On FAIL: store it, sign nothing. -> no nonce is burned, no signature is
 *                                          produced, and the response contains
 *                                          no `claim` and no `signature` key at
 *                                          all, so there is nothing to replay
 *                                          even if the client keeps the body.
 *   9. On PASS: reserve a nonce, settle it against the season pool, THEN sign,
 *      THEN record what was signed.
 *
 * WHAT IS ADDITIVE AND WHAT IS NOT: steps 1-6 and the FAIL shape are exactly as
 * they were. Everything the economy does is bounded by "only on a PASS, only
 * before the nonce, only from injected dependencies", so an unreachable
 * mechanism cannot start writing to a user's ledgers and a FAIL cannot mint,
 * sign or accrue anything.
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
const economics = require("./economics");
const seasons = require("./seasons");
const staminaAllowance = require("./stamina-allowance");
const { createMemoryStore, assertStoreShape, STORAGE_ADAPTERS, getStorageAdapter } = require("./storage");
const relayModule = require("./relay");

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

/**
 * How many recent submissions syndicate detection compares against — the size
 * of the CORPUS WINDOW.
 *
 * It is a bound, not a tuning knob: a ring can hide outside it, which is
 * residual risk #2 (lookback evasion) and is unaffected by excluding the
 * submitter's own submissions, which narrows the window by one ADDRESS's rows
 * and not by any of the window's other contents. Raising this buys recall at
 * the cost of a longer scan and more comparisons per submit.
 */
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
  /* --- gasless relay (see /api/relay) --- */
  INVALID_CLAIM: "INVALID_CLAIM",
  RELAY_NOT_CONFIGURED: "RELAY_NOT_CONFIGURED",
  RELAY_CLAIM_EXPIRED: "RELAY_CLAIM_EXPIRED",
  RELAY_SIGNATURE_INVALID: "RELAY_SIGNATURE_INVALID",
  RELAY_CLAIM_MISMATCH: "RELAY_CLAIM_MISMATCH",
  RELAY_ALREADY_RELAYED: "RELAY_ALREADY_RELAYED",
  RELAY_TX_REVERTED: "RELAY_TX_REVERTED",
  RELAY_TX_FAILED: "RELAY_TX_FAILED",
  /* --- the live economy (see /api/submit step 7) --- */
  /**
   * The season's 2,000,000 CATT pool is spent, so the claim cannot settle.
   * Deliberately LOUD and deliberately the season module's own code: the
   * founder's rule is that an exhausted season STOPS mining, and a client (or
   * an operator reading a log) has to be able to tell that apart from every
   * other refusal without a second lookup table.
   */
  SEASON_ALLOCATION_EXHAUSTED: seasons.SEASON_ERRORS.ALLOCATION_EXHAUSTED,
  /** No season owns this instant: before the epoch, or the schedule is unwritten. No fallback. */
  SEASON_NO_ACTIVE_SEASON: seasons.SEASON_ERRORS.NO_ACTIVE_SEASON,
  /** The season that owns this instant has already closed. Its accruals survive; a new claim does not. */
  SEASON_WINDOW_ENDED: seasons.SEASON_ERRORS.WINDOW_ENDED,
  /** The stored season settles under a claim mode this build does not support. */
  SEASON_UNKNOWN_CLAIM_MODE: seasons.SEASON_ERRORS.UNKNOWN_CLAIM_MODE,
  /** This (season, user, nonce) has already been recorded — a replayed settlement. */
  SEASON_CLAIM_ALREADY_RECORDED: seasons.SEASON_ERRORS.CLAIM_ALREADY_RECORDED,
  /** Today's stamina SPEND cap (50 points by default) is already committed. */
  DAILY_STAMINA_CAP_EXCEEDED: "DAILY_STAMINA_CAP_EXCEEDED",
});

/**
 * HTTP status for each season refusal, so a season failure is a clear, stable
 * client-visible code rather than an opaque 500.
 *
 * 409 for all of them, and that is the point: a 500 would say "the Judge is
 * broken" when the system is behaving EXACTLY as specified — a season whose
 * pool is spent is a correct, intended, observable outage whose recovery is the
 * next season. `INVALID_ARGUMENT` and `INVARIANT_VIOLATED` are deliberately
 * absent: those are OUR bugs and must surface as a 500.
 */
const SEASON_ERROR_HTTP_STATUS = Object.freeze({
  [seasons.SEASON_ERRORS.ALLOCATION_EXHAUSTED]: 409,
  [seasons.SEASON_ERRORS.NO_ACTIVE_SEASON]: 409,
  [seasons.SEASON_ERRORS.WINDOW_ENDED]: 409,
  [seasons.SEASON_ERRORS.UNKNOWN_CLAIM_MODE]: 409,
  [seasons.SEASON_ERRORS.CLAIM_ALREADY_RECORDED]: 409,
});

/**
 * The nonce used for the season DRY RUN that runs before a real nonce exists.
 *
 * `previewSettlement` writes nothing, so this key is never reserved, never
 * recorded and never spent; it exists only so the hard-cap refusal happens
 * before the one irreversible step in the handler. `0` is not a nonce the
 * store will ever hand out (`reserveNonce` counts from 1).
 */
const SEASON_PREVIEW_NONCE = "0";

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
 * The UTC day immediately BEFORE `dayKey`, as `YYYY-MM-DD`.
 *
 * UTC arithmetic on the parsed calendar parts, so month, year and leap
 * boundaries are ordinary cases rather than special ones. `null` for anything
 * that is not a real `YYYY-MM-DD` day key, which the caller treats as "no
 * consecutive day" — the safe direction, since an unreadable day key must not
 * be able to buy a streak multiplier.
 *
 * @param {*} dayKey Candidate day key.
 * @returns {string|null}
 */
function previousDayKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey));
  if (!match) return null;
  const asUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 86_400_000;
  if (!Number.isFinite(asUtc)) return null;
  return new Date(asUtc).toISOString().slice(0, 10);
}

/**
 * The CONSECUTIVE, already-banked streak days a claim is entitled to be paid on.
 *
 * WHY THE JUDGE HAS TO DERIVE THIS rather than reading `store.getStreak(...).current`
 * straight into the pricing call. The store deliberately applies the gap rule at
 * WRITE time — `recordGradedCompletion` resets the row to 1 on any day that is not
 * the next calendar day, and its own documentation is explicit that the store only
 * counts and the economic policy decides what counting is worth. The row therefore
 * means "N consecutive graded days, ending on `lastGradedDay`", NOT "N days before
 * today", and the two differ in exactly two situations:
 *
 *   - THE FIRST CLAIM AFTER A MISSED DAY. The row still holds the pre-gap count,
 *     because the reset for that gap is this very claim's job to write. Read raw,
 *     a deliberate day off per streak would cost nothing and the ladder would
 *     never actually reset.
 *   - A SECOND MISSION ON THE SAME DAY. The row counts TODAY among its N days.
 *     Read raw, the day's second mission would be paid on N banked days while its
 *     own first mission was paid on N - 1, so a user could raise their own payout
 *     simply by mining again later the same day. Off by one here is a free,
 *     repeatable escalation, so it is corrected too.
 *
 * @param {Object} streak `store.getStreak(...)` for the claiming user.
 * @param {string} dayKey The UTC day this claim is graded for.
 * @returns {number} Banked consecutive days BEFORE today: 0 when the chain is
 *   broken or absent.
 */
function consecutiveStreakDays(streak, dayKey) {
  if (!streak || typeof streak !== "object") return 0;
  const banked = Number(streak.current);
  if (!Number.isFinite(banked) || banked <= 0) return 0;
  const last = streak.lastGradedDay;
  if (last === null || last === undefined) return 0;
  if (last === dayKey) return banked - 1 > 0 ? banked - 1 : 0;
  return last === previousDayKey(dayKey) ? banked : 0;
}

/**
 * ============================================================================
 * THE CONFIG SURFACE, AND THE PARSE RULE THAT IS DELIBERATELY INVERTED
 * ============================================================================
 * Every economic mechanism below is ON by default, and its flag is read with
 * the rule stated here. IT IS INVERTED RELATIVE TO THE USUAL "SAFE DEFAULTS"
 * CONVENTION AND THAT IS THE FOUNDER'S CHOICE, NOT AN OVERSIGHT:
 *
 *     ONLY AN EXPLICIT LITERAL `false`, `0` OR `off` DISABLES A MECHANISM.
 *
 * Unset, empty, whitespace, a typo, `yes`, `1`, `true`, `enabled` — ALL of them
 * leave the AGGRESSIVE behaviour ON. A misspelled `CATT_DYNAMIC_EMISSIOM=false`
 * does not silently restore flat rewards; it leaves dynamic emission running,
 * which is the loud, observable, founder-chosen state rather than a quiet
 * reversion to an economics policy nobody chose.
 *
 * DO NOT "FIX" THIS BACK to a conventional parse that defaults to off or that
 * treats any falsy string as off. That reversion is precisely the failure mode
 * this comment exists to prevent.
 */
const DISABLING_FLAG_LITERALS = Object.freeze(["false", "0", "off"]);

/**
 * Reads one on/off mechanism flag under the INVERTED rule above.
 *
 * @param {*} raw The raw environment value; `undefined`/`null` means unset.
 * @param {boolean} [fallback] The value when the flag says nothing usable.
 * @returns {boolean}
 */
function flagEnabled(raw, fallback = true) {
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === "") return fallback;
  return !DISABLING_FLAG_LITERALS.includes(text);
}

/**
 * Reads one numeric flag under the same inverted rule: anything that is not a
 * usable finite number leaves the FOUNDER-CHOSEN DEFAULT in place, because
 * garbage must not become a different economic parameter.
 *
 * @param {*} raw The raw environment value.
 * @param {number|null} [fallback] The default, or `null` for "no default".
 * @returns {number|null}
 */
function flagNumber(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const text = String(raw).trim();
  if (text === "") return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the live economy configuration for one app instance.
 *
 * Pure with respect to the store and the chain: it reads the environment (or
 * the injected `env`), reads the injected clock ONCE for the boot instant, and
 * returns a frozen decision. No I/O, so `createApp` stays synchronous.
 *
 * @param {Object} params
 * @param {Object} params.env Environment to read.
 * @param {Function} params.clock `() => epoch milliseconds`.
 * @param {number|null} [params.dailyStaminaCap] Injected cap override.
 * @returns {Readonly<Object>} The frozen economy configuration.
 */
function readEconomyConfig({ env, clock, dailyStaminaCap } = {}) {
  const source = env || process.env;
  const bootMs = clock();
  const bootSeconds = Math.floor(bootMs / 1000);

  // `SEASON_EPOCH` IS THE FOUNDER-UNSPECIFIED PARAMETER, AND 0 IS ITS DOCUMENTED
  // DEFAULT. It is NOT what the wired Judge uses when the flag is unset, and the
  // reason is mechanical rather than editorial: the schedule is twenty CONTIGUOUS
  // 30-day windows starting at the epoch, so an epoch of 0 puts every window
  // inside 1970 and every instant from 1971 onwards has NO active season — with
  // the documented, no-fallback `SEASON_NO_ACTIVE_SEASON` refusal, an epoch of 0
  // would mean the Judge signs nothing, ever. The wired default is therefore the
  // BOOT INSTANT (season 1 starts when the Judge first boots), and the
  // founder's 0 is fully live and reachable: set `CATT_SEASON_EPOCH=0` and the
  // 1970 schedule is written verbatim and every claim refuses loudly.
  const configuredEpoch = flagNumber(source.CATT_SEASON_EPOCH, null);
  const seasonEpoch = configuredEpoch === null ? bootSeconds : Math.trunc(configuredEpoch);

  const cap = dailyStaminaCap === undefined || dailyStaminaCap === null
    ? flagNumber(source.CATT_DAILY_STAMINA_CAP, content.DEFAULT_DAILY_STAMINA_CAP)
    : dailyStaminaCap;

  return Object.freeze({
    /** The twenty-season schedule is enforced: per-claim `settle`, hard cap. */
    seasons: flagEnabled(source.CATT_SEASONS),
    /** Launch instant the twenty windows are generated from. */
    seasonEpoch,
    /** Rewards shrink with the active-miner count. */
    dynamicEmission: flagEnabled(source.CATT_DYNAMIC_EMISSION),
    /** Top of the dynamic-emission ramp (the founder did not specify it). */
    floorMiners: flagNumber(source.CATT_DYNAMIC_EMISSION_FLOOR_MINERS, Number(economics.DYNAMIC_EMISSION_FLOOR_MINERS)),
    /** Rewards grow with consecutive graded days. */
    streakMultiplier: flagEnabled(source.CATT_STREAK_MULTIPLIER),
    /** 30 free stamina points per user per UTC day, off-chain ledger only. */
    freeStamina: flagEnabled(source.CATT_FREE_STAMINA),
    /** The daily stamina SPEND ceiling, in unitless points. */
    dailyStaminaCap: cap,
    /** The pure admission policy for that ceiling. */
    staminaPolicy: content.createStaminaPolicy({ cap: cap === null ? null : Math.trunc(cap) }),
  });
}

/**
 * Maps a `seasons.js` refusal onto an HTTP status + stable Judge error code.
 *
 * @param {*} err The thrown error.
 * @returns {{ status: number, code: string }|null} The refusal, or `null` when
 *   the error is OURS (`SEASON_INVALID_ARGUMENT`, `SEASON_INVARIANT_VIOLATED`,
 *   a store fault) and must stay an opaque 500 rather than be blamed on the
 *   client.
 */
function seasonRefusal(err) {
  if (!err || typeof err.code !== "string") return null;
  const status = SEASON_ERROR_HTTP_STATUS[err.code];
  if (status === undefined) return null;
  const code = ERRORS[err.code];
  if (typeof code !== "string") return null;
  return { status, code };
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
 * True when the injected relay could actually broadcast a transaction.
 *
 * Tolerant of a partial stub on purpose: an injected test double is only
 * required to expose `isConfigured`, so a missing method reads as "not
 * configured" (a 503), never as a crash.
 *
 * @param {Object} relay Relay service.
 * @returns {boolean}
 */
function relayIsConfigured(relay) {
  if (!relay || typeof relay.isConfigured !== "function") return false;
  try {
    return relay.isConfigured() === true;
  } catch (err) {
    return false;
  }
}

/**
 * The relayer's PUBLIC address, or `null`. Never key material: the relayer
 * object only ever exposes an address, and nothing here stringifies it.
 *
 * @param {Object} relay Relay service.
 * @returns {Promise<string|null>}
 */
async function relayRelayerAddress(relay) {
  if (!relay) return null;
  try {
    if (typeof relay.relayerAddress === "function") {
      const sync = relay.relayerAddress();
      if (sync) return sync;
    }
    if (typeof relay.getRelayerAddress === "function") {
      return (await relay.getRelayerAddress()) || null;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * The address whose signatures the claimer will accept: the injected override
 * if there is one, otherwise `MiningClaimer.signer()` read from the chain.
 *
 * Returns `null` when neither is available (offline, unconfigured, or a stub
 * with no chain behind it). That is NOT a failure: the contract compares the
 * recovered signer itself and reverts `ClaimSignatureInvalid`, so the worst a
 * `null` here can cost is a sponsored transaction that reverts. When the chain
 * IS reachable the value is used to reject such a claim locally, for free.
 *
 * @param {Object} relay Relay service.
 * @param {string} [override] Injected expected signer.
 * @returns {Promise<string|null>}
 */
async function relayExpectedSigner(relay, override) {
  if (typeof override === "string" && ethers.isAddress(override)) return override;
  if (relay && typeof relay.getExpectedSigner === "function") {
    try {
      const fromChain = await relay.getExpectedSigner();
      if (typeof fromChain === "string" && ethers.isAddress(fromChain)) return fromChain;
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * Builds the express application.
 *
 * Every dependency is injected with a sane default, which is the whole reason
 * the app is testable: a test can pass a throwaway in-memory store, a throwaway
 * private key, a recording logger and a stub relay service without touching
 * `process.env` or any module-level state.
 *
 * `relayService` is optional and defaults to one built from `process.env`
 * (`RELAYER_PRIVATE_KEY`, `RPC_URL`, `CHAIN_ID`, `MINING_CLAIMER_ADDRESS`).
 * When those are absent — the normal case for a dev box, and a supported
 * deployment mode — the default service simply reports `isConfigured() ===
 * false` and `/api/relay` answers 503, which tells the app to fall back to
 * submitting the transaction itself. No existing behaviour changes when the
 * relay is unconfigured: nothing else in this file consults it.
 *
 * @param {Object} [params]
 * @param {Object} [params.store] Storage interface implementation; defaults to `createMemoryStore()`.
 * @param {string} [params.privateKey] Backend signer key. NEVER logged or returned.
 * @param {number|string} [params.chainId] EVM chain id for the EIP-712 domain.
 * @param {string} [params.verifyingContract] Deployed MiningClaimer address.
 * @param {Console|Object} [params.logger] Sink for server-side logs; defaults to `console`.
 * @param {Object} [params.relayService] Gasless relay adapter (see ./relay.js).
 * @param {string} [params.expectedSigner] Override for the address whose
 *   signatures the claimer accepts. Used by tests and by offline deployments;
 *   when omitted the value is read from the chain via `MiningClaimer.signer()`.
 * @param {Function} [params.clock] `() => epoch milliseconds`. The ONE place the
 *   Judge reads time, injected so the streak ladder, the day rollover, the
 *   season window and the claim deadline can all be driven deterministically by
 *   a test. Defaults to `Date.now`; nothing below reads a clock directly.
 * @param {Object} [params.env] Environment the economy flags are read from.
 *   Defaults to `process.env`. Only the economy block consults it, and only for
 *   non-secret configuration.
 * @param {number|null} [params.dailyStaminaCap] Overrides the daily stamina
 *   SPEND ceiling (`CATT_DAILY_STAMINA_CAP`); `null` disables the throttle.
 * @returns {import("express").Express} The configured app.
 * @throws {Error} If the injected store does not implement the storage interface.
 */
function createApp({
  store,
  privateKey,
  chainId,
  verifyingContract,
  logger,
  relayService,
  expectedSigner,
  clock,
  env,
  dailyStaminaCap,
} = {}) {
  const activeStore = store || createMemoryStore();

  // Fail fast and loudly: a Postgres adapter that forgets a method must not be
  // able to boot and then discover the gap on a user's mining claim.
  assertStoreShape(activeStore);

  const log = logger || console;
  const activeClock = typeof clock === "function" ? clock : Date.now;
  /* The live economy: dynamic emission, streak, seasons, free stamina and the
   * daily stamina spend cap. Every flag defaults to the founder's aggressive
   * choice and is only switched off by an explicit false/0/off — see the parse
   * rule above `flagEnabled`. */
  const economy = readEconomyConfig({ env, clock: activeClock, dailyStaminaCap });

  /**
   * Writes the twenty-season schedule into the store, once, on boot.
   *
   * IDEMPOTENT, and it never clobbers a stored row that differs (see
   * `seasons.js`): a differing window or allocation is preserved and reported,
   * because `saveSeason` is an upsert and silently rewriting it would move a
   * window that claims have already been recorded against.
   *
   * The promise is memoised so twenty concurrent first requests do not each run
   * the write, and it is primed at boot rather than awaited there (`createApp`
   * is synchronous). A failure clears the memo so the next request retries
   * instead of serving claims against an unwritten schedule — which would fail
   * anyway, with `SEASON_NO_ACTIVE_SEASON`, but with a confusing cause.
   *
   * @returns {Promise<Object>} The `ensureSeasons` summary.
   */
  function ensureSeasonSchedule() {
    if (seasonSchedule === null) {
      seasonSchedule = seasons
        .ensureSeasons(activeStore, { epoch: economy.seasonEpoch })
        .catch((err) => {
          seasonSchedule = null;
          throw err;
        });
      // Primed here so the schedule is written even by a Judge that never sees
      // a claim. The bare catch is here so a boot-time failure is not an
      // unhandled rejection; the request path still sees the real error.
      seasonSchedule.catch(() => {});
    }
    return seasonSchedule;
  }

  /** @type {Promise<Object>|null} See {@link ensureSeasonSchedule}. */
  let seasonSchedule = null;
  if (economy.seasons) ensureSeasonSchedule();

  /**
   * Proves, WITHOUT WRITING ANYTHING, that this claim may settle into the
   * season pool — and answers the refusal itself when it may not.
   *
   * This is the "an exhausted season burns nothing" guarantee. It runs before
   * `reserveNonce`, so a `SEASON_ALLOCATION_EXHAUSTED` pool costs the user no
   * nonce, produces no signature and reports no success; the season total does
   * not move. It goes through `previewSettlement`, which is the dry run of
   * `settle` through the SAME decision function, so the preview can never say
   * yes to something the settlement would refuse.
   *
   * `SEASON_NO_ACTIVE_SEASON` — an instant before `SEASON_EPOCH`, or a
   * schedule that does not cover it — is the SAME loud refusal with NO
   * fallback season. A default season would be an uncapped pool by another
   * name, which is the one failure mode the season module exists to make
   * impossible.
   *
   * @param {Object} res Express response, used only to send a refusal.
   * @param {string} userAddress Claiming wallet.
   * @param {string} amount Exact CATT base-unit reward as a decimal string.
   * @param {number} nowSeconds The instant, unix seconds.
   * @returns {Promise<Object|null>} The decision, or `null` when a refusal was
   *   sent.
   */
  async function previewSeasonClaim(res, userAddress, amount, nowSeconds) {
    try {
      return await seasons.previewSettlement(activeStore, {
        userAddress,
        amount,
        nonce: SEASON_PREVIEW_NONCE,
        now: nowSeconds,
      });
    } catch (err) {
      const refusal = seasonRefusal(err);
      if (refusal === null) throw err;
      if (log && typeof log.warn === "function") {
        log.warn("catt-economy: season refused a claim", {
          code: refusal.code,
          seasonId: err.seasonId === undefined ? null : String(err.seasonId),
          remaining: err.remaining === undefined ? null : String(err.remaining),
        });
      }
      sendError(res, refusal.status, refusal.code);
      return null;
    }
  }

  const activeRelay =
    relayService ||
    relayModule.createRelayServiceFromEnv({
      chainId,
      claimerAddress: verifyingContract,
      logger: log,
    });
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
     * The corpus spans ALL OTHER USERS, and it is the submitter's OWN rows    *
     * that are filtered out (residual risk #3).                                *
     *                                                                          *
     * Why it still has to be cross-user: a syndicate is a group of submitters  *
     * copying one another, so a per-user query could never see the copy — user *
     * B's answer would only ever be compared against B's own history. That is  *
     * why this is NOT "restrict to other users I have something in common     *
     * with" and not "restrict to one user": the ring is only visible across    *
     * accounts.                                                                  *
     *                                                                          *
     * Why the submitter's OWN rows are excluded: comparing an answer against    *
     * the submitter's own earlier answer is a comparison with itself. An       *
     * honest user who re-mines the same article and writes the same summary    *
     * twice — which is exactly what a user is told they may do — matched their  *
     * own text at similarity 1.0 and was refused as a syndicate, with no       *
     * signature and no claim. That is a false positive with no reading behind  *
     * it, and it is now closed by the `excludeUserAddress` filter below.        *
     *                                                                          *
     * WHAT THE EXCLUSION DOES NOT DO, stated explicitly so nobody mistakes    *
     * this for a syndicate-detection improvement: the corpus is still a        *
     * BOUNDED WINDOW of the last SYNDICATE_LOOKBACK submissions. A ring that   *
     * spaces its copies out past that window, or that paraphrases below the    *
     * 0.9 Dice threshold, is still undetected — residual risk #2, unchanged,    *
     * measured in test/red-team.test.js (ATTACK 4d). And a ring of two or more *
     * DISTINCT addresses loses nothing here: every other member's row is still *
     * in the corpus, so the copy is still caught (ATTACK 4a/4g).               *
     *                                                                          *
     * WHICH ADDRESS IS EXCLUDED: the SUBMITTED `user` — the account being      *
     * graded — not `msg.sender`. This route has no authenticated caller: it is *
     * submission-time, and `user` is the identity the verdict, the stored row, *
     * the nonce and the signed claim all use, so it is the identity whose own  *
     * history would be self-comparison. Using anything else (a transport-level *
     * caller identity) would exclude a stranger's history and leave the real   *
     * submitter's own text in the corpus — reintroducing risk #3 exactly. The  *
     * gasless relay is claim-time, lives on POST /api/relay, and never reaches  *
     * this step, so there is no "claim-time caller" to consider. The known     *
     * consequence of `user` being caller-supplied is recorded separately as    *
     * residual risk P4 (no proof-of-possession on this route), which this      *
     * choice neither worsens nor papers over: it is a different defect.        *
     *                                                                          *
     * Empty free-texts are dropped: they carry no content and comparing against *
     * "" would either always or never match, depending on the implementation. */
    const recent = await activeStore.listRecentSubmissions({
      excludeUserAddress: user,
      limit: SYNDICATE_LOOKBACK,
    });
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
    let effectiveResult = failed
      ? { ...resultJson, status: anticheat.FAIL, reward: 0, flags: blockingFlags }
      : { ...resultJson, status: anticheat.PASS };

    /* ================================================================== *
     * 7. THE LIVE ECONOMY.                                                *
     * ================================================================== *
     * Everything below is bounded by THREE rules, each of which exists
     * because breaking it is a way to mint or to deny for free:
     *
     *   (i)   ONLY ON A PASS. A rejected submission prices nothing, accrues
     *         nothing and consumes no season allocation. The one exception is
     *         the free-stamina grant, which is day-scoped ACCESS and not a
     *         reward (see below).
     *   (ii)  THE STREAK IS READ BEFORE THE COMPLETION IS RECORDED. The
     *         record happens at step 10, below, and only on a PASS — the
     *         documented risk in `economics.js`: recording first would pay
     *         tomorrow's day count for today's completion, and two missions
     *         in one UTC day would farm a bonus day.
     *   (iii) THE SEASON HARD CAP IS CHECKED BEFORE THE NONCE IS RESERVED,
     *         so an exhausted season burns NOTHING: no nonce, no signature,
     *         no claim, no success. It is a dry run through the SAME decision
     *         function `settle` uses, so the two cannot disagree.
     *
     * A REFUSAL HERE (cap exceeded, season exhausted) is answered BEFORE the
     * submission row is written. That is deliberate: a stored row carrying a
     * priced reward that was never signed is a number a later reader could
     * mistake for a payable, and the refusal is already loud and typed — so
     * nothing about it is silent, and nothing accrues.
     */
    const nowMs = activeClock();
    const nowSeconds = Math.floor(nowMs / 1000);
    const dayKey = content.dayKeyFor(nowMs);

    /* --- 7a. DAY ROLLOVER: the free-stamina allowance. --- *
     * 30 points per user per UTC day, ONCE per dayKey, in an off-chain
     * ledger. `grantFreeStamina` is idempotent by arithmetic rather than by a
     * flag, so calling it on every submit IS the rollover detection: the first
     * call of the day writes the remainder, later calls of the same day write
     * nothing at all.
     *
     * IT DOES NOT BYPASS THE ON-CHAIN `consumeStamina`. This records what the
     * user is OWED; the claim still has to settle against `StakingManager`
     * or it reverts there. Nothing here mints, balances or weakens a check.
     *
     * IT IS GRANTED FOR A GRADED ATTEMPT, NOT ONLY A PASSED ONE, because it
     * buys access to the day's first missions rather than paying for one. */
    const freeStaminaGrant = economy.freeStamina
      ? await staminaAllowance.grantFreeStamina(activeStore, { userAddress: user, now: dayKey })
      : null;

    /** The audit block returned on a PASS. Never on a FAIL: nothing was priced. */
    let economyJson = null;

    if (!failed) {
      /* --- 7b. The two live factors. READ-ONLY, and before any write. --- */
      const streak = await activeStore.getStreak({ userAddress: user });
      const activeMiners = economy.dynamicEmission
        ? await activeStore.countActiveMiners({ dayKey })
        : 0;
      const priced = economics.computeReward({
        mission,
        activeMiners,
        // Rule (ii): this is the streak as it stood BEFORE this completion, and
        // only its CONSECUTIVE days count — see `consecutiveStreakDays`, which is
        // what makes a missed day reset the ladder to 1.0x instead of paying the
        // pre-gap count one last time.
        streakDays: economy.streakMultiplier ? consecutiveStreakDays(streak, dayKey) : 0,
        floorMiners: economy.floorMiners,
      });
      // The priced amount REPLACES the mission's flat reward, so the signed
      // claim, the stored submission row and the response all carry one number.
      effectiveResult = { ...effectiveResult, reward: priced.reward };

      /* --- 7c. The daily stamina SPEND cap, still 50. --- *
       * A cap on stamina SPENT per UTC day, re-derived from the per-DAY
       * ledger, so unspent stamina rolls over and is never confiscated. It is
       * enforced ALONGSIDE the free grant, which is 30 points AVAILABLE: the
       * grant buys access to the day's first missions, not a way past the
       * day's ceiling. A refusal is loud (429) and happens BEFORE the nonce,
       * so a throttled user has not burned anything. */
      const consumedBefore = await activeStore.getStaminaConsumed({ userAddress: user, dayKey });
      const staminaCostPoints = Number(effectiveResult.staminaCost);
      const admission = economy.staminaPolicy.admits({
        consumed: Number(consumedBefore.consumed),
        amount: Number.isSafeInteger(staminaCostPoints) ? staminaCostPoints : 0,
      });
      if (!admission.allowed) {
        return sendError(res, 429, ERRORS.DAILY_STAMINA_CAP_EXCEEDED);
      }

      /* --- 7d. The season pool is a HARD CAP, checked before the nonce. --- */
      let seasonDecision = null;
      if (economy.seasons) {
        await ensureSeasonSchedule();
        // A refusal is answered HERE, before the nonce: `null` means the
        // response has already been sent.
        seasonDecision = await previewSeasonClaim(res, user, priced.reward, nowSeconds);
        if (seasonDecision === null) return;
      }

      economyJson = {
        dayKey,
        baseReward: priced.baseReward,
        reward: priced.reward,
        dynamicEmission: {
          enabled: economy.dynamicEmission,
          activeMiners: priced.breakdown.activeMiners,
          triggerMiners: priced.breakdown.triggerMiners,
          floorMiners: priced.breakdown.floorMiners,
          factorBps: priced.breakdown.dynamicFactorBps,
          applied: priced.applied.dynamicEmission,
        },
        streak: {
          enabled: economy.streakMultiplier,
          daysBeforeCompletion: priced.breakdown.streakDays,
          factorBps: priced.breakdown.streakFactorBps,
          applied: priced.applied.streakMultiplier,
        },
        freeStamina: freeStaminaGrant
          ? {
              dayKey: freeStaminaGrant.dayKey,
              grantedThisCall: freeStaminaGrant.granted,
              dayTotal: freeStaminaGrant.dayTotal,
              remaining: freeStaminaGrant.remaining,
            }
          : null,
        staminaSpend: {
          dayKey,
          cost: String(admission.amount),
          capPoints: admission.cap,
          consumedBefore: consumedBefore.consumed,
          remainingAfter: admission.remaining === null ? null : String(admission.remaining),
        },
        season: seasonDecision
          ? { enabled: true, seasonId: seasonDecision.seasonId, remainingAfter: seasonDecision.remainingAfter }
          : { enabled: false, seasonId: null, remainingAfter: null },
      };
    }

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

    /* --- 8. FAIL: no nonce, no signature, no `claim` key at all. --- */
    if (failed) {
      return res.status(200).json({
        status: anticheat.FAIL,
        result: effectiveResult,
        syndicate: syndicateJson,
        telemetry: telemetryJson,
      });
    }

    /* --- 9. PASS: record the graded completion. ONLY NOW, and only here. --- *
     * Rule (ii), the other half: the streak was READ at step 7b, and the
     * record is what ADVANCES it (first ever -> 1, same day -> unchanged,
     * immediate next UTC day -> +1, any gap or retroactive day -> reset to 1).
     * A FAIL never reaches this line, so a wrong quiz can neither inflate a
     * streak nor count its author as an active miner — and the active-miner
     * count is the input that shrinks everybody ELSE's emission. */
    await activeStore.recordGradedCompletion({
      userAddress: user,
      dayKey,
      reward: effectiveResult.reward,
      missionId: mission.id,
    });

    /* --- 10. PASS: reserve a nonce, settle it, THEN sign. --- *
     * The nonce is reserved BEFORE signing and before responding, because    *
     * the contract burns whatever nonce it sees forever: if the process died *
     * between here and the response, that nonce must already be retired.     */
    const nonce = await activeStore.reserveNonce(user);
    const deadline = nowSeconds + CLAIM_TTL_SECONDS;

    if (economy.seasons) {
      // The real settlement, carrying the nonce that was just reserved. The
      // hard cap was already proved at step 7d, so reaching here means this
      // either records the claim or loses a race against a concurrent one.
      try {
        await seasons.settle(activeStore, {
          userAddress: user,
          amount: effectiveResult.reward,
          nonce: String(nonce),
          now: nowSeconds,
        });
      } catch (err) {
        const refusal = seasonRefusal(err);
        if (refusal === null) throw err;
        return sendError(res, refusal.status, refusal.code);
      }
    }

    // The day's SPENT ledger moves only for a claim that actually settled, and
    // it moves once. This mirrors the on-chain `consumeStamina` debit; it
    // never replaces it.
    const consumedAfter = await activeStore.recordStaminaConsumption({
      userAddress: user,
      dayKey,
      amount: effectiveResult.staminaCost,
    });
    if (economyJson !== null) {
      economyJson = { ...economyJson, staminaSpend: { ...economyJson.staminaSpend, consumedAfter: consumedAfter.consumed } };
    }

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
      // Everything the economy decided for this claim, so a settlement can be
      // re-derived by hand from the response alone.
      economy: economyJson,
    });
  }));

  /* ---------------------------------------------------------------- *
   * GET /api/relay/status — can the app be gasless?                     *
   * ---------------------------------------------------------------- */

  /**
   * Tells the mobile app whether to expect a sponsored claim or to submit the
   * transaction itself.
   *
   * It answers with PUBLIC facts only: a boolean and the relayer's address.
   * The relayer key is not reachable from here and never leaves the process —
   * the only way to obtain it would be the environment, and this handler does
   * not read one.
   *
   * `configured: false` is the supported, expected state for a deployment
   * without a relayer, so the app falls back to a wallet-side submission
   * instead of failing.
   */
  app.get("/api/relay/status", asyncHandler(async (req, res) => {
    const configured = relayIsConfigured(activeRelay);
    const relayer = configured ? await relayRelayerAddress(activeRelay) : null;
    res.json({ configured, relayer });
  }));

  /* ---------------------------------------------------------------- *
   * POST /api/relay — the gasless claim (PRD 3.2)                      *
   * ---------------------------------------------------------------- */

  /**
   * Broadcasts a Judge-issued claim on the user's behalf, so the user never
   * needs MATIC. `MiningClaimer.claimReward` credits `user`, not `msg.sender`,
   * so sponsoring a stranger's claim can only ever pay the address the Judge
   * signed for — `user` is inside the signature.
   *
   * THE ORDER OF THE CHECKS IS THE WHOLE POINT, and it is deliberate:
   *
   *   1. SHAPE first (400 `INVALID_CLAIM`). Cheapest possible rejection, and
   *      it keeps a malformed body from reaching crypto or a provider.
   *   2. CONFIGURED second (503 `RELAY_NOT_CONFIGURED`). The honest answer
   *      when there is no relayer key or RPC endpoint. It is checked before
   *      any expensive validation because "this deployment cannot relay at
   *      all" is a fact about the server, not about the claim, and it must not
   *      be masked by a claim-specific error. It is also what lets the app
   *      fall back to submitting the transaction itself.
   *   3. EXPIRY third (400 `RELAY_CLAIM_EXPIRED`). A deadline inside the
   *      signature has already elapsed on our clock, so the chain would reject
   *      it; refusing here saves the gas and tells the user to re-mine.
   *   4. SIGNATURE fourth (400 `RELAY_SIGNATURE_INVALID`). The digest is
   *      REBUILT from the fields as received, so altering `reward`,
   *      `staminaCost`, `nonce`, `deadline` or `user` changes the digest and
   *      the recovered signer stops matching. This is defense in depth: the
   *      contract re-checks it, but here a forgery costs nothing.
   *   5. ISSUANCE CROSS-CHECK fifth (400 `RELAY_CLAIM_MISMATCH`). When this
   *      backend knows it issued the nonce, the submitted amounts must match
   *      the record exactly. An UNKNOWN nonce is allowed: a signature issued by
   *      a sibling Judge instance, or by an earlier deployment, is still a
   *      valid signature, and step 4 already proved it. Refusing unknown
   *      nonces would make the relayer useless behind a load balancer with
   *      more than one instance.
   *   6. ALREADY RELAYED sixth (409 `RELAY_ALREADY_RELAYED`). The mobile app
   *      retries aggressively on a flaky connection, and a retry of a request
   *      that actually succeeded must not broadcast a second transaction. It
   *      is re-checked after the broadcast as well.
   *   7. BROADCAST, RECORD, RESPOND. The record is written AFTER the broadcast
   *      on purpose: a connection that dies mid-flight leaves the claim
   *      marked relayed rather than silently replayable.
   *   8. A REVERT is a 502 with a short sanitized reason and the nonce is
   *      deliberately NOT marked relayed: nothing was paid, so the claim is
   *      still relayable (and the user should be able to retry it).
   */
  app.post("/api/relay", asyncHandler(async (req, res) => {
    const body = req.body || {};
    const { user, reward, staminaCost, nonce, deadline, signature } = body;

    /* --- 1. Shape. Nothing malformed reaches crypto or a chain. --- */
    let claim;
    try {
      claim = relayModule.normalizeClaimPayload({ user, reward, staminaCost, nonce, deadline, signature });
    } catch (err) {
      return sendError(res, 400, ERRORS.INVALID_CLAIM);
    }

    /* --- 2. Is a relayer even deployed here? --- */
    if (!relayIsConfigured(activeRelay)) {
      return sendError(res, 503, ERRORS.RELAY_NOT_CONFIGURED);
    }

    /* --- 3. Deadline. The contract accepts `block.timestamp <= deadline`. --- */
    if (Number(claim.deadline) < Math.floor(Date.now() / 1000)) {
      return sendError(res, 400, ERRORS.RELAY_CLAIM_EXPIRED);
    }

    /* --- 4. Signature over the digest rebuilt from the fields received. --- */
    const signerAddress = await relayExpectedSigner(activeRelay, expectedSigner);
    let recovered;
    try {
      const validated =
        typeof activeRelay.validateClaimPayload === "function"
          ? activeRelay.validateClaimPayload({ ...claim, expectedSigner: signerAddress })
          : relayModule.validateClaimPayload({
              ...claim,
              chainId,
              verifyingContract,
              expectedSigner: signerAddress,
            });
      recovered = validated.recoveredSigner;
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : null;
      if (code === relayModule.RELAY_ERRORS.INVALID_CLAIM) return sendError(res, 400, ERRORS.INVALID_CLAIM);
      if (code === relayModule.RELAY_ERRORS.NOT_CONFIGURED) return sendError(res, 503, ERRORS.RELAY_NOT_CONFIGURED);
      if (code === relayModule.RELAY_ERRORS.SIGNATURE_INVALID) {
        return sendError(res, 400, ERRORS.RELAY_SIGNATURE_INVALID);
      }
      // Anything else is OUR bug, not the caller's: it is re-thrown so the JSON
      // error handler turns it into an opaque 500 and an alert. Mapping an
      // unexpected failure onto 400 would silently blame the client for a
      // defect in this process.
      throw err;
    }
    if (typeof recovered !== "string" || !ethers.isAddress(recovered)) {
      return sendError(res, 400, ERRORS.RELAY_SIGNATURE_INVALID);
    }
    if (signerAddress === null && log && typeof log.debug === "function") {
      log.debug("catt-relay: no expected signer available; relying on the contract's own check");
    }

    /* --- 5 + 6. Issuance cross-check and double-relay guard. --- */
    let record;
    if (typeof activeStore.getIssuedClaim === "function") {
      record = await activeStore.getIssuedClaim(claim.user, claim.nonce);
    }
    if (record) {
      // A relay-only row (created by `markRelayed` for a claim this backend
      // never issued) has NULL reward/staminaCost/deadline. There is nothing
      // recorded to disagree with, so those fields are skipped rather than
      // compared — and, just as importantly, not `BigInt(null)`-ed.
      const sameReward = record.reward === null || record.reward === undefined || BigInt(record.reward) === BigInt(claim.reward);
      const sameStamina =
        record.staminaCost === null || record.staminaCost === undefined || BigInt(record.staminaCost) === BigInt(claim.staminaCost);
      const sameDeadline =
        record.deadline === null || record.deadline === undefined || Number(record.deadline) === Number(claim.deadline);
      if (!sameReward || !sameStamina || !sameDeadline) {
        return sendError(res, 400, ERRORS.RELAY_CLAIM_MISMATCH);
      }
      if (record.relayerTxHash) {
        return sendError(res, 409, ERRORS.RELAY_ALREADY_RELAYED);
      }
    }

    /* --- 7. Broadcast, record, respond. --- */
    let relayed;
    try {
      relayed = await activeRelay.submitClaim({
        user: claim.user,
        reward: claim.reward,
        staminaCost: claim.staminaCost,
        nonce: claim.nonce,
        deadline: claim.deadline,
        signature: claim.signature,
      });
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : relayModule.RELAY_ERRORS.TX_FAILED;
      if (code === relayModule.RELAY_ERRORS.TX_REVERTED) {
        // NOT marked relayed: nothing was paid, so the nonce stays relayable.
        if (log && typeof log.warn === "function") {
          log.warn("catt-relay: claim transaction reverted", {
            user: claim.user,
            nonce: claim.nonce,
            reason: err && typeof err.reason === "string" ? err.reason : "execution reverted",
          });
        }
        return res.status(502).json({
          error: ERRORS.RELAY_TX_REVERTED,
          reason: err && typeof err.reason === "string" ? err.reason : "execution reverted",
        });
      }
      if (log && typeof log.error === "function") {
        log.error("catt-relay: broadcast failed", err && err.message ? err.message : String(err));
      }
      return res.status(502).json({
        error: ERRORS.RELAY_TX_FAILED,
        reason: err && typeof err.reason === "string" ? err.reason : "broadcast failed",
      });
    }

    const txHash = relayed && typeof relayed.txHash === "string" ? relayed.txHash : null;

    // Re-checked after the broadcast: if another concurrent request for the
    // same nonce recorded first, this call did not own the nonce even though
    // it did broadcast. The chain settles it, but it must be visible.
    let recorded = true;
    if (typeof activeStore.markRelayed === "function") {
      recorded = await activeStore.markRelayed({
        userAddress: claim.user,
        nonce: claim.nonce,
        txHash,
      });
    }
    if (!recorded && log && typeof log.warn === "function") {
      log.warn("catt-relay: nonce was already relayed by a concurrent request", {
        user: claim.user,
        nonce: claim.nonce,
        txHash,
      });
    }

    res.status(200).json({
      txHash,
      status: relayed && relayed.status !== undefined ? relayed.status : null,
      relayer: await relayRelayerAddress(activeRelay),
      user: claim.user,
      nonce: claim.nonce,
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
 * Builds the storage adapter the environment asks for.
 *
 * DEFAULTING IS THE POINT: with nothing configured this returns
 * `createMemoryStore()`, which is exactly what `startServer` did before any of
 * this existed. SQLite is loaded only when an operator names it, so every
 * existing test — and every deployment that has not opted in — behaves
 * identically, and `better-sqlite3` is never required in that case.
 *
 * It is called from the DEFAULT-CONSTRUCTION PATH ONLY. `createApp` still takes
 * an injected `store` and never consults the environment, which is what keeps
 * the dependency injection (and therefore the tests) intact.
 *
 * Environment (all optional):
 *   `CATT_STORE`   `memory` (default) or `sqlite`. Anything else is a startup
 *                  error naming the valid values, never a silent fallback: a
 *                  misspelled `CATT_STORE=sqlie` must not quietly produce a
 *                  volatile Judge that forgets its nonces on every restart.
 *   `SQLITE_PATH`  Database file for the sqlite adapter. Defaults to
 *                  `sqlite-store.js`'s documented default, which is OUTSIDE the
 *                  repository working tree on purpose — the file holds session
 *                  and wallet data and must never be committed. A relative
 *                  value is resolved against the process working directory, so
 *                  an operator who wants one inside their own tree must say so
 *                  AND gitignore it.
 *
 * @param {Object} [params]
 * @param {Object} [params.env] Environment to read; defaults to `process.env`.
 * @param {Console|Object} [params.logger] Sink for non-fatal warnings.
 * @returns {Object} A store implementing `STORAGE_METHODS`.
 * @throws {Error} If `CATT_STORE` names an adapter that does not exist.
 */
function createStoreFromEnv({ env, logger } = {}) {
  const source = env || process.env;
  const requested = String(source.CATT_STORE || "").trim().toLowerCase();
  if (requested === "" || requested === "memory") return createMemoryStore();

  const adapter = getStorageAdapter(requested);
  if (!adapter) {
    throw new Error(
      `catt-judge: unknown CATT_STORE adapter "${requested}". Valid values: ` +
        STORAGE_ADAPTERS.map((entry) => entry.id).join(", ") +
        ". See backend-server/.env.example."
    );
  }
  return adapter.load(
    adapter.id === "sqlite"
      ? { filename: source.SQLITE_PATH, logger: logger || console }
      : undefined
  );
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
  // `CATT_STORE=sqlite` + `SQLITE_PATH` opts into the persistent adapter;
  // unset, this is the in-memory store the Judge has always used.
  const store = createStoreFromEnv({ logger: console });
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
  // Which storage adapter is live. Public configuration, not state: the sqlite
  // path is not printed (it is host layout), only whether the Judge is
  // persistent at all, because a Judge silently running on the volatile
  // in-memory store is a production incident.
  console.log("catt-judge: store", String(process.env.CATT_STORE || "memory").toLowerCase());

  // The gasless relay is OPTIONAL: without `RELAYER_PRIVATE_KEY` and `RPC_URL`
  // the server still starts and `/api/relay` answers 503, which tells the app
  // to submit the claim itself. Only the boolean is reported — the relayer
  // key is never read into a log line.
  const relayConfigured =
    Boolean(process.env.RELAYER_PRIVATE_KEY) && Boolean(process.env.RPC_URL) && Boolean(process.env.MINING_CLAIMER_ADDRESS);
  console.log("catt-judge: gasless relay configured", relayConfigured);

  return app.listen(port);
}

module.exports = {
  CLAIM_TTL_SECONDS,
  ERRORS,
  JUDGE_FLAGS,
  createApp,
  createStoreFromEnv,
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
