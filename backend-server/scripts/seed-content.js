#!/usr/bin/env node
/**
 * CATT Protocol — content seed loader (backend-server).
 *
 * PURPOSE
 * -------
 * A fresh testnet Judge must be able to serve the bounty board immediately:
 * the 3 sample articles and the 3 missions the app reads. This script loads
 * that content into the PERSISTENT store when the store can hold it, and
 * otherwise emits it as a deterministic JSON fixture.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * The content is READ from `require("../src/content.js")` (`ARTICLES`,
 * `MISSIONS`). Nothing is duplicated here: this file is a LOADER, not a second
 * copy of the prose. If you edit an article in content.js, re-run this script
 * and the fixture changes with it.
 *
 * WHY A FIXTURE IS THE DEFAULT (store interface reality, not preference)
 * ---------------------------------------------------------------------
 * `STORAGE_METHODS` in ../src/storage.js is a frozen 14-name contract:
 *
 *   init, createSession, getSession, appendTelemetry, getTelemetry,
 *   saveSubmission, listRecentSubmissions, reserveNonce, isNonceUsed,
 *   recordIssuedClaim, getIssuedClaim, markRelayed, close, dispose
 *
 * It is session / telemetry / submission / nonce / claim oriented. There is NO
 * article or mission persistence in it, and this script deliberately does NOT
 * extend that frozen interface or touch ../src/storage.js or
 * ../src/sqlite-store.js: those belong to another task, and an adapter that
 * silently grows methods is how two Judge builds end up disagreeing about what
 * `STORAGE_METHODS` means.
 *
 * So the script PROBES the selected adapter for the optional content methods
 * documented below and picks its path at runtime:
 *
 *   store-write path  — used only if the adapter exposes ALL of
 *                       upsertArticle, upsertMission, getArticle, listArticles,
 *                       listMissions. No current adapter does; this branch is
 *                       here so the day one does, seeding is one command.
 *   fixture path      — the DEFAULT. Writes a canonical, byte-deterministic
 *                       JSON document derived from content.js, and prints
 *                       exactly what a future content-table migration must add.
 *
 * ADAPTER SELECTION
 *   STORAGE_ADAPTER=memory|sqlite|auto   (default: auto)
 *     auto   -> use sqlite when ../src/sqlite-store.js exists, else memory
 *     sqlite -> require ../src/sqlite-store.js (fails loudly if absent)
 *     memory -> require ../src/storage.js `createMemoryStore()`
 *   SQLITE_PATH=<file>   sqlite file. DEFAULT: a file under the OS temp dir, so
 *                        seeding never drops a database inside the repository.
 *
 * OUTPUT PATH
 *   SEED_OUTPUT=<file>   default backend-server/data/bounty-board.json.
 *                        That file is GENERATED: do not hand-edit it and do not
 *                        treat it as a second source of truth.
 *
 * IDEMPOTENCE / UPSERT SEMANTICS
 *   Natural keys: article `id` (`art-focus-101`) and mission `id`
 *   (`mission-1`). Re-running NEVER duplicates: the fixture is rendered with a
 *   stable key order and sorted rows, so a second run over unchanged content
 *   produces a byte-identical file and the script reports `unchanged`. Over a
 *   changed content.js the fixture is rewritten wholesale (replace, not append)
 *   and the script prints the rows that differ. On the store-write path the
 *   upsert is keyed on the same natural key, so re-running overwrites the same
 *   row instead of inserting a second copy — that is what "upsert" must mean for
 *   a bounty board whose ids are authored, not generated.
 *
 * FLAGS
 *   --check    verify the existing fixture matches content.js; write nothing.
 *   --print    also print the fixture JSON to stdout (large).
 *
 * No secret, key or credential is read, written or logged by this script.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const content = require("../src/content.js");
const { STORAGE_METHODS } = require("../src/storage.js");

const FIXTURE_SCHEMA_VERSION = 1;

/** Optional adapter methods that, if ALL present, enable the store-write path. */
const CONTENT_STORE_METHODS = Object.freeze([
  "upsertArticle",
  "upsertMission",
  "getArticle",
  "listArticles",
  "listMissions",
]);

