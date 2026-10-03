/**
 * CATT Protocol — persistence across a process RESTART.
 *
 * This is the test that justifies the SQLite adapter existing at all. The
 * in-memory store loses everything when the process dies, which means a Judge
 * restart re-issues nonce 1 to a user who has already been paid with it. Two
 * proofs are given, and BOTH are required, because neither alone is enough:
 *
 *   1. IN-PROCESS re-open: close the store, open a new one on the same file.
 *      Proves the data is in the file rather than in a closure.
 *   2. ACROSS A REAL PROCESS BOUNDARY: a parent process writes, then spawns a
 *      CHILD `node` process that opens the same file and reads it back. An
 *      in-process re-open cannot prove durability: it shares the page cache, the
 *      file descriptor layer and the process, and a store that buffered
 *      everything in memory it had not yet flushed would pass it. A child
 *      process sees only what actually reached the disk.
 *
 * The HTTP test drives the real Judge (`createApp` + `fetch`) against the
 * persistent store, because the promise that matters is not "the database has
 * rows" but "a restarted Judge does not hand out the same nonce twice".
 *
 * The child script is written to the OS temp directory, never into the
 * repository: the database it reads holds wallet addresses and signed claims.
 */

"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ethers } = require("ethers");

const content = require("../src/content");
const { createApp, createStoreFromEnv } = require("../src/server");
const { createSqliteStore } = require("../src/sqlite-store");
const { createMemoryStore } = require("../src/storage");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Throwaway signer. Never persisted, never logged, never an env var. */
const backendWallet = ethers.Wallet.createRandom();
const CHAIN_ID = 31337;
const VERIFYING_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const USER = "0x" + "11".repeat(20);
const MISSION = content.getMission("mission-1");
const ARTICLE = content.getArticle(MISSION.articleId);
const BIG_REWARD = "1000000000000000000000001";
const TX_HASH = "0x" + "ab".repeat(32);

/** Every temp directory created here, removed in `after`. */
const tempDirs = [];

/**
 * A throwaway directory under the OS temp dir.
 *
 * @param {string} [label] Recognisable suffix.
 * @returns {string} The directory path.
 */
function tempDir(label = "persist") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `catt-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** A realistic human telemetry stream (drifting temperature, jittered touch). */
function humanTelemetry(count = 25) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    samples.push({
      ts: 1_760_000_000_000 + i * 5000,
      batteryTempC: 26 + ((i * 7) % 81) / 10,
      touch: { x: 40 + ((i * 37) % 260), y: 90 + ((i * 53) % 420) },
      scrollDelta: [120, -45, 310, -260, 0, 175, -95, 60][i % 8],
    });
  }
  return samples;
}

/** A submission that passes every check: correct answers, real highlight, human timing. */
function passingSubmission(sessionId) {
  return {
    sessionId,
    user: USER,
    answers: ARTICLE.quiz.map((q) => ({ questionId: q.id, answerIndex: q.correctIndex })),
    highlight: ARTICLE.highlightTask.keySentences.join(" "),
    typingMs: 40_000,
  };
}

/** Live HTTP servers started by these tests. */
const liveServers = [];

after(async () => {
  await Promise.all(
    liveServers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Boots the real Judge on an ephemeral port against the given store.
 *
 * @param {Object} store A storage adapter.
 * @returns {Promise<string>} The base URL.
 */
async function bootJudge(store) {
  const app = createApp({
    store,
    chainId: CHAIN_ID,
    verifyingContract: VERIFYING_CONTRACT,
    privateKey: backendWallet.privateKey,
    relayService: { isConfigured: () => false },
    logger: { info() {}, log() {}, warn() {}, error() {}, debug() {} },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  liveServers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * POSTs JSON and returns the parsed body plus the status.
 *
 * @param {string} baseUrl Judge base URL.
 * @param {string} path Endpoint.
 * @param {Object} payload Request body.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function postJson(baseUrl, path_, payload) {
  const res = await fetch(`${baseUrl}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/**
 * GETs JSON and returns the parsed body plus the status.
 *
 * @param {string} baseUrl Judge base URL.
 * @param {string} path_ Endpoint.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(baseUrl, path_) {
  const res = await fetch(`${baseUrl}${path_}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/* -------------------------------------------------------------------------- */
