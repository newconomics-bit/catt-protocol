/**
 * Unit tests for the AUTHORING-TIME CONTENT VALIDATION in ../src/content.js
 * (the livelock guard behind residual risk #4).
 *
 * Runner: Node's built-in test runner, no dependencies.
 *   cd backend-server && node --test test/content-validation.test.js
 *
 * Why this file exists separately from content.test.js: content.test.js
 * asserts the CONTENT itself (seed integrity, layout shape, determinism).
 * This file asserts the GUARD — the checks that make a livelocked mission
 * unloadable in the first place. It is kept apart so that "the seed is good"
 * and "bad content is rejected" are two separate, independently readable
 * claims.
 *
 * The bug being closed: a mission authored with `staminaCost == 0` is signed
 * into the `ClaimReward` struct and then reverts on-chain, because
 * `MiningClaimer.claimReward` calls `StakingManager.consumeStamina` and that
 * is the only check that fires: `if (amount == 0) revert ZeroAmount();`.
 * The result is a 100%-reverting mission listed on a live bounty board, with
 * no error anywhere a user or an operator would ever see it. The signed
 * `staminaCost` is not attacker-influenced today, so this is defence in depth:
 * the guard belongs at AUTHORING time, where the mistake is still fixable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  MISSIONS,
  ARTICLES,
  DIFFICULTIES,
  CONTENT_ERRORS,
  CONTENT_ERROR_NAME,
  listMissions,
  getArticle,
  getArticleLayout,
  validateContent,
  validateMission,
  validateArticle,
  MAX_STAMINA_COST_POINTS,
} = require("../src/content.js");

/**
 * The three REAL seeded stamina costs, quoted verbatim from the seed: 10, 20 and
 * 30 UNITLESS STAMINA POINTS (see StakingManager.sol — stamina "is unitless and
 * has no monetary value"), NOT 18-decimal CATT base units. They are plain JS
 * integers because the reachable range is single-digit, so `Number.isSafeInteger`
 * is lossless for them.
 */
const REAL_STAMINA_COSTS = [
  ["mission-1", 10],
  ["mission-2", 20],
  ["mission-3", 30],
];

/**
 * A deep clone of the whole seed, for mutation in tests. Uses the PUBLIC
 * accessors (`listMissions` / `getArticle`) so the clone is built the same way
 * any caller would build it — the real frozen seed is never touched.
 *
 * @returns {{ missions: Array<Object>, articles: Array<Object> }}
 */
function cloneSeed() {
  return {
    missions: listMissions(),
    articles: ARTICLES.map((article) => getArticle(article.id)),
  };
}

/** Asserts a throw from a validator and returns the error for further checks. */
function expectRejection(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, CONTENT_ERROR_NAME, "every rejection is an InvalidMissionContent");
    assert.ok(
      err instanceof Error,
      "the codebase idiom is a plain Error carrying .code, not an Error subclass"
    );
    assert.ok(
      Object.values(CONTENT_ERRORS).includes(err.code),
      `unexpected .code ${err.code}`
    );
    assert.equal(typeof err.missionId !== "undefined" ? typeof err.missionId : "string", "string");
    assert.equal(typeof err.field, "string");
    assert.equal(typeof err.reason, "string");
    return err;
  }
  throw new assert.AssertionError({ message: "expected the validator to throw, but it returned" });
}

/** A mission that is valid in every respect, used as the base for bad-field variants. */
function validMission(overrides) {
  return {
    id: "mission-synthetic",
    articleId: "art-focus-101",
    difficulty: DIFFICULTIES.EASY,
    reward: "5000000000000000000",
    // Stamina is unitless POINTS, not a CATT amount: see StakingManager.sol.
    staminaCost: 25,
    ...overrides,
  };
}