const DEFAULT_OUTPUT = path.join(__dirname, "..", "data", "bounty-board.json");

const log = (...args) => console.log(...args);
const warn = (...args) => console.warn("  !! " + args.join(" "));

/**
 * Deterministic JSON: object keys sorted, so two runs over identical content
 * produce identical bytes (and an unchanged fixture is provably unchanged).
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

/** Natural key: the authored id. Never derive a key from position or content. */
function naturalKey(row) {
  return String(row.id);
}

function buildFixture() {
  const missions = content.MISSIONS.map((mission) => ({
    id: mission.id,
    articleId: mission.articleId,
    difficulty: mission.difficulty,
    reward: mission.reward,
    staminaCost: mission.staminaCost,
  })).sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));

  const articles = content.ARTICLES.map((article) => ({
    id: article.id,
    missionId: article.missionId,
    title: article.title,
    difficulty: article.difficulty,
    reward: article.reward,
    staminaCost: article.staminaCost,
    paragraphs: article.paragraphs,
    quiz: article.quiz,
    highlightTask: article.highlightTask,
  })).sort((a, b) => naturalKey(a).localeCompare(naturalKey(b)));

  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    generator: "backend-server/scripts/seed-content.js",
    source: "backend-server/src/content.js",
    note:
      "GENERATED FILE. Re-generate with `node backend-server/scripts/seed-content.js` after editing " +
      "src/content.js. The Judge serves this content from src/content.js at runtime; this fixture is " +
      "the migration input for a future content table, not a runtime dependency.",
    counts: { missions: missions.length, articles: articles.length },
    missions,
    articles,
  };
}

/**
 * Loads the configured storage adapter and reports what it can hold.
 * Never edits the adapter; only reads it.
 */
function loadAdapter(requested) {
  const choice = String(requested || "auto").toLowerCase();
  const sqlitePath = path.resolve(
    process.env.SQLITE_PATH || path.join(os.tmpdir(), "catt-seed", "judge.db")
  );

  if (choice === "sqlite") {
    let sqlite;
    try {
      sqlite = require("../src/sqlite-store.js");
    } catch (error) {
      throw new Error(
        "STORAGE_ADAPTER=sqlite but ../src/sqlite-store.js could not be loaded: " + error.message +
          "\nInstall its dependency (better-sqlite3) or use STORAGE_ADAPTER=memory."
      );
    }
    return { name: "sqlite", store: sqlite.createSqliteStore({ filename: sqlitePath }), sqlitePath };
  }

  if (choice === "memory") {
    const { createMemoryStore } = require("../src/storage.js");
    return { name: "memory", store: createMemoryStore(), sqlitePath: null };
  }

  // auto
  try {
    const sqlite = require("../src/sqlite-store.js");
    return { name: "sqlite", store: sqlite.createSqliteStore({ filename: sqlitePath }), sqlitePath };
  } catch (error) {
    const { createMemoryStore } = require("../src/storage.js");
    return { name: "memory", store: createMemoryStore(), sqlitePath: null };
  }
}

function hasContentStoreMethods(store) {
  return CONTENT_STORE_METHODS.every((name) => typeof store[name] === "function");
}

