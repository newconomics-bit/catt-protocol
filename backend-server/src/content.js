/**
 * CATT Protocol — Backend "Content Randomizer" (PRD 3.1 / 3.2)
 *
 * Owns the seeded reading content (3 articles, 3 missions) and the
 * per-session randomization of the article structure that defeats naive
 * auto-scrollers:
 *
 *   - paragraph order is shuffled per session;
 *   - exactly ONE "focus trap" is placed inside the shuffled body.
 *
 * DETERMINISM IS THE POINT, NOT AN ACCIDENT.
 * `getArticleLayout(articleId, sessionId)` is a pure function of its two
 * arguments: the SAME session id ALWAYS yields the byte-identical layout,
 * and DIFFERENT session ids yield different layouts. This is required
 * because the Judge (this file) and the client must AGREE on the layout for
 * a session: the client fetches the layout once, reads it, and then posts
 * answers/highlights that are graded against that exact layout. A layout
 * that re-rolled on every request would make re-submission impossible and
 * would make the anti-cheat logs unauditable.
 *
 * Because determinism is required, `Math.random()` is NEVER used anywhere
 * in this file. All randomness comes from an explicitly seeded PRNG
 * (FNV-1a hash -> mulberry32) driven by a Fisher-Yates shuffle. Swapping
 * the PRNG for a different one would change every layout, so it is
 * documented in detail and treated as part of the module's contract.
 *
 * SEED IMMUTABILITY: `MISSIONS` and `ARTICLES` are deep-frozen, and every
 * value handed back to a caller is a fresh deep copy. A caller that mutates
 * a returned layout (sorts its paragraphs, edits a quiz option) cannot
 * corrupt the seed or affect any other session.
 *
 * TWO UNITS, NEVER CONFLATED. This is the single most important thing to know
 * about this file after the wave-9 stamina unit fix:
 *
 *   `reward`      a MONETARY amount: a decimal STRING of 18-decimal CATT base
 *                 units (1 CATT = 1e18), matching the on-chain uint256 type and
 *                 the `ClaimReward` struct in ../signer.js. Use `BigInt(x)` for
 *                 arithmetic; never rely on Number arithmetic (1e18 exceeds
 *                 Number.MAX_SAFE_INTEGER).
 *
 *   `staminaCost` a UNITLESS COUNT OF STAMINA POINTS, as a plain JS integer.
 *                 `StakingManager.sol` states it directly: stamina "is unitless
 *                 and has no monetary value" (see the NatSpec on the `stamina`
 *                 mapping), `STAMINA_PER_STAKE = 50` stamina points are credited
 *                 per successful stake, and `consumeStamina(account, amount)`
 *                 reverts `StaminaInsufficient` unless `amount <= stamina[account]`.
 *                 Declaring a stamina cost in wei made the cheapest mission cost
 *                 `1e18 / 50 = 2e16` successful stakes to cover: no claim could
 *                 ever settle and realised emission was 0. Stamina costs are
 *                 therefore single-digit points, which is exactly the range where
 *                 `Number.isSafeInteger` is lossless and a plain integer is the
 *                 honest representation.
 *
 * Conflating the two is not a style question. A 1e18 "stamina cost" is not a
 * large number of points, it is a number no account can ever hold; a stamina
 * cost expressed as `"10"` is not ten wei, it is ten points.
 *
 * AUTHORING-TIME VALIDATION (the livelock guard): the seeded content is
 * validated at MODULE LOAD by `validateContent`, so a mission that could never
 * settle on-chain is rejected before the module is even exported — long before
 * anything can be signed. The motivating case is `staminaCost == 0`:
 * `StakingManager.consumeStamina` reverts `ZeroAmount()` on a zero amount, and
 * `MiningClaimer.claimReward` calls it unconditionally, so a mission authored
 * with a zero stamina cost makes 100% of its claims revert while the board
 * happily lists it and the Judge happily signs it — a silent livelock. The
 * same class of footgun (bad data that only surfaces as a permanent, silent
 * failure for the claimant) is guarded for `reward`, `articleId`, `difficulty`,
 * `minMatches` vs `keySentences` and quiz `correctIndex`.
 *
 * A POISONED CONTENT FILE MUST CRASH THE JUDGE AT BOOT. `require`ing this
 * module with an invalid seed throws from the top level of the module and there
 * is deliberately NO try/catch anywhere around it: serving a mission that can
 * never be claimed is strictly worse than not serving it at all, because the
 * user is invited to read, and then to lose, a reward that was never
 * claimable. Failing loudly at boot turns an undetectable livelock into a
 * deploy-time error an operator sees in the first second of the process.
 *
 * Pure module: no I/O, no clock, no randomness, no environment access.
 */

const DIFFICULTIES = Object.freeze({
  EASY: "EASY",
  MEDIUM: "MEDIUM",
  HARD: "HARD",
});

/**
 * Machine-readable codes attached to content-validation errors, following the
 * same `*.code` convention as `relay.js`'s `RELAY_ERRORS`: a plain `Error`
 * with a stable string `.code` plus the offending values as own fields, so a
 * test or an operator can assert on the code instead of matching a message.
 *
 * @type {Readonly<{ INVALID_MISSION: string, INVALID_ARTICLE: string }>}
 */
const CONTENT_ERRORS = Object.freeze({
  /** A mission field is missing, malformed, or would livelock a claim. */
  INVALID_MISSION: "CONTENT_INVALID_MISSION",
  /** An article field is missing, malformed, or makes the mission unclaimable. */
  INVALID_ARTICLE: "CONTENT_INVALID_ARTICLE",
});

/** The `name` every validation failure carries, so one `instanceof`-free check covers both codes. */
const CONTENT_ERROR_NAME = "InvalidMissionContent";

/** A non-negative decimal integer, in string form (the amount wire format). */
const DECIMAL_PATTERN = /^\d+$/;

/**
 * The focus-trap kinds the reading client knows how to render. Exactly one of
 * these is attached to each layout; the client triggers the trap (swipe to
 * continue / tap the image / hold to reveal) when the reader reaches the
 * trap's paragraph index.
 *
 * @type {ReadonlyArray<"swipe-to-continue"|"tap-the-image"|"hold-to-reveal">}
 */
const FOCUS_TRAP_TYPES = Object.freeze([
  "swipe-to-continue",
  "tap-the-image",
  "hold-to-reveal",
]);

/* -------------------------------------------------------------------------- */
/* Seed content                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The three seeded articles. Real prose about attention / focus / learning
 * science — this is a live bounty board, not filler text.
 *
 * @type {ReadonlyArray<Object>}
 */
