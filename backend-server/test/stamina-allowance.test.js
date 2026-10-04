/**
 * CATT Protocol — the DAILY FREE-STAMINA ALLOWANCE (30 stamina POINTS per day).
 *
 * WHAT THIS FILE IS PROVING, in order of how much it matters:
 *
 *   1. ONCE PER DAY, NOT STACKABLE, AND A NEW DAY RESTORES IT. The first call of
 *      a day grants 30 points; a second call the same day grants 0 and WRITES
 *      NOTHING (asserted on the store's own row, not just on the return value);
 *      a new `dayKey` grants the full 30 again; and day A's grant is invisible
 *      from day B. A partial prior grant yields only the REMAINDER, so the day's
 *      total can never pass 30 no matter how many calls arrive.
 *
 *   2. THE UNIT IS POINTS AND ONLY POINTS. Every figure is the integer 30 as a
 *      canonical decimal string. Nothing in the source carries an 18-decimal
 *      scale factor, and the tests assert the ABSENCE of one — a scaled
 *      "30 free stamina" is the same unit conflation that once made every claim
 *      unsettleable (`test/growth-store.test.js`, section 1).
 *
 *   3. IT CANNOT MINT, PAY, CONSUME OR SETTLE, AND IT CANNOT BYPASS THE CHAIN.
 *      Asserted on the export names AND on the source: no `ethers`, no
 *      `process.env`, no network, no provider, no key. A user holding a full
 *      30-point grant still cannot settle a claim unless
 *      `StakingManager.consumeStamina(user, staminaCost)` succeeds on-chain,
 *      and because this ledger is off-chain it is honestly NOT independently
 *      enforced on-chain.
 *
 * BOTH ADAPTERS: every behavioural assertion runs against `createMemoryStore()`
 * AND `createSqliteStore()` on an `os.tmpdir()` mkdtemp database removed in
 * `after`, so no `.db`, `-wal` or `-shm` is ever left in the tree.
 *
 * `node:test` + `node:assert/strict` only: no test framework dependency.
 */

"use strict";

const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const allowance = require("../src/stamina-allowance");
const {
  FREE_STAMINA_PER_DAY,
  DAILY_SPEND_CAP_POINTS,
  STAMINA_ALLOWANCE_ERRORS,
  STAMINA_ALLOWANCE_ERROR_NAME,
  freeStaminaAllowance,
  freeStaminaRemaining,
  grantFreeStamina,
} = allowance;
const { createSqliteStore } = require("../src/sqlite-store");
const { createMemoryStore } = require("../src/storage");
const { DEFAULT_DAILY_STAMINA_CAP, dayKeyFor } = require("../src/content");

const USER_A = "0x1111111111111111111111111111111111111111";
const USER_B = "0x2222222222222222222222222222222222222222";
const MIXED_CASE = "0xaBcDeF0123456789aBcDeF0123456789AbCdEf01";

/** Well beyond 2^53 (9007199254740992), so a lossy counter would be visible. */
const HUGE = "9007199254740993";

const DAY_1 = Date.UTC(2026, 0, 2, 9, 30, 0); // 2026-01-02
const DAY_1_LATER = Date.UTC(2026, 0, 2, 23, 59, 59);
const DAY_2 = Date.UTC(2026, 0, 3, 0, 0, 1);
const DAY_10 = Date.UTC(2026, 0, 11, 12, 0, 0);
const LEAP_DAY = Date.UTC(2028, 1, 29, 6, 0, 0);
const DAY_AFTER_LEAP_DAY = Date.UTC(2028, 2, 1, 6, 0, 0);

/** Every temp directory this file created, removed in `after`. */
const tempDirs = [];

/**
 * A throwaway directory under the OS temp dir and a database path inside it.
 * NEVER inside the repository.
 *
 * @param {string} [label] Recognisable suffix.
 * @returns {string} An absolute path to a not-yet-created `.db` file.
 */