/* 1. In-process re-open                                                       */
/* -------------------------------------------------------------------------- */

test("restart (in-process): everything written before close() is there afterwards", async () => {
  const dir = tempDir("inproc");
  const filename = path.join(dir, "judge.db");

  /* --- writer ------------------------------------------------------- */
  const writer = createSqliteStore({ filename });
  await writer.init();
  await writer.createSession({ sessionId: "s-1", userAddress: USER, missionId: "mission-1" });
  await writer.appendTelemetry("s-1", humanTelemetry(5));
  await writer.saveSubmission({
    sessionId: "s-1",
    userAddress: USER,
    missionId: "mission-1",
    answers: [0],
    highlight: "h",
    typingMs: 40_000,
    freeText: "an answer a syndicate might copy",
    result: { status: "PASS", reward: BIG_REWARD, staminaCost: "5" },
  });
  const burned = await writer.reserveNonce(USER); // reserved, never signed
  const signed = await writer.reserveNonce(USER); // reserved AND signed
  await writer.recordIssuedClaim({
    userAddress: USER,
    nonce: signed,
    sessionId: "s-1",
    digest: "0x" + "11".repeat(32),
    reward: BIG_REWARD,
    staminaCost: "5",
    deadline: 1_700_000_000,
    signature: "0x" + "22".repeat(65),
  });
  await writer.markRelayed({ userAddress: USER, nonce: signed, txHash: TX_HASH });
  await writer.close();

  /* --- reader: a brand new store object on the same file ------------- */
  const reader = createSqliteStore({ filename });
  await reader.init();

  assert.deepEqual(reader._debugState(), {
    sessions: 1,
    telemetry: 5,
    submissions: 1,
    issuedClaims: 1,
    relayedClaims: 1,
  });
  const session = await reader.getSession("s-1");
  assert.equal(session.userAddress, USER);
  assert.equal(session.missionId, "mission-1");
  assert.deepEqual((await reader.getTelemetry("s-1")).map((s) => s.ts), humanTelemetry(5).map((s) => s.ts));
  const submissions = await reader.listRecentSubmissions({ limit: 10 });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].freeText, "an answer a syndicate might copy");

  // The nonce burned without a signature is STILL burned: this is the invariant
  // a restart used to destroy.
  assert.equal(await reader.isNonceUsed(USER, burned), true, "a nonce reserved and never signed must stay retired");
  assert.equal(await reader.reserveNonce(USER), signed + 1, "the next nonce must continue the sequence");

  const claim = await reader.getIssuedClaim(USER, signed);
  assert.equal(claim.reward, BIG_REWARD);
  assert.equal(claim.relayerTxHash, TX_HASH, "the relay record must survive");
  assert.equal(await reader.markRelayed({ userAddress: USER, nonce: signed, txHash: "0x" + "cd".repeat(32) }), false);
  await reader.close();
});

/* -------------------------------------------------------------------------- */
/* 2. Across a real process boundary                                           */
/* -------------------------------------------------------------------------- */