const _ARTICLES_SEED = [
  {
    id: "art-focus-101",
    missionId: "mission-1",
    title: "Why Your Attention Slips at Twenty-Three Minutes",
    difficulty: DIFFICULTIES.EASY,
    reward: "12000000000000000000", // 12 CATT
    staminaCost: 10, // 10 stamina POINTS (unitless), NOT 10 wei — see StakingManager.sol
    paragraphs: [
      "Most people believe attention behaves like a fuel tank: it empties, you refill it, and once it is empty there is nothing to do but wait. The research disagrees. Attention drifts long before the tank is empty, and the drift is not smooth. Instead it arrives in bursts — a few minutes of clean engagement, then a moment where your eyes have moved across the page without having read it, then a return. Once you notice that you have drifted, the previous paragraph is usually gone. Researchers call this a mind-wandering event, and the interesting part is that most of them are invisible from the inside until after the fact.",
      "The older explanation for this rhythm was the ultradian cycle, borrowed from sleep research: roughly ninety minutes of concentrated work, then a rest. Work on the twenty- to thirty-minute scale instead suggests a different mechanism. Under conditions of steady, self-paced reading, most readers begin to show measurable lapses in comprehension somewhere between fifteen and twenty-five minutes, with a median close to twenty-three. Crucially, the timing varies with the reader, the material and the environment — which is exactly why a fixed timer produces a fixed ceiling rather than a reliable signal.",
      "A second, better-supported explanation is task-switching cost. Every time you look away — at a notification, a second window, your own thoughts — you do not merely pause, you reload. Researchers call the residue a switching cost, and the empirical result is uncomfortable: a substantial share of that cost is not recovered at all. The deep problem is not that you cannot focus, it is that returning costs more than staying, so every interruption is quietly repricing the next ten minutes of your work.",
      "The practical implication is that you should externalise the things that would otherwise capture your attention instead of trying to defeat them with willpower. Put the phone in another room rather than face down, keep the article in a window that is the only visible window, and write down the intrusive thought instead of pursuing it. Each of these replaces a moment of suppression with a moment of delegation, and delegation does not require you to remember anything. The goal is not a perfect session; a session with three planned interruptions beats an unplanned one almost every time.",
      "Finally, the reading you do in those protected blocks matters more than the reading you do in the gaps, and this is where the payoff is. Spacing — distributing practice across days rather than cramming it into one evening — reliably outperforms massed practice for long-term retention, even when the cramming feels dramatically better at the time. Short, protected, repeated blocks with a real comprehension check attached to each block is the entire recommendation. Everything else in this article is a detail in service of making those blocks happen.",
    ],
    quiz: [
      {
        id: "art-focus-101-q1",
        question:
          "According to the article, when do most readers start to show measurable comprehension lapses during self-paced reading?",
        options: [
          "At least sixty minutes in, regardless of conditions",
          "Between about fifteen and twenty-five minutes, with a median near twenty-three",
          "Only when the material is difficult or unfamiliar",
          "Precisely at the ninety-minute ultradian boundary",
        ],
        correctIndex: 1,
      },
      {
        id: "art-focus-101-q2",
        question:
          "What does the article identify as the hidden cost of looking away from the text?",
        options: [
          "A permanent reduction in total daily reading capacity",
          "The loss of all comprehension of the paragraph already read",
          "A task-switching cost, part of which is never recovered",
          "An increase in the battery cost of the screen",
        ],
        correctIndex: 2,
      },
      {
        id: "art-focus-101-q3",
        question:
          "Which practice does the article recommend for interrupting material most efficiently?",
        options: [
          "Suppressing the intrusive thought harder each time it appears",
          "Keeping the phone face down on the desk so it is in reach",
          "Externalising interruptions: delegate them, then protect the block",
          "Waiting for willpower to return at the next fixed timer",
        ],
        correctIndex: 2,
      },
    ],
    highlightTask: {
      instructions:
        "Highlight the two sentences that explain WHY your attention drifts, then why externalising interruptions works better than willpower.",
      keySentences: [
        "a substantial share of that cost is not recovered at all",
        "a session with three planned interruptions beats an unplanned one almost every time",
      ],
      minMatches: 2,
    },
  },
  {
    id: "art-focus-202",
    missionId: "mission-2",
    title: "The Spacing Effect: Why Cramming Lies to You",
    difficulty: DIFFICULTIES.MEDIUM,
    reward: "20000000000000000000", // 20 CATT
    staminaCost: 20, // 20 stamina POINTS (unitless), NOT 20 wei — see StakingManager.sol
    paragraphs: [
      "Cebiril's experiments with nonsense syllables are the oldest evidence in this story, and they are still the cleanest. He asked participants to learn lists of syllables and tested them at fixed intervals. Repeated testing always felt better and always scored worse than a single test after a longer delay, even though in the repeated condition each individual session was faster. The subjective report of a good study session and the objective report of later retention are simply different measurements, and only one of them is predictive of anything.",
      "The mechanism appears to be a failure of contextual retrieval rather than of memory itself. Each retrieval attempt succeeds partly because of cues present in that moment: the room, the time of day, the text two lines above, the mood you were in. Spaced retrieval removes those cues, so each attempt has to succeed on the strength of the material itself. That is the part you want. What feels like difficulty at the moment of practice is the diagnostic of an attempt that was not leaning on the room.",
      "The consequences for a learner are unusually practical because spacing is a scheduling decision, not an ability. The same total study time produces very different outcomes depending on whether it is front-loaded into one evening or distributed across a week. The distribution is the intervention. Nobody needs more discipline here; they need a queue of small sessions that arrive before the previous one has decayed, and an implementation that makes the next session easy to start.",
      "Interleaving is the natural companion to spacing, and it is the one people resist most. Blocked practice — ten problems of type A, then ten of type B — feels dramatically smoother and produces worse transfer, because the learner never has to decide which procedure applies. Interleaved practice forces that decision on every item, and the decision is the knowledge. This is the most robust and most counter-intuitive finding in the whole literature: making practice harder, on purpose and immediately, makes it stick better.",
      "The failure mode to avoid is optimisation for the feeling of mastery. A session that is smooth, fast and complete produces a strong sense of having learned something, and that sense is generated by fluency, not by retention. Both feedback systems matter here. Fluency is what the session feels like; retention is what is left a week later when the context is gone. If the only signal available during the session is fluency, the learner will systematically prefer the schedule that teaches the least.",
    ],
    quiz: [
      {
        id: "art-focus-202-q1",
        question:
          "What did the repeated-testing condition in the classic syllable experiments actually produce?",
        options: [
          "Better delayed retention than a single test after a long delay",
          "Faster individual sessions but worse delayed retention",
          "Identical retention with a stronger subjective sense of learning",
          "Higher scores only for participants who reported low confidence",
        ],
        correctIndex: 1,
      },
      {
        id: "art-focus-202-q2",
        question:
          "According to the article, why does spacing improve long-term retention?",
        options: [
          "Because spaced sessions are shorter and therefore less tiring",
          "Because contextual cues are removed, so retrieval must lean on the material itself",
          "Because spacing reduces the total amount of material to be learned",
          "Because repeated sessions trigger protein synthesis in the hippocampus",
        ],
        correctIndex: 1,
      },
      {
        id: "art-focus-202-q3",
        question:
          "Why is interleaved practice resisted, according to the article?",
        options: [
          "Because the added difficulty measurably damages retention",
          "Because it requires equipment that most learners do not have",
          "Because it is slower per session even when transfer is better",
          "Because it only works for motor skills and not for verbal material",
        ],
        correctIndex: 2,
      },
    ],
    highlightTask: {
      instructions:
        "Highlight the sentence explaining the retrieval mechanism behind spacing, and the sentence describing the failure mode this creates for learners.",
      keySentences: [
        "The distribution is the intervention",
        "optimisation for the feeling of mastery",
      ],
      minMatches: 2,
    },
  },
  {
    id: "art-focus-303",
    missionId: "mission-3",
    title: "Desirable Difficulty and the Illusion of Fluency",
    difficulty: DIFFICULTIES.HARD,
    reward: "40000000000000000000", // 40 CATT (sponsored tier)
    staminaCost: 30, // 30 stamina POINTS (unitless), NOT 30 wei — see StakingManager.sol
    paragraphs: [
      "Learning scientists use difficulty as a design variable rather than a defect. During acquisition, conditions that make retrieval feel effortful — a delay before the cue, a partial cue rather than a full one, mixing problem types — reliably produce better long-run performance than conditions that feel clean. The word they use is desirable difficulty, and the qualifier matters: the difficulty has to be on the retrieval side. Adding difficulty to the presentation of material, or making the material itself more confusing, degrades learning reliably.",
      "Fluency is the reason this is hard to practise. When material is easy to process, comprehension feels immediate and real, and that feeling is produced by the ease of processing rather than by the quality of what was understood. A well-known demonstration has participants judge the font size of a passage, and then judge how likely they are to remember having read it: the smaller the font, the higher the remembered fluency, and the worse the actual later performance. Memory for the experience of understanding and memory for the content diverge completely under this manipulation.",
      "There is a practical test you can apply to your own learning that costs nothing. Ask whether the difficult version of the session is difficult at the moment of retrieval or only at the moment of the first encounter. If the struggle is in working out that a procedure applies, the difficulty is desirable. If the struggle is in decoding the notation, in following the argument or in remembering what the previous paragraph said, the difficulty is pure friction and it is being misread as rigour.",
      "This is also the honest reconciliation between the felt experience of practice and the evidence. Effort is a signal, and the signal is about the timing of the effort, not its amount. The uncomfortable corollary is that a session which felt excellent may have taught almost nothing, and you will not be able to tell from inside the session. The only reliable feedback available is delayed: a check a week later, in a different context, with no cue from the original material. Any system that reports your learning in real time is reporting fluency, not retention.",
      "What follows for a learn-to-earn product like this one is a design constraint rather than a slogan. If the reward is paid on the session, the product will optimise for the feeling of mastery; if it is paid on a delayed check performed outside the session, the product optimises for retention. The second is harder to build and considerably harder to cheat, which is not a coincidence — every mechanism that makes cheating easier tends to make fluency easier to feel.",
    ],
    quiz: [
      {
        id: "art-focus-303-q1",
        question: "What makes a difficulty 'desirable' in the sense used by the article?",
        options: [
          "Any difficulty at all, as long as the total time spent increases",
          "Difficulty located at the moment of retrieval, not in the presentation",
          "Difficulty that appears only in the first encounter with the material",
          "Difficulty introduced by making the notation harder to decode",
        ],
        correctIndex: 1,
      },
      {
        id: "art-focus-303-q2",
        question: "In the font-size demonstration, what happened as the font got smaller?",
        options: [
          "Judged fluency went down and later performance went up",
          "Judged fluency stayed constant and later performance improved",
          "Judged fluency went up and later performance got worse",
          "Both fluency and later performance improved together",
        ],
        correctIndex: 2,
      },
      {
        id: "art-focus-303-q3",
        question:
          "According to the article, what does a product that pays rewards on the session itself tend to optimise?",
        options: [
          "Delayed retention, because it is harder to fake",
          "The feeling of mastery, which is generated by fluency rather than retention",
          "The total number of practice attempts per week",
          "Presentation difficulty, since that signals seriousness to the learner",
        ],
        correctIndex: 1,
      },
    ],
    highlightTask: {
      instructions:
        "Highlight the sentence stating where desirable difficulty must be located, and the sentence about what real-time learning feedback is actually reporting.",
      keySentences: [
        "the difficulty has to be on the retrieval side",
        "reporting fluency, not retention",
      ],
      minMatches: 2,
    },
  },
];

