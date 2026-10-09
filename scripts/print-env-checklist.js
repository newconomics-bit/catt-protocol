#!/usr/bin/env node
/**
 * CATT Protocol — Backend Env Checklist Generator
 *
 * Reads smart-contracts/deployed-testnet.json and prints the exact
 * backend-server/.env lines with public values filled in and secrets
 * as named placeholders.
 *
 * Usage:
 *   node scripts/print-env-checklist.js
 *   node scripts/print-env-checklist.js --path /custom/path/deployed-testnet.json
 *
 * Output can be redirected to backend-server/.env:
 *   node scripts/print-env-checklist.js > backend-server/.env
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function parseArgs() {
  const args = process.argv.slice(2);
  let manifestPath = path.join(__dirname, "..", "smart-contracts", "deployed-testnet.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) {
      manifestPath = args[i + 1];
      i++;
    }
  }
  return manifestPath;
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`✗ Manifest not found: ${manifestPath}`);
    console.error("  Run smart-contracts deployment first, or specify --path");
    process.exit(1);
  }
  const content = fs.readFileSync(manifestPath, "utf8");
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error(`✗ Invalid JSON in manifest: ${e.message}`);
    process.exit(1);
  }
}

function formatBigInt(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return String(value);
}

function main() {
  const manifestPath = parseArgs();
  const manifest = loadManifest(manifestPath);

  const contracts = manifest.contracts || {};
  const network = manifest.network || {};
  const backend = manifest.backend || {};

  const chainId = network.chainId || 80002;
  const miningClaimer = contracts.MiningClaimer?.address || "";
  const cattToken = contracts.CATT?.address || "";
  const stakingManager = contracts.StakingManager?.address || "";
  const bondManager = contracts.BondManager?.address || "";
  const teamVesting = contracts.TeamVesting?.address || "";
  const yieldToken = manifest.yieldToken?.address || "";

  const deployer = manifest.deployer || "";
  const signerAddress = backend.signerAddress || "";

  // Generate a random admin token if not provided
  const adminTokenPlaceholder = "YOUR_ADMIN_TOKEN_HERE  # generate: openssl rand -hex 32";

  const lines = [
    "# CATT Protocol backend environment — GENERATED FROM deployed-testnet.json",
    "# Public values filled from deployment manifest. Secrets marked as PLACEHOLDERS.",
    "# Copy this output to backend-server/.env and fill in the placeholders.",
    "#",
    `# Generated: ${new Date().toISOString()}`,
    `# Source: ${manifestPath}`,
    `# Network: ${network.name || "unknown"} (chain id ${chainId})`,
    "",
    "# ===========================================================================",
    "# REQUIRED SECRETS (fill these in — NEVER commit real values)",
    "# ===========================================================================",
    "",
    "# Private key of the backend signer (the address allowed by MiningClaimer).",
    "# READ BY backend-server/signer.js. NEVER commit this value, never log it.",
    "# 32-byte hex private key, e.g. 0x followed by 64 hex characters.",
    `SIGNER_PRIVATE_KEY=PLACEHOLDER_SIGNER_PRIVATE_KEY  # private key for ${signerAddress || "SIGNER_ADDRESS from deploy"}`,
    "",
    "# Private key of the RELAYER (gas sponsor). Separate from SIGNER_PRIVATE_KEY.",
    "# READ BY backend-server/src/relay.js. NEVER commit, NEVER log.",
    "# Fund this address with Amoy MATIC for gas.",
    "RELAYER_PRIVATE_KEY=PLACEHOLDER_RELAYER_PRIVATE_KEY",
    "",
    "# JSON-RPC endpoint for Polygon Amoy (chain id 80002).",
    "# Used by relay to broadcast claims and by Judge for read-only calls.",
    "RPC_URL=https://polygon-amoy.g.alchemy.com/v2/YOUR_API_KEY  # or Infura/QuickNode",
    "",
    "# Admin token for GET /api/admin/pilot-report (phone browser access).",
    "# Generate: openssl rand -hex 32",
    `ADMIN_TOKEN=${adminTokenPlaceholder}`,
    "",
    "# ===========================================================================",
    "# PUBLIC CONFIGURATION (from deployment manifest)",
    "# ===========================================================================",
    "",
    "# EVM chain id used as EIP-712 domain separator.",
    `CHAIN_ID=${chainId}`,
    "",
    "# Address of the deployed MiningClaimer contract.",
    `MINING_CLAIMER_ADDRESS=${miningClaimer}`,
    "",
    "# Address of the deployed CATT token contract.",
    `CATT_TOKEN_ADDRESS=${cattToken}`,
    "",
    "# Address of the deployed StakingManager contract.",
    `STAKING_MANAGER_ADDRESS=${stakingManager}`,
    "",
    "# Address of the deployed BondManager contract.",
    `BOND_MANAGER_ADDRESS=${bondManager}`,
    "",
    "# Address of the deployed TeamVesting contract.",
    `TEAM_VESTING_ADDRESS=${teamVesting}`,
    "",
    "# Yield token for BondManager (MockUSDT or real stablecoin).",
    `YIELD_TOKEN_ADDRESS=${yieldToken}`,
    "",
    "# ===========================================================================",
    "# STORAGE (optional)",
    "# ===========================================================================",
    "",
    '# Which storage adapter: "memory" (default, volatile) or "sqlite" (persistent).',
    "CATT_STORE=sqlite",
    "",
    "# Database file for sqlite adapter. Default outside repo working tree.",
    "SQLITE_PATH=/data/data/com.termux/files/home/catt-judge/judge.db",
    "",
    "# ===========================================================================",
    "# LIVE ECONOMY FLAGS (all ON by default — only explicit false/0/off disables)",
    "# ===========================================================================",
    "",
    "# Dynamic emission — rewards shrink as active miners grow.",
    "CATT_DYNAMIC_EMISSION=",
    "",
    "# Top of dynamic-emission ramp (active miners). Default 50000.",
    "CATT_DYNAMIC_EMISSION_FLOOR_MINERS=",
    "",
    "# Streak multiplier — consecutive graded days raise reward.",
    "CATT_STREAK_MULTIPLIER=",
    "",
    "# Seasons — twelve 30-day windows, 3.3M CATT each, hard cap.",
    "CATT_SEASONS=",
    "",
    "# Season epoch (unix seconds). Unset = boot time (season 1 starts now).",
    "CATT_SEASON_EPOCH=",
    "",
    "# Free stamina — 30 points per user per WIB business day.",
    "CATT_FREE_STAMINA=",
    "",
    "# Daily stamina SPEND ceiling (unitless points). Default 50.",
    "CATT_DAILY_STAMINA_CAP=",
    "",
    "# Governor (S1+S2) — daily budget normaliser (110k CATT/day, floors 3/5/10).",
    "CATT_GOVERNOR=",
    "",
    "# ===========================================================================",
    "# DEPLOYMENT METADATA (for reference)",
    "# ===========================================================================",
    "",
    `# Deployer: ${deployer}`,
    `# Signer Address: ${signerAddress}`,
    `# Genesis Total: ${manifest.initialAllocation?.totalMintedFormatted || "unknown"}`,
    `# Mining Headroom: ${manifest.initialAllocation?.miningHeadroom ? formatBigInt(manifest.initialAllocation.miningHeadroom) : "unknown"}`,
    `# Season Count: ${manifest.contracts ? "12 (per PRD 3.5)" : "unknown"}`,
    `# Season Allocation: 3,300,000 CATT each`,
    `# Daily Budget: 110,000 CATT`,
    `# Governor Floors: EASY 3 CATT, MEDIUM 5 CATT, HARD 10 CATT`,
  ];

  console.log(lines.join("\n"));
}

main();