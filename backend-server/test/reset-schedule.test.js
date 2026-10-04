/**
 * CATT Protocol — THE 04:00 WIB RESET RULE AND THE SHARED CONTRACT CONSTANTS.
 *
 *   cd backend-server && npm test
 *
 * ===========================================================================
 * WHAT IS UNDER TEST
 * ===========================================================================
 *   1. `wibDayKey`'s 21:00 UTC boundary, in both directions.
 *   2. THE FOUNDER'S TWO REQUIRED CASES, driven through the REAL store, the
 *      REAL free-stamina grant and the REAL spend-cap ledger:
 *        (a) a reader at 23:55 WIB KEEPS their streak;
 *        (b) a reader at 05:00 WIB GETS refreshed stamina and a new budget day.
 *   3. The month boundary, including the season-window equivalence.
 *   4. Month, year and leap-day rollovers.
 *   5. Invalid input, and the SECONDS-vs-MILLISECONDS guard.
 *   6. `secondsUntilReset`.
 *   7. THE DRIFT TEST: the backend's contract constants against the `.sol`
 *      SOURCE TEXT.
 *   8. Regression: `content.dayKeyFor` and the live `server.js` agree with
 *      `wibDayKey` across the boundary.
 *
 * ===========================================================================
 * WHY THE INSTANTS BELOW ARE WRITTEN OUT RATHER THAN COMPUTED
 * ===========================================================================
 * Every boundary case names its UTC ISO-8601 instant AND the WIB wall clock it
 * corresponds to. A reader who does not trust this suite's arithmetic can check
 * one case by hand against a real clock, and 21:00Z + 7h = 04:00 of the next
 * morning is checkable without running anything. That is the whole point of
 * pinning a fixed offset: the rule is auditable on paper.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const resetSchedule = require("../src/reset-schedule");
const content = require("../src/content");
const economics = require("../src/economics");
const staminaAllowance = require("../src/stamina-allowance");
const serverModule = require("../src/server");
const { createMemoryStore, normalizeDayKey, isNextDayAfter } = require("../src/storage");
const {
  CONTRACT_CONSTANTS,
  CONTRACT_CONSTANT_MIRRORS,
  CATT_BASE_UNITS,
} = require("../src/contract-constants");

const {
  WIB_OFFSET_HOURS,
  DAILY_RESET_UTC_HOUR,
  SECONDS_PER_DAY,
  wibDayKey,
  wibMonthKey,
  previousWibDayKey,
  nextWibDayKey,
  isConsecutiveWibDay,
  resetEpochFor,
  utcHourOfReset,
  secondsUntilReset,
  startOfWibDay,
  endOfWibDay,
  formatWib,
  RESET_ERRORS,
  RESET_ERROR_NAME,
} = resetSchedule;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** An ISO-8601 instant to epoch SECONDS — the unit this suite is about. */
const S = (iso) => {
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `fixture instant must parse: ${iso}`);
  return Math.floor(ms / 1000);
};

/** An ISO-8601 instant to epoch MILLISECONDS, for the `dayKeyFor` boundary. */
const MS = (iso) => Date.parse(iso);

const USER_A = "0x" + "aa".repeat(20);
const MISSION_ID = "mission-1";
const ARTICLE = content.getArticle(content.getMission(MISSION_ID).articleId);
const CORRECT_ANSWERS = ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex }));
const HIGHLIGHT = ARTICLE.highlightTask.keySentences.join(" ");

const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
/** Throwaway signer for the live-server regression case. Never persisted. */
const backendWallet = ethers.Wallet.createRandom();

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let liveServers = [];