/**
 * The public bounty-board projection of the seed: one mission per article.
 * `reward` (an 18-decimal CATT decimal string) and `staminaCost` (a plain
 * integer count of unitless stamina POINTS) mirror the owning article exactly
 * — the mission is what the board displays, the article is what the reader gets
 * — and the difficulty ordering is the economy ordering: HARD/SPONSORED earns
 * the most and costs the most stamina.
 *
 * @type {ReadonlyArray<{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: number }>}
 */
const _MISSIONS_SEED = [
  {
    id: "mission-1",
    articleId: "art-focus-101",
    difficulty: DIFFICULTIES.EASY,
    reward: "12000000000000000000", // 12 CATT
    staminaCost: 10, // 10 stamina POINTS (unitless), NOT 10 wei — see StakingManager.sol
  },
  {
    id: "mission-2",
    articleId: "art-focus-202",
    difficulty: DIFFICULTIES.MEDIUM,
    reward: "20000000000000000000", // 20 CATT
    staminaCost: 20, // 20 stamina POINTS (unitless), NOT 20 wei — see StakingManager.sol
  },
  {
    id: "mission-3",
    articleId: "art-focus-303",
    difficulty: DIFFICULTIES.HARD,
    reward: "40000000000000000000", // 40 CATT
    staminaCost: 30, // 30 stamina POINTS (unitless), NOT 30 wei — see StakingManager.sol
  },
];

/* -------------------------------------------------------------------------- */
/* Immutability helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Recursively freezes a value in place. Applied to the seed at module load so
 * that a careless caller cannot edit the bounty board.
 *
 * @template T
 * @param {T} value
 * @returns {T} The same (now frozen) value.
 */