test("restart (child process): a separate node process reads back every row", async () => {
  const dir = tempDir("childproc");
  const filename = path.join(dir, "judge.db");

  const writer = createSqliteStore({ filename });
  await writer.init();
  await writer.createSession({ sessionId: "s-1", userAddress: USER, missionId: "mission-1" });
  await writer.appendTelemetry("s-1", humanTelemetry(3));
  await writer.saveSubmission({
    sessionId: "s-1",
    userAddress: USER,
    missionId: "mission-1",
    answers: [0],
    highlight: "h",
    typingMs: 1,
    freeText: "child process proof",
    result: { status: "PASS", reward: BIG_REWARD, staminaCost: "5" },
  });
  const burned = await writer.reserveNonce(USER);
  const signed = await writer.reserveNonce(USER);
  await writer.recordIssuedClaim({
    userAddress: USER,
    nonce: signed,
    digest: "0x" + "11".repeat(32),
    reward: BIG_REWARD,
    staminaCost: "5",
    deadline: 1_700_000_000,
    signature: "0x" + "22".repeat(65),
  });
  await writer.markRelayed({ userAddress: USER, nonce: signed, txHash: TX_HASH });
  await writer.close();

  // The child is a standalone script in the OS temp dir, not in the repo.
  const scriptPath = path.join(dir, "child-read.js");
  fs.writeFileSync(
    scriptPath,
    [
      'const { createSqliteStore } = require(' + JSON.stringify(require.resolve("../src/sqlite-store")) + ');',
      'const main = async () => {',
      '  const store = createSqliteStore({ filename: process.argv[2] });',
      '  await store.init();',
      '  const out = {',
      '    pid: process.pid,',
      '    schemaVersion: store._schemaVersion(),',
      '    state: store._debugState(),',
      '    session: await store.getSession("s-1"),',
      '    telemetryTs: (await store.getTelemetry("s-1")).map((s) => s.ts),',
      '    submissions: (await store.listRecentSubmissions({ limit: 10 })).map((r) => r.freeText),',
      '    isBurnedUsed: await store.isNonceUsed(' + JSON.stringify(USER) + ', ' + String(burned) + '),',
      '    claim: await store.getIssuedClaim(' + JSON.stringify(USER) + ', ' + String(signed) + '),',
      "    markRelayedAgain: await store.markRelayed({ userAddress: " + JSON.stringify(USER) + ", nonce: " + String(signed) + ', txHash: "0x' + "cd".repeat(32) + '" }),',
      '    nextNonce: await store.reserveNonce(' + JSON.stringify(USER) + '),',
      '  };',
      '  await store.close();',
      '  process.stdout.write(JSON.stringify(out));',
      '};',
      'main().catch((err) => { process.stderr.write(String(err && err.stack)); process.exit(1); });',
      '',
    ].join("\n")
  );

  const stdout = execFileSync(process.execPath, [scriptPath, filename], { encoding: "utf8" });
  const seen = JSON.parse(stdout);

  assert.notEqual(seen.pid, process.pid, "the read must come from a DIFFERENT process");
  assert.equal(seen.schemaVersion, 1);
  assert.deepEqual(seen.state, {
    sessions: 1,
    telemetry: 3,
    submissions: 1,
    issuedClaims: 1,
    relayedClaims: 1,
  });
  assert.equal(seen.session.userAddress, USER);
  assert.deepEqual(seen.telemetryTs, humanTelemetry(3).map((s) => s.ts));
  assert.deepEqual(seen.submissions, ["child process proof"]);
  assert.equal(seen.isBurnedUsed, true, "the child sees the nonce burned with no signature");
  assert.equal(seen.claim.reward, BIG_REWARD);
  assert.equal(seen.claim.relayerTxHash, TX_HASH);
  assert.equal(seen.markRelayedAgain, false, "the child also refuses a second relay");
  assert.equal(seen.nextNonce, signed + 1, "the child continues the nonce sequence instead of restarting it");
});

/* -------------------------------------------------------------------------- */
/* 3. The real Judge, restarted                                               */
/* -------------------------------------------------------------------------- */