after(async () => {
  await Promise.all(
    liveServers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

/**
 * Boots a real app on an ephemeral port with an INJECTED clock, so a case can
 * place the Judge at a chosen instant — 20:59:59Z, 21:00:00Z, 16:55Z — and read
 * the day key back out of the response it actually produced.
 *
 * @param {Object} options
 * @param {number} options.nowMs The instant, epoch milliseconds.
 * @param {Object} [options.store] Store; defaults to a fresh memory store.
 * @returns {Promise<{ baseUrl: string, store: Object, now: Object }>}
 */
async function boot({ nowMs, store }) {
  const activeStore = store || createMemoryStore();
  const now = { ms: nowMs };
  const app = serverModule.createApp({
    store: activeStore,
    logger: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    privateKey: backendWallet.privateKey,
    clock: () => now.ms,
    env: {},
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, store: activeStore, now };
}

/**
 * Runs one honest mining attempt end to end through the live server.
 *
 * @param {string} baseUrl Server root.
 * @param {string} sessionId Session id.
 * @returns {Promise<Object>} The parsed submit response.
 */
async function mineOnce(baseUrl, sessionId) {
  const telemetry = [];
  for (let i = 0; i < 25; i += 1) {
    telemetry.push({
      ts: 1_760_000_000_000 + i * 5000,
      batteryTempC: 26 + ((i * 7) % 81) / 10,
      x: 40 + ((i * 37) % 260),
      y: 90 + ((i * 53) % 420),
      scrollDelta: 90,
    });
  }
  await fetch(`${baseUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, user: USER_A, missionId: MISSION_ID }),
  });
  await fetch(`${baseUrl}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, samples: telemetry }),
  });
  const res = await fetch(`${baseUrl}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      user: USER_A,
      answers: CORRECT_ANSWERS,
      highlight: HIGHLIGHT,
      typingMs: 40_000,
    }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, `submit failed: ${raw}`);
  return JSON.parse(raw);
}

/* ========================================================================== */
/* 0. The constants themselves                                                  */
/* ========================================================================== */

test("constants: the reset is 21:00 UTC, which is exactly 04:00 WIB", () => {
  assert.equal(WIB_OFFSET_HOURS, 7);
  assert.equal(DAILY_RESET_UTC_HOUR, 21);
  assert.equal(utcHourOfReset(), DAILY_RESET_UTC_HOUR);
  assert.equal(SECONDS_PER_DAY, 86400);
  // THE EQUIVALENCE, ARITHMETICALLY: 21:00 UTC plus 7 hours is 04:00 of the next
  // calendar date. This is the sentence the module header exists to defend, and
  // it is asserted here so a future "cleanup" cannot quietly invalidate it.
  const rolloverUtcHour = (DAILY_RESET_UTC_HOUR + WIB_OFFSET_HOURS) % 24;
  assert.equal(rolloverUtcHour, 4, "21:00 UTC + 7h is 04:00");
  assert.ok(DAILY_RESET_UTC_HOUR + WIB_OFFSET_HOURS > 24, "it is 04:00 of the FOLLOWING morning, not 04:00 the same evening");
  // The exported error pair is frozen and carries the module's own name.
  assert.ok(Object.isFrozen(RESET_ERRORS));
  assert.equal(RESET_ERROR_NAME, "ResetScheduleError");
  assert.equal(RESET_ERRORS.INVALID_INSTANT, "RESET_INVALID_INSTANT");
});

/* ========================================================================== */
/* 1. The boundary                                                             */
/* ========================================================================== */

test("wibDayKey: 20:59:59Z is still today; 21:00:00Z is already tomorrow", () => {
  // One second before the rollover: 03:59:59 WIB on 2026-01-02, still the
  // business day 2026-01-01.
  const before = S("2026-01-01T20:59:59Z");
  assert.equal(formatWib(before), "2026-01-02 03:59:59 WIB (2026-01-01T20:59:59.000Z, business day 2026-01-01)");
  assert.equal(wibDayKey(before), "2026-01-01", "the CURRENT UTC date, before 21:00");

  // The rollover itself: 04:00:00 WIB on 2026-01-02, which is business day
  // 2026-01-02 — i.e. the NEXT UTC calendar date.
  const at = S("2026-01-01T21:00:00Z");
  assert.equal(formatWib(at), "2026-01-02 04:00:00 WIB (2026-01-01T21:00:00.000Z, business day 2026-01-02)");
  assert.equal(wibDayKey(at), "2026-01-02", "exactly at 21:00:00Z the NEXT UTC date has begun");

  // And the whole in-between window is the same day, which is the property that
  // makes a "late night" reading count as that day rather than the next one.
  for (const iso of [
    "2026-01-01T21:00:00Z",
    "2026-01-01T21:00:01Z",
    "2026-01-01T22:30:00Z",
    "2026-01-01T23:59:59Z",
  ]) {
    assert.equal(wibDayKey(S(iso)), "2026-01-02", `${iso} is inside the new business day`);
  }
  // One second before midnight UTC has NOT rolled into 2026-01-03 yet: the day
  // rolls at 21:00, not at midnight.
  assert.equal(wibDayKey(S("2026-01-01T23:59:59Z")), "2026-01-02");
  assert.notEqual(wibDayKey(S("2026-01-01T23:59:59Z")), "2026-01-03");
});

test("wibDayKey: the day window is exactly [21:00Z previous date, 21:00Z)", () => {
  for (const day of ["2026-03-01", "2028-03-01", "2027-03-01", "2026-01-01"]) {
    const start = startOfWibDay(day);
    const end = endOfWibDay(day);
    assert.equal(end - start, SECONDS_PER_DAY, `${day} is exactly one day long`);
    assert.equal(wibDayKey(start), day, "the first second of the window is already in it");
    assert.equal(wibDayKey(end - 1), day, "the last second of the window is still in it");
    assert.equal(wibDayKey(end), nextWibDayKey(day), "one second past the window is the next day");
    assert.match(formatWib(start), / 04:00:00 WIB \(/, `${day} opens at 04:00 WIB`);
  }
});

/* ========================================================================== */
/* 2. THE FOUNDER'S TWO CASES                                                   */
/* ========================================================================== */

test("FOUNDER CASE (a): 23:55 WIB keeps the streak — the store does not reset it", async () => {
  // 2026-01-02 23:55 WIB is 2026-01-02T16:55:00Z. Under the OLD 00:00-UTC rule
  // this user was already on 2026-01-03 while reading on 2026-01-02; under the
  // WIB rule they are still on the business day they started.
  const lateEveningWib = S("2026-01-02T16:55:00Z");
  assert.equal(formatWib(lateEveningWib), "2026-01-02 23:55:00 WIB (2026-01-02T16:55:00.000Z, business day 2026-01-02)");
  const dayKey = wibDayKey(lateEveningWib);
  assert.equal(dayKey, "2026-01-02");
  assert.equal(previousWibDayKey(dayKey), "2026-01-01");
  assert.ok(isConsecutiveWibDay("2026-01-01", dayKey), "01-01 and 01-02 are consecutive business days");

  // Drive the REAL store: a graded completion yesterday, then one at 23:55 WIB.
  const store = createMemoryStore();
  await store.init();
  await store.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-01-01", reward: "1", missionId: MISSION_ID });
  const afterFirst = await store.getStreak({ userAddress: USER_A });
  assert.equal(afterFirst.current, 1);
  assert.equal(afterFirst.lastGradedDay, "2026-01-01");

  await store.recordGradedCompletion({ userAddress: USER_A, dayKey: dayKey, reward: "1", missionId: MISSION_ID });
  const afterLate = await store.getStreak({ userAddress: USER_A });
  assert.equal(afterLate.current, 2, "the late-night completion ADVANCED the streak");
  assert.equal(afterLate.lastGradedDay, "2026-01-02");

  // The same completion under the old UTC boundary would have been a DIFFERENT
  // calendar day with a 22-hour gap between the two day keys, which the store
  // correctly treats as a broken chain. This is the regression the WIB rule
  // removes, asserted rather than asserted-about.
  assert.equal(wibDayKey(S("2026-01-02T17:00:00Z")), "2026-01-02", "00:00 WIB is still the same business day");
  assert.equal(wibDayKey(S("2026-01-02T22:00:00Z")), "2026-01-03", "05:00 WIB the next morning is the next business day");
  const gap = createMemoryStore();
  await gap.init();
  await gap.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-01-02", reward: "1", missionId: MISSION_ID });
  await gap.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-01-03", reward: "1", missionId: MISSION_ID });
  assert.equal((await gap.getStreak({ userAddress: USER_A })).current, 2, "consecutive keys advance; a real gap would not");
  await gap.recordGradedCompletion({ userAddress: USER_A, dayKey: "2026-01-06", reward: "1", missionId: MISSION_ID });
  assert.equal((await gap.getStreak({ userAddress: USER_A })).current, 1, "a genuine gap still resets to 1");
  assert.ok(isNextDayAfter("2026-01-02", "2026-01-03"), "the store's next-day test agrees with the WIB helper");
});

test("FOUNDER CASE (b): 05:00 WIB rolls the day — refreshed stamina, fresh budget", async () => {
  // 2026-01-03 05:00 WIB is 2026-01-02T22:00:00Z — the previous UTC date, which
  // is exactly the case that used to be impossible to express.
  const earlyMorningWib = S("2026-01-02T22:00:00Z");
  assert.equal(formatWib(earlyMorningWib), "2026-01-03 05:00:00 WIB (2026-01-02T22:00:00.000Z, business day 2026-01-03)");
  const dayKey = wibDayKey(earlyMorningWib);
  assert.equal(dayKey, "2026-01-03", "05:00 WIB is already the NEW business day");
  assert.equal(content.dayKeyFor(MS("2026-01-02T22:00:00Z")), "2026-01-03", "content.js delegates and agrees");

  // The previous business day, spent: allowance granted, 50 points of spend
  // recorded against the day's cap.
  const store = createMemoryStore();
  await store.init();
  const yesterdayKey = previousWibDayKey(dayKey);
  const yesterdayGrant = await staminaAllowance.grantFreeStamina(store, { userAddress: USER_A, now: yesterdayKey });
  assert.equal(yesterdayGrant.granted, "30");
  assert.equal(yesterdayGrant.remaining, "0", "yesterday's allowance is spent");
  await store.recordStaminaConsumption({ userAddress: USER_A, dayKey: yesterdayKey, amount: 50 });
  assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: yesterdayKey })).consumed, "50");
  const capPolicy = content.createStaminaPolicy({ cap: content.DEFAULT_DAILY_STAMINA_CAP });
  assert.equal(capPolicy.admits({ consumed: 50, amount: 10 }).allowed, false, "yesterday's budget is exhausted");

  // 05:00 WIB the next morning: a NEW day key, so all three ledgers reset.
  const todayGrant = await staminaAllowance.grantFreeStamina(store, { userAddress: USER_A, now: dayKey });
  assert.equal(todayGrant.granted, "30", "the free-stamina grant is available again");
  assert.equal(todayGrant.dayTotal, "30");
  assert.equal(todayGrant.remaining, "0");
  assert.equal(todayGrant.wrote, true);
  assert.equal(todayGrant.dayKey, dayKey);

  const consumedToday = await store.getStaminaConsumed({ userAddress: USER_A, dayKey });
  assert.equal(consumedToday.consumed, "0", "the daily SPEND ledger starts from zero");
  const admission = capPolicy.admits({ consumed: Number(consumedToday.consumed), amount: 50 });
  assert.equal(admission.allowed, true, "the full day budget is spendable again");
  assert.equal(admission.amount, 50);
  assert.equal(admission.cap, 50);
  assert.equal(admission.remaining, 50, "all 50 points of the day's budget are available, not 0 as yesterday left it");
  await store.recordStaminaConsumption({ userAddress: USER_A, dayKey, amount: 50 });
  assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey })).consumed, "50");
  assert.equal(capPolicy.admits({ consumed: 50, amount: 1 }).allowed, false, "and the new day's budget is now spent too");
  assert.equal(capPolicy.remaining({ consumed: 0 }), 50, "the policy itself is stateless — the ledger is what resets");

  // Yesterday's rows are untouched by today's refresh.
  assert.equal((await store.getStaminaConsumed({ userAddress: USER_A, dayKey: yesterdayKey })).consumed, "50");
  assert.equal((await store.getFreeStaminaGranted({ userAddress: USER_A, dayKey: yesterdayKey })).granted, "30");

  // And a second call on the new day grants nothing, so the refresh happened
  // exactly once. NOTE THE UNIT: the allowance's `now` speaks epoch
  // MILLISECONDS (it feeds `content.dayKeyFor`), not the epoch seconds this
  // module uses — so it is handed the day KEY here. Passing `earlyMorningWib`
  // (seconds) would have been read as 1970 and granted a second allowance.
  const repeat = await staminaAllowance.grantFreeStamina(store, { userAddress: USER_A, now: dayKey });
  assert.equal(repeat.granted, "0");
  assert.equal(repeat.wrote, false);
  assert.equal(await staminaAllowance.freeStaminaRemaining(store, { userAddress: USER_A, now: dayKey }), "0");
  assert.equal(await staminaAllowance.freeStaminaRemaining(store, { userAddress: USER_A, now: MS("2026-01-02T22:00:00Z") }), "0", "and the same instant in milliseconds agrees");
  assert.equal(await staminaAllowance.freeStaminaRemaining(store, { userAddress: USER_A, now: previousWibDayKey(dayKey) }), "0", "yesterday's grant is untouched");
});

/* ========================================================================== */
/* 3. Month boundary                                                           */
/* ========================================================================== */

test("wibMonthKey: the business month rolls at 04:00 WIB on the 1st", () => {
  // 2026-02-28 20:59:59 UTC = 2026-03-01 03:59:59 WIB: the LAST moment of
  // business month 2026-02.
  const lastMoment = S("2026-02-28T20:59:59Z");
  assert.equal(formatWib(lastMoment), "2026-03-01 03:59:59 WIB (2026-02-28T20:59:59.000Z, business day 2026-02-28)");
  assert.equal(wibMonthKey(lastMoment), "2026-02");
  assert.equal(wibDayKey(lastMoment), "2026-02-28");

  // 21:00:00 UTC on the last day of the month IS 04:00 WIB on the 1st, so the
  // month has already rolled.
  const rollover = S("2026-02-28T21:00:00Z");
  assert.equal(formatWib(rollover), "2026-03-01 04:00:00 WIB (2026-02-28T21:00:00.000Z, business day 2026-03-01)");
  assert.equal(wibMonthKey(rollover), "2026-03", "the month rolls at 21:00 UTC on the previous month's last day");
  assert.equal(wibDayKey(rollover), "2026-03-01");
  assert.equal(wibMonthKey(rollover + 1), "2026-03", "and it stays rolled");
  assert.equal(wibMonthKey(rollover - 1), "2026-02");
});

test("season windows: a calendar-month boundary at 04:00 WIB on the 1st IS 21:00 UTC on the previous month's last day", () => {
  // The seasons module schedules ABSOLUTE INSTANT windows `[start, end)`, so the
  // WIB rule cannot invalidate them: there is no timezone left inside an epoch
  // second. What has to be true — and is asserted here — is that the instant a
  // founder would call "the March season boundary" is the one this module
  // produces: 21:00 UTC on February's last day.
  const marchStart = resetEpochFor("2026-03-01");
  assert.equal(new Date(marchStart * 1000).toISOString(), "2026-02-28T21:00:00.000Z");
  assert.equal(formatWib(marchStart), "2026-03-01 04:00:00 WIB (2026-02-28T21:00:00.000Z, business day 2026-03-01)");

  // And it is exactly the rollover instant: an instant one second earlier is
  // still February, one second later is March. So a season window starting at
  // this instant and ending at the next month's equivalent partitions the year
  // with no gap and no overlap.
  assert.equal(wibMonthKey(marchStart - 1), "2026-02");
  assert.equal(wibMonthKey(marchStart), "2026-03");

  const aprilStart = resetEpochFor("2026-04-01");
  assert.equal(new Date(aprilStart * 1000).toISOString(), "2026-03-31T21:00:00.000Z");
  assert.ok(aprilStart > endOfWibDay("2026-03-01"), "April opens a month after March, never on the same day");
  // Half-open across EVERY month boundary of a year: the second before belongs
  // to the old month, the boundary instant to the new one, and no instant is
  // claimed twice or by nobody.
  const MONTHS_2026 = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
  for (let i = 0; i < MONTHS_2026.length; i += 1) {
    const start = resetEpochFor(`${MONTHS_2026[i]}-01`);
    const previous = i === 0 ? "2025-12" : MONTHS_2026[i - 1];
    assert.equal(wibMonthKey(start - 1), previous, `${MONTHS_2026[i]} opens with ${previous} still owning the second before it`);
    assert.equal(wibMonthKey(start), MONTHS_2026[i], `${MONTHS_2026[i]} owns its own boundary instant`);
    assert.equal(new Date(start * 1000).getUTCHours(), 21, `${MONTHS_2026[i]} opens at 21:00 UTC`);
    assert.equal(formatWib(start).includes("04:00:00 WIB"), true, `${MONTHS_2026[i]} opens at 04:00 WIB`);
  }

  // Every month of a leap year and of a common year, because "the last day of
  // the previous month" is a phrase with a bug in it for February.
  assert.equal(new Date(resetEpochFor("2028-03-01") * 1000).toISOString(), "2028-02-29T21:00:00.000Z", "2028 is a leap year");
  assert.equal(new Date(resetEpochFor("2027-03-01") * 1000).toISOString(), "2027-02-28T21:00:00.000Z", "2027 is not");
  assert.equal(new Date(resetEpochFor("2026-01-01") * 1000).toISOString(), "2025-12-31T21:00:00.000Z", "the year boundary too");
  assert.equal(new Date(resetEpochFor("2026-12-01") * 1000).toISOString(), "2026-11-30T21:00:00.000Z");

  // The shipped schedule is a run of 30-day windows from a fixed epoch, and it
  // is not month-aligned by design; what matters is that it is contiguous and
  // expressed in absolute instants, which is what makes it timezone-proof.
  const seasons = require("../src/seasons");
  const epoch = resetEpochFor("2026-03-01");
  const schedule = seasons.buildSeasonSchedule({ epoch });
  for (let i = 0; i + 1 < schedule.length; i += 1) {
    assert.equal(schedule[i].end, schedule[i + 1].start, "half-open windows partition the timeline");
  }
  assert.equal(schedule[0].start, epoch, "the schedule is anchored on the 21:00 UTC month boundary, unshifted");
  assert.equal(seasons.seasonFor(marchStart, { epoch }).id, "season-1", "a boundary instant belongs to the later season");
  assert.equal(seasons.seasonFor(marchStart - 1, { epoch }), undefined, "one second earlier belongs to nothing yet, which is the half-open rule");
});

/* ========================================================================== */
/* 4. Month, year and leap rollovers                                            */
/* ========================================================================== */

test("rollovers: 31 Jan -> 1 Feb, 28/29 Feb -> 1 Mar, 31 Dec -> 1 Jan", () => {
  // The helper pair, at the rollover instant of each next day.
  assert.equal(new Date(resetEpochFor("2026-02-01") * 1000).toISOString(), "2026-01-31T21:00:00.000Z");
  assert.equal(previousWibDayKey("2026-02-01"), "2026-01-31");
  assert.equal(wibMonthKey(resetEpochFor("2026-02-01")), "2026-02");

  // NON-leap year: 28 February is the last day, so the March business month
  // opens on 28 February at 21:00 UTC.
  assert.equal(previousWibDayKey("2025-03-01"), "2025-02-28");
  assert.equal(new Date(resetEpochFor("2025-03-01") * 1000).toISOString(), "2025-02-28T21:00:00.000Z");
  assert.equal(wibMonthKey(S("2025-02-28T20:59:59Z")), "2025-02");
  assert.equal(wibMonthKey(S("2025-02-28T21:00:00Z")), "2025-03");

  // LEAP year 2028: the extra day exists, and the March business month opens on
  // 29 February at 21:00 UTC — one day later, which is the whole point.
  assert.equal(previousWibDayKey("2028-03-01"), "2028-02-29");
  assert.equal(new Date(resetEpochFor("2028-03-01") * 1000).toISOString(), "2028-02-29T21:00:00.000Z");
  assert.equal(wibDayKey(S("2028-02-29T20:59:59Z")), "2028-02-29");
  assert.equal(wibDayKey(S("2028-02-29T21:00:00Z")), "2028-03-01");
  assert.equal(wibMonthKey(S("2028-02-29T20:59:59Z")), "2028-02");
  assert.equal(wibMonthKey(S("2028-02-29T21:00:00Z")), "2028-03");
  // 29 February is a real day in 2028 and consecutive with 28 and with 1 March.
  assert.ok(isConsecutiveWibDay("2028-02-28", "2028-02-29"));
  assert.ok(isConsecutiveWibDay("2028-02-29", "2028-03-01"));
  assert.equal(normalizeDayKey("2028-02-29"), "2028-02-29", "the store accepts it as a real day");

  // Year boundary: 31 December -> 1 January, and the month rolls with it.
  assert.equal(previousWibDayKey("2026-01-01"), "2025-12-31");
  assert.equal(new Date(resetEpochFor("2026-01-01") * 1000).toISOString(), "2025-12-31T21:00:00.000Z");
  assert.equal(wibDayKey(S("2025-12-31T20:59:59Z")), "2025-12-31");
  assert.equal(wibDayKey(S("2025-12-31T21:00:00Z")), "2026-01-01");
  assert.equal(wibMonthKey(S("2025-12-31T20:59:59Z")), "2025-12");
  assert.equal(wibMonthKey(S("2025-12-31T21:00:00Z")), "2026-01");

  // April has 30 days, so May opens on 30 April at 21:00 UTC — the "31st of the
  // previous month" reflex is wrong here and this pins it.
  assert.equal(previousWibDayKey("2026-05-01"), "2026-04-30");
  assert.equal(new Date(resetEpochFor("2026-05-01") * 1000).toISOString(), "2026-04-30T21:00:00.000Z");

  // Direction sensitivity: yesterday is not today, and a day is not its own
  // successor.
  assert.equal(isConsecutiveWibDay("2026-01-02", "2026-01-03"), true);
  assert.equal(isConsecutiveWibDay("2026-01-03", "2026-01-02"), false);
  assert.equal(isConsecutiveWibDay("2026-01-01", "2026-01-01"), false);
  assert.equal(isConsecutiveWibDay("2026-01-01", "2026-01-03"), false, "a gap is not a rollover");
});

/* ========================================================================== */
/* 5. Invalid input and the seconds/ms guard                                    */
/* ========================================================================== */

test("validation: a non-existent calendar date is refused, not rolled over", () => {
  // Well-formed strings that name no day. A ledger bucket keyed by one is a
  // bucket nothing can ever roll over into.
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-01-32", "2026-04-31"]) {
    assert.throws(() => previousWibDayKey(bad), TypeError, `${bad} is not a real calendar day`);
    assert.throws(() => nextWibDayKey(bad), TypeError, `${bad} is not a real calendar day`);
    assert.throws(() => isConsecutiveWibDay("2026-01-01", bad), TypeError, `${bad} is not a real calendar day`);
    assert.throws(() => isConsecutiveWibDay(bad, "2026-01-01"), TypeError, `${bad} is not a real calendar day`);
    assert.throws(() => resetEpochFor(bad), TypeError, `${bad} is not a real calendar day`);
    // And the error is TYPED, so a caller can branch on the code.
    try {
      previousWibDayKey(bad);
      assert.fail(`${bad} must be refused`);
    } catch (err) {
      assert.equal(err.code, RESET_ERRORS.INVALID_DAY_KEY);
      assert.equal(err.name, RESET_ERROR_NAME);
    }
  }
  // Shape, not just calendar.
  for (const bad of ["2026-1-1", "20260101", "2026-01-01T00:00:00Z", "", "today", 20260101, null, undefined, {}]) {
    assert.throws(() => previousWibDayKey(bad), TypeError, `${String(bad)} must be refused`);
  }
  // Month keys are validated as months.
  for (const bad of ["2026-13", "2026-00", "2026-1", "202603", "", null]) {
    assert.throws(() => resetSchedule.parseMonthKey(bad), TypeError, `${String(bad)} must be refused`);
  }
  assert.equal(resetSchedule.parseMonthKey(" 2026-03 ").year, 2026);
  // Surrounding whitespace is tolerated, as everywhere else in this codebase.
  assert.equal(previousWibDayKey(" 2026-01-02 "), "2026-01-01");
});

test("validation: a bad instant is refused with a clear error", () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1, "2026-01-01", {}, [], true, 1.5]) {
    assert.throws(() => wibDayKey(bad), TypeError, `${String(bad)} must be refused`);
    assert.throws(() => wibMonthKey(bad), TypeError, `${String(bad)} must be refused`);
    assert.throws(() => secondsUntilReset(bad), TypeError, `${String(bad)} must be refused`);
    assert.throws(() => formatWib(bad), TypeError, `${String(bad)} must be refused`);
  }
  try {
    wibDayKey(-5);
    assert.fail("a negative instant must be refused");
  } catch (err) {
    assert.equal(err.code, RESET_ERRORS.INVALID_INSTANT);
    assert.match(err.message, /non-negative/);
  }
});

test("units: SECONDS, not milliseconds — a plausible ms value is refused, not silently 1970", () => {
  // 2026-01-01T00:00:00Z as SECONDS.
  assert.equal(wibDayKey(S("2026-01-01T00:00:00Z")), "2026-01-01");
  // The same instant as MILLISECONDS. Passing it must NOT quietly produce a
  // 1970 business day, which is the silent-ledger-corruption failure mode.
  const asMs = MS("2026-01-01T00:00:00Z");
  assert.equal(asMs, 1767225600000);
  assert.throws(() => wibDayKey(asMs), TypeError, "milliseconds are refused");
  assert.throws(() => wibMonthKey(asMs), TypeError);
  assert.throws(() => secondsUntilReset(asMs), TypeError);
  assert.throws(() => resetEpochFor(asMs), TypeError);
  try {
    wibDayKey(asMs);
    assert.fail("milliseconds must be refused");
  } catch (err) {
    assert.equal(err.code, RESET_ERRORS.INVALID_INSTANT);
    assert.match(err.message, /MILLISECONDS/, "the error says which unit was expected");
  }
  // And nothing slipped through to a 1970 key: no instant this suite accepts
  // produces a day before 2000-01-01.
  for (const seconds of [0, 1, 946_684_800, 1_000_000_000, 2_000_000_000]) {
    const key = wibDayKey(seconds);
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(key >= "1970-01-01" && key < "2100-01-01", `${seconds}s -> ${key} is a sane key`);
  }
  // The GUARD is documented in the module header and pinned here: the threshold
  // sits below every real millisecond value and above every plausible seconds
  // value.
  assert.ok(resetSchedule.MAX_EPOCH_SECONDS <= 1e11);
  assert.ok(1_700_000_000_000 > resetSchedule.MAX_EPOCH_SECONDS, "any 2023+ ms value is caught");
  assert.ok(4_000_000_000 < resetSchedule.MAX_EPOCH_SECONDS, "year 2096 in seconds is still accepted");
});

/* ========================================================================== */
/* 6. secondsUntilReset                                                        */
/* ========================================================================== */

test("secondsUntilReset: in (0, 86400], exactly 86400 on the boundary", () => {
  // Sweep a whole day of seconds around the rollover, plus a sample across a
  // month boundary, and assert the invariant everywhere.
  const base = S("2026-02-28T00:00:00Z");
  for (let offset = 0; offset <= SECONDS_PER_DAY; offset += 1) {
    const value = secondsUntilReset(base + offset);
    assert.ok(value > 0, `offset ${offset} -> ${value} must be strictly positive`);
    assert.ok(value <= SECONDS_PER_DAY, `offset ${offset} -> ${value} must be at most one day`);
    assert.equal(Number.isInteger(value), true);
  }
  // Exactly on the boundary the reset has JUST happened, so a full day remains.
  assert.equal(secondsUntilReset(S("2026-01-01T21:00:00Z")), SECONDS_PER_DAY);
  assert.equal(secondsUntilReset(S("2026-01-01T21:00:01Z")), SECONDS_PER_DAY - 1);
  assert.equal(secondsUntilReset(S("2026-01-01T20:59:59Z")), 1);
  assert.equal(secondsUntilReset(S("2026-01-01T12:00:00Z")), 9 * 3600, "noon UTC is 9 hours from 21:00 UTC");
  assert.equal(secondsUntilReset(S("2026-01-01T00:00:00Z")), 21 * 3600);
  // The instant is always exactly one day before the reported reset, which is
  // the identity that makes the helper usable for a countdown.
  for (const iso of ["2026-01-01T21:00:00Z", "2026-02-28T23:59:59Z", "2028-02-29T21:00:00Z"]) {
    assert.equal(resetEpochFor(S(iso)), S(iso) + secondsUntilReset(S(iso)), iso);
  }
});

/* ========================================================================== */
/* 7. THE DRIFT TEST                                                            */
/* ========================================================================== */

test("drift: the backend's contract constants still match the .sol SOURCE", () => {
  // The contracts are FROZEN, so this mirror is hand-maintained — which is only
  // safe because something proves it has not moved. This reads the contract
  // source as TEXT (no build, no artifact, no network) and compares the literal
  // each symbol is declared with.
  assert.ok(Array.isArray(CONTRACT_CONSTANT_MIRRORS) && CONTRACT_CONSTANT_MIRRORS.length > 0);
  const readFiles = new Map();

  for (const mirror of CONTRACT_CONSTANT_MIRRORS) {
    const { name, file, symbol, literal } = mirror;
    const value = CONTRACT_CONSTANTS[name];
    assert.notEqual(value, undefined, `${name} must exist in CONTRACT_CONSTANTS`);

    if (!readFiles.has(file)) {
      const absolute = path.join(REPO_ROOT, file);
      assert.ok(fs.existsSync(absolute), `contract source must be readable: ${file}`);
      readFiles.set(file, fs.readFileSync(absolute, "utf8"));
    }
    const source = readFiles.get(file);

    // The declaration line itself, so a match cannot come from a comment or a
    // docstring that merely quotes the number.
    const declaration = new RegExp(
      `^\\s*uint256\\s+public\\s+constant\\s+${symbol}\\s*=\\s*([^;]+);`,
      "m"
    ).exec(source);
    assert.notEqual(declaration, null, `${symbol} must be declared as a constant in ${file}`);
    const declared = declaration[1].trim();
    assert.equal(
      declared.includes(literal),
      true,
      `${symbol} in ${file} is declared \`${declared}\`, which no longer contains the mirrored literal \`${literal}\``
    );

    // And the backend value equals the contract value.
    if (mirror.derived) {
      // `MAX_SUPPLY = 100_000_000 * 10 ** 18`: the backend unwinds the base-unit
      // scale once, here. So the contract's token count is the mirror, times the
      // 18 decimals, and both halves are asserted.
      assert.equal(declared, "100_000_000 * 10 ** 18", `unexpected MAX_SUPPLY shape: ${declared}`);
      assert.equal(literal, "100_000_000");
      const tokenCount = BigInt(declared.split("*")[0].replace(/_/g, "").trim());
      assert.equal(tokenCount, CONTRACT_CONSTANTS.MAX_SUPPLY_CATT, "MAX_SUPPLY_CATT is the token factor");
      assert.equal(tokenCount * CATT_BASE_UNITS, 100_000_000n * 10n ** 18n, "and 18 decimals is the full base-unit cap");
    } else {
      assert.equal(declared, literal, `${name} must equal the contract literal exactly`);
      assert.equal(value, BigInt(literal.replace(/_/g, "")), `${name} must equal the contract value`);
    }
  }
});