function _deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    _deepFreeze(value[key]);
  }
  return value;
}

/**
 * Structured deep copy of JSON-shaped seed data (plain objects, arrays,
 * strings, numbers). Deliberately hand-rolled instead of `structuredClone`
 * so the clone helper is trivially auditable and dependency-free.
 *
 * @template T
 * @param {T} value
 * @returns {T} A deep copy that shares no mutable reference with `value`.
 */
function _deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(_deepClone);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = _deepClone(value[key]);
    }
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Authoring-time validation (the livelock guard)                              */
/* -------------------------------------------------------------------------- */

/**
 * Builds a content-validation error.
 *
 * IDIOM: the codebase has exactly two error idioms — `storage.js` throws a bare
 * `new Error(message)`, and `relay.js` throws a bare `new Error(message)` with a
 * stable string `.code` from a frozen `*_ERRORS` map plus the offending values
 * as own fields (see `_relayError` in relay.js). This factory follows the
 * SECOND one, because content failures are machine-readable the same way relay
 * failures are: a named error, a stable `.code`, and the offending values as
 * fields. It deliberately does not introduce a third idiom (no Error subclass):
 * `instanceof` across module reloads is a footgun, and `.name` + `.code` is
 * what every other failure in this codebase is matched on.
 *
 * @param {string} code One of `CONTENT_ERRORS`.
 * @param {string} message Short, secret-free message naming the entity and field.
 * @param {Object} fields `{ missionId, articleId, field, value, reason }`.
 * @returns {Error} The typed error.
 */
function _contentError(code, message, fields) {
  const err = new Error(message);
  err.name = CONTENT_ERROR_NAME;
  err.code = code;
  Object.assign(err, fields);
  return err;
}

/**
 * Normalises a value for inclusion in an error field: a bigint would not
 * survive `JSON.stringify`, so it is carried as its decimal text.
 *
 * @param {*} value
 * @returns {*}
 */
function _reportableValue(value) {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * True for a STRICTLY POSITIVE integer amount: a positive `bigint`, a safe
 * integer `number` > 0, or a decimal digit string denoting a value > 0.
 *
 * Rejected on purpose: `0` and `"0"` (the livelock: `consumeStamina` reverts
 * `ZeroAmount`), negative values (`-1`, `"-1"` — a uint256 the ABI encoder
 * would reject, after the signature had already been issued), fractions
 * (`1.5`, `"1.5"` — 18-decimal base units cannot be fractional), `NaN`,
 * `Infinity`, booleans, `null`, `undefined` and objects. Non-finite and unsafe
 * numbers are rejected because `Number.isSafeInteger` is the only `number`
 * predicate that survives the 1e18 magnitudes this codebase uses.
 *
 * @param {*} value Candidate amount.
 * @returns {boolean}
 */
function _isPositiveAmount(value) {
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) return false;
    try {
      return BigInt(trimmed) > 0n;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Renders an amount for an error message without ever throwing on a Symbol.
 *
 * @param {*} value
 * @returns {string}
 */
function _describe(value) {
  try {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return "<unprintable>";
  }
}

/**
 * The largest stamina cost an author may declare, in unitless stamina points.
 *
 * A VALIDATION ceiling, not an economic parameter — see `_isPositiveStaminaCost`.
 * It exists so that the wave-9 unit fix cannot be reintroduced silently: any
 * value expressed in CATT base units (1e18 and up) is rejected at module load,
 * with the same loud boot crash as any other poisoned content file.
 *
 * @type {number}
 */
const MAX_STAMINA_COST_POINTS = 1000000;

/**
 * True for a stamina cost that is a plain, plausible number of stamina POINTS.
 *
 * This is `_isPositiveAmount` AND a magnitude ceiling, and the second half is
 * the point. `staminaCost > 0` is the wave-8 livelock guard and it catches the
 * SIGN of the unit defect (a zero or negative cost reverts `ZeroAmount`). It
 * cannot catch the MAGNITUDE: `"1000000000000000000"` is strictly positive, so
 * the positivity guard passed it happily while the mission became permanently
 * unclaimable — `consumeStamina` reverts `StaminaInsufficient` until the user
 * has accumulated `1e18 / 50 = 2e16` successful stakes. That is the exact defect
 * this file shipped until wave 9, and a positivity guard must never again be
 * read as evidence that the unit is right.
 *
 * So the guard also refuses anything above `MAX_STAMINA_COST_POINTS`. This is a
 * validation ceiling, NOT an economic parameter: it bounds what an AUTHOR may
 * write, not what a USER may earn or spend, and no reward, split or multiplier
 * is derived from it. `1e6` points is 33,333 seeded HARD missions in one go, so
 * no plausible authored cost is excluded by it, while a CATT-denominated value
 * (`1e18`) misses it by twelve orders of magnitude.
 *
 * @param {*} value Candidate stamina cost.
 * @returns {boolean}
 */
function _isPositiveStaminaCost(value) {
  if (!_isPositiveAmount(value)) return false;
  const points = _staminaPointsOf(value);
  // An unrepresentable magnitude (`points === null`) is a REJECT, never a pass:
  // `null <= MAX` is `true` in JavaScript, which would let the exact
  // CATT-denominated string this guard exists to catch straight through.
  return points !== null && points <= MAX_STAMINA_COST_POINTS;
}

/**
 * The point value of a positive stamina cost, or `null` when the value is not a
 * plain integer quantity at all.
 *
 * @param {*} value Candidate stamina cost (number or decimal digit string).
 * @returns {number|null}
 */
function _staminaPointsOf(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  if (typeof value === "string" && DECIMAL_PATTERN.test(value.trim())) {
    const asBig = BigInt(value.trim());
    return asBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(asBig) : null;
  }
  return null;
}

/**
 * Validates ONE mission.
 *
 * REQUIRED RULE — `staminaCost` must be a strictly positive integer amount.
 * This is the whole point of the module: a zero stamina cost is signed into
 * the `ClaimReward` struct by the Judge and then reverts on-chain in
 * `StakingManager.consumeStamina` (`if (amount == 0) revert ZeroAmount();`,
 * called unconditionally by `MiningClaimer.claimReward`), which livelocks
 * 100% of that mission's claims with no user-visible cause. It is checked
 * FIRST so the error message leads with the required guard.
 *
 * EXTRA HARDENING, all of the same class (authored data that fails silently
 * and permanently rather than loudly):
 *   - `reward` must be a positive amount. `StakingManager` never rejects a
 *     zero reward, so a zero-reward mission instead mints signed claims that
 *     pay nothing — the reader does the work and receives nothing, forever.
 *   - `articleId` must be a non-empty string that RESOLVES to a real article
 *     when an article set is supplied. A dangling id makes `getArticleLayout`
 *     return `null`, so the board lists a mission whose reading material 404s.
 *   - `difficulty` must be one of `DIFFICULTIES`. It is part of the public
 *     board projection and of the economy ordering; an unknown value is a
 *     content bug that no reader can act on.
 *
 * The function is PURE: it reads its inputs and throws, it never mutates,
 * clones, freezes or normalises them. Passing the frozen seed is therefore
 * safe by construction.
 *
 * @param {Object} mission Candidate mission (`{ id, articleId, difficulty, reward, staminaCost }`).
 * @param {Object} [options]
 * @param {ReadonlyArray<Object>} [options.articles] Article set to resolve `articleId` against.
 * @returns {Object} The same `mission` reference, unchanged.
 * @throws {Error} `CONTENT_INVALID_MISSION` (`InvalidMissionContent`).
 */
function validateMission(mission, options) {
  const articles = options && Array.isArray(options.articles) ? options.articles : null;
  const fail = (field, reason, value) => {
    const id = mission && typeof mission.id === "string" ? mission.id : "<missing id>";
    throw _contentError(
      CONTENT_ERRORS.INVALID_MISSION,
      `content: mission \`${id}\` is invalid — field \`${field}\`: ${reason}`,
      {
        missionId: id,
        articleId: mission && typeof mission.articleId === "string" ? mission.articleId : undefined,
        field,
        value: _reportableValue(
          mission && typeof mission === "object" ? mission[field] : value
        ),
        reason,
      }
    );
  };

  if (mission === null || typeof mission !== "object" || Array.isArray(mission)) {
    fail("id", "mission must be an object");
  }
  if (typeof mission.id !== "string" || mission.id.length === 0) {
    fail("id", "mission id must be a non-empty string");
  }

  // REQUIRED: the livelock guard. First amount check, deliberately.
  if (!_isPositiveStaminaCost(mission.staminaCost)) {
    fail(
      "staminaCost",
      `must be a positive integer number of stamina POINTS in [1, ${MAX_STAMINA_COST_POINTS}] ` +
        `(stamina is unitless — see StakingManager.sol; it is NOT a CATT amount), got ${_describe(
          mission.staminaCost
        )} — a zero or malformed stamina cost makes every claim revert on-chain with ` +
        `ZeroAmount, and a CATT-denominated one reverts StaminaInsufficient forever`,
      mission.staminaCost
    );
  }
  if (!_isPositiveAmount(mission.reward)) {
    fail(
      "reward",
      `must be a strictly positive integer amount in 18-decimal base units, got ${_describe(
        mission.reward
      )} — a zero reward would sign claims that pay nothing`,
      mission.reward
    );
  }
  if (typeof mission.articleId !== "string" || mission.articleId.length === 0) {
    fail("articleId", `must be a non-empty string, got ${_describe(mission.articleId)}`, mission.articleId);
  }
  if (articles !== null) {
    const target = articles.find((article) => article && article.id === mission.articleId);
    if (!target) {
      fail(
        "articleId",
        `\`${mission.articleId}\` does not resolve to a seeded article — the board would list a mission whose reading material 404s`,
        mission.articleId
      );
    }
  }
  if (!Object.values(DIFFICULTIES).includes(mission.difficulty)) {
    fail(
      "difficulty",
      `must be one of ${Object.values(DIFFICULTIES).join(", ")}, got ${_describe(mission.difficulty)}`,
      mission.difficulty
    );
  }

  return mission;
}

/**
 * Validates ONE article — the content a reader is graded against.
 *
 * The article-level rules are the same footgun class as the mission-level ones:
 * a malformed quiz or highlight task does not crash anything, it just makes
 * every submission FAIL forever.
 *   - `quiz[i].correctIndex` must be an integer inside `[0, options.length)`.
 *     Out of range, the question can never be answered correctly, so
 *     `QUIZ_INCORRECT` is permanent and the mission pays nothing, ever.
 *   - `highlightTask.minMatches` must be an integer in
 *     `[1, keySentences.length]`. Above the key count, `HIGHLIGHT_MISSING` is
 *     permanent even for a reader who highlighted everything.
 *   - `quiz`/`keySentences` must be non-empty, `paragraphs` must be non-empty:
 *     an empty question set or a blank body leaves the reader with nothing to
 *     answer or nothing to read, and the mission silently pays nothing.
 *   - `missionId` must resolve to a seeded mission when a mission set is given
 *     (the mirror of the mission -> article check), `difficulty` must be known,
 *     and `reward`/`staminaCost` must be positive — the article is what the
 *     layout serves, so it carries the amounts itself.
 *
 * Pure: reads only, never mutates.
 *
 * @param {Object} article Candidate article.
 * @param {Object} [options]
 * @param {ReadonlyArray<Object>} [options.missions] Mission set to resolve `missionId` against.
 * @returns {Object} The same `article` reference, unchanged.
 * @throws {Error} `CONTENT_INVALID_ARTICLE` (`InvalidMissionContent`).
 */
function validateArticle(article, options) {
  const missions = options && Array.isArray(options.missions) ? options.missions : null;
  const fail = (field, reason, ownerId) => {
    const id = article && typeof article.id === "string" ? article.id : "<missing id>";
    throw _contentError(
      CONTENT_ERRORS.INVALID_ARTICLE,
      `content: article \`${id}\` is invalid — field \`${field}\`: ${reason}`,
      {
        missionId: typeof ownerId === "string" ? ownerId : undefined,
        articleId: id,
        field,
        value: _reportableValue(article && typeof article === "object" ? article[field] : undefined),
        reason,
      }
    );
  };

  if (article === null || typeof article !== "object" || Array.isArray(article)) {
    fail("id", "article must be an object");
  }
  if (typeof article.id !== "string" || article.id.length === 0) {
    fail("id", "article id must be a non-empty string");
  }
  if (!Object.values(DIFFICULTIES).includes(article.difficulty)) {
    fail(
      "difficulty",
      `must be one of ${Object.values(DIFFICULTIES).join(", ")}, got ${_describe(article.difficulty)}`,
      article.missionId
    );
  }
  if (!_isPositiveStaminaCost(article.staminaCost)) {
    fail(
      "staminaCost",
      `must be a positive integer number of stamina POINTS in [1, ${MAX_STAMINA_COST_POINTS}] ` +
        `(unitless, see StakingManager.sol — NOT an 18-decimal CATT amount), got ${_describe(
          article.staminaCost
        )} — the layout serves this amount and it becomes the signed claim`,
      article.missionId
    );
  }
  if (!_isPositiveAmount(article.reward)) {
    fail(
      "reward",
      `must be a strictly positive integer amount in 18-decimal base units, got ${_describe(
        article.reward
      )}`,
      article.missionId
    );
  }
  if (missions !== null && !missions.some((mission) => mission && mission.id === article.missionId)) {
    fail(
      "missionId",
      `\`${_describe(article.missionId)}\` does not resolve to a seeded mission`,
      article.missionId
    );
  }
  if (!Array.isArray(article.paragraphs) || article.paragraphs.length === 0) {
    fail("paragraphs", "must be a non-empty array of prose", article.missionId);
  }
  for (const paragraph of article.paragraphs) {
    if (typeof paragraph !== "string" || paragraph.length === 0) {
      fail("paragraphs", "every paragraph must be a non-empty string", article.missionId);
    }
  }

  if (!Array.isArray(article.quiz) || article.quiz.length === 0) {
    fail("quiz", "must be a non-empty array of questions", article.missionId);
  }
  for (const question of article.quiz) {
    if (!question || typeof question !== "object") {
      fail("quiz", "every question must be an object", article.missionId);
    }
    if (typeof question.id !== "string" || question.id.length === 0) {
      fail("quiz", "every question needs a non-empty string id", article.missionId);
    }
    const options = question.options;
    if (!Array.isArray(options) || options.length === 0) {
      fail("quiz", `question \`${question.id}\` must have a non-empty \`options\` array`, article.missionId);
    }
    if (
      !Number.isInteger(question.correctIndex) ||
      question.correctIndex < 0 ||
      question.correctIndex >= options.length
    ) {
      fail(
        "quiz",
        `question \`${question.id}\` has correctIndex ${_describe(
          question.correctIndex
        )}, outside [0, ${options.length - 1}] — the question could never be answered correctly`,
        article.missionId
      );
    }
  }

  const task = article.highlightTask;
  if (!task || typeof task !== "object") {
    fail("highlightTask", "must be an object", article.missionId);
  }
  if (!Array.isArray(task.keySentences) || task.keySentences.length === 0) {
    fail("highlightTask", "`keySentences` must be a non-empty array", article.missionId);
  }
  for (const key of task.keySentences) {
    if (typeof key !== "string" || key.length === 0) {
      fail("highlightTask", "every key sentence must be a non-empty string", article.missionId);
    }
  }
  if (!Number.isInteger(task.minMatches) || task.minMatches < 1) {
    fail(
      "highlightTask",
      `\`minMatches\` must be an integer >= 1, got ${_describe(task.minMatches)}`,
      article.missionId
    );
  }
  if (task.minMatches > task.keySentences.length) {
    fail(
      "highlightTask",
      `\`minMatches\` ${task.minMatches} exceeds the ${task.keySentences.length} available key sentence(s) — every submission would fail HIGHLIGHT_MISSING forever`,
      article.missionId
    );
  }

  return article;
}

/**
 * Validates a whole content set: every mission, then every article, with each
 * set resolved against the other so the two projections cannot disagree.
 *
 * Fails FAST on the first violation (a poisoned file should produce one
 * precise error at boot, not a list the caller has to correlate).
 *
 * Pure: reads only, never mutates, never freezes and never clones.
 *
 * @param {Object} content
 * @param {ReadonlyArray<Object>} content.missions
 * @param {ReadonlyArray<Object>} content.articles
 * @returns {{ missions: ReadonlyArray<Object>, articles: ReadonlyArray<Object> }} The same references.
 * @throws {Error} `CONTENT_INVALID_MISSION` / `CONTENT_INVALID_ARTICLE`.
 */
function validateContent(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw _contentError(
      CONTENT_ERRORS.INVALID_MISSION,
      "content: validateContent({ missions, articles }) requires an object argument",
      { missionId: undefined, articleId: undefined, field: "content", value: undefined, reason: "argument must be an object" }
    );
  }
  const { missions, articles } = content;
  if (!Array.isArray(missions)) {
    throw _contentError(
      CONTENT_ERRORS.INVALID_MISSION,
      "content: `missions` must be an array",
      { missionId: undefined, articleId: undefined, field: "missions", value: undefined, reason: "must be an array" }
    );
  }
  if (!Array.isArray(articles)) {
    throw _contentError(
      CONTENT_ERRORS.INVALID_ARTICLE,
      "content: `articles` must be an array",
      { missionId: undefined, articleId: undefined, field: "articles", value: undefined, reason: "must be an array" }
    );
  }

  for (const mission of missions) {
    validateMission(mission, { articles });
  }
  for (const article of articles) {
    validateArticle(article, { missions });
  }

  return { missions, articles };
}

/* -------------------------------------------------------------------------- */
/* Stamina: the daily spend cap, the injectable policy, and the day key       */
/* -------------------------------------------------------------------------- */

/**
 * The per-user daily cap on stamina SPENT, in stamina POINTS.
 *
 * WHAT IT IS: a throttle on how much stamina one user may SPEND in one UTC day.
 * It is deliberately NOT an on-chain parameter and NOT a confiscation:
 *
 *   - IT DOES NOT CONFISCATE ANYTHING. Stamina lives on-chain in
 *     `StakingManager.stamina[account]`, and nothing in this backend can debit
 *     a balance the user is not spending through a claim. The cap is admission
 *     control in front of claims, not a clawback of a balance.
 *   - UNSPENT STAMINA ROLLS OVER. Whatever a user does not spend today is still
 *     theirs tomorrow, because the cap is re-derived from the per-DAY ledger
 *     (`storage.js`'s `recordStaminaConsumption`) and never from a lifetime
 *     total. There is no expiry to implement and no balance to burn.
 *   - THEREFORE IT THROTTLES EMISSION, IT DOES NOT DESTROY A BALANCE. The
 *     cheapest thing the cap can do is delay a claim by a day; the most it can
 *     do is slow the burn-down of the mining headroom. That distinction is the
 *     whole reason the mechanism is a per-day ledger rather than a mutable
 *     balance: a cap that destroyed unspent stamina would be confiscation, and
 *     this one is not.
 *
 * WHY 50, and why it is a NUMBER RATHER THAN A MODELLED SCHEDULE:
 *   - It is exactly `STAMINA_PER_STAKE = 50` in `StakingManager.sol`: one
 *     successful `stakeForStamina` buys one day of full-budget spending. The cap
 *     is therefore self-explanatory against the one on-chain stamina constant
 *     that exists, and needs no second invented constant to justify it.
 *   - The mixed-average stamina cost of the seeded board is
 *     `0.6 x 10 + 0.3 x 20 + 0.1 x 30 = 15` points, so `50 / 15 ~ 3.3` mixed
 *     missions per day. A user who clears two HARD missions a day spends 60 and
 *     is throttled on the third; a user doing three EASY missions spends 30 and
 *     is not throttled at all.
 *   - It is a THROTTLE CEILING, not a promise. Nothing here guarantees a user
 *     can spend 50 a day; it only bounds what they may.
 *
 * WHAT THIS IS NOT: it is not an emission schedule, a reward, a multiplier or a
 * season split. Those are economic parameters owned elsewhere, and none of them
 * is set by this constant.
 *
 * @type {number}
 */
const DEFAULT_DAILY_STAMINA_CAP = 50;

/**
 * The UTC calendar day an instant belongs to, as `YYYY-MM-DD`.
 *
 * WHY UTC AND NOT LOCAL TIME: the day key is a storage key. If it were computed
 * from the host's local timezone then the same instant would land in two
 * different buckets depending on which machine ran the Judge, the ledger would
 * fork across a redeploy, and a user could spend their cap twice by moving
 * between two timezones. `toISOString()` is UTC by definition, so `slice(0, 10)`
 * is the calendar day in one fixed frame for every process on earth.
 *
 * WHY THE CALLER SUPPLIES `now`: this module reads no clock. It is a pure module
 * — no I/O, no clock, no randomness, no environment — and an argument is the
 * whole mechanism by which time enters it. A `dayKeyFor()` with no argument
 * would put `Date.now()` back into a file whose header promises it is not there.
 *
 * @param {Date|number} now The instant, as a `Date` or epoch milliseconds.
 * @returns {string} `YYYY-MM-DD` in UTC.
 * @throws {TypeError} If `now` is not a `Date` or a finite epoch-milliseconds
 *   number.
 */
function dayKeyFor(now) {
  if (now === null || now === undefined) {
    throw new TypeError(
      "dayKeyFor(now): `now` is required — the clock is injected, never read from inside " +
        "this module."
    );
  }
  const instant = now instanceof Date ? now : new Date(Number(now));
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError(
      "dayKeyFor(now): `now` must be a Date or epoch milliseconds — the clock is injected, " +
        "never read from inside this module."
    );
  }
  return instant.toISOString().slice(0, 10);
}

