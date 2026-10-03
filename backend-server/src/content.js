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
 * AMOUNTS: `reward` and `staminaCost` are decimal STRINGS of 18-decimal
 * CATT base units (1 CATT = 1e18), matching the on-chain uint256 types and
 * the `ClaimReward` struct in ../signer.js. Use `BigInt(x)` for arithmetic;
 * never rely on Number arithmetic (1e18 exceeds Number.MAX_SAFE_INTEGER).
 *
 * Pure module: no I/O, no clock, no randomness, no environment access.
 */

const DIFFICULTIES = Object.freeze({
  EASY: "EASY",
  MEDIUM: "MEDIUM",
  HARD: "HARD",
});

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
    staminaCost: "1000000000000000000", // 1 CATT
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
    staminaCost: "2000000000000000000", // 2 CATT
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
    staminaCost: "3000000000000000000", // 3 CATT
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
 * `reward` and `staminaCost` mirror the owning article exactly (the mission
 * is what the board displays, the article is what the reader gets), and the
 * difficulty ordering is the economy ordering — HARD/SPONSORED earns the most
 * and costs the most stamina.
 *
 * @type {ReadonlyArray<{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: string }>}
 */
const _MISSIONS_SEED = [
  {
    id: "mission-1",
    articleId: "art-focus-101",
    difficulty: DIFFICULTIES.EASY,
    reward: "12000000000000000000", // 12 CATT
    staminaCost: "1000000000000000000", // 1 CATT
  },
  {
    id: "mission-2",
    articleId: "art-focus-202",
    difficulty: DIFFICULTIES.MEDIUM,
    reward: "20000000000000000000", // 20 CATT
    staminaCost: "2000000000000000000", // 2 CATT
  },
  {
    id: "mission-3",
    articleId: "art-focus-303",
    difficulty: DIFFICULTIES.HARD,
    reward: "40000000000000000000", // 40 CATT
    staminaCost: "3000000000000000000", // 3 CATT
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
 * Lists the bounty board. Returns a deep copy so the caller can filter/sort
 * the result freely without any possibility of mutating the seed.
 *
 * @returns {Array<{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: string }>}
 *   Fresh mission objects, in board order.
 */
function listMissions() {
  return MISSIONS.map((mission) => _deepClone(mission));
}

/**
 * Looks up a single mission (bounty-board projection).
 *
 * @param {string} missionId
 * @returns {{ id: string, articleId: string, difficulty: string, reward: string, staminaCost: string }|undefined}
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
 *   reward: string, staminaCost: string,
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
  MISSIONS,
  ARTICLES,
  listMissions,
  getMission,
  getArticle,
  getArticleLayout,
};