function printFutureMigration() {
  log("");
  log("  WHAT A FUTURE CONTENT-TABLE MIGRATION MUST ADD");
  log("  ------------------------------------------------");
  log("  The frozen STORAGE_METHODS interface has no article/mission persistence, so this");
  log("  script cannot seed a content table today. When someone adds one, it must be");
  log("  additive: new method names + a new migration version, never a change to an");
  log("  existing method's meaning. Minimal DDL (SQLite dialect; the Postgres/Supabase");
  log("  equivalent is in backend-server/src/storage.js's header):");
  log("");
  log("    -- migration version 2 in ../src/sqlite-store.js MIGRATIONS");
  log("    CREATE TABLE IF NOT EXISTS articles (");
  log("      id              TEXT PRIMARY KEY,          -- natural key: art-focus-101");
  log("      mission_id      TEXT NOT NULL,             -- FK -> missions(id)");
  log("      title           TEXT NOT NULL,");
  log("      difficulty      TEXT NOT NULL,");
  log("      reward          TEXT NOT NULL,             -- 18-dec base units, TEXT (uint256)");
  log("      stamina_cost    TEXT NOT NULL,             -- 18-dec base units, TEXT (uint256)");
  log("      paragraphs_json TEXT NOT NULL,             -- ordered array of paragraphs");
  log("      quiz_json       TEXT NOT NULL,             -- questions + answer key");
  log("      highlight_json  TEXT NOT NULL,             -- highlight task + accepted answers");
  log("      seeded_at       INTEGER NOT NULL");
  log("    );");
  log("    CREATE TABLE IF NOT EXISTS missions (");
  log("      id           TEXT PRIMARY KEY,             -- natural key: mission-1");
  log("      article_id   TEXT NOT NULL,                -- FK -> articles(id)");
  log("      difficulty   TEXT NOT NULL,");
  log("      reward       TEXT NOT NULL,");
  log("      stamina_cost TEXT NOT NULL,");
  log("      seeded_at    INTEGER NOT NULL");
  log("    );");
  log("    CREATE INDEX IF NOT EXISTS missions_article ON missions (article_id);");
  log("");
  log("  Plus the interface additions (frozen list -> v2) and their semantics:");
  log("    upsertMission(mission)  INSERT ... ON CONFLICT(id) DO UPDATE SET ...   -- upsert by id");
  log("    upsertArticle(article)  INSERT ... ON CONFLICT(id) DO UPDATE SET ...   -- upsert by id");
  log("    listMissions()          -> rows ordered by id");
  log("    listArticles()          -> rows ordered by id");
  log("    getArticle(id)          -> row or null");
  log("  and the same five in the memory adapter, plus the Postgres adapter, so the");
  log("  three adapters cannot drift (that is what assertStoreShape is for).");
  log("  Until then: the Judge already serves all 3 articles and 3 missions straight");
  log("  from src/content.js, so a fresh testnet Judge has content with no seeding at all.");
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const alsoPrint = args.includes("--print");
  const unknown = args.filter((a) => a !== "--check" && a !== "--print");
  if (unknown.length > 0) {
    console.error(`Unrecognised argument(s): ${unknown.join(" ")}. Supported: --check, --print.`);
    process.exitCode = 1;
    return;
  }

  log("=".repeat(78));
  log("CATT PROTOCOL — CONTENT SEED");
  log("=".repeat(78));
  log(`source             : backend-server/src/content.js (ARTICLES, MISSIONS)`);
  log(`articles / missions: ${content.ARTICLES.length} / ${content.MISSIONS.length}`);
  log(`storage interface  : ${STORAGE_METHODS.length} methods, none of them article/mission scoped`);

  // Prove the content module is the single source of truth and is internally
  // consistent, so a broken fixture can never be blamed on the loader.
  const ids = new Set();
  for (const article of content.ARTICLES) {
    if (ids.has(article.id)) throw new Error(`duplicate article id in content.js: ${article.id}`);
    ids.add(article.id);
    if (!Array.isArray(article.paragraphs) || article.paragraphs.length < 3) {
      throw new Error(`article ${article.id} has too few paragraphs to be readable`);
    }
  }
  const missionIds = new Set();
  for (const mission of content.MISSIONS) {
    if (missionIds.has(mission.id)) throw new Error(`duplicate mission id in content.js: ${mission.id}`);
    missionIds.add(mission.id);
    if (!ids.has(mission.articleId)) {
      throw new Error(`mission ${mission.id} points at unknown article ${mission.articleId}`);
    }
  }
  log(`natural keys       : ${[...missionIds].sort().join(", ")} / ${[...ids].sort().join(", ")}`);

  /* ---------------------------------------------------------------------- */
  /* Adapter                                                                */
  /* ---------------------------------------------------------------------- */

  let adapter;
  try {
    adapter = loadAdapter(process.env.STORAGE_ADAPTER);
  } catch (error) {
    console.error("");
    console.error("FATAL: " + error.message);
    process.exitCode = 1;
    return;
  }

  log("");
  log(`adapter            : ${adapter.name}`);
  if (adapter.sqlitePath) {
    log(`  sqlite file       : ${adapter.sqlitePath}`);
    log(`  (outside the repository on purpose: seeding must not drop a DB in the repo)`);
  }

  await adapter.store.init();

  const storeCanPersistContent = hasContentStoreMethods(adapter.store);
  log(`content methods    : ${CONTENT_STORE_METHODS.filter((n) => typeof adapter.store[n] === "function").length}/${CONTENT_STORE_METHODS.length} of the optional set`);

  const fixture = buildFixture();

  if (storeCanPersistContent) {
    log("");
    log("PATH: store-write — the adapter exposes the optional content methods.");
    let inserted = 0;
    let updated = 0;
    for (const mission of fixture.missions) {
      const existing = await adapter.store.getArticle(mission.articleId);
      const seen = existing ? updated++ : inserted++;
      await adapter.store.upsertMission(mission);
      log(`  upsertMission ${mission.id} (${seen === 1 ? "update" : "insert"})`);
    }
    for (const article of fixture.articles) {
      const existing = await adapter.store.getArticle(article.id);
      const seen = existing ? updated++ : inserted++;
      await adapter.store.upsertArticle(article);
      log(`  upsertArticle ${article.id} (${seen === 1 ? "update" : "insert"})`);
    }
    log(`  missions: ${inserted} inserted, ${updated} updated (upsert keyed on id)`);
  } else {
    log("");
    log("PATH: fixture — the store interface has NO article/mission persistence, and this");
    log("script will not extend another task's adapter or the frozen STORAGE_METHODS list.");
    warn("no seeding into the store is possible, and none is needed: src/content.js already");
    warn("serves this content in-process. Writing the deterministic fixture instead.");

    const outputPath = path.resolve(process.env.SEED_OUTPUT || DEFAULT_OUTPUT);
    const json = `${stableStringify(fixture)}\n`;
    const existed = fs.existsSync(outputPath);
    const previous = existed ? fs.readFileSync(outputPath, "utf8") : null;

    log("");
    log(`output             : ${outputPath}`);

    if (checkOnly) {
      if (previous === null) {
        warn("--check: fixture does not exist yet.");
        process.exitCode = 1;
      } else if (previous === json) {
        log("check              : PASS — fixture is byte-identical to content.js");
      } else {
        warn("--check: fixture is STALE — re-run without --check to regenerate it.");
        process.exitCode = 1;
      }
    } else if (previous === json) {
      log("result             : unchanged (idempotent — second run over the same content is a no-op)");
    } else {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, json, "utf8");
      log(
        existed
          ? "result             : REWRITTEN (content.js changed; rows are replaced, never appended)"
          : "result             : CREATED"
      );
      log("bytes              : " + Buffer.byteLength(json, "utf8"));
    }

    if (alsoPrint) log(json);
  }

  /* ---------------------------------------------------------------------- */
  /* Post-conditions: the Judge can serve the board                         */
  /* ---------------------------------------------------------------------- */

  log("");
  log("READ-BACK CHECK (through the same accessor the server uses)");
  for (const mission of content.MISSIONS) {
    const found = content.getMission(mission.id);
    const article = content.getArticle(mission.articleId);
    if (!found || !article) {
      throw new Error(`content.js cannot resolve mission ${mission.id} / article ${mission.articleId}`);
    }
    log(`  ${mission.id} -> ${article.id} (${article.difficulty}) reward ${article.reward} CATT units`);
  }
  const layout = content.getArticleLayout(content.ARTICLES[0].id, "seed-content-smoke-session");
  log(`  layout determinism: ${content.ARTICLES[0].id} rendered for a fixed session id (trap ${layout.focusTrap.type} @ ${layout.focusTrap.index})`);

  if (adapter.store.close) {
    try {
      await adapter.store.close();
    } catch (_) {
      /* closing is best-effort */
    }
  }

  printFutureMigration();

  log("");
  log("=".repeat(78));
  log("SEED COMPLETE");
  log("=".repeat(78));
  process.exitCode = 0;
}

main().catch((error) => {
  console.error("");
  console.error("SEED FAILED:");
  console.error(error && error.stack ? error.stack : String(error));
  console.error("");
  process.exitCode = 1;
});