test("drift: the specific pair the founder cares about — STAMINA_PER_STAKE = 50", () => {
  const stakingSource = fs.readFileSync(
    path.join(REPO_ROOT, "smart-contracts/contracts/StakingManager.sol"),
    "utf8"
  );
  // The literal the backend's economics are reasoned against.
  assert.match(stakingSource, /uint256\s+public\s+constant\s+STAMINA_PER_STAKE\s*=\s*50;/);
  assert.equal(CONTRACT_CONSTANTS.STAMINA_PER_STAKE, 50n);
  assert.equal(typeof CONTRACT_CONSTANTS.STAMINA_PER_STAKE, "bigint", "a uint256 quantity is a bigint, not a float");
  // The daily stamina cap IS one stake's worth, and if the contract moves, one
  // of these two must move with it.
  assert.equal(content.DEFAULT_DAILY_STAMINA_CAP, Number(CONTRACT_CONSTANTS.STAMINA_PER_STAKE));
  assert.equal(Number(staminaAllowance.DAILY_SPEND_CAP_POINTS), Number(CONTRACT_CONSTANTS.STAMINA_PER_STAKE));
});

test("drift: MAX_SUPPLY in CATT.sol, and the backend respects the cap", () => {
  const cattSource = fs.readFileSync(path.join(REPO_ROOT, "smart-contracts/contracts/CATT.sol"), "utf8");
  assert.match(cattSource, /uint256\s+public\s+constant\s+MAX_SUPPLY\s*=\s*100_000_000\s*\*\s*10\s*\*\*\s*18;/);
  assert.equal(CONTRACT_CONSTANTS.MAX_SUPPLY_CATT, 100_000_000n);
  assert.equal(CATT_BASE_UNITS, 10n ** 18n, "the 18-decimal base-unit scale, exported beside the record");
  assert.equal(CONTRACT_CONSTANTS.CATT_BASE_UNITS, undefined, "and deliberately NOT inside it: it is not a contract constant");
  // The season pool the backend can allocate must fit inside the token's cap.
  // This is the check that would catch a season allocation typo: 40,000,000
  // headroom against 100,000,000 minted is fine, and it is asserted rather than
  // assumed because the allocation is 25 digits of string.
  const seasons = require("../src/seasons");
  const headroom = seasons.TOTAL_HEADROOM_CATT;
  assert.equal(typeof headroom, "bigint");
  assert.ok(headroom > 0n && headroom <= CONTRACT_CONSTANTS.MAX_SUPPLY_CATT, `season headroom ${headroom} must fit under MAX_SUPPLY`);
});

test("drift: the streak multiplier is NOT pretended to be a contract constant", () => {
  // Reported explicitly, because the temptation is real: `STREAK_MAX_BPS` and
  // its siblings sit next to contract constants in the backend and look like a
  // family. They are not on the chain. If a mirror ever claims otherwise, the
  // claim has to be removed rather than made true.
  for (const name of ["STREAK_BASE_BPS", "STREAK_STEP_BPS", "STREAK_MAX_BPS", "STREAK_CAP_FIRST_REACHED_DAY"]) {
    assert.equal(CONTRACT_CONSTANTS[name], undefined, `${name} must NOT be mirrored: it is backend policy`);
  }
  assert.ok(!JSON.stringify(CONTRACT_CONSTANT_MIRRORS).includes("STREAK"), "and it must not be in the drift list either");
  assert.equal(economics.STREAK_MAX_BPS, 20000n, "it stays frozen in economics.js, where it belongs");
  // Nothing may claim to mirror a symbol that no contract declares.
  const contractSources = fs
    .readdirSync(path.join(REPO_ROOT, "smart-contracts/contracts"))
    .filter((f) => f.endsWith(".sol"))
    .map((f) => fs.readFileSync(path.join(REPO_ROOT, "smart-contracts/contracts", f), "utf8"))
    .join("\n");
  for (const mirror of CONTRACT_CONSTANT_MIRRORS) {
    assert.match(contractSources, new RegExp(`constant\\s+${mirror.symbol}\\s*=`), `${mirror.symbol} must exist somewhere in the contracts`);
  }
});