/**
 * Coerces a stamina POINT quantity to a plain non-negative integer.
 *
 * Accepts a safe-integer `number` or a decimal digit string (both are what the
 * Judge produces), and rejects everything else: a negative value (the chain's
 * `uint256` ABI encoder would reject it), a fraction (points are indivisible),
 * `NaN`, `Infinity`, a boolean, `null`, `undefined`, an object.
 *
 * @param {*} value Candidate point quantity.
 * @param {string} label Field name, for the error message.
 * @returns {number} The integer value.
 * @throws {TypeError} If `value` is not a non-negative integer quantity.
 */
function _points(value, label) {
  let points = value;
  if (typeof points === "string" && /^\d+$/.test(points.trim())) {
    points = Number(points.trim());
  }
  if (typeof points !== "number" || !Number.isSafeInteger(points) || points < 0) {
    throw new TypeError(
      `${label} must be a non-negative integer number of stamina POINTS (unitless — see ` +
        `StakingManager.sol), got ${_describe(value)}.`
    );
  }
  return points;
}

/**
 * Builds the injectable stamina-spend policy.
 *
 * This is a HOOK, not a decision. `cap` is a parameter, `cap: null` disables the
 * throttle entirely, and no call site inside this module reads the cap: the
 * returned object is a pure function of what the caller already knows (the day's
 * consumed total and the amount about to be spent), so it can be exercised in a
 * test without a store, a clock or a chain.
 *
 * The policy NEVER holds state. It is `Object.freeze`d, it accumulates nothing,
 * and two calls with the same arguments always return the same answer — which is
 * what makes it safe to construct one per request and share it across users.
 *
 * @param {Object} [options]
 * @param {number|null} [options.cap] Daily cap in stamina points, or `null` to
 *   disable the throttle. Defaults to {@link DEFAULT_DAILY_STAMINA_CAP}.
 * @returns {Readonly<{
 *   cap: number|null,
 *   enabled: boolean,
 *   remaining: ({ consumed: number }) => number|null,
 *   admits: ({ consumed: number, amount: number }) => Readonly<Object>,
 * }>} A frozen policy object.
 * @throws {TypeError} If `cap` is neither `null` nor a non-negative integer.
 */
function createStaminaPolicy({ cap = DEFAULT_DAILY_STAMINA_CAP } = {}) {
  const resolved = cap === null || cap === undefined ? null : _points(cap, "cap");

  return Object.freeze({
    /** The daily cap in points, or `null` when the throttle is disabled. */
    cap: resolved,
    /** True when a cap is in force. */
    enabled: resolved !== null,

    /**
     * Points still spendable today.
     *
     * @param {{ consumed: number }} state The day's consumed total so far.
     * @returns {number|null} The remaining allowance (never negative), or `null`
     *   when the throttle is disabled and there is therefore no allowance to
     *   speak of.
     */
    remaining({ consumed }) {
      if (resolved === null) return null;
      const spent = _points(consumed, "consumed");
      return Math.max(0, resolved - spent);
    },

    /**
     * The single question a caller needs answered: may this claim go through?
     *
     * @param {{ consumed: number, amount: number }} state The day's consumed
     *   total and the points this claim would spend.
     * @returns {Readonly<{ allowed: boolean, cap: number|null, consumed: number,
     *   amount: number, remaining: number|null }>} The decision plus the numbers
     *   that produced it, so a rejection can be explained rather than guessed.
     */
    admits({ consumed, amount }) {
      const spent = _points(consumed, "consumed");
      const want = _points(amount, "amount");
      if (resolved === null) {
        return Object.freeze({ allowed: true, cap: null, consumed: spent, amount: want, remaining: null });
      }
      const left = Math.max(0, resolved - spent);
      return Object.freeze({
        allowed: want <= left,
        cap: resolved,
        consumed: spent,
        amount: want,
        remaining: left,
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Seeded PRNG (the reproducibility contract)                                  */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a, 32-bit. Turns an arbitrary session/article key string into a
 * 32-bit seed. Deterministic, dependency-free, and good enough to decorrelate
 * the session ids we actually see.
 *
 * @param {string} input
 * @returns {number} Unsigned 32-bit seed.
 */
function _fnv1a32(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG. It is seeded
 * explicitly, so its whole output sequence is a pure function of the seed.
 * This is what makes `getArticleLayout` reproducible across processes and
 * machines — the alternative (`Math.random`) is unreproducible by design.
 *
 * @param {number} seed Unsigned 32-bit seed.
 * @returns {() => number} Generator yielding floats in [0, 1).
 */
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle driven by a supplied PRNG. Walks backwards and swaps
 * each element with a uniformly chosen one at or before it, which is the
 * standard uniform permutation algorithm.
 *
 * @template T
 * @param {ReadonlyArray<T>} items
 * @param {() => number} rng Seeded generator.
 * @returns {Array<T>} A NEW shuffled array; `items` is not mutated.
 */
function _shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Resolves the PRNG for a (session, article) pair. The seed string is
 * `articleId::sessionId` so that the same session reading two different
 * articles gets two independent streams.
 *
 * @param {string} sessionId
 * @param {string} articleId
 * @returns {() => number}
 */
function _rngFor(sessionId, articleId) {
  return _mulberry32(_fnv1a32(`${articleId}::${sessionId}`));
}

/* -------------------------------------------------------------------------- */
/* Public accessors                                                            */
/* -------------------------------------------------------------------------- */

/** @type {ReadonlyArray<Object>} Frozen seed: the bounty board. */
const MISSIONS = _deepFreeze(_MISSIONS_SEED);

/** @type {ReadonlyArray<Object>} Frozen seed: the full articles. */
const ARTICLES = _deepFreeze(_ARTICLES_SEED);

/**
 * AUTHORING-TIME GUARD, RUN AT MODULE LOAD.
 *
 * The frozen seed is validated here, at the top level of the module, BEFORE
 * `module.exports` is reached. A mission that could livelock its own claims is
 * therefore not loadable, let alone signable: `require("content.js")` throws
 * and the Judge never boots.
 *
 * This throw is DELIBERATELY NOT CAUGHT. There is no try/catch anywhere around
 * this call and there must never be one: a poisoned content file must crash
 * the Judge at boot rather than silently serve a mission whose every claim
 * reverts on-chain with `ZeroAmount()`. The cost of a loud crash is an operator
 * fixing a constant; the cost of swallowing it is an indefinite, invisible
 * livelock on the bounty board.
 *
 * Validation is read-only, so running it against the frozen seed cannot mutate
 * or unfreeze anything, and it never touches the PRNG: `getArticleLayout` is
 * byte-identical to before this guard existed.
 */
validateContent({ missions: MISSIONS, articles: ARTICLES });

/**
 * Lists the bounty board. Returns a deep copy so the caller can filter/sort
 * the result freely without any possibility of mutating the seed.
 *
 * @returns {Array<{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: number }>}
 *   Fresh mission objects, in board order.
 */
function listMissions() {
  return MISSIONS.map((mission) => _deepClone(mission));
}

/**
 * Looks up a single mission (bounty-board projection).
 *
 * @param {string} missionId
 * @returns {{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: number }|undefined}
 *   A defensive copy, or `undefined` when the id is unknown.
 */
function getMission(missionId) {
  const found = MISSIONS.find((mission) => mission.id === missionId);
  return found ? _deepClone(found) : undefined;
}

/**
 * Looks up a single article.
 *
 * @param {string} articleId
 * @returns {Object|undefined} A defensive copy, or `undefined` when unknown.
 */
function getArticle(articleId) {
  const found = ARTICLES.find((article) => article.id === articleId);
  return found ? _deepClone(found) : undefined;
}

/**
 * Builds the randomized, per-session reading layout for an article.
 *
 * What is randomized: the paragraph ORDER and the position/type of the single
 * focus trap. What is NOT randomized: the quiz and the highlight task. The
 * quiz stays in its authored order on purpose — the answer key is graded per
 * question id, and reshuffling it would add no anti-cheat value while making
 * the answer order differ between the client render and any later replay of
 * the same session. The paragraphs are what an auto-scroller cheats on, so the
 * paragraphs are what get shuffled.
 *
 * Reproducibility contract: for a fixed (articleId, sessionId) this function
 * returns deep-equal results forever, in this process or any other.
 *
 * @param {string} articleId Article to randomize.
 * @param {string} sessionId Caller's session id; seeds the PRNG.
 * @returns {{
 *   id: string, missionId: string, title: string, difficulty: string,
 *   reward: string, staminaCost: number,
 *   paragraphs: Array<string>,
 *   focusTrap: { index: number, type: "swipe-to-continue"|"tap-the-image"|"hold-to-reveal" },
 *   quiz: Array<Object>,
 *   highlightTask: Object
 * }|null} The layout, or `null` for an unknown articleId.
 * @throws {TypeError} If `sessionId` is not a non-empty string.
 */
function getArticleLayout(articleId, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError(
      "getArticleLayout(articleId, sessionId): sessionId must be a non-empty string. " +
        "The session id seeds the deterministic PRNG that fixes this session's paragraph order " +
        "and focus-trap position; an empty or non-string id cannot seed it."
    );
  }

  const article = ARTICLES.find((candidate) => candidate.id === articleId);
  if (!article) {
    return null;
  }

  const rng = _rngFor(sessionId, article.id);
  const paragraphs = _shuffle(article.paragraphs, rng);

  // Exactly one trap, never before the first paragraph and never after the
  // last: a trap at index 0 fires before the reader has seen any text, and one
  // at the final index is unreachable in practice. Clamped to [1, len - 2].
  const minIndex = 1;
  const maxIndex = Math.max(minIndex, paragraphs.length - 2);
  const index = minIndex + Math.floor(rng() * (maxIndex - minIndex + 1));
  const type = FOCUS_TRAP_TYPES[Math.floor(rng() * FOCUS_TRAP_TYPES.length)];

  return {
    id: article.id,
    missionId: article.missionId,
    title: article.title,
    difficulty: article.difficulty,
    reward: article.reward,
    staminaCost: article.staminaCost,
    paragraphs,
    focusTrap: { index, type },
    // Authored order, deep-copied so the caller cannot edit the answer key.
    quiz: _deepClone(article.quiz),
    highlightTask: _deepClone(article.highlightTask),
  };
}

module.exports = {
  DIFFICULTIES,
  FOCUS_TRAP_TYPES,
  CONTENT_ERRORS,
  CONTENT_ERROR_NAME,
  MISSIONS,
  ARTICLES,
  listMissions,
  getMission,
  getArticle,
  getArticleLayout,
  // Stamina: the daily SPEND cap, the injectable policy hook, and the UTC day key.
  DEFAULT_DAILY_STAMINA_CAP,
  MAX_STAMINA_COST_POINTS,
  createStaminaPolicy,
  dayKeyFor,
  // Authoring-time validation (the livelock guard).
  validateContent,
  validateMission,
  validateArticle,
};