test("restart (HTTP): a restarted Judge continues the nonce sequence and keeps the session", async () => {
  const dir = tempDir("http");
  const filename = path.join(dir, "judge.db");

  /* --- first boot --------------------------------------------------- */
  const storeA = createSqliteStore({ filename });
  const baseUrlA = await bootJudge(storeA);
  const opened = await postJson(baseUrlA, "/api/session", { sessionId: "s-1", user: USER, missionId: MISSION.id });
  assert.equal(opened.status, 201);
  const telemetryA = await postJson(baseUrlA, "/api/telemetry", { sessionId: "s-1", samples: humanTelemetry() });
  assert.equal(telemetryA.status, 200);
  assert.equal(telemetryA.body.total, 25);
  const first = await postJson(baseUrlA, "/api/submit", passingSubmission("s-1"));
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "PASS", `first submit should pass: ${JSON.stringify(first.body.result)}`);
  assert.equal(first.body.claim.nonce, "1");
  assert.equal(await storeA.markRelayed({ userAddress: USER, nonce: 1, txHash: TX_HASH }), true);
  await storeA.close();

  /* --- restart: new store, new app, new process state ---------------- */
  const storeB = createSqliteStore({ filename });
  const baseUrlB = await bootJudge(storeB);
  const reopened = await postJson(baseUrlB, "/api/session", { sessionId: "s-1", user: USER, missionId: MISSION.id });
  assert.equal(reopened.status, 201, "the session is known to the restarted Judge");
  const telemetryB = await getJson(baseUrlB, "/api/session/s-1/telemetry");
  assert.equal(telemetryB.body.count, 25, "telemetry streamed before the restart is still there");

  const second = await postJson(baseUrlB, "/api/submit", passingSubmission("s-1"));
  assert.equal(second.status, 200);
  assert.equal(second.body.status, "PASS", `second submit should pass: ${JSON.stringify(second.body.result)}`);
  assert.equal(second.body.claim.nonce, "2", "the restarted Judge must NOT reissue nonce 1");

  // The relay cross-check still works after the restart, which is the other
  // thing a volatile store silently breaks.
  const claim = await storeB.getIssuedClaim(USER, 1);
  assert.equal(claim.relayerTxHash, TX_HASH);
  assert.equal(claim.reward, first.body.claim.reward, "a wei-scale reward survives the restart exactly");
  assert.equal(await storeB.markRelayed({ userAddress: USER, nonce: 1, txHash: "0x" + "cd".repeat(32) }), false);
  const secondClaim = await storeB.getIssuedClaim(USER, 2);
  assert.equal(secondClaim.relayerTxHash, null, "nonce 2 was signed but never relayed");
  assert.equal(secondClaim.reward, second.body.claim.reward);
  await storeB.close();
});

/* -------------------------------------------------------------------------- */
/* 4. Adapter selection from the environment                                  */
/* -------------------------------------------------------------------------- */

test("env: the in-memory adapter stays the default and SQLite is opt-in", async () => {
  const memory = createStoreFromEnv({ env: {} });
  assert.equal(typeof memory.reserveNonce, "function");
  assert.equal(await memory.reserveNonce(USER), 1, "the default adapter behaves like the memory store");
  await memory.close();

  assert.equal(await createStoreFromEnv({ env: { CATT_STORE: "memory" } }).reserveNonce(USER), 1);
  // A typo must not silently produce a volatile Judge.
  assert.throws(() => createStoreFromEnv({ env: { CATT_STORE: "sqlie" } }), /unknown CATT_STORE adapter/);

  const filename = path.join(tempDir("env"), "judge.db");
  const sqlite = createStoreFromEnv({ env: { CATT_STORE: "sqlite", SQLITE_PATH: filename } });
  assert.equal(await sqlite.reserveNonce(USER), 1);
  await sqlite.close();
  const again = createStoreFromEnv({ env: { CATT_STORE: "SQLite", SQLITE_PATH: filename } });
  assert.equal(await again.reserveNonce(USER), 2, "CATT_STORE is case-insensitive and the file persisted");
  await again.close();
});

test("env: createApp still takes an injected store and never reads the environment", async () => {
  const saved = process.env.CATT_STORE;
  process.env.CATT_STORE = "sqlie"; // invalid: if createApp consulted it, this would throw
  try {
    const injected = createMemoryStore();
    const baseUrl = await bootJudge(injected);
    await postJson(baseUrl, "/api/session", { sessionId: "s-1", user: USER, missionId: MISSION.id });
    const session = await injected.getSession("s-1");
    assert.equal(session.userAddress, USER, "the injected store received the write");
    await injected.close();
  } finally {
    if (saved === undefined) delete process.env.CATT_STORE;
    else process.env.CATT_STORE = saved;
  }
});