function tempDbPath(label = "stamina") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catt-stamina-${label}-`));
  tempDirs.push(dir);
  return path.join(dir, "judge.db");
}

/** Removes every temp directory, so no `.db`, `-wal` or `-shm` is ever left behind. */
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `body` against a memory store and a fresh SQLite store, in that order.
 *
 * @param {string} label Temp-directory label.
 * @param {(store: Object) => Promise<void>} body The assertions.
 * @returns {Promise<void>}
 */
async function bothAdapters(label, body) {
  const memory = createMemoryStore();
  await memory.init();
  await body(memory);
  const sqlite = createSqliteStore({ filename: tempDbPath(label) });
  await sqlite.init();
  try {
    await body(sqlite);
  } finally {
    await sqlite.close();
  }
}

/* ========================================================================== */
/* 1. The allowance itself                                                     */
/* ========================================================================== */

test("allowance: 30 stamina POINTS per day, and the 50-point daily spend cap is carried alongside", () => {
  assert.equal(FREE_STAMINA_PER_DAY, 30n);
  assert.equal(typeof FREE_STAMINA_PER_DAY, "bigint", "the allowance is an exact integer, not a float");
  assert.equal(DAILY_SPEND_CAP_POINTS, 50);
  assert.equal(DAILY_SPEND_CAP_POINTS, DEFAULT_DAILY_STAMINA_CAP, "it is content.js's cap, not a second one");

  // THE UNIT. Points, whole, unscaled: 30 is 30 and nothing is 30 of anything.
  assert.equal(FREE_STAMINA_PER_DAY.toString(), "30");
  assert.equal(String(FREE_STAMINA_PER_DAY).length, 2);
  assert.ok(!FREE_STAMINA_PER_DAY.toString().includes("e"), "no exponent form, so no scale factor in play");
});

test("allowance: the reported discrepancy — 30 points funds three easy missions, not one", () => {
  const EASY = 10n;
  const MEDIUM = 20n;
  const HARD = 30n;
  // What 30 points actually buys at the shipped costs of 10 / 20 / 30.
  assert.equal(EASY * 3n, FREE_STAMINA_PER_DAY, "three easy missions");
  assert.equal(MEDIUM + EASY, FREE_STAMINA_PER_DAY, "one medium plus one easy");
  assert.equal(HARD, FREE_STAMINA_PER_DAY, "or exactly one hard mission");
  // The founder described "one easy mission", i.e. 10 points: a third of what
  // is implemented. REPORTED, not reconciled — the instruction was 30.
  assert.equal(EASY * 3n, 30n);
  assert.notEqual(EASY, FREE_STAMINA_PER_DAY);
  // And the day's SPEND cap is still 50, so the free grant is access, not a
  // ceiling raise: 30 free + 50 staked can never spend more than 50 in a day.
  assert.ok(DAILY_SPEND_CAP_POINTS >= Number(FREE_STAMINA_PER_DAY), "the grant is inside the spend cap");
  assert.equal(DAILY_SPEND_CAP_POINTS, 50);
});

/* ========================================================================== */
/* 2. Once per day, not stackable                                              */
/* ========================================================================== */

test("grant: the first call of a day grants 30; a second call the same day grants 0 and writes nothing", async () => {
  await bothAdapters("once-per-day", async (store) => {
    const first = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
    assert.equal(first.granted, "30");
    assert.equal(first.dayTotal, "30");
    assert.equal(first.remaining, "0");
    assert.equal(first.exhausted, true);
    assert.equal(first.wrote, true);
    assert.equal(first.dayKey, "2026-01-02");
    assert.equal(first.userAddress, USER_A);

    const row = await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" });
    assert.equal(row.granted, "30", "the ledger holds exactly 30 points for the day");

    // Same day, later instant: nothing to grant.
    const second = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1_LATER });
    assert.equal(second.granted, "0");
    assert.equal(second.wrote, false, "a spent day is not written to again");
    assert.equal(second.dayTotal, "30", "and the day's total is unchanged");
    assert.equal(second.remaining, "0");
    assert.equal(second.exhausted, true);

    // A third and fourth call, and ten more, still cannot push the day past 30.
    for (let call = 0; call < 10; call += 1) {
      const repeat = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
      assert.equal(repeat.granted, "0");
      assert.equal(repeat.wrote, false);
    }
    assert.equal(
      (await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" })).granted,
      "30",
      "twelve calls in one day is still 30 points, not 360"
    );
  });
});

test("grant: a NEW day restores the full allowance, and the previous day is untouched", async () => {
  await bothAdapters("new-day", async (store) => {
    await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
    const next = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_2 });
    assert.equal(next.granted, "30", "a new dayKey means a full 30 again");
    assert.equal(next.dayTotal, "30");
    assert.equal(next.dayKey, "2026-01-03");
    assert.equal(next.wrote, true);

    // Two separate buckets, each reading 30. The grant does not accumulate
    // across days and does not consume yesterday's.
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" })).granted, "30");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-03" })).granted, "30");

    // Day A's grant must NEVER LEAK into day B: reading a day that was never
    // granted returns the full allowance, not a deduction.
    const later = await freeStaminaAllowance(store, { userAddress: USER_A, now: DAY_10 });
    assert.equal(later.granted, "0");
    assert.equal(later.remaining, "30", "a fresh day shows the whole allowance, unencumbered by yesterday");
    assert.equal(await freeStaminaRemaining(store, { userAddress: USER_A, now: DAY_10 }), "30");

    // Across a leap-day boundary, because a day key that drifts here would be a
    // ledger that forks.
    assert.equal(dayKeyFor(LEAP_DAY), "2028-02-29");
    assert.equal(dayKeyFor(DAY_AFTER_LEAP_DAY), "2028-03-01");
    const leap = await grantFreeStamina(store, { userAddress: USER_B, now: LEAP_DAY });
    assert.equal(leap.granted, "30");
    const afterLeap = await grantFreeStamina(store, { userAddress: USER_B, now: DAY_AFTER_LEAP_DAY });
    assert.equal(afterLeap.granted, "30", "the day after a leap day is a different bucket, with its own 30");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_B, dayKey: "2028-02-29" })).granted, "30");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_B, dayKey: "2028-03-01" })).granted, "30");
  });
});

test("grant: a partial prior grant yields only the REMAINDER, and the day never exceeds 30", async () => {
  await bothAdapters("remainder", async (store) => {
    // 10 points now, 20 later the same day, then nothing.
    const ten = await grantFreeStamina(store, { userAddress: USER_A, amount: 10, now: DAY_1 });
    assert.equal(ten.granted, "10");
    assert.equal(ten.dayTotal, "10");
    assert.equal(ten.remaining, "20");
    assert.equal(ten.exhausted, false);
    assert.equal(ten.wrote, true);

    const twelve = await grantFreeStamina(store, { userAddress: USER_A, amount: 12, now: DAY_1_LATER });
    assert.equal(twelve.granted, "12");
    assert.equal(twelve.dayTotal, "22", "the remainder is what was actually left");
    assert.equal(twelve.remaining, "8");

    // Asking for more than remains yields the REMAINDER, never an overshoot.
    const rest = await grantFreeStamina(store, { userAddress: USER_A, amount: 999, now: DAY_1_LATER });
    assert.equal(rest.granted, "8");
    assert.equal(rest.dayTotal, "30");
    assert.equal(rest.remaining, "0");
    assert.equal(rest.exhausted, true);
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" })).granted, "30");

    // And the day is now closed.
    const closed = await grantFreeStamina(store, { userAddress: USER_A, amount: 1, now: DAY_1_LATER });
    assert.equal(closed.granted, "0");
    assert.equal(closed.wrote, false);

    // A repeated partial grant of zero is also a no-op, not a write.
    const explicitZero = await grantFreeStamina(store, { userAddress: USER_A, amount: 0, now: DAY_1 });
    assert.equal(explicitZero.granted, "0");
    assert.equal(explicitZero.wrote, false);
    assert.equal(explicitZero.dayTotal, "30");

    // Odd-sized remainders: 1 + 1 + 28 lands on exactly 30 and no further.
    const one = await grantFreeStamina(store, { userAddress: USER_B, amount: 1, now: DAY_1 });
    assert.equal(one.dayTotal, "1");
    const oneMore = await grantFreeStamina(store, { userAddress: USER_B, amount: 1, now: DAY_1 });
    assert.equal(oneMore.dayTotal, "2");
    const twentyEight = await grantFreeStamina(store, { userAddress: USER_B, now: DAY_1 });
    assert.equal(twentyEight.granted, "28");
    assert.equal(twentyEight.dayTotal, "30");
    assert.equal(twentyEight.remaining, "0");
  });
});

test("allowance: reads never write, and the two users are separate buckets", async () => {
  await bothAdapters("reads", async (store) => {
    const before = await freeStaminaAllowance(store, { userAddress: USER_A, now: DAY_1 });
    assert.deepEqual({ ...before }, {
      userAddress: USER_A,
      dayKey: "2026-01-02",
      allowance: "30",
      granted: "0",
      remaining: "30",
      exhausted: false,
      dailySpendCapPoints: 50,
    });
    // Reading again after reading changed nothing.
    assert.equal((await freeStaminaAllowance(store, { userAddress: USER_A, now: DAY_1 })).granted, "0");
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" })).granted, "0");

    await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
    // A different wallet in the same day is unaffected.
    const other = await freeStaminaAllowance(store, { userAddress: USER_B, now: DAY_1 });
    assert.equal(other.granted, "0");
    assert.equal(other.remaining, "30");

    // And the same wallet in a different case is the SAME bucket: the grant
    // handed out to the lowercase form is visible to the checksummed form.
    const mixed = await freeStaminaAllowance(store, { userAddress: MIXED_CASE, now: DAY_1 });
    assert.equal(mixed.userAddress, MIXED_CASE.toLowerCase());
    assert.equal(mixed.remaining, "30");
    await grantFreeStamina(store, { userAddress: MIXED_CASE, now: DAY_1 });
    assert.equal(
      (await freeStaminaAllowance(store, { userAddress: MIXED_CASE.toLowerCase(), now: DAY_1 })).granted,
      "30",
      "one wallet, one day, one 30-point grant — regardless of address casing"
    );
  });
});

test("grant: the day key may be supplied directly, and every value is a plain decimal string", async () => {
  await bothAdapters("day-key", async (store) => {
    const byKey = await grantFreeStamina(store, { userAddress: USER_A, now: "2026-01-02" });
    assert.equal(byKey.dayKey, "2026-01-02");
    assert.equal(byKey.granted, "30");
    // The same day, addressed as an instant, is the same bucket.
    const byInstant = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
    assert.equal(byInstant.granted, "0", "a day key and an instant in it name the same bucket");
    for (const field of ["granted", "dayTotal", "remaining"]) {
      assert.equal(typeof byKey[field], "string");
      assert.match(byKey[field], /^\d+$/, `${field} is a plain decimal string of points`);
    }
    assert.equal(await freeStaminaRemaining(store, { userAddress: USER_A, now: "2026-01-02" }), "0");
  });
});

test("grant: malformed arguments are refused with stable codes, and fractional points never happen", async () => {
  await bothAdapters("invalid", async (store) => {
    // A well-formed string that no UTC day ever names.
    for (const badDay of ["2026-02-30", "20260102", "not-a-day", "2026-1-2", ""]) {
      await assert.rejects(
        () => grantFreeStamina(store, { userAddress: USER_A, now: badDay }),
        (err) => {
          assert.equal(err.name, STAMINA_ALLOWANCE_ERROR_NAME);
          assert.equal(err.code, STAMINA_ALLOWANCE_ERRORS.INVALID_DAY_KEY);
          return true;
        },
        `day key ${JSON.stringify(badDay)} must be refused`
      );
    }
    // A string is always read as a day key, so a non-date string is a day-key
    // error, and a non-date VALUE is an instant error.
    await assert.rejects(
      () => grantFreeStamina(store, { userAddress: USER_A, now: "not-a-date" }),
      (err) => err.code === STAMINA_ALLOWANCE_ERRORS.INVALID_DAY_KEY
    );
    for (const badInstant of [{}, [], true, NaN]) {
      await assert.rejects(
        () => grantFreeStamina(store, { userAddress: USER_A, now: badInstant }),
        (err) => err.code === STAMINA_ALLOWANCE_ERRORS.INVALID_INSTANT,
        `instant ${JSON.stringify(badInstant) ?? String(badInstant)} must be refused`
      );
    }
    // Points are indivisible, and never negative.
    for (const badAmount of [2.5, -1, -0.5, NaN, Infinity, "1.5", "1e2", null, {}, true]) {
      await assert.rejects(
        () => grantFreeStamina(store, { userAddress: USER_A, amount: badAmount, now: DAY_1 }),
        (err) => err.code === STAMINA_ALLOWANCE_ERRORS.INVALID_AMOUNT,
        `amount ${JSON.stringify(badAmount)} must be refused`
      );
    }
    await assert.rejects(
      () => grantFreeStamina(store, { userAddress: "", now: DAY_1 }),
      (err) => err.code === STAMINA_ALLOWANCE_ERRORS.INVALID_AMOUNT
    );
    // Nothing above was recorded.
    assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: "2026-01-02" })).granted, "0");
  });
});

test("ledger: an over-granted day reads back as exhausted rather than going negative", async () => {
  await bothAdapters("over-granted", async (store) => {
    // An operator writing 30 x 1e9 base units... in POINTS, by hand, is simply a
    // day with 30,000,000,000 points already granted. The allowance must floor
    // at zero remaining, not report a negative allowance and not hand out more.
    await store.recordFreeStaminaGrant({ userAddress: USER_A, dayKey: "2026-01-02", amount: HUGE });
    const view = await freeStaminaAllowance(store, { userAddress: USER_A, now: DAY_1 });
    assert.equal(view.granted, HUGE, "the counter above 2^53 is exact");
    assert.equal(view.remaining, "0", "remaining is floored at zero");
    assert.equal(view.exhausted, true);
    const grant = await grantFreeStamina(store, { userAddress: USER_A, now: DAY_1 });
    assert.equal(grant.granted, "0");
    assert.equal(grant.wrote, false);
    assert.equal(grant.dayTotal, HUGE, "the exact oversized total is preserved, not rounded");
  });
});

/* ========================================================================== */
/* 3. What the module is not                                                   */
/* ========================================================================== */

test("no mint / pay / consume / settle verb is exported", () => {
  const exports = Object.keys(allowance).sort();
  assert.deepEqual(exports, [
    "DAILY_SPEND_CAP_POINTS",
    "FREE_STAMINA_PER_DAY",
    "STAMINA_ALLOWANCE_ERRORS",
    "STAMINA_ALLOWANCE_ERROR_NAME",
    "freeStaminaAllowance",
    "freeStaminaRemaining",
    "grantFreeStamina",
  ]);
  // The verbs that would imply this module can create or move value. `grant`
  // records an entitlement in a ledger; it is not on this list, and the only
  // write path it reaches is `recordFreeStaminaGrant`.
  for (const forbidden of [
    "mint",
    "mintFreeStamina",
    "pay",
    "payFreeStamina",
    "consume",
    "consumeStamina",
    "settle",
    "settleClaim",
    "burn",
    "withdraw",
    "transfer",
    "airdrop",
    "claim",
  ]) {
    assert.equal(exports.includes(forbidden), false, `${forbidden} must not be exported`);
  }
  for (const name of exports) {
    assert.ok(
      !/\b(mint|pay|consume|settle|burn|withdraw|transfer|airdrop)\w*\s*[:(]/.test(
        String(allowance[name] ?? "")
      ) || typeof allowance[name] !== "function",
      `${name} must not be a value-moving verb`
    );
  }
  // And the module cannot be coerced into a claim: there is no claim-shaped
  // export at all.
  for (const forbidden of ["claim", "claimReward", "relay", "sign", "settleClaim", "stake"]) {
    assert.equal(typeof allowance[forbidden], "undefined", `${forbidden} must not exist here`);
  }
});

test("no chain interaction: no ethers, no process.env, no network, no clock read", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "stamina-allowance.js"), "utf8");
  // COMMENTS ARE STRIPPED FIRST. The module header names every one of these
  // things precisely to say it does not do them, so asserting on the raw text
  // would assert that the documentation is absent. What is asserted is the
  // CODE.
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const forbidden of ["ethers", "process.env", "require(\"node:http\")", "fetch(", "JsonRpcProvider", "PRIVATE_KEY", "Wallet("]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `stamina-allowance.js must contain no ${forbidden}: it is an off-chain ledger only`
    );
  }
  // Its only imports are the store's shape/day-key helpers and content.js's cap
  // and day key. Nothing that can reach a chain or the environment.
  const requires = [...raw.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)].sort(), ["./content", "./storage"]);
  // It reads no clock of its own: `now` is always supplied by the caller.
  assert.equal(source.includes("Date.now()"), false, "the clock is injected, never read here");
  assert.equal(source.includes("new Date()"), false);
});

test("plain points only: nothing in the source scales a value by an 18-decimal factor", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "stamina-allowance.js"), "utf8");
  // No scale-factor literal in any spelling, and no division by one.
  for (const forbidden of [
    "1e18",
    "1e24",
    "1E18",
    "10n ** 18n",
    "10 ** 18",
    "1000000000000000000",
    "0xde0b6b3a7640000",
  ]) {
    assert.equal(source.includes(forbidden), false, `no ${forbidden}: stamina is unscaled points`);
  }
  // The only arithmetic on the allowance is addition/subtraction/comparison of
  // whole points; nothing multiplies by a scale.
  assert.ok(
    !/\/\s*1e\d|1e\d\s*\*|\*\s*1e\d/.test(source),
    "the allowance is never multiplied or divided by a scale factor"
  );
  assert.equal(FREE_STAMINA_PER_DAY * 1n, 30n, "and the allowance itself carries no scale");
  assert.equal((FREE_STAMINA_PER_DAY * 10n).toString(), "300", "30 points is 30, at any interpretation");
});
