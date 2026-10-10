/**
 * CATT Protocol — MockUSDT deployer (STANDALONE / phone-only path).
 *
 * Deploys contracts/mocks/MockUSDT.sol — the TEST-ONLY, 6-decimal
 * mock stablecoin — and prints its address, so the operator can put
 * it in YIELD_TOKEN_ADDRESS for a later BondManager deployment.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * Same reason as deploy-testnet-standalone.js: hardhat@2 loads its
 * Solidity parser from a napi-rs native module that has no
 * Termux/Android-ARM build, so every hardhat entry point dies with
 * Error HH18 at requireNapiRsModule on the phone. This script never
 * requires hardhat: it deploys with plain ethers v6 straight from
 * the committed compiled artifact (artifacts/ is tracked in git).
 *
 * Usage
 * -----
 *   # Termux / Android-ARM (the reason this script exists):
 *   cd smart-contracts
 *   node scripts/deploy-mock-yield-standalone.js
 *
 *   # Dry run against a local node (start `npx hardhat node` first;
 *   # the well-known first account of the local node is used when
 *   # PRIVATE_KEY is unset):
 *   node scripts/deploy-mock-yield-standalone.js --local
 *
 *   # On a laptop/CI with a working hardhat toolchain, the mock can
 *   # also be deployed as part of the full deploy:
 *   MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon
 *
 * WARNING
 * -------
 * MockUSDT is PERMISSIONLESS and UNCAPPED: anybody can mint as much
 * of it as they like, so it has none of the properties of a real
 * stablecoin. It exists to prove BondManager's yield accounting is
 * decimals-agnostic. ANY testnet liquidity, any bond yield and any
 * accounting derived from this token is WORTHLESS. Never use it on a
 * network where tokens have value.
 *
 * Required environment (remote runs only; see smart-contracts/.env.example)
 * ----------------------------------------------------------------------------
 *   PRIVATE_KEY       Deployer key. 0x + 64 hex. The first key of a
 *                     comma-separated list signs — exactly the account
 *                     hardhat.config.js uses as the first signer on the
 *                     "polygon" network. NOT required with --local.
 *   POLYGON_RPC_URL   JSON-RPC endpoint. Point at Polygon Amoy
 *                     (chain id 80002) for a testnet deployment.
 *                     NOT required with --local (defaults to
 *                     http://127.0.0.1:8545).
 *
 * No private key, mnemonic or RPC credential is hardcoded here (PRD Rule 2).
 * The only key constant in this file is the PUBLIC, value-less first
 * account of a local hardhat node, used solely for --local dry runs.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Load .env — the same dotenv load hardhat.config.js performs for the
// hardhat-based path. There is no hardhat config, no hardhat task,
// no compilation in this script.
require("dotenv").config();

// Plain ethers v6. There is deliberately NO require("hardhat") anywhere
// in this file: hardhat's Solidity parser is a napi-rs native module
// with no Termux/Android-ARM build (Error HH18 at requireNapiRsModule),
// and this script must run on the phone without ever loading it.
const { ethers } = require("ethers");

/** Committed compiled artifact for the mock yield token. */
const MOCK_USDT_ARTIFACT = "artifacts/contracts/mocks/MockUSDT.sol/MockUSDT.json";

/**
 * The network this script deploys to. hardhat.config.js defines exactly
 * one deployable network, named "polygon", which reads POLYGON_RPC_URL
 * and PRIVATE_KEY; there is no separate Amoy alias, so an Amoy
 * deployment is a deployment to the "polygon" network with
 * POLYGON_RPC_URL pointed at an Amoy RPC (chain id 80002).
 */
const NETWORK_NAME_REMOTE = "polygon";

/** Default RPC for --local runs: a `npx hardhat node` process. */
const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8545";

/**
 * The PUBLIC, value-less first account of a local hardhat node (the
 * default hardhat mnemonic's account #0). Used ONLY for --local dry
 * runs when PRIVATE_KEY is unset — never for a real network, where
 * PRIVATE_KEY is required. It holds no real funds anywhere.
 */
const HARDHAT_DEFAULT_ACCOUNT_0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Chain ids that hold real value; deploying a mock there is a mistake. */
const MAINNET_CHAIN_IDS = new Set([
  1n, // Ethereum
  10n, // Optimism
  56n, // BNB Chain
  137n, // Polygon
  250n, // Fantom
  42161n, // Arbitrum One
  43114n, // Avalanche
  8453n, // Base
]);

/** Polygon Amoy testnet chain id. */
const DEFAULT_EXPECTED_CHAIN_ID = 80002n;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const log = (...args) => console.log(...args);
const banner = (title) => {
  log("");
  log("=".repeat(78));
  log(title);
  log("=".repeat(78));
};

function warn(message) {
  console.warn(`  !! ${message}`);
}

function fatal(message, hint) {
  console.error("");
  console.error("FATAL: " + message);
  if (hint) {
    console.error("");
    console.error(hint);
  }
  console.error("");
  process.exitCode = 1;
  throw new Error(message);
}

function parseFlags(argv) {
  const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));
  const flags = {
    local: truthy(process.env.LOCAL),
    force: truthy(process.env.FORCE),
    unknown: [],
  };
  for (const arg of argv) {
    if (arg === "--local") flags.local = true;
    else if (arg === "--force") flags.force = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

const isLocalhostUrl = (url) =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(String(url || "").trim());

/** Reads env and collects every missing/blank value so the operator fixes them in one pass. */
function collectRequiredEnv(names) {
  const missing = [];
  const value = {};
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      missing.push(name);
    } else {
      value[name] = String(raw).trim();
    }
  }
  return { value, missing };
}

/** Reads the committed MockUSDT artifact; fails fast if it is absent. */
function loadMockUsdtArtifact() {
  const absPath = path.resolve(__dirname, "..", MOCK_USDT_ARTIFACT);
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (_) {
    fatal(
      `compiled artifact for MockUSDT is missing: ${absPath}`,
      "This script deploys from the COMPILED artifact committed to the repo\n" +
        "(artifacts/ is tracked in git), so no compilation step is needed.\n" +
        "If this file is absent, the checkout is incomplete — re-clone or\n" +
        "restore the tracked artifacts. On a machine with a working hardhat\n" +
        "toolchain it can be regenerated with:\n" +
        "    cd smart-contracts && npx hardhat compile\n" +
        "On Termux/Android-ARM that command fails (Error HH18: the napi-rs\n" +
        "Solidity parser has no Android build) — which is exactly why this\n" +
        "script exists."
    );
  }
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch (error) {
    fatal(`compiled artifact for MockUSDT is not valid JSON: ${absPath}`, String(error));
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    fatal(`compiled artifact for MockUSDT has no ABI: ${absPath}`);
  }
  if (
    typeof artifact.bytecode !== "string" ||
    !artifact.bytecode.startsWith("0x") ||
    artifact.bytecode.length < 4
  ) {
    fatal(
      `compiled artifact for MockUSDT has no bytecode: ${absPath}`,
      "The committed artifact is incomplete. Regenerate it on a machine with a\n" +
        "working hardhat toolchain:  cd smart-contracts && npx hardhat compile"
    );
  }
  return artifact;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.unknown.length > 0) {
    fatal(
      `Unrecognised argument(s): ${flags.unknown.join(" ")}`,
      "Supported flags: --local, --force.\n" +
        'For a real testnet deploy, point POLYGON_RPC_URL at Polygon Amoy — the\n' +
        'same "polygon" network hardhat.config.js defines.'
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 0. Network selection                                                   */
  /* ---------------------------------------------------------------------- */

  // There is no hardhat `run` task here, so there is no hre.network.name
  // to read. The network is derived from the RPC URL instead: --local,
  // or a localhost POLYGON_RPC_URL, targets a local node; anything else
  // is the "polygon" network from hardhat.config.js (Amoy via
  // POLYGON_RPC_URL, chain id 80002).
  const rawRpcUrl = (process.env.POLYGON_RPC_URL || "").trim();
  const isLocalRun = flags.local || (rawRpcUrl !== "" && isLocalhostUrl(rawRpcUrl));

  let rpcUrl;
  if (isLocalRun) {
    rpcUrl = rawRpcUrl !== "" ? rawRpcUrl : DEFAULT_LOCAL_RPC_URL;
    if (flags.local && rawRpcUrl !== "" && !isLocalhostUrl(rawRpcUrl)) {
      warn(`--local was passed but POLYGON_RPC_URL (${rawRpcUrl}) is not a localhost URL.`);
    }
  } else {
    // Required for remote runs; validated below.
    rpcUrl = rawRpcUrl;
  }

  const networkName = isLocalRun ? "localhost" : NETWORK_NAME_REMOTE;

  banner("CATT PROTOCOL — MOCKUSDT DEPLOYMENT (standalone, artifact-direct)");
  log(`network            : ${networkName}${isLocalRun ? " (local node)" : ' (the "polygon" network from hardhat.config.js)'}`);
  log(`rpc                : ${rpcUrl}`);
  log(`deploy path        : ethers v6 + committed artifact (no hardhat, no Solidity parser)`);

  /* ---------------------------------------------------------------------- */
  /* 1. Configuration + fail-fast environment validation                    */
  /* ---------------------------------------------------------------------- */

  const requiredEnvNames = [];
  if (!isLocalRun) {
    requiredEnvNames.push("PRIVATE_KEY", "POLYGON_RPC_URL");
  }

  const { value: env, missing } = collectRequiredEnv(requiredEnvNames);
  if (missing.length > 0) {
    fatal(
      `Missing required environment variable(s): ${missing.join(", ")}.`,
      [
        "Set them in smart-contracts/.env (git-ignored) or export them in the shell:",
        ...requiredEnvNames.map((name) => `  ${name}=...`),
        "",
        "Descriptions:",
        "  PRIVATE_KEY           deployer key, 0x + 64 hex (the first key of a comma-separated list signs)",
        "  POLYGON_RPC_URL       Polygon Amoy testnet JSON-RPC endpoint (chain id 80002)",
        "",
        "Tip: --local (or a localhost POLYGON_RPC_URL) runs against a local node and needs no PRIVATE_KEY.",
      ].join("\n")
    );
  }

  // The deployer key: the FIRST key of the comma-separated PRIVATE_KEY
  // list — exactly the account hardhat.config.js uses as the first signer
  // on the "polygon" network. In local mode a PRIVATE_KEY is optional
  // and defaults to the well-known first account of a local hardhat node.
  const privateKeyEnv = (process.env.PRIVATE_KEY || "").trim();
  let privateKey;
  let privateKeySource;
  if (privateKeyEnv !== "") {
    privateKey = privateKeyEnv.split(",")[0].trim();
    privateKeySource = "PRIVATE_KEY[0]";
  } else if (isLocalRun) {
    privateKey = HARDHAT_DEFAULT_ACCOUNT_0_KEY;
    privateKeySource = "hardhat node default account #0 (local dry-run default)";
    warn(
      "PRIVATE_KEY is not set: using the well-known first account of a local\n" +
        "        hardhat node. This is ONLY safe against a local node — against a real\n" +
        "        network PRIVATE_KEY is required and the script aborts without it."
    );
  } else {
    // Unreachable for remote runs: PRIVATE_KEY is in requiredEnvNames and
    // the collectRequiredEnv check above already aborted. Kept as a guard.
    fatal(
      "PRIVATE_KEY is required for a non-local deployment.",
      "Set PRIVATE_KEY in smart-contracts/.env (git-ignored) or export it in the shell."
    );
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    fatal(
      `PRIVATE_KEY[0] is not a valid private key (expected 0x followed by 64 hex characters, got "${privateKey.slice(0, 12)}...").`,
      "The first key of the comma-separated PRIVATE_KEY list is the deployer."
    );
  }

  // cacheTimeout: -1 disables ethers' 250ms JSON-RPC response
  // cache (see the matching note in deploy-testnet-standalone.js:
  // rapid sequential transactions must never read a stale
  // eth_getTransactionCount).
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  const deployer = new ethers.Wallet(privateKey, provider);
  const deployerAddress = await deployer.getAddress();

  const liveChainId = BigInt((await provider.getNetwork()).chainId);
  const balanceWei = await provider.getBalance(deployerAddress);

  banner("PRE-FLIGHT");
  log(`network            : ${networkName} (chain id ${liveChainId})`);
  log(`deployer           : ${deployerAddress}   (${privateKeySource})`);
  log(`deployer balance   : ${ethers.formatEther(balanceWei)} native token`);

  if (balanceWei === 0n) {
    fatal(
      "The deployer account has no native token, so no deployment transaction can be sent.",
      "Fund it with testnet MATIC (Amoy faucet) or run with --local against a local node."
    );
  }

  if (isLocalRun) {
    warn(`running against a LOCAL network (RPC: ${rpcUrl}): nothing is broadcast to any real chain.`);
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Chain id guard                                                      */
  /* ---------------------------------------------------------------------- */

  const expectedChainId = process.env.EXPECTED_CHAIN_ID
    ? BigInt(String(process.env.EXPECTED_CHAIN_ID).trim())
    : DEFAULT_EXPECTED_CHAIN_ID;

  if (!isLocalRun && liveChainId !== expectedChainId) {
    if (MAINNET_CHAIN_IDS.has(liveChainId)) {
      if (!flags.force) {
        fatal(
          `The configured RPC is on chain id ${liveChainId}, a MAINNET, but EXPECTED_CHAIN_ID is ${expectedChainId}.`,
          "This script deploys a TEST-ONLY mock token. Refusing to touch a value-bearing chain.\n" +
            "Point POLYGON_RPC_URL at Polygon Amoy (80002), or pass --force if you truly mean it."
        );
      }
      warn(`chain id ${liveChainId} is a MAINNET and --force was passed. You are on your own.`);
    } else {
      warn(`chain id is ${liveChainId}, not the expected ${expectedChainId} (Polygon Amoy). Continuing.`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Deploy MockUSDT from the committed artifact                     */
  /* ---------------------------------------------------------------------- */

  banner("DEPLOY — MockUSDT (TEST-ONLY mock stablecoin)");
  const artifact = loadMockUsdtArtifact();
  log(`artifact           : ${MOCK_USDT_ARTIFACT}  (${artifact.abi.length} ABI entries)`);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const mock = await factory.deploy();
  const receipt = await mock.deploymentTransaction().wait();
  const mockAddress = await mock.getAddress();

  log(`MockUSDT           : ${mockAddress}   tx ${receipt.hash}`);
  log("");
  warn("MockUSDT is PERMISSIONLESS and UNCAPPED: anybody can mint it. It is a");
  warn("6-decimal test double with none of the properties of a real stablecoin.");
  warn("ANY testnet liquidity, any bond yield and any accounting derived from");
  warn("this token is WORTHLESS. Never use it on a network where tokens have value.");
  log("");

  banner("DEPLOYMENT SUMMARY");
  log(`  network          : ${networkName} (chain id ${liveChainId})`);
  log(`  deployer         : ${deployerAddress}`);
  log(`  MockUSDT         : ${mockAddress}`);
  log(`  deploy tx        : ${receipt.hash}`);
  log("");
  log("  NEXT");
  log("  1. put this address in YIELD_TOKEN_ADDRESS for a BondManager deployment,");
  log("     or deploy the full protocol with MOCK_YIELD=true, which deploys its own");
  log("     MockUSDT as part of the wiring (scripts/deploy-testnet-standalone.js).");
  log("");
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                 */
/* -------------------------------------------------------------------------- */

// NOTE: there is deliberately NO compile step here. The compiled artifact
// is committed to the repo (see MOCK_USDT_ARTIFACT above), and invoking
// hardhat's compile task is precisely what fails on Termux/Android-ARM
// with Error HH18 at requireNapiRsModule. This script must remain free
// of any require("hardhat") so the napi-rs Solidity parser is never
// loaded.

main().catch((error) => {
  console.error("");
  console.error("DEPLOYMENT FAILED:");
  console.error(error && error.stack ? error.stack : String(error));
  console.error("");
  process.exitCode = 1;
});