/** An article that is valid in every respect, used as the base for bad-field variants. */
function validArticle(overrides) {
  const base = getArticle("art-focus-101");
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* 1. The shipped seed validates                                                */
/* -------------------------------------------------------------------------- */

test("the shipped seed validates: validateContent throws nothing for the real MISSIONS/ARTICLES", () => {
  const result = validateContent({ missions: MISSIONS, articles: ARTICLES });
  assert.equal(result.missions, MISSIONS, "validation is pure: it returns the same references");
  assert.equal(result.articles, ARTICLES);
  assert.equal(validateMission(MISSIONS[0], { articles: ARTICLES }), MISSIONS[0]);
  assert.equal(validateArticle(ARTICLES[0], { missions: MISSIONS }), ARTICLES[0]);
});

test("all three real missions have a strictly positive staminaCost (the values quoted below are the seed's)", () => {
  const missions = listMissions();
  assert.equal(missions.length, 3);
  assert.deepEqual(
    missions.map((m) => [m.id, m.staminaCost]),
    REAL_STAMINA_COSTS,
    "the seed's stamina costs, verbatim"
  );
  for (const [id, staminaCost] of REAL_STAMINA_COSTS) {
    assert.ok(BigInt(staminaCost) > 0n, `${id}: ${staminaCost} must be strictly positive`);
    assert.notEqual(staminaCost, "0");
    assert.ok(Number.isSafeInteger(staminaCost), `${id}: ${staminaCost} must be a plain safe integer`);
    assert.ok(
      staminaCost <= MAX_STAMINA_COST_POINTS,
      `${id}: ${staminaCost} points must be within the authoring ceiling — a value in the 1e18 ` +
        "range is a CATT amount wearing a stamina label, and that mission could never settle"
    );
    assert.doesNotThrow(() =>
      validateMission(
        missions.find((m) => m.id === id),
        { articles: ARTICLES }
      )
    );
  }
});

test("validation of the real seed does not mutate or unfreeze it", () => {
  const before = JSON.stringify({ MISSIONS, ARTICLES });
  validateContent({ missions: MISSIONS, articles: ARTICLES });
  validateContent(cloneSeed());
  assert.equal(JSON.stringify({ MISSIONS, ARTICLES }), before, "seed unchanged by validation");
  assert.ok(Object.isFrozen(MISSIONS));
  assert.ok(Object.isFrozen(MISSIONS[0]));
  assert.ok(Object.isFrozen(ARTICLES[0].quiz[0]));
});

/* -------------------------------------------------------------------------- */
/* 2. The REQUIRED guard: staminaCost must be strictly positive                 */
/* -------------------------------------------------------------------------- */

test("REQUIRED: staminaCost \"0\" — the string zero the content file would actually use — is rejected", () => {
  const mission = validMission({ staminaCost: "0" });
  const err = expectRejection(() => validateMission(mission, { articles: ARTICLES }));
  assert.equal(err.code, CONTENT_ERRORS.INVALID_MISSION);
  assert.equal(err.missionId, "mission-synthetic", "the error identifies the offending mission");
  assert.equal(err.field, "staminaCost");
  assert.equal(err.value, "0");
  assert.match(err.message, /mission-synthetic/);
  assert.match(err.message, /staminaCost/);
  assert.match(err.message, /ZeroAmount/, "the message names the on-chain failure it prevents");
});

test("REQUIRED: numeric zero and negative stamina costs are rejected", () => {
  for (const bad of [0, -1, -1000000000000000000]) {
    const err = expectRejection(() =>
      validateMission(validMission({ staminaCost: bad }), { articles: ARTICLES })
    );
    assert.equal(err.field, "staminaCost");
    assert.equal(err.missionId, "mission-synthetic");
  }
  for (const bad of ["-1", "-1000000000000000000"]) {
    const err = expectRejection(() =>
      validateMission(validMission({ staminaCost: bad }), { articles: ARTICLES })
    );
    assert.equal(err.field, "staminaCost");
    assert.equal(err.value, bad);
  }
});

test("REQUIRED: non-integer, non-numeric, missing and NaN stamina costs are rejected", () => {
  const bad = [
    "1.5",
    "abc",
    "",
    " ",
    " 0",
    "0x1",
    "1e18",
    "+1",
    "1,000",
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1.5,
    true,
    {},
    [],
    1e21,
  ];
  for (const value of bad) {
    const err = expectRejection(() =>
      validateMission(validMission({ staminaCost: value }), { articles: ARTICLES })
    );
    assert.equal(err.field, "staminaCost", `staminaCost ${String(value)} must be rejected`);
  }
});

test("REQUIRED: a missing staminaCost field is rejected (undefined never means zero-cost)", () => {
  const mission = validMission();
  delete mission.staminaCost;
  const err = expectRejection(() => validateMission(mission, { articles: ARTICLES }));
  assert.equal(err.field, "staminaCost");
  assert.equal(err.missionId, "mission-synthetic");
});

/* -------------------------------------------------------------------------- */
/* 3. Extra hardening — same footgun class (silent, permanent failure)          */
/* -------------------------------------------------------------------------- */

test("EXTRA: a zero or negative reward is rejected (it would sign claims that pay nothing)", () => {
  for (const bad of ["0", 0, -1, "-1"]) {
    const err = expectRejection(() =>
      validateMission(validMission({ reward: bad }), { articles: ARTICLES })
    );
    assert.equal(err.field, "reward");
    assert.equal(err.missionId, "mission-synthetic");
  }
  expectRejection(() => validateMission(validMission({ reward: null }), { articles: ARTICLES }));
  expectRejection(() => validateMission(validMission({ reward: "1.5" }), { articles: ARTICLES }));
});

test("EXTRA: a difficulty outside the known set is rejected", () => {
  for (const bad of ["SPONSORED", "easy", "", null, 1, undefined]) {
    const err = expectRejection(() =>
      validateMission(validMission({ difficulty: bad }), { articles: ARTICLES })
    );
    assert.equal(err.field, "difficulty");
    assert.equal(err.missionId, "mission-synthetic");
  }
  for (const good of Object.values(DIFFICULTIES)) {
    assert.doesNotThrow(() =>
      validateMission(validMission({ difficulty: good }), { articles: ARTICLES })
    );
  }
});

test("EXTRA: an articleId that resolves to no seeded article is rejected", () => {
  for (const bad of ["art-does-not-exist", "", null, undefined, 7]) {
    const err = expectRejection(() =>
      validateMission(validMission({ articleId: bad }), { articles: ARTICLES })
    );
    assert.equal(err.field, "articleId");
    assert.equal(err.missionId, "mission-synthetic");
  }
  assert.match(
    expectRejection(() =>
      validateMission(validMission({ articleId: "art-does-not-exist" }), { articles: ARTICLES })
    ).reason,
    /does not resolve/
  );
});

test("EXTRA: a missing or non-object mission id is rejected", () => {
  for (const bad of [undefined, null, "", 42]) {
    const err = expectRejection(() => validateMission(validMission({ id: bad }), { articles: ARTICLES }));
    assert.equal(err.field, "id");
  }
  expectRejection(() => validateMission(null));
  expectRejection(() => validateMission("mission-1"));
  expectRejection(() => validateMission([]));
});

test("EXTRA: an out-of-range quiz correctIndex is rejected (the question could never be answered)", () => {
  const article = validArticle({
    quiz: [{ id: "q1", question: "?", options: ["a", "b", "c", "d"], correctIndex: 4 }],
  });
  const err = expectRejection(() => validateArticle(article, { missions: MISSIONS }));
  assert.equal(err.code, CONTENT_ERRORS.INVALID_ARTICLE);
  assert.equal(err.articleId, "art-focus-101");
  assert.equal(err.field, "quiz");
  assert.match(err.message, /correctIndex/);

  for (const bad of [-1, 4, 1.5, "1", null, undefined, NaN]) {
    expectRejection(() =>
      validateArticle(validArticle({ quiz: [{ id: "q1", question: "?", options: ["a", "b"], correctIndex: bad }] }), {
        missions: MISSIONS,
      })
    );
  }
});

test("EXTRA: minMatches greater than keySentences.length is rejected (HIGHLIGHT_MISSING forever)", () => {
  const article = validArticle({
    highlightTask: {
      instructions: "highlight things",
      keySentences: ["one", "two"],
      minMatches: 3,
    },
  });
  const err = expectRejection(() => validateArticle(article, { missions: MISSIONS }));
  assert.equal(err.field, "highlightTask");
  assert.match(err.message, /minMatches/);

  for (const bad of [0, -1, 1.5, "2", null, undefined, NaN]) {
    expectRejection(() =>
      validateArticle(
        validArticle({ highlightTask: { instructions: "x", keySentences: ["one", "two"], minMatches: bad } }),
        { missions: MISSIONS }
      )
    );
  }
  expectRejection(() =>
    validateArticle(
      validArticle({ highlightTask: { instructions: "x", keySentences: [], minMatches: 1 } }),
      { missions: MISSIONS }
    )
  );
});

test("EXTRA: an article with no quiz or no paragraphs is rejected", () => {
  for (const quiz of [[], null, undefined, "quiz", [{ id: "q1", question: "?", options: [], correctIndex: 0 }]]) {
    expectRejection(() => validateArticle(validArticle({ quiz }), { missions: MISSIONS }));
  }
  for (const paragraphs of [[], null, undefined, "", [""]]) {
    expectRejection(() => validateArticle(validArticle({ paragraphs }), { missions: MISSIONS }));
  }
});

test("EXTRA: an article whose reward or staminaCost is zero is rejected too (the layout serves them)", () => {
  for (const bad of ["0", 0, -5]) {
    const err = expectRejection(() =>
      validateArticle(validArticle({ staminaCost: bad }), { missions: MISSIONS })
    );
    assert.equal(err.field, "staminaCost");
  }
  expectRejection(() => validateArticle(validArticle({ reward: "0" }), { missions: MISSIONS }));
});

test("EXTRA: an article pointing at a mission that does not exist is rejected", () => {
  const err = expectRejection(() =>
    validateArticle(validArticle({ missionId: "mission-does-not-exist" }), { missions: MISSIONS })
  );
  assert.equal(err.field, "missionId");
});

test("EXTRA: validateContent rejects a malformed argument shape", () => {
  expectRejection(() => validateContent(null));
  expectRejection(() => validateContent([]));
  expectRejection(() => validateContent({ missions: MISSIONS }));
  expectRejection(() => validateContent({ articles: ARTICLES }));
});

test("the error message names the mission id and the bad field, and nothing else leaks", () => {
  const err = expectRejection(() =>
    validateMission(validMission({ staminaCost: "0" }), { articles: ARTICLES })
  );
  assert.equal(err.message, `content: mission \`mission-synthetic\` is invalid — field \`staminaCost\`: ${err.reason}`);
  assert.ok(!("cause" in err), "no cause chain: there is no underlying exception to hide");
});

/* -------------------------------------------------------------------------- */
/* 4. The guard is not simply "reject everything"                              */
/* -------------------------------------------------------------------------- */

test("a VALID synthetic mission mirroring the real shape is ACCEPTED", () => {
  const mission = validMission();
  assert.doesNotThrow(() => validateMission(mission, { articles: ARTICLES }));
  assert.equal(validateMission(mission, { articles: ARTICLES }), mission, "pure: same reference back");
  assert.doesNotThrow(() => validateMission(mission), "article resolution is optional");
  // Amounts expressed the other legitimate ways are accepted too: bigint and
  // safe integer numbers, because the JSDoc allows string | number | bigint.
  assert.doesNotThrow(() =>
    validateMission(validMission({ staminaCost: 1000, reward: 2000 }), { articles: ARTICLES })
  );
  assert.doesNotThrow(() =>
    validateMission(validMission({ staminaCost: 1000n, reward: 2000n }), { articles: ARTICLES })
  );
  assert.doesNotThrow(() =>
    validateMission(validMission({ staminaCost: "1", reward: "1" }), { articles: ARTICLES })
  );
});

test("a whole VALID synthetic content set is ACCEPTED (guard is not vacuous)", () => {
  const { missions, articles } = cloneSeed();
  assert.doesNotThrow(() => validateContent({ missions, articles }));

  // A fourth, fully consistent mission/article pair (the shape a real content
  // author would add) must validate.
  missions.push({
    id: "mission-4",
    articleId: "art-focus-404",
    difficulty: DIFFICULTIES.MEDIUM,
    reward: "7000000000000000000",
    // Stamina is unitless POINTS: 40, not 4 CATT.
    staminaCost: 40,
  });
  const template = getArticle("art-focus-202");
  articles.push({ ...template, id: "art-focus-404", missionId: "mission-4" });
  assert.doesNotThrow(() => validateContent({ missions, articles }));

  // ...and the same pair with a zero stamina cost is not.
  articles[3].staminaCost = "0";
  const err = expectRejection(() => validateContent({ missions, articles }));
  assert.equal(err.field, "staminaCost");
  assert.equal(err.articleId, "art-focus-404");
  assert.equal(err.missionId, "mission-4");
});

/* -------------------------------------------------------------------------- */
/* 5. PROOF: a zero-cost mission cannot even be LOADED                          */
/* -------------------------------------------------------------------------- */

test("PROOF: require()-ing content.js with a zero-cost mission THROWS at module load", () => {
  // Build a poisoned COPY of the module in a temp directory — the real file is
  // never modified — and require it. The throw must come from the top level of
  // the module, before module.exports is assigned: the mission cannot be loaded,
  // so it can never be listed, served, graded or signed.
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");
  const missionBlock = [
    '    articleId: "art-focus-101",',
    "    difficulty: DIFFICULTIES.EASY,",
    '    reward: "12000000000000000000", // 12 CATT',
    '    staminaCost: 10, // 10 stamina POINTS (unitless), NOT 10 wei — see StakingManager.sol',
  ].join("\n");
  assert.ok(source.includes(missionBlock), "the seeded mission-1 block is where the poison goes");
  const poisoned = source.replace(
    missionBlock,
    missionBlock.replace("staminaCost: 10,", 'staminaCost: "0",')
  );
  assert.notEqual(poisoned, source);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "catt-content-"));
  const tmpFile = path.join(tmpDir, "poisoned-content.js");
  try {
    fs.writeFileSync(tmpFile, poisoned, "utf8");
    const err = expectRejection(() => require(tmpFile));
    assert.equal(err.code, CONTENT_ERRORS.INVALID_MISSION);
    assert.equal(err.missionId, "mission-1", "the poisoned mission is named");
    assert.equal(err.field, "staminaCost");
    assert.equal(err.value, "0");
    assert.match(err.message, /mission-1/);
    assert.match(err.message, /staminaCost/);
    // Nothing was exported: there is no partially-valid content module.
    assert.equal(require.cache[require.resolve(tmpFile)], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // The real module is untouched and still loadable.
  const real = require("../src/content.js");
  assert.equal(real.listMissions().length, 3);
  assert.equal(real.listMissions()[0].staminaCost, 10);
});

test("PROOF: mutating a deep CLONE of the seed to zero throws, and the real seed survives", () => {
  const { missions, articles } = cloneSeed();
  assert.notEqual(missions[0], MISSIONS[0], "the clone shares no reference with the seed");

  missions[0].staminaCost = "0";
  const err = expectRejection(() => validateContent({ missions, articles }));
  assert.equal(err.missionId, "mission-1");
  assert.equal(err.field, "staminaCost");

  // The real frozen seed is exactly as it was, still servable.
  assert.equal(MISSIONS[0].staminaCost, 10);
  assert.deepEqual(
    listMissions().map((m) => [m.id, m.staminaCost]),
    REAL_STAMINA_COSTS
  );
  assert.doesNotThrow(() => validateContent({ missions: MISSIONS, articles: ARTICLES }));
});

test("PROOF: a zero-cost mission cannot be served by the accessors, because validation gates the module", () => {
  // The guard is a MODULE-LOAD gate, so the invariant is simply: whatever the
  // public accessors return has a positive stamina cost, always.
  for (const mission of listMissions()) {
    assert.ok(BigInt(mission.staminaCost) > 0n, `${mission.id} is servable`);
    assert.notEqual(mission.staminaCost, "0");
  }
  for (const article of ARTICLES) {
    assert.ok(BigInt(article.staminaCost) > 0n, `${article.id} is servable`);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. Nothing else moved: deep-freeze, defensive copies, layout determinism     */
/* -------------------------------------------------------------------------- */

test("deep-freeze and defensive copies still hold after the guard was added", () => {
  assert.ok(Object.isFrozen(MISSIONS));
  assert.ok(Object.isFrozen(ARTICLES));
  assert.ok(Object.isFrozen(MISSIONS[0]));
  assert.ok(Object.isFrozen(ARTICLES[0].paragraphs));
  assert.ok(Object.isFrozen(ARTICLES[0].quiz[0].options));

  const missions = listMissions();
  missions[0].reward = "1";
  missions.push({ id: "forged" });
  assert.equal(MISSIONS[0].reward, "12000000000000000000");
  assert.equal(MISSIONS.length, 3);

  const article = getArticle("art-focus-101");
  article.paragraphs[0] = "tampered";
  assert.notEqual(ARTICLES[0].paragraphs[0], "tampered");

  assert.equal(getMissionLike("mission-1").staminaCost, 10);
});

test("getArticleLayout determinism PARITY: the layout is still the documented FNV-1a -> mulberry32 -> Fisher-Yates output", () => {
  // An independent re-implementation of the documented algorithm, written from
  // this file's own spec rather than imported from it. If the guard had perturbed
  // the PRNG (e.g. consumed a draw, or reordered the shuffle) this would break.
  const fnv1a = (input) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  };
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const reference = (article, sessionId) => {
    const rng = mulberry32(fnv1a(`${article.id}::${sessionId}`));
    const paragraphs = article.paragraphs.slice();
    for (let i = paragraphs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [paragraphs[i], paragraphs[j]] = [paragraphs[j], paragraphs[i]];
    }
    const maxIndex = Math.max(1, paragraphs.length - 2);
    const index = 1 + Math.floor(rng() * (maxIndex - 1 + 1));
    const type = ["swipe-to-continue", "tap-the-image", "hold-to-reveal"][
      Math.floor(rng() * 3)
    ];
    return { paragraphs, focusTrap: { index, type } };
  };

  for (const article of ARTICLES) {
    for (const sessionId of ["session-abc", "session-0", "sess-29", "parity-check"]) {
      const expected = reference(article, sessionId);
      const actual = getArticleLayout(article.id, sessionId);
      assert.deepEqual(actual.paragraphs, expected.paragraphs, `${article.id}/${sessionId}: order`);
      assert.deepEqual(actual.focusTrap, expected.focusTrap, `${article.id}/${sessionId}: trap`);
      assert.deepEqual(actual, getArticleLayout(article.id, sessionId), "stable across calls");
    }
  }
});

test("getArticleLayout determinism PARITY: concrete golden fingerprint for one fixed session", () => {
  // The exact layout that content.test.js has always asserted for
  // (art-focus-101, session-abc): paragraphs in seed order [2, 0, 4, 3, 1] and
  // a single trap at index 2 of type "hold-to-reveal". The PRNG output is
  // unchanged by the wave-9 stamina unit fix and by the guard, because neither
  // consumes a draw — the ONLY thing that moved this fingerprint is
  // `staminaCost`, which went from the 18-decimal string "1000000000000000000"
  // to the unitless integer 10.
  const layout = getArticleLayout("art-focus-101", "session-abc");
  assert.deepEqual(
    layout.paragraphs.map((p) => ARTICLES[0].paragraphs.indexOf(p)),
    [2, 0, 4, 3, 1]
  );
  assert.equal(layout.focusTrap.index, 2);
  assert.equal(layout.focusTrap.type, "hold-to-reveal");
  assert.equal(layout.staminaCost, 10);
  assert.equal(layout.reward, "12000000000000000000");
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(layout)).digest("hex"),
    "5b54fb57a0669f96a7ebfc97a2e358d35580198c86e73aaf26aba8857c0fb69b",
    "the whole layout, byte for byte"
  );
  // Same session, 25 more calls: identical.
  const first = JSON.stringify(layout);
  for (let i = 0; i < 25; i += 1) {
    assert.equal(JSON.stringify(getArticleLayout("art-focus-101", "session-abc")), first);
  }
  // A different session still differs.
  assert.notEqual(
    JSON.stringify(getArticleLayout("art-focus-101", "session-xyz")),
    first
  );
});

/** Local helper: the public single-mission accessor, kept out of the way above. */
function getMissionLike(id) {
  const found = listMissions().find((mission) => mission.id === id);
  return found;
}