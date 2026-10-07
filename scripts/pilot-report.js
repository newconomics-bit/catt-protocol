#!/usr/bin/env node
/**
 * CATT Protocol — Pilot Weekly Report Generator
 *
 * Reads the Judge's SQLite store and prints a privacy-minimal weekly summary:
 * - Telemetry score distribution (histogram buckets)
 * - BATTERY_NOT_REPORTED rate
 * - FAIL reason counts
 * - Missions per user per day (average)
 * - Governor daily spend totals (budget pressure)
 * - Active miners trend
 *
 * Usage:
 *   CATT_STORE=sqlite SQLITE_PATH=/path/to/judge.db node scripts/pilot-report.js
 *
 * The script uses the same storage adapter as the Judge, so it works with
 * both memory and SQLite stores. For a weekly report, run against the
 * production SQLite database.
 *
 * NO personal data is printed: only aggregate counts and distributions.
 */

"use strict";

const path = require("node:path");
const { getStorageAdapter } = require("../backend-server/src/storage");
const { content } = require("../backend-server/src/content");

/**
 * Generate WIB business day keys for the last N days (including today).
 * @param {number} days Number of days to include (default 7).
 * @returns {string[]} Array of YYYY-MM-DD day keys, newest first.
 */
function getLastNDayKeys(days = 7) {
  const now = Date.now();
  const keys = [];
  for (let i = 0; i < days; i++) {
    const dayKey = content.dayKeyFor(now - i * 86400000);
    keys.push(dayKey);
  }
  return keys;
}

/**
 * Format a number with commas.
 */
function fmt(n) {
  return Number(n).toLocaleString();
}

/**
 * Format a rate as percentage with 1 decimal.
 */
function pct(n) {
  return (n * 100).toFixed(1) + "%";
}

/**
 * Print a section header.
 */
function header(title) {
  console.log("");
  console.log("=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

/**
 * Print a key-value pair.
 */
function kv(key, value) {
  console.log(`  ${key.padEnd(36)} ${value}`);
}

async function main() {
  const storeType = process.env.CATT_STORE || "memory";
  const adapter = getStorageAdapter(storeType);
  if (!adapter) {
    console.error(`Unknown store type: ${storeType}`);
    console.error(`Available: ${getStorageAdapter("memory").id}, ${getStorageAdapter("sqlite").id}`);
    process.exit(1);
  }

  const options = {};
  if (storeType === "sqlite") {
    options.filename = process.env.SQLITE_PATH;
  }

  console.log(`CATT Protocol — Pilot Weekly Report`);
  console.log(`Store: ${adapter.description}`);
  console.log(`Generated: ${new Date().toISOString()}`);

  const store = adapter.load(options);
  await store.init();

  try {
    // 1. Telemetry Score Distribution
    header("TELEMETRY SCORE DISTRIBUTION");
    const scoreDist = await store.getTelemetryScoreDistribution();
    let totalScores = 0;
    for (const [bucket, count] of Object.entries(scoreDist)) {
      totalScores += count;
    }
    if (totalScores === 0) {
      console.log("  No telemetry data recorded.");
    } else {
      for (const [bucket, count] of Object.entries(scoreDist)) {
        const bar = "█".repeat(Math.round((count / totalScores) * 30));
        kv(`${bucket}:`, `${fmt(count)} (${pct(count / totalScores)}) ${bar}`);
      }
      kv("Total samples", fmt(totalScores));
    }

    // 2. Battery Not Reported Rate
    header("BATTERY TELEMETRY COVERAGE");
    const batteryRate = await store.getBatteryNotReportedRate();
    kv("Total samples", fmt(batteryRate.totalSamples));
    kv("Battery NOT reported", fmt(batteryRate.batteryNotReported));
    kv("Reported", fmt(batteryRate.totalSamples - batteryRate.batteryNotReported));
    kv("BATTERY_NOT_REPORTED rate", pct(batteryRate.rate));

    // 3. FAIL Reason Counts
    header("FAIL REASON COUNTS");
    const failCounts = await store.getFailReasonCounts();
    if (Object.keys(failCounts).length === 0) {
      console.log("  No FAIL submissions recorded.");
    } else {
      // Sort by count descending
      const sorted = Object.entries(failCounts).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sorted) {
        kv(reason, fmt(count));
      }
    }

    // 4. Missions per User per Day
    header("MISSIONS PER USER PER DAY (graded completions)");
    const missionsPerUser = await store.getMissionsPerUserPerDay();
    kv("Average missions/user/day", missionsPerUser.average.toFixed(2));
    kv("Active users (with ≥1 completion)", fmt(Object.keys(missionsPerUser.perUser).length));
    // Show top 10 users by mission count
    const topUsers = Object.entries(missionsPerUser.perUser)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (topUsers.length > 0) {
      console.log("  Top 10 users by completions:");
      for (const [user, count] of topUsers) {
        console.log(`    ${user.slice(0, 10)}... : ${count}`);
      }
    }

    // 5. Governor Engagements (Daily Spend Totals)
    header("GOVERNOR DAILY SPEND (budget pressure)");
    const governor = await store.getGovernorEngagements();
    if (Object.keys(governor.dailySpendTotals).length === 0) {
      console.log("  No governor spend recorded (governor may be disabled or no claims yet).");
    } else {
      const sortedDays = Object.entries(governor.dailySpendTotals)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-7); // Last 7 days
      for (const [key, spent] of sortedDays) {
        const [season, day] = key.split("|");
        const spentCatt = (BigInt(spent) / 10n**18n).toString();
        console.log(`  ${day} (${season}): ${spentCatt} CATT spent`);
      }
    }

    // 6. Active Miners Trend (last 7 days)
    header("ACTIVE MINERS (last 7 WIB business days)");
    const dayKeys = getLastNDayKeys(7);
    for (const dayKey of dayKeys) {
      const count = await store.countActiveMiners({ dayKey });
      kv(dayKey, fmt(count));
    }

    // 7. Season Pool Status (if seasons enabled)
    header("SEASON POOL STATUS");
    try {
      const seasons = require("../backend-server/src/seasons");
      const nowSeconds = Math.floor(Date.now() / 1000);
      const activeSeason = await store.getActiveSeason(nowSeconds);
      if (activeSeason) {
        const remaining = await seasons.remainingForSeason(store, activeSeason.id);
        const claimedTotal = await store.getSeasonClaimedTotal(activeSeason.id);
        const allocation = remaining.allocation;
        const claimedCatt = (BigInt(claimedTotal) / 10n**18n).toString();
        const remainingCatt = (BigInt(remaining.remaining) / 10n**18n).toString();
        const allocationCatt = (BigInt(allocation) / 10n**18n).toString();
        const pctUsed = ((BigInt(claimedTotal) * 10000n) / BigInt(allocation)).toString();
        kv(`Active season`, activeSeason.id);
        kv(`Allocation`, `${allocationCatt} CATT`);
        kv(`Claimed`, `${claimedCatt} CATT`);
        kv(`Remaining`, `${remainingCatt} CATT`);
        kv(`Used`, `${(Number(pctUsed) / 100).toFixed(2)}%`);
        kv(`Exhausted`, remaining.exhausted ? "YES" : "NO");
      } else {
        console.log("  No active season (before epoch or schedule not written).");
      }
    } catch (e) {
      console.log("  Seasons module not available or error:", e.message);
    }

  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error("Report generation failed:", err);
  process.exit(1);
});