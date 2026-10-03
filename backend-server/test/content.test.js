/**
 * Unit tests for the CATT Content Randomizer (PRD 3.1 / 3.2).
 *
 * Runner: Node's built-in test runner, no dependencies.
 *   cd backend-server && node --test test/content.test.js
 *
 * The properties that actually matter for the Judge are asserted here:
 *   - reproducibility (same session => identical layout, 25x over),
 *   - variation (different sessions => different orders and trap positions),
 *   - trap placement (never first, never last),
 *   - seed integrity (the seed cannot be mutated through a returned layout).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MISSIONS,
  ARTICLES,
  FOCUS_TRAP_TYPES,
  listMissions,
  getMission,
  getArticle,
  getArticleLayout,
} = require("../src/content.js");

const SAMPLE_SESSIONS = [
  "session-abc",
  "session-0",
  "sess-1",
  "sess-2",
  "sess-3",
  "sess-4",
  "sess-5",
  "sess-6",
  "sess-7",
  "sess-8",
  "sess-9",
  "sess-10",
  "sess-11",
  "sess-12",
  "sess-13",
  "sess-14",
  "sess-15",
  "sess-16",
  "sess-17",
  "sess-18",
  "sess-19",
  "sess-20",
  "sess-21",
  "sess-22",
  "sess-23",
  "sess-24",
  "sess-25",
  "sess-26",
  "sess-27",
  "sess-28",
  "sess-29",
];

/* -------------------------------------------------------------------------- */
/* Seed integrity                                                              */
/* -------------------------------------------------------------------------- */

test("bounty board: three missions are listed in order with the projected fields", () => {
  const missions = listMissions();
  assert.equal(missions.length, 3);
  assert.equal(MISSIONS.length, 3);
  for (const mission of missions) {
    assert.deepEqual(
      Object.keys(mission).sort(),
      ["articleId", "difficulty", "id", "reward", "staminaCost"]
    );
    assert.equal(typeof mission.id, "string");
    assert.ok(["EASY", "MEDIUM", "HARD"].includes(mission.difficulty));
    assert.match(mission.reward, /^\d+$/);
    assert.match(mission.staminaCost, /^\d+$/);
  }
  assert.deepEqual(
    missions.map((m) => m.id),
    ["mission-1", "mission-2", "mission-3"]
  );
});

test("every mission maps to a real article, with matching difficulty/reward/stamina", () => {
  const missions = listMissions();
  const seenArticles = new Set();
  for (const mission of missions) {
    const article = getArticle(mission.articleId);
    assert.ok(article, `mission ${mission.id} points at missing article ${mission.articleId}`);
    assert.equal(article.id, mission.articleId);
    // The mission is the public projection of the article: the economy must
    // not be able to disagree with itself between board and reader.
    assert.equal(article.difficulty, mission.difficulty);
    assert.equal(article.reward, mission.reward);
    assert.equal(article.staminaCost, mission.staminaCost);
    assert.equal(article.missionId, mission.id);
    seenArticles.add(article.id);
  }
  assert.equal(seenArticles.size, missions.length, "one article per mission, no sharing");
});

test("the economy rewards difficulty: HARD/SPONSORED pays the most and costs the most stamina", () => {
  const missions = listMissions();
  for (let i = 1; i < missions.length; i += 1) {
    const previous = missions[i - 1];
    const current = missions[i];
    assert.ok(
      BigInt(current.reward) > BigInt(previous.reward),
      `${current.id} must pay more than ${previous.id}`
    );
    assert.ok(
      BigInt(current.staminaCost) > BigInt(previous.staminaCost),
      `${current.id} must cost more stamina than ${previous.id}`
    );
  }
  const hard = missions[missions.length - 1];
  assert.equal(hard.difficulty, "HARD");
});

test("articles are real seeded prose: >=4 paragraphs, >=3 questions, 4 options, valid correctIndex", () => {
  assert.equal(ARTICLES.length, 3);
  for (const article of ARTICLES) {
    assert.equal(typeof article.title, "string");
    assert.ok(article.title.length > 10, "titles are real, not placeholders");
    assert.ok(article.paragraphs.length >= 4, `${article.id}: >=4 paragraphs`);
    for (const paragraph of article.paragraphs) {
      assert.equal(typeof paragraph, "string");
      assert.ok(paragraph.length > 120, `${article.id}: prose, not a stub`);
    }
    assert.ok(article.quiz.length >= 3, `${article.id}: >=3 quiz questions`);
    for (const question of article.quiz) {
      assert.equal(typeof question.id, "string");
      assert.equal(typeof question.question, "string");
      assert.equal(question.options.length, 4, `${question.id}: exactly 4 options`);
      for (const option of question.options) {
        assert.equal(typeof option, "string");
        assert.ok(option.length > 0);
      }
      assert.ok(
        Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4,
        `${question.id}: correctIndex in range`
      );
    }
  }
});

test("highlightTask is well-formed: minMatches <= keySentences.length, keys appear verbatim", () => {
  for (const article of ARTICLES) {
    const task = article.highlightTask;
    assert.equal(typeof task.instructions, "string");
    assert.ok(task.keySentences.length >= 2);
    assert.ok(task.keySentences.length <= 3);
    assert.ok(
      task.minMatches <= task.keySentences.length,
      `${article.id}: minMatches cannot exceed the key count`
    );
    assert.ok(task.minMatches >= 1);
    for (const key of task.keySentences) {
      const present = article.paragraphs.some((paragraph) => paragraph.includes(key));
      assert.ok(present, `${article.id}: key sentence must be a verbatim substring of a paragraph`);
    }
  }
});

test("unknown ids resolve to undefined / null instead of throwing", () => {
  assert.equal(getMission("mission-does-not-exist"), undefined);
  assert.equal(getArticle("art-does-not-exist"), undefined);
  assert.equal(getArticleLayout("art-does-not-exist", "session-abc"), null);
});

test("accessors return defensive copies; the seed is deep-frozen", () => {
  const missions = listMissions();
  missions[0].reward = "1";
  missions.push({ id: "forged" });
  assert.notEqual(MISSIONS[0].reward, "1");
  assert.equal(MISSIONS.length, 3);

  const article = getArticle("art-focus-101");
  article.paragraphs[0] = "tampered";
  assert.notEqual(ARTICLES[0].paragraphs[0], "tampered");

  assert.ok(Object.isFrozen(MISSIONS));
  assert.ok(Object.isFrozen(ARTICLES));
  assert.ok(Object.isFrozen(ARTICLES[0]));
  assert.ok(Object.isFrozen(ARTICLES[0].paragraphs));
  assert.ok(Object.isFrozen(ARTICLES[0].quiz[0]));
});

/* -------------------------------------------------------------------------- */
/* Layout shape                                                               */
/* -------------------------------------------------------------------------- */

test("layout shape: metadata, shuffled paragraphs, one trap, authored quiz order", () => {
  const layout = getArticleLayout("art-focus-101", "session-abc");
  assert.equal(layout.id, "art-focus-101");
  assert.equal(layout.missionId, "mission-1");
  assert.equal(layout.difficulty, "EASY");
  assert.equal(layout.reward, "12000000000000000000");
  assert.equal(layout.staminaCost, "1000000000000000000");
  assert.equal(typeof layout.title, "string");
  assert.ok(Array.isArray(layout.paragraphs));
  assert.deepEqual(
    [...layout.paragraphs].sort(),
    [...ARTICLES[0].paragraphs].sort(),
    "the same paragraphs, reordered"
  );
  assert.ok(FOCUS_TRAP_TYPES.includes(layout.focusTrap.type));
  assert.ok(Number.isInteger(layout.focusTrap.index));

  // Quiz and highlight task keep their AUTHORED order on purpose: the answer
  // key is graded by question id, so reshuffling buys no anti-cheat value and
  // would make a session's rendering unreplayable.
  assert.deepEqual(
    layout.quiz.map((q) => q.id),
    ARTICLES[0].quiz.map((q) => q.id)
  );
  assert.deepEqual(layout.highlightTask.keySentences, ARTICLES[0].highlightTask.keySentences);
});

/* -------------------------------------------------------------------------- */
/* Determinism (the reproducibility contract)                                 */
/* -------------------------------------------------------------------------- */

test("determinism: 25 calls for the same session return deep-equal layouts", () => {
  for (const article of ARTICLES) {
    const first = getArticleLayout(article.id, "session-abc");
    for (let i = 0; i < 25; i += 1) {
      const again = getArticleLayout(article.id, "session-abc");
      assert.deepEqual(again, first, `${article.id}: call ${i} diverged`);
      assert.deepEqual(again.paragraphs, first.paragraphs, "paragraph order is stable");
      assert.equal(again.focusTrap.index, first.focusTrap.index, "trap index is stable");
      assert.equal(again.focusTrap.type, first.focusTrap.type, "trap type is stable");
    }
  }
});

test("determinism holds across articles for one session: independent streams", () => {
  const a = getArticleLayout("art-focus-101", "session-abc");
  const b = getArticleLayout("art-focus-202", "session-abc");
  assert.equal(a.id, "art-focus-101");
  assert.equal(b.id, "art-focus-202");
  // Sanity: a fresh article for the same session must still be reproducible.
  assert.deepEqual(getArticleLayout("art-focus-202", "session-abc"), b);
});

/* -------------------------------------------------------------------------- */
/* Variation across sessions                                                   */
/* -------------------------------------------------------------------------- */

test("variation: 30 distinct sessions yield many distinct paragraph orders", () => {
  const orders = new Set();
  const traps = new Set();
  for (const sessionId of SAMPLE_SESSIONS) {
    const layout = getArticleLayout("art-focus-101", sessionId);
    orders.add(layout.paragraphs.join(" "));
    traps.add(`${layout.focusTrap.index}:${layout.focusTrap.type}`);
  }
  // 5 paragraphs => 120 possible orders, so 30 sessions landing on >=8 distinct
  // orders is a wide, non-flaky margin (the expected count is ~22). The bar is
  // set low on purpose: the test must stay deterministic and cheap, not
  // statistically tight, while still failing if the shuffle collapses (e.g. if
  // someone replaced the seeded PRNG with a constant).
  assert.ok(
    orders.size >= 8,
    `expected >=8 distinct paragraph orders across 30 sessions, got ${orders.size}`
  );
  // Trap index must move around too, not be pinned to one position.
  assert.ok(
    new Set([...traps].map((t) => t.split(":")[0])).size >= 2,
    `expected at least 2 distinct trap indices, got ${traps.size} distinct index:type pairs`
  );
  assert.ok(traps.size >= 2, "trap index/type combinations must vary across sessions");
});

/* -------------------------------------------------------------------------- */
/* Trap placement                                                              */
/* -------------------------------------------------------------------------- */

test("trap placement: never index 0, never the final index, for every article and many sessions", () => {
  for (const article of ARTICLES) {
    for (const sessionId of SAMPLE_SESSIONS) {
      const layout = getArticleLayout(article.id, sessionId);
      const last = layout.paragraphs.length - 1;
      assert.ok(
        layout.focusTrap.index >= 1,
        `${article.id}/${sessionId}: trap at 0 fires before any text is read`
      );
      assert.ok(
        layout.focusTrap.index <= last - 1,
        `${article.id}/${sessionId}: trap at ${layout.focusTrap.index} is the last index (${last})`
      );
      assert.ok(FOCUS_TRAP_TYPES.includes(layout.focusTrap.type));
    }
  }
});

test("trap placement: the same index is reused across sessions (it is a random draw, not a constant)", () => {
  const indices = new Set(
    SAMPLE_SESSIONS.map((s) => getArticleLayout("art-focus-202", s).focusTrap.index)
  );
  assert.ok(indices.size >= 2, `expected >=2 distinct trap indices, got ${[...indices].join(",")}`);
});

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

test("getArticleLayout throws a TypeError for a non-string or empty sessionId", () => {
  for (const bad of [undefined, null, "", 0, 42, {}, [], true, Symbol("s")]) {
    assert.throws(
      () => getArticleLayout("art-focus-101", bad),
      TypeError,
      `sessionId ${String(bad)} must be rejected`
    );
  }
  // Whitespace is a valid non-empty string id: the engine hashes whatever it
  // is given rather than guessing at the caller's intent.
  assert.doesNotThrow(() => getArticleLayout("art-focus-101", " "));
});

test("getArticleLayout rejects the bad sessionId even for an unknown articleId", () => {
  assert.throws(() => getArticleLayout("nope", ""), TypeError);
  assert.throws(() => getArticleLayout("nope", null), TypeError);
});

/* -------------------------------------------------------------------------- */
/* Seed integrity through a returned layout                                    */
/* -------------------------------------------------------------------------- */

test("a caller cannot corrupt the seed through a returned layout", () => {
  const before = ARTICLES[0].paragraphs.slice();

  const layout = getArticleLayout("art-focus-101", "session-tamper");
  layout.paragraphs.sort();
  layout.paragraphs.push("injected paragraph");
  layout.paragraphs[0] = "overwritten";
  layout.quiz[0].options[0] = "overwritten option";
  layout.quiz[0].correctIndex = 3;
  layout.highlightTask.keySentences[0] = "forged key";
  layout.focusTrap.index = 99;
  layout.reward = "1";

  // A fresh fetch is still the pristine, authored content...
  const refetched = getArticleLayout("art-focus-101", "session-tamper");
  assert.equal(refetched.paragraphs.length, before.length);
  assert.deepEqual(
    [...refetched.paragraphs].sort(),
    [...before].sort(),
    "the layout is rebuilt from the untouched seed"
  );
  assert.deepEqual(
    getArticle("art-focus-101").paragraphs,
    before,
    "and the seed itself is unchanged"
  );
  // ...and the tampered session still gets its original trap position back.
  assert.ok(refetched.focusTrap.index >= 1 && refetched.focusTrap.index < before.length - 1);
  assert.notEqual(refetched.quiz[0].options[0], "overwritten option");
  assert.equal(refetched.reward, "12000000000000000000");
});