/* ========================================================================== */
/* 8. Regression: content.js and server.js agree with wibDayKey                 */
/* ========================================================================== */

test("regression: content.dayKeyFor delegates to wibDayKey across the boundary", () => {
  const instants = [
    "2025-12-31T20:59:59Z",
    "2025-12-31T21:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-01-01T20:59:59Z",
    "2026-01-01T21:00:00Z",
    "2026-01-01T21:00:01Z",
    "2026-01-01T23:59:59Z",
    "2026-01-02T00:00:00Z",
    "2026-01-02T16:55:00Z",
    "2026-01-02T22:00:00Z",
    "2026-01-31T21:00:00Z",
    "2025-02-28T21:00:00Z",
    "2028-02-29T21:00:00Z",
    "2025-12-31T23:59:59Z",
  ];
  for (const iso of instants) {
    const expected = wibDayKey(S(iso));
    assert.equal(content.dayKeyFor(MS(iso)), expected, `${iso} via epoch milliseconds`);
    assert.equal(content.dayKeyFor(new Date(MS(iso))), expected, `${iso} via a Date`);
    // And the shape is still exactly what every ledger bucket expects.
    assert.match(expected, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(normalizeDayKey(expected), expected, "the store accepts what content.js produced");
  }
  // The clock is still injected, never read: bad input still throws TypeError.
  for (const bad of [undefined, null, NaN, new Date("nonsense"), "2026-01-01", {}]) {
    assert.throws(() => content.dayKeyFor(bad), TypeError);
  }
});

test("regression: the LIVE server.js uses the WIB day key for every day-scoped decision", async () => {
  // Driven through a real app with an injected clock, so this is the shipped
  // wiring and not a re-derivation: the day key read back out of the response is
  // the one the free-stamina grant, the spend cap, the streak and the graded
  // completion all used.
  const cases = [
    { iso: "2026-03-05T20:59:59Z", sessionId: "s-wib-before" },
    { iso: "2026-03-05T21:00:00Z", sessionId: "s-wib-at" },
    { iso: "2026-03-05T23:30:00Z", sessionId: "s-wib-after" },
  ];
  const store = createMemoryStore();
  await store.init();

  for (const { iso, sessionId } of cases) {
    const { baseUrl } = await boot({ nowMs: MS(iso), store });
    const body = await mineOnce(baseUrl, sessionId);
    assert.equal(body.status, "PASS", `${iso} must mine: ${JSON.stringify(body.result)}`);
    const expected = wibDayKey(S(iso));
    // Every day-scoped field in the audit block agrees, and none of them is the
    // 00:00-UTC day.
    assert.equal(body.economy.dayKey, expected, `${iso} economy.dayKey`);
    assert.equal(body.economy.staminaSpend.dayKey, expected, `${iso} staminaSpend.dayKey`);
    assert.equal(body.economy.freeStamina.dayKey, expected, `${iso} freeStamina.dayKey`);
    assert.equal(body.economy.freeStamina.dayTotal, "30", "the day's grant");
    // The store was written with the same key — the graded completion row is the
    // proof, since that is what a future streak reads.
    const streak = await store.getStreak({ userAddress: USER_A });
    assert.equal(streak.lastGradedDay, expected, `${iso} the store recorded the WIB day`);
  }

  // The three instants above are two distinct business days: 20:59:59Z is still
  // 2026-03-05, and 21:00:00Z onward is 2026-03-06. A server still rolling at
  // midnight UTC would have produced 2026-03-05 for ALL THREE, because
  // 2026-03-05T21:00:00Z and 2026-03-05T23:30:00Z are the same UTC date. That
  // difference is the whole behaviour change, asserted on the live server.
  assert.equal(wibDayKey(S("2026-03-05T20:59:59Z")), "2026-03-05");
  assert.equal(wibDayKey(S("2026-03-05T21:00:00Z")), "2026-03-06");
  assert.equal(wibDayKey(S("2026-03-05T23:30:00Z")), "2026-03-06");
  const utcDate = "2026-03-05T23:30:00Z".slice(0, 10);
  assert.equal(wibDayKey(S("2026-03-05T23:30:00Z")), "2026-03-06");
  assert.notEqual(wibDayKey(S("2026-03-05T23:30:00Z")), utcDate, "the UTC date is NOT the business day after 21:00Z");
});
