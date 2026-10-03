/**
 * CATT Protocol — Backend "Anti-Cheat Engine" / Judge (PRD 3.2)
 *
 * PURE FUNCTIONS ONLY. This module performs no I/O, reads no clock, uses no
 * randomness, opens no sockets, logs nothing and touches no environment
 * variable. Every function is a deterministic, side-effect-free function of
 * its arguments, which is what makes the Judge auditable: a disputed mining
 * claim can be re-scored offline from the same stored telemetry and the same
 * stored submission, on any machine, at any time, and must produce the same
 * answer. It also makes the whole thing unit-testable in isolation (see
 * ../test/anticheat.test.js) with no database, no HTTP and no fixtures on
 * disk.
 *
 * Two independent signals decide a claim:
 *
 *   1. `evaluateTelemetry(samples)`   — hardware-level signals (battery
 *      temperature, touch coordinates, scroll velocity) that a server farm or
 *      an emulator cannot fake convincingly.
 *   2. `evaluateSubmission({...})`   — comprehension-level signals (quiz
 *      accuracy, highlighted key sentences, typing-speed floor, and the
 *      telemetry score) that a reader cannot fake without actually reading.
 *
 * The two are combined by the caller: `evaluateSubmission` takes the
 * telemetry score as an input rather than re-deriving it, so the transport
 * layer decides when telemetry is scored. `isTelemetryAcceptable` is exported
 * so the submission path can apply the same threshold without duplicating it.
 *
 * DEFENSIVE POSTURE: `evaluateSubmission` never throws on malformed content
 * — that input arrives from the public internet, and a thrown exception on a
 * bot payload is an easy way to get the process killed. A malformed claim
 * comes back as FAIL plus a flag. It throws only for structurally impossible
 * input (the argument itself is not an object), because that is a programming
 * error in the calling route, not an attack.
 */

/* -------------------------------------------------------------------------- */
/* Tunable thresholds — all exported so tests and the ops dashboard can cite  */
/* the exact numbers the engine is using.                                      */
/* -------------------------------------------------------------------------- */

/**
 * A session with fewer samples than this has not been observed long enough
 * for any hardware signal to mean anything. This is a FAIL, not a pass: the
 * burden of proof is on the claimant, and a one-sample "session" is the
 * cheapest possible way to try to claim a reward.
 *
 * @type {number}
 */
const MIN_TELEMETRY_SAMPLES = 8;

/**
 * Minimum telemetry score (0..100) a session must reach to be trusted.
 * Combined with the per-flag penalties below this means: one major signal
 * (flatline battery, impossible battery) can be survived, but two minor
 * signals, or one major plus anything else, cannot.
 *
 * @type {number}
 */
const TELEMETRY_PASS_SCORE = 60;

/**
 * Plausible battery-temperature window in degrees Celsius. A phone under
 * sustained load sits roughly 25-45C; below 10C or above 60C the reported
 * value is not a phone battery, it is a stubbed sensor.
 *
 * @type {number}
 */
const BATTERY_MIN_PLAUSIBLE_C = 10;

/**
 * @type {number}
 */
const BATTERY_MAX_PLAUSIBLE_C = 60;

/**
 * Tolerance (degrees C) inside which two temperature readings count as
 * identical. Real hardware drifts by more than this over any meaningful
 * window; a farm of devices reporting the same rounded constant does not.
 *
 * @type {number}
 */
const BATTERY_FLATLINE_EPSILON = 0.01;

/**
 * Human-plausible ceiling on implied scroll velocity, in px/s. Computed as
 * `abs(scrollDelta) / dtSeconds` between consecutive samples. A very fast
 * flick on a high-refresh display can exceed 1000 px/s, but nothing a human
 * does sustains 4000 px/s, and any value above it is a scripted scroll.
 *
 * @type {number}
 */
const SCROLL_MAX_PX_PER_SECOND = 4000;

/**
 * Typing-speed floor in milliseconds per character. Fast typists sustain
 * well under 100 ms/char; 60 ms/char is a generous floor that still requires
 * more time than a script replaying a pre-recorded answer can produce.
 *
 * @type {number}
 */
const MIN_TYPING_MS_PER_CHAR = 60;

/**
 * Free-text similarity above which an answer is considered a syndicated
 * (copied between accounts) submission.
 *
 * @type {number}
 */
const SYNDICATE_SIMILARITY_THRESHOLD = 0.9;

/**
 * Penalty subtracted from the pristine 100 for each flag raised. The two
 * "hardware is not real" signals are the most expensive because they are the
 * least explainable by a real device:
 *
 *   BATTERY_FLATLINE         40  -> survives alone (60), not with anything else
 *   BATTERY_IMPOSSIBLE       30  -> survives alone (70), not with a flatline
 *   PIXEL_PERFECT_TOUCH      25
 *   INHUMAN_SCROLL_SPEED     20
 *   TOO_FEW_SAMPLES         100  -> always 0; not enough evidence to pass
 *
 * @type {Record<string, number>}
 */
const FLAGS_PENALTIES = Object.freeze({
  BATTERY_FLATLINE: 40,
  BATTERY_IMPOSSIBLE: 30,
  PIXEL_PERFECT_TOUCH: 25,
  INHUMAN_SCROLL_SPEED: 20,
  TOO_FEW_SAMPLES: 100,
});

/* -------------------------------------------------------------------------- */
/* Flag constants                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Telemetry flags raised by `evaluateTelemetry`.
 *
 * @type {Readonly<{
 *   BATTERY_FLATLINE: string,
 *   BATTERY_IMPOSSIBLE: string,
 *   PIXEL_PERFECT_TOUCH: string,
 *   INHUMAN_SCROLL_SPEED: string,
 *   TOO_FEW_SAMPLES: string
 * }>}
 */
const FLAGS = Object.freeze({
  /** Battery temperature never moves across the whole sample window. */
  BATTERY_FLATLINE: "BATTERY_FLATLINE",
  /** Battery temperature outside 10..60C, missing, or non-numeric (also: missing ts). */
  BATTERY_IMPOSSIBLE: "BATTERY_IMPOSSIBLE",
  /** The exact same touch coordinate landed at least twice. */
  PIXEL_PERFECT_TOUCH: "PIXEL_PERFECT_TOUCH",
  /** Implied scroll velocity exceeded SCROLL_MAX_PX_PER_SECOND. */
  INHUMAN_SCROLL_SPEED: "INHUMAN_SCROLL_SPEED",
  /** Fewer than MIN_TELEMETRY_SAMPLES records: insufficient evidence to trust. */
  TOO_FEW_SAMPLES: "TOO_FEW_SAMPLES",
});

/**
 * Submission flags raised by `evaluateSubmission`.
 *
 * @type {Readonly<{
 *   QUIZ_INCORRECT: string,
 *   HIGHLIGHT_MISSING: string,
 *   TYPING_TOO_FAST: string,
 *   TELEMETRY_POOR: string,
 *   SUBMISSION_MALFORMED: string
 * }>}
 */
const SUBMISSION_FLAGS = Object.freeze({
  /** Not every question answered, or at least one answer was wrong. */
  QUIZ_INCORRECT: "QUIZ_INCORRECT",
  /** Fewer than highlightTask.minMatches key sentences appear in `highlight`. */
  HIGHLIGHT_MISSING: "HIGHLIGHT_MISSING",
  /** typingMs below impliedChars * MIN_TYPING_MS_PER_CHAR. */
  TYPING_TOO_FAST: "TYPING_TOO_FAST",
  /** telemetryScore below TELEMETRY_PASS_SCORE. */
  TELEMETRY_POOR: "TELEMETRY_POOR",
  /** Structurally wrong payload (non-array answers, non-numeric typingMs, ...). */
  SUBMISSION_MALFORMED: "SUBMISSION_MALFORMED",
});

/**
 * Submission status constants.
 *
 * @type {Readonly<{ PASS: "PASS", FAIL: "FAIL" }>}
 */
const STATUS = Object.freeze({
  /** @type {"PASS"} */
  PASS: "PASS",
  /** @type {"FAIL"} */
  FAIL: "FAIL",
});

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * True only for a real, finite number. Rejects NaN, Infinity, null, undefined,
 * numeric strings and booleans — telemetry comes off the wire as arbitrary
 * JSON, so every field has to be treated as untrusted.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function _isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Clamps a score into the inclusive 0..100 range and rounds it to an integer.
 *
 * @param {number} value
 * @returns {number} Integer in [0, 100].
 */
function _clampScore(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Lowercases, replaces every non-alphanumeric run with a single space and
 * trims. Exported because both the highlight check and `similarity` need
 * exactly the same notion of "the same text".
 *
 * @param {unknown} text
 * @returns {string} Normalized text; `""` for non-string input.
 */
function normalizeText(text) {
  if (typeof text !== "string") {
    return "";
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Splits normalized text into a set of unique tokens.
 *
 * @param {unknown} text
 * @returns {Set<string>}
 */
function _tokenize(text) {
  const normalized = normalizeText(text);
  if (normalized === "") {
    return new Set();
  }
  return new Set(normalized.split(" "));
}

/* -------------------------------------------------------------------------- */
/* 1. Telemetry analysis                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Scores a session's telemetry stream. Pure: no clock is read (the caller
 * supplies `ts` on every record), no randomness, and the input array is never
 * mutated.
 *
 * Detection summary:
 *   - BATTERY_FLATLINE: fewer than two plausible temperature readings, or
 *     every plausible reading identical within BATTERY_FLATLINE_EPSILON. Real
 *     hardware drifts.
 *   - BATTERY_IMPOSSIBLE: a temperature outside 10..60C, missing, NaN or
 *     non-numeric, or a missing/non-finite `ts`.
 *   - PIXEL_PERFECT_TOUCH: the same (x, y) pair appearing at least twice.
 *   - INHUMAN_SCROLL_SPEED: |scrollDelta| / dtSeconds above
 *     SCROLL_MAX_PX_PER_SECOND, using the signed per-interval delta.
 *   - TOO_FEW_SAMPLES: fewer than MIN_TELEMETRY_SAMPLES records.
 *
 * @param {Array<{ ts: number, batteryTempC: number, touch: { x: number, y: number }, scrollDelta: number }>} samples
 *   Telemetry records in chronological order.
 * @returns {{ score: number, flags: Array<string> }} Score 0..100 (100 = pristine)
 *   plus the flags that were raised.
 * @throws {TypeError} If `samples` is not an array.
 */
function evaluateTelemetry(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError(
      "evaluateTelemetry(samples): samples must be an array of telemetry records " +
        "(each { ts, batteryTempC, touch: { x, y }, scrollDelta })."
    );
  }

  const flags = [];

  // --- Sample sufficiency: a failure, not a pass. ---------------------------
  if (samples.length < MIN_TELEMETRY_SAMPLES) {
    flags.push(FLAGS.TOO_FEW_SAMPLES);
  }

  // --- Per-record plausibility ---------------------------------------------
  let impossible = false;
  const temperatures = [];
  const seenTouches = new Set();
  let repeatedTouch = false;

  for (const sample of samples) {
    const record = sample && typeof sample === "object" ? sample : {};
    const ts = record.ts;
    const temp = record.batteryTempC;

    // A missing timestamp is not a battery fault, but it is the same class of
    // fabrication (a stubbed sensor emitting canned records), so it is folded
    // into BATTERY_IMPOSSIBLE rather than given its own flag.
    if (!_isFiniteNumber(ts)) {
      impossible = true;
    }

    if (!_isFiniteNumber(temp) || temp < BATTERY_MIN_PLAUSIBLE_C || temp > BATTERY_MAX_PLAUSIBLE_C) {
      impossible = true;
    } else {
      temperatures.push(temp);
    }

    const touch = record.touch;
    if (touch && typeof touch === "object" && _isFiniteNumber(touch.x) && _isFiniteNumber(touch.y)) {
      const key = `${touch.x}|${touch.y}`;
      if (seenTouches.has(key)) {
        repeatedTouch = true;
      }
      seenTouches.add(key);
    }
  }

  // --- Flatline -------------------------------------------------------------
  // Requires at least two readings: a single reading trivially has zero
  // spread and would otherwise flag every short-but-valid stream.
  let flatline = false;
  if (temperatures.length < 2) {
    // A session that produced fewer than two plausible readings has a dead or
    // stubbed sensor, not a battery that happens to be steady. Flagged as a
    // flatline because that is the honest description of the signal.
    flatline = samples.length > 0;
  } else {
    let min = temperatures[0];
    let max = temperatures[0];
    for (const temp of temperatures) {
      if (temp < min) min = temp;
      if (temp > max) max = temp;
    }
    // Every plausible reading identical within tolerance: no drift at all.
    flatline = max - min <= BATTERY_FLATLINE_EPSILON;
  }

  // --- Scroll velocity ------------------------------------------------------
  // Between consecutive records that both have a usable timestamp. `scrollDelta`
  // is a signed per-interval delta, so the magnitude is the distance travelled
  // and the direction is irrelevant to plausibility.
  let inhumanScroll = false;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1] && typeof samples[i - 1] === "object" ? samples[i - 1] : {};
    const curr = samples[i] && typeof samples[i] === "object" ? samples[i] : {};
    if (!_isFiniteNumber(prev.ts) || !_isFiniteNumber(curr.ts)) {
      continue;
    }
    const dtMs = curr.ts - prev.ts;
    if (!(dtMs > 0)) {
      continue;
    }
    if (!_isFiniteNumber(curr.scrollDelta)) {
      continue;
    }
    const velocity = Math.abs(curr.scrollDelta) / (dtMs / 1000);
    if (velocity > SCROLL_MAX_PX_PER_SECOND) {
      inhumanScroll = true;
    }
  }

  if (flatline) flags.push(FLAGS.BATTERY_FLATLINE);
  if (impossible) flags.push(FLAGS.BATTERY_IMPOSSIBLE);
  if (repeatedTouch) flags.push(FLAGS.PIXEL_PERFECT_TOUCH);
  if (inhumanScroll) flags.push(FLAGS.INHUMAN_SCROLL_SPEED);

  let score = 100;
  for (const flag of flags) {
    score -= FLAGS_PENALTIES[flag] !== undefined ? FLAGS_PENALTIES[flag] : 0;
  }

  return { score: _clampScore(score), flags };
}

/**
 * Convenience gate for the submission path: did the telemetry clear the bar?
 *
 * @param {{ score: number, flags: Array<string> }|null|undefined} result
 *   Result of `evaluateTelemetry`. Anything non-conforming is unacceptable.
 * @returns {boolean} True only when the score reaches TELEMETRY_PASS_SCORE.
 */
function isTelemetryAcceptable(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  return _isFiniteNumber(result.score) && result.score >= TELEMETRY_PASS_SCORE;
}

/* -------------------------------------------------------------------------- */
/* 2. Submission evaluation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Grades a mining claim. Pure and defensive: any malformed field produces
 * FAIL plus a flag rather than an exception.
 *
 * Checks (every one of them must pass):
 *   1. QUIZ_INCORRECT  — every quiz question answered AND correct. No partial
 *      credit: the comprehension gate is pass/fail, so 2/3 correct is a fail.
 *   2. HIGHLIGHT_MISSING — at least highlightTask.minMatches of the key
 *      sentences appear in the submitted highlight string (case-insensitive,
 *      whitespace- and punctuation-normalized).
 *   3. TYPING_TOO_FAST — typingMs >= impliedChars * MIN_TYPING_MS_PER_CHAR,
 *      where impliedChars counts the selected option text plus the highlight
 *      length. Below the floor the answer was replayed, not typed.
 *   4. TELEMETRY_POOR — telemetryScore >= TELEMETRY_PASS_SCORE.
 *
 * ECONOMY DECISION (explicit, because it is a product decision and not an
 * implementation detail): `staminaCost` is charged whenever a submission is
 * graded, whether it passes or fails. Stamina is the anti-spam meter for
 * *attempting* a mission; charging only on success would make failed attempts
 * free and turn the quiz into a free oracle that can be brute-forced at no
 * cost. The reward, by contrast, is `mission.reward` on PASS and exactly 0 on
 * FAIL — a failed attempt pays for the reader's time, not for the protocol.
 *
 * @param {Object} submission
 * @param {Array<{ questionId: string, answerIndex: number }>} submission.answers
 * @param {string} submission.highlight Text the user claims to have highlighted.
 * @param {number} submission.typingMs Total typing time for the attempt, in ms.
 * @param {number} submission.telemetryScore 0..100 from `evaluateTelemetry`.
 * @param {{ reward: string|number, staminaCost: string|number }} submission.mission
 * @param {{ quiz: Array<Object>, highlightTask: Object }} submission.article
 * @returns {{ status: "PASS"|"FAIL", reward: string|number|0, staminaCost: string|number, flags: Array<string>, details: Object }}
 *   Auditable verdict.
 * @throws {TypeError} Only if `submission` is not an object.
 */
function evaluateSubmission(submission) {
  if (typeof submission !== "object" || submission === null || Array.isArray(submission)) {
    throw new TypeError(
      "evaluateSubmission(submission): submission must be an object shaped " +
        "{ answers, highlight, typingMs, telemetryScore, mission, article }."
    );
  }

  const { answers, highlight, typingMs, telemetryScore, mission, article } = submission;

  const flags = [];
  // Deduplicated: SUBMISSION_MALFORMED is a summary signal, not a counter, so a
  // payload that is wrong in five ways still carries the flag exactly once.
  let malformed = false;
  const addMalformed = () => {
    malformed = true;
  };

  const missionSafe = mission && typeof mission === "object" ? mission : {};
  const articleSafe = article && typeof article === "object" ? article : {};
  if ((!mission || typeof mission !== "object") || (!article || typeof article !== "object")) {
    addMalformed();
  }

  const quiz = Array.isArray(articleSafe.quiz) ? articleSafe.quiz : [];
  const highlightTask =
    articleSafe.highlightTask && typeof articleSafe.highlightTask === "object"
      ? articleSafe.highlightTask
      : {};
  const keySentences = Array.isArray(highlightTask.keySentences) ? highlightTask.keySentences : [];
  const minMatches = _isFiniteNumber(highlightTask.minMatches) ? highlightTask.minMatches : 0;

  /* --- 1. Quiz correctness ------------------------------------------------ */
  const answerList = Array.isArray(answers) ? answers : null;
  if (answerList === null) {
    addMalformed();
  }
  const byQuestionId = new Map();
  if (answerList) {
    for (const answer of answerList) {
      if (!answer || typeof answer !== "object") {
        addMalformed();
        continue;
      }
      byQuestionId.set(answer.questionId, answer.answerIndex);
    }
  }

  let correctAnswers = 0;
  let typedChars = 0;
  for (const question of quiz) {
    if (!question || typeof question !== "object") {
      addMalformed();
      continue;
    }
    const submitted = byQuestionId.get(question.id);
    if (submitted === question.correctIndex) {
      correctAnswers += 1;
    }
    if (_isFiniteNumber(submitted)) {
      const option = Array.isArray(question.options) ? question.options[submitted] : undefined;
      if (typeof option === "string") {
        typedChars += option.length;
      }
    }
  }
  if (correctAnswers !== quiz.length) {
    flags.push(SUBMISSION_FLAGS.QUIZ_INCORRECT);
  }

  /* --- 2. Highlight overlap ------------------------------------------------ */
  const highlightText = typeof highlight === "string" ? highlight : "";
  if (typeof highlight !== "string") {
    addMalformed();
  }
  const normalizedHighlight = normalizeText(highlightText);
  let highlightMatches = 0;
  for (const key of keySentences) {
    const normalizedKey = normalizeText(key);
    if (normalizedKey !== "" && normalizedHighlight.includes(normalizedKey)) {
      highlightMatches += 1;
    }
  }
  if (highlightMatches < minMatches) {
    flags.push(SUBMISSION_FLAGS.HIGHLIGHT_MISSING);
  }

  /* --- 3. Typing-speed floor ----------------------------------------------- */
  typedChars += highlightText.length;
  const impliedChars = typedChars;
  const floorMs = impliedChars * MIN_TYPING_MS_PER_CHAR;
  const effectiveTypingMs = _isFiniteNumber(typingMs) ? typingMs : 0;
  if (!_isFiniteNumber(typingMs)) {
    addMalformed();
  }
  const impliedMs = effectiveTypingMs;
  if (impliedMs < floorMs) {
    flags.push(SUBMISSION_FLAGS.TYPING_TOO_FAST);
  }

  /* --- 4. Telemetry gate --------------------------------------------------- */
  const effectiveTelemetry = _isFiniteNumber(telemetryScore) ? telemetryScore : 0;
  if (!_isFiniteNumber(telemetryScore)) {
    addMalformed();
  }
  if (effectiveTelemetry < TELEMETRY_PASS_SCORE) {
    flags.push(SUBMISSION_FLAGS.TELEMETRY_POOR);
  }

  /* --- Verdict ------------------------------------------------------------- */
  // Flag order is deterministic (malformed summary first, then quiz,
  // highlight, typing, telemetry) so two runs over the same payload are
  // deep-equal and a rejection reads consistently in the audit log.
  const finalFlags = malformed ? [SUBMISSION_FLAGS.SUBMISSION_MALFORMED, ...flags] : flags;
  const status = finalFlags.length === 0 ? STATUS.PASS : STATUS.FAIL;
  const reward = status === STATUS.PASS ? missionSafe.reward : 0;

  return {
    status,
    reward,
    // Always charged: stamina is the cost of attempting the mission.
    staminaCost: missionSafe.staminaCost !== undefined ? missionSafe.staminaCost : 0,
    flags: finalFlags,
    details: {
      correctAnswers,
      totalQuestions: quiz.length,
      answeredQuestions: answerList ? answerList.length : 0,
      highlightMatches,
      minMatches,
      impliedChars,
      impliedMs,
      floorMs,
      telemetryScore: effectiveTelemetry,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Free-text similarity                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Dice-coefficient similarity over token SETS (a Jaccard/Dice-style score in
 * [0, 1]). Set semantics mean a repeated phrase does not inflate the score —
 * relevant here, because syndicated answers are often padded with repetition.
 *
 * Properties relied on by tests: `similarity(x, x) === 1`,
 * `similarity("", "") === 1`, `similarity("a", "") === 0`, and symmetry.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Score in [0, 1].
 */
function similarity(a, b) {
  const setA = _tokenize(a);
  const setB = _tokenize(b);
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/* -------------------------------------------------------------------------- */
/* 4. Syndicate detection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compares a free-text answer against previously submitted answers and flags
 * it when the best match is above SYNDICATE_SIMILARITY_THRESHOLD. A high
 * similarity between two accounts' answers means the text was copied, which
 * for a learn-to-earn protocol is a reward claim with no reading behind it.
 *
 * @param {Object} params
 * @param {Array<string>} params.previousTexts Previously accepted free texts.
 * @param {string} params.currentText The text being submitted now.
 * @returns {{ syndicate: boolean, similarity: number }} `similarity` is the
 *   BEST match found (0 when there is no history).
 */
function detectSyndicate({ previousTexts, currentText } = {}) {
  if (!Array.isArray(previousTexts) || previousTexts.length === 0) {
    return { syndicate: false, similarity: 0 };
  }
  let best = 0;
  for (const previous of previousTexts) {
    if (typeof previous !== "string") {
      continue;
    }
    const score = similarity(previous, currentText);
    if (score > best) {
      best = score;
    }
  }
  return {
    syndicate: best > SYNDICATE_SIMILARITY_THRESHOLD,
    similarity: best,
  };
}

module.exports = {
  // Telemetry thresholds
  MIN_TELEMETRY_SAMPLES,
  TELEMETRY_PASS_SCORE,
  BATTERY_MIN_PLAUSIBLE_C,
  BATTERY_MAX_PLAUSIBLE_C,
  BATTERY_FLATLINE_EPSILON,
  SCROLL_MAX_PX_PER_SECOND,
  MIN_TYPING_MS_PER_CHAR,
  SYNDICATE_SIMILARITY_THRESHOLD,
  FLAGS_PENALTIES,
  // Flag constants
  FLAGS,
  SUBMISSION_FLAGS,
  STATUS,
  PASS: STATUS.PASS,
  FAIL: STATUS.FAIL,
  // Functions
  evaluateTelemetry,
  isTelemetryAcceptable,
  evaluateSubmission,
  similarity,
  normalizeText,
  detectSyndicate,
};
