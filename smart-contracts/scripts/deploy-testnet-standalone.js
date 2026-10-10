/**
 * CATT Protocol — TESTNET deployment script (STANDALONE / phone-only path).
 *
 * Deploys and wires the whole on-chain system (CATT, TeamVesting,
 * StakingManager, BondManager, MiningClaimer) in the ONLY order that
 * leaves a working protocol — the order mandated by `MiningClaimer`'s
 * own `DeploymentNotes` NatSpec header (see the DEPLOYMENT ORDER block
 * below). It deploys and wires EXACTLY what scripts/deploy-testnet.js
 * deploys and wires: same deployment order, same wiring sequence, same
 * verification checks, same deployed-testnet.json manifest. The ONLY
 * difference is HOW contracts are loaded: this script never requires
 * hardhat, so the Solidity parser is never invoked.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * hardhat@2 loads its Solidity parser from a napi-rs native module
 * that has no Termux/Android-ARM build. On the phone, every hardhat
 * entry point that can reach the parser dies with
 *
 *     Error HH18 ... at requireNapiRsModule (hardhat/src/common/napi-rs.ts)
 *
 * — including `npx hardhat run scripts/deploy-testnet.js --no-compile`,
 * because hardhat's `run` task triggers the compile task internally
 * (the `--no-compile` flag does NOT suppress that nested compile).
 * This script bypasses hardhat entirely: it deploys with plain ethers
 * v6 straight from the COMPILED artifacts that are committed to the
 * repo (artifacts/ is tracked in git), so the Solidity parser — the
 * only component that calls into napi-rs — is never loaded.
 *
 * Usage
 * -----
 *   # Termux / Android-ARM (the reason this script exists).
 *   # .env holds PRIVATE_KEY, POLYGON_RPC_URL (Amoy), SIGNER_ADDRESS,
 *   # TEAM_BENEFICIARY, TREASURY_BENEFICIARY, MARKETING_WALLET:
 *   cd smart-contracts
 *   node scripts/deploy-testnet-standalone.js
 *
 *   # Same, with the TEST-ONLY mock stablecoin as the yield token:
 *   MOCK_YIELD=true node scripts/deploy-testnet-standalone.js
 *
 *   # Dry run against a local node (start `npx hardhat node` first, on a
 *   # machine that has a working hardhat; when PRIVATE_KEY is unset the
 *   # well-known first account of the local node is used):
 *   node scripts/deploy-testnet-standalone.js --local --mock-yield --dry-run
 *
 *   # On a laptop/CI with a working hardhat toolchain, the original
 *   # hardhat-based script remains the canonical path:
 *   MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon
 *
 * Flags
 * -----
 *   --mock-yield     Deploy contracts/mocks/MockUSDT.sol and use it as the
 *                    BondManager yield token. TEST-ONLY: the mock is
 *                    permissionless and uncapped, so anybody can print the
 *                    token the bond pool pays out in. Never use it on a
 *                    network where tokens have value. Env: MOCK_YIELD=true.
 *   --local          Target a LOCAL node (default RPC http://127.0.0.1:8545,
 *                    e.g. `npx hardhat node`). Skips the chain-id guard and
 *                    the PRIVATE_KEY requirement. Also implied when
 *                    POLYGON_RPC_URL points at localhost/127.0.0.1/[::1].
 *                    Env: LOCAL=true.
 *   --force          Overwrite an existing deployed-testnet.json instead of
 *                    refusing. Without it the script REFUSES to run.
 *                    Env: FORCE=true.
 *   --dry-run        Deploy and verify, but do NOT write deployed-testnet.json.
 *                    Env: DRY_RUN=true.
 *
 * Required environment (see smart-contracts/.env.example and docs/TESTNET_DEPLOYMENT.md)
 * ----------------------------------------------------------------------------
 *   PRIVATE_KEY             Deployer key. 0x + 64 hex. Comma-separated for
 *                           multiple keys (the FIRST key signs — exactly the
 *                           account hardhat.config.js uses as the first signer
 *                           on the "polygon" network). NOT required with
 *                           --local / a localhost RPC.
 *   POLYGON_RPC_URL         JSON-RPC endpoint. Must be the TESTNET endpoint
 *                           (Polygon Amoy, chain id 80002) for a testnet
 *                           deploy. NOT required with --local (defaults to
 *                           http://127.0.0.1:8545).
 *   SIGNER_ADDRESS          Backend Judge address -> MiningClaimer `signer`.
 *                           MUST be a real, non-zero address; the script fails
 *                           fast without it.
 *   TEAM_BENEFICIARY        15,000,000 CATT vesting beneficiary.
 *   TREASURY_BENEFICIARY    20,000,000 CATT vesting beneficiary. Must differ
 *                           from TEAM_BENEFICIARY (TeamVesting reverts on a
 *                           duplicate beneficiary).
 *   MARKETING_WALLET         Recipient of the SEPARATE 15,000,000 CATT
 *                           marketing allocation. REQUIRED: marketing is its
 *                           own labelled bucket, it is never folded into the
 *                           liquidity bucket, and it deliberately has NO
 *                           default — the deployer is not an acceptable
 *                           destination. The script aborts if it is unset and
 *                           warns loudly if it collides with another
 *                           destination.
 *   LIQUIDITY_WALLET         Recipient of the 10,000,000 CATT DEX liquidity
 *                           allocation. Optional; defaults to the deployer
 *                           with a loud warning, because on a testnet the
 *                           deployer is fine.
 *   YIELD_TOKEN_ADDRESS     Real stablecoin for BondManager. Required unless
 *                           --mock-yield / MOCK_YIELD=true.
 *   INITIAL_SUPPLY          Optional. Genesis mint total in whole CATT. It is
 *                           DERIVED from the four buckets below and defaults to
 *                           60,000,000. If set, it must equal that derived
 *                           total exactly: the script refuses to run rather
 *                           than mint a genesis supply the buckets do not
 *                           account for. The result must also stay below
 *                           100,000,000 (MAX_SUPPLY) so mining headroom is
 *                           non-zero (see INITIAL ALLOCATION below).
 *   DEPLOYMENT_OUTPUT       Optional. Path of the JSON manifest, default
 *                           <repo>/smart-contracts/deployed-testnet.json.
 *                           Deployment output: never commit it.
 *   EXPECTED_CHAIN_ID       Optional. Chain id this deployment is allowed on,
 *                           default 80002 (Polygon Amoy). A mismatch only
 *                           warns; a known MAINNET id aborts unless --force.
 *
 * No private key, mnemonic or RPC credential is hardcoded here (PRD Rule 2).
 * The only key constant in this file is the PUBLIC, value-less first account
 * of a local hardhat node, used solely for --local dry runs.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Load .env — the same dotenv load hardhat.config.js performs for the
// hardhat-based path. This is the ONLY config loading this script does;
// there is no hardhat config, no hardhat task, no compilation.
require("dotenv").config();

// Plain ethers v6. There is deliberately NO require("hardhat") anywhere
// in this file: hardhat's Solidity parser is a napi-rs native module
// with no Termux/Android-ARM build (Error HH18 at requireNapiRsModule),
// and this script must run on the phone without ever loading it.
const { ethers } = require("ethers");

/* -------------------------------------------------------------------------- */
/* Compiled artifacts (committed to the repo)                                 */
/* -------------------------------------------------------------------------- */

// The compiled artifacts are tracked in git (see smart-contracts/.gitignore),
// so this script can deploy WITHOUT running the Solidity compiler — which is
// the whole point on Termux/Android-ARM, where hardhat's napi-rs parser
// cannot run. Paths are relative to the smart-contracts/ directory (the
// parent of this script's directory) and match hardhat's artifacts/ layout.
//
// All six artifacts have empty linkReferences and no "__$" library
// placeholders (OpenZeppelin is compiled IN, not linked), so a plain
// ethers ContractFactory over (abi, bytecode) is a complete deployment
// path — no library-linking step is needed.
const ARTIFACT_FILES = Object.freeze({
  catt: "artifacts/contracts/CATT.sol/CATT.json",
  teamVesting: "artifacts/contracts/TeamVesting.sol/TeamVesting.json",
  stakingManager: "artifacts/contracts/StakingManager.sol/StakingManager.json",
  bondManager: "artifacts/contracts/BondManager.sol/BondManager.json",
  miningClaimer: "artifacts/contracts/MiningClaimer.sol/MiningClaimer.json",
  mockYield: "artifacts/contracts/mocks/MockUSDT.sol/MockUSDT.json",
});

/**
 * Reads one compiled artifact from disk. Fails fast with an actionable
 * message if the checkout is missing its committed artifacts.
 */
function loadArtifact(key) {
  const relPath = ARTIFACT_FILES[key];
  const absPath = path.resolve(__dirname, "..", relPath);
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch (_) {
    fatal(
      `compiled artifact for ${key} is missing: ${absPath}`,
      "This script deploys from the COMPILED artifacts committed to the repo\n" +
        "(artifacts/ is tracked in git), so no compilation step is needed.\n" +
        "If this file is absent, the checkout is incomplete — re-clone or\n" +
        "restore the tracked artifacts. On a machine with a working hardhat\n" +
        "toolchain they can be regenerated with:\n" +
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
    fatal(`compiled artifact for ${key} is not valid JSON: ${absPath}`, String(error));
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    fatal(`compiled artifact for ${key} has no ABI: ${absPath}`);
  }
  if (
    typeof artifact.bytecode !== "string" ||
    !artifact.bytecode.startsWith("0x") ||
    artifact.bytecode.length < 4
  ) {
    fatal(
      `compiled artifact for ${key} has no bytecode: ${absPath}`,
      "The committed artifact is incomplete. Regenerate it on a machine with a\n" +
        "working hardhat toolchain:  cd smart-contracts && npx hardhat compile"
    );
  }
  return artifact;
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const ONE = 10n ** 18n;

/** Immutable cap from CATT.sol; asserted against the deployed contract below. */
const MAX_SUPPLY_CATT = 100_000_000n;

/**
 * INITIAL ALLOCATION (PRD Section 3.4 "Token Allocation" + TeamVesting's
 * constructor NatSpec). This is the authoritative PRD split and nothing else
 * is permitted to appear here.
 *
 * The four genesis buckets, each with its own destination:
 *
 *   team vesting        15,000,000 CATT  15.00% of MAX_SUPPLY  25.00% of genesis
 *   treasury            20,000,000 CATT  20.00% of MAX_SUPPLY  33.33% of genesis
 *   marketing           15,000,000 CATT  15.00% of MAX_SUPPLY  25.00% of genesis
 *   DEX liquidity       10,000,000 CATT  10.00% of MAX_SUPPLY  16.67% of genesis
 *   ------------------------------------------------------------
 *   genesis total       60,000,000 CATT  60.00% of MAX_SUPPLY 100.00% of genesis
 *   mining headroom     40,000,000 CATT  40.00% of MAX_SUPPLY  (never minted here)
 *
 * Team and treasury are additionally pinned by `TeamVesting`'s documented
 * constructor values (15,000,000e18 and 20,000,000e18), so those two cannot
 * drift. Marketing is a SEPARATE bucket with its own destination and is never
 * folded into liquidity; liquidity is 10,000,000, not the 30,000,000 an earlier
 * revision of the deploy script used.
 *
 * The remaining 40% of the cap is NOT minted at genesis, because
 * `MiningClaimer` is the sole minter after `transferOwnership` and every
 * mining reward mints ON TOP of the genesis supply: minting the full
 * 100,000,000 at genesis would leave ZERO headroom and make every single claim
 * revert with `MintExceedsMaxSupply`.
 *
 * The genesis total is DERIVED from the four bucket constants and then checked
 * against the PRD's 60,000,000 at module load, so editing a bucket without
 * updating the PRD total crashes the script immediately instead of silently
 * deploying a different tokenomics. `INITIAL_SUPPLY` may only restate that
 * derived total; it cannot redefine it.
 */
const TEAM_ALLOCATION_CATT = 15_000_000n;
const TREASURY_ALLOCATION_CATT = 20_000_000n;
const MARKETING_ALLOCATION_CATT = 15_000_000n;
const DEX_LIQUIDITY_ALLOCATION_CATT = 10_000_000n;

/** The PRD's genesis mint total, in whole CATT. Not configurable. */
const EXPECTED_GENESIS_TOTAL_CATT = 60_000_000n;

/** Sum of the four genesis buckets. This is what actually gets minted. */
const GENESIS_TOTAL_CATT =
  TEAM_ALLOCATION_CATT +
  TREASURY_ALLOCATION_CATT +
  MARKETING_ALLOCATION_CATT +
  DEX_LIQUIDITY_ALLOCATION_CATT;

// REAL CHECK, at module load, before a single transaction can be sent: the four
// buckets must account for the PRD genesis total exactly.
if (GENESIS_TOTAL_CATT !== EXPECTED_GENESIS_TOTAL_CATT) {
  throw new Error(
    "deploy-testnet-standalone.js: the four genesis buckets sum to " +
      `${GENESIS_TOTAL_CATT} CATT but the PRD genesis mint is ${EXPECTED_GENESIS_TOTAL_CATT} CATT ` +
      `(team ${TEAM_ALLOCATION_CATT} + treasury ${TREASURY_ALLOCATION_CATT} + ` +
      `marketing ${MARKETING_ALLOCATION_CATT} + DEX liquidity ${DEX_LIQUIDITY_ALLOCATION_CATT}). ` +
      "Refusing to deploy a tokenomics the PRD does not describe."
  );
}

/** Genesis mint = the four buckets. Overridable only to restate this exact value. */
const DEFAULT_INITIAL_SUPPLY_CATT = GENESIS_TOTAL_CATT;

/** Polygon Amoy testnet chain id. */
const DEFAULT_EXPECTED_CHAIN_ID = 80002n;

/**
 * The network this script deploys to. hardhat.config.js defines exactly one
 * deployable network, named "polygon", which reads POLYGON_RPC_URL and
 * PRIVATE_KEY; there is no separate Amoy alias, so an Amoy deployment is a
 * deployment to the "polygon" network with POLYGON_RPC_URL pointed at an
 * Amoy RPC (chain id 80002). The chain-id guard below confirms it.
 */
const NETWORK_NAME_REMOTE = "polygon";

/** Default RPC for --local runs: a `npx hardhat node` process. */
const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8545";

/**
 * The PUBLIC, value-less first account of a local hardhat node (the default
 * hardhat mnemonic's account #0). Used ONLY for --local dry runs when
 * PRIVATE_KEY is unset — never for a real network, where PRIVATE_KEY is
 * required. It holds no real funds anywhere.
 */
const HARDHAT_DEFAULT_ACCOUNT_0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Chain ids that hold real value; a "testnet" deploy there is almost certainly a mistake. */
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
    mockYield: truthy(process.env.MOCK_YIELD),
    local: truthy(process.env.LOCAL),
    force: truthy(process.env.FORCE),
    dryRun: truthy(process.env.DRY_RUN),
    unknown: [],
  };
  for (const arg of argv) {
    if (arg === "--mock-yield") flags.mockYield = true;
    else if (arg === "--local") flags.local = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());

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

function formatCatt(amountWei) {
  const whole = amountWei / ONE;
  const frac = (amountWei % ONE).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function pct(part, whole) {
  if (whole === 0n) return "n/a";
  // BigInt ratio first (no precision loss on the division), then format.
  const hundredths = Number((part * 10000n) / whole) / 100;
  return `${hundredths.toFixed(2)}%`;
}

/**
 * Best-effort human-readable revert description from a plain ethers v6 error.
 * hardhat-ethers decorates revert errors with `shortMessage`; plain ethers
 * v6 exposes the decoded custom-error name via `errorName`/`errorSignature`
 * and the reason via `message`/`reason`, so every field is concatenated and
 * the wiring probe below matches on the union.
 */
function describeRevert(error) {
  return [
    error && error.shortMessage,
    error && error.message,
    error && error.reason,
    error && error.errorName,
    error && error.errorSignature,
    String(error),
  ]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" | ");
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.unknown.length > 0) {
    fatal(
      `Unrecognised argument(s): ${flags.unknown.join(" ")}`,
      "Supported flags: --mock-yield, --local, --force, --dry-run.\n" +
        'For a real testnet deploy, point POLYGON_RPC_URL at Polygon Amoy — the\n' +
        'same "polygon" network hardhat.config.js defines.'
    );
  }

  const mockYieldRequested = flags.mockYield;

  /* ---------------------------------------------------------------------- */
  /* 0. Network selection                                                   */
  /* ---------------------------------------------------------------------- */

  // There is no hardhat `run` task here, so there is no hre.network.name to
  // read. The network is derived from the RPC URL instead:
  //
  //   --local, or a POLYGON_RPC_URL pointing at localhost/127.0.0.1/[::1]
  //     -> local mode (a `npx hardhat node` process; for dry runs)
  //   anything else
  //     -> the "polygon" network defined in hardhat.config.js — the network
  //        this script deploys to. Point POLYGON_RPC_URL at Polygon Amoy
  //        (chain id 80002) for a testnet deployment.
  const rawRpcUrl = (process.env.POLYGON_RPC_URL || "").trim();
  const isLocalRun = flags.local || (rawRpcUrl !== "" && isLocalhostUrl(rawRpcUrl));

  let rpcUrl;
  if (isLocalRun) {
    rpcUrl = rawRpcUrl !== "" ? rawRpcUrl : DEFAULT_LOCAL_RPC_URL;
    if (flags.local && rawRpcUrl !== "" && !isLocalhostUrl(rawRpcUrl)) {
      warn(`--local was passed but POLYGON_RPC_URL (${rawRpcUrl}) is not a localhost URL.`);
    }
  } else {
    // Required for remote runs; validated below together with the other env.
    rpcUrl = rawRpcUrl;
  }

  const networkName = isLocalRun ? "localhost" : NETWORK_NAME_REMOTE;

  banner("CATT PROTOCOL — TESTNET DEPLOYMENT (standalone, artifact-direct)");
  log(`network            : ${networkName}${isLocalRun ? " (local node)" : ' (the "polygon" network from hardhat.config.js)'}`);
  log(`rpc                : ${rpcUrl}`);
  log(`deploy path        : ethers v6 + committed artifacts (no hardhat, no Solidity parser)`);

  /* ---------------------------------------------------------------------- */
  /* 1. Configuration + fail-fast environment validation                    */
  /* ---------------------------------------------------------------------- */

  const requiredEnvNames = ["SIGNER_ADDRESS", "TEAM_BENEFICIARY", "TREASURY_BENEFICIARY", "MARKETING_WALLET"];
  if (!isLocalRun) {
    requiredEnvNames.push("PRIVATE_KEY", "POLYGON_RPC_URL");
  }
  if (!mockYieldRequested) {
    requiredEnvNames.push("YIELD_TOKEN_ADDRESS");
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
        "  SIGNER_ADDRESS        backend Judge address -> MiningClaimer.signer",
        "  TEAM_BENEFICIARY      15,000,000 CATT vesting beneficiary",
        "  TREASURY_BENEFICIARY  20,000,000 CATT vesting beneficiary (must differ from TEAM_BENEFICIARY)",
        "  MARKETING_WALLET      15,000,000 CATT marketing allocation. REQUIRED, no default: it is a",
        "                         separate labelled bucket and must never silently land on the deployer",
        "                         or be folded into the liquidity bucket.",
        "  YIELD_TOKEN_ADDRESS   real stablecoin for BondManager (omit with --mock-yield)",
        "",
        "Optional: LIQUIDITY_WALLET, INITIAL_SUPPLY, DEPLOYMENT_OUTPUT, EXPECTED_CHAIN_ID, MOCK_YIELD, LOCAL, FORCE, DRY_RUN, POLYGONSCAN_API_KEY.",
        "",
        "Tip: --local (or a localhost POLYGON_RPC_URL) runs against a local node and needs no PRIVATE_KEY.",
      ].join("\n")
    );
  }

  // Optional variables are read straight from the environment: `collectRequiredEnv`
  // only fills in the ones that are mandatory.
  for (const name of ["LIQUIDITY_WALLET", "INITIAL_SUPPLY", "DEPLOYMENT_OUTPUT", "EXPECTED_CHAIN_ID"]) {
    if (process.env[name] !== undefined && String(process.env[name]).trim() !== "") {
      env[name] = String(process.env[name]).trim();
    }
  }
  if (env.LIQUIDITY_WALLET && !isAddress(env.LIQUIDITY_WALLET)) {
    fatal(
      `LIQUIDITY_WALLET is not a valid EVM address: ${JSON.stringify(env.LIQUIDITY_WALLET)}`,
      "It must be 0x followed by exactly 40 hex characters, or be left unset to use the deployer."
    );
  }

  if (!isAddress(env.SIGNER_ADDRESS)) {
    fatal(
      `SIGNER_ADDRESS is not a valid EVM address: ${JSON.stringify(env.SIGNER_ADDRESS)}`,
      "It must be 0x followed by exactly 40 hex characters. It is the backend Judge address\n" +
        "whose EIP-712 signatures MiningClaimer accepts; a typo here means NO user can ever claim."
    );
  }
  const signerAddress = ethers.getAddress(env.SIGNER_ADDRESS);
  if (signerAddress === ethers.ZeroAddress) {
    fatal(
      "SIGNER_ADDRESS is the zero address.",
      "MiningClaimer would revert with ZeroAddress at deployment. Set it to the backend Judge wallet."
    );
  }

  for (const name of ["TEAM_BENEFICIARY", "TREASURY_BENEFICIARY"]) {
    if (!isAddress(env[name])) {
      fatal(`${name} is not a valid EVM address: ${JSON.stringify(env[name])}`,
        "It must be 0x followed by exactly 40 hex characters.");
    }
  }
  const teamBeneficiary = ethers.getAddress(env.TEAM_BENEFICIARY);
  const treasuryBeneficiary = ethers.getAddress(env.TREASURY_BENEFICIARY);
  if (teamBeneficiary === treasuryBeneficiary) {
    fatal(
      "TEAM_BENEFICIARY and TREASURY_BENEFICIARY are the same address.",
      "TeamVesting reverts with DuplicateBeneficiary in its constructor."
    );
  }

  // Marketing is a separate, labelled bucket with its own destination. It is
  // required (no default) precisely so it is never silently swept into the
  // liquidity bucket or left sitting on the deployer.
  if (!isAddress(env.MARKETING_WALLET)) {
    fatal(
      `MARKETING_WALLET is not a valid EVM address: ${JSON.stringify(env.MARKETING_WALLET)}`,
      "It must be 0x followed by exactly 40 hex characters. The 15,000,000 CATT marketing\n" +
        "allocation has NO default destination: it is a distinct bucket, not a slice of liquidity."
    );
  }
  const marketingWallet = ethers.getAddress(env.MARKETING_WALLET);
  if (marketingWallet === ethers.ZeroAddress) {
    fatal("MARKETING_WALLET is the zero address.", "15,000,000 CATT would be burned at deployment.");
  }

  const initialSupplyCatt = process.env.INITIAL_SUPPLY
    ? BigInt(String(process.env.INITIAL_SUPPLY).trim())
    : DEFAULT_INITIAL_SUPPLY_CATT;
  const teamAmount = TEAM_ALLOCATION_CATT * ONE;
  const treasuryAmount = TREASURY_ALLOCATION_CATT * ONE;
  const marketingAmountWei = MARKETING_ALLOCATION_CATT * ONE;
  const liquidityAmountWei = DEX_LIQUIDITY_ALLOCATION_CATT * ONE;
  const maxSupplyWei = MAX_SUPPLY_CATT * ONE;
  const genesisWei = initialSupplyCatt * ONE;
  const miningHeadroomWei = maxSupplyWei - genesisWei;

  if (initialSupplyCatt <= 0n) {
    fatal(`INITIAL_SUPPLY must be positive, got ${initialSupplyCatt}.`);
  }
  // The genesis mint is DERIVED from the four buckets. INITIAL_SUPPLY may only
  // restate that derived value; anything else is a different tokenomics and is
  // refused rather than deployed.
  const bucketSumWei = teamAmount + treasuryAmount + marketingAmountWei + liquidityAmountWei;
  if (genesisWei !== bucketSumWei) {
    fatal(
      `INITIAL_SUPPLY=${initialSupplyCatt} CATT does not equal the sum of the four PRD genesis buckets ` +
        `(${formatCatt(bucketSumWei)} CATT: team ${TEAM_ALLOCATION_CATT} + treasury ${TREASURY_ALLOCATION_CATT} + ` +
        `marketing ${MARKETING_ALLOCATION_CATT} + DEX liquidity ${DEX_LIQUIDITY_ALLOCATION_CATT}).`,
      "The genesis mint is computed from the PRD allocation, not configured independently of it.\n" +
        `Either unset INITIAL_SUPPLY (it defaults to ${formatCatt(bucketSumWei)}) or set it to exactly that value.`
    );
  }
  if (initialSupplyCatt >= MAX_SUPPLY_CATT) {
    fatal(
      `INITIAL_SUPPLY=${initialSupplyCatt} CATT is at or above MAX_SUPPLY (${MAX_SUPPLY_CATT} CATT).`,
      "MiningClaimer is the SOLE minter after transferOwnership and every mining reward mints on top of the\n" +
        "genesis supply, so a genesis mint equal to MAX_SUPPLY leaves ZERO headroom and makes EVERY claim\n" +
        "revert with MintExceedsMaxSupply."
    );
  }
  if (miningHeadroomWei <= 0n) {
    fatal(
      `INITIAL_SUPPLY=${initialSupplyCatt} CATT leaves ZERO mining headroom (MAX_SUPPLY is ${MAX_SUPPLY_CATT} CATT).`,
      "After transferOwnership the MiningClaimer is the SOLE minter and every mining reward mints\n" +
        "on top of the genesis supply, so a genesis mint equal to MAX_SUPPLY makes EVERY claim revert\n" +
        "with MintExceedsMaxSupply. Reduce INITIAL_SUPPLY."
    );
  }

  const liquidityWalletEnv = env.LIQUIDITY_WALLET ? ethers.getAddress(env.LIQUIDITY_WALLET) : null;

  /* ---------------------------------------------------------------------- */
  /* 2. Provider + signer                                                   */
  /* ---------------------------------------------------------------------- */

  // The deployer key: the FIRST key of the comma-separated PRIVATE_KEY list —
  // exactly the account hardhat.config.js uses as the first signer on the
  // "polygon" network. In local mode a PRIVATE_KEY is optional and defaults
  // to the well-known first account of a local hardhat node.
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
    // Unreachable for remote runs: PRIVATE_KEY is in requiredEnvNames and the
    // collectRequiredEnv check above already aborted. Kept as a guard.
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
  // cache. With the default cache, two rapid transactions — the
  // five deployments and the four allocation mints below are all
  // sent back-to-back — can read a STALE eth_getTransactionCount
  // (the previous transaction's receipt wait is shorter than the
  // cache window) and fail with NONCE_EXPIRED on fast networks
  // and local nodes. Uncached, every nonce query hits the wire,
  // which is exactly what the hardhat-based path's in-process
  // provider does.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  const deployer = new ethers.Wallet(privateKey, provider);
  const deployerAddress = await deployer.getAddress();

  // The signer is constructed FROM PRIVATE_KEY[0], so the deployer address is
  // by construction the address of the first key in the list — the same
  // account hardhat.config.js would use as the first signer on "polygon".
  // (The hardhat-based script warned when the first signer differed from
  // PRIVATE_KEY[0]; here that cannot happen by construction.)

  const liveChainId = BigInt((await provider.getNetwork()).chainId);

  const balanceWei = await provider.getBalance(deployerAddress);
  banner("PRE-FLIGHT");
  log(`network            : ${networkName} (chain id ${liveChainId})`);
  log(`deployer           : ${deployerAddress}   (${privateKeySource})`);
  log(`deployer balance   : ${ethers.formatEther(balanceWei)} native token`);
  log(`backend signer     : ${signerAddress}   (MiningClaimer.signer)`);
  log(`team beneficiary   : ${teamBeneficiary}   (${formatCatt(teamAmount)} CATT, vested)`);
  log(`treasury           : ${treasuryBeneficiary}   (${formatCatt(treasuryAmount)} CATT, vested)`);
  log(`marketing wallet   : ${marketingWallet}   (${formatCatt(marketingAmountWei)} CATT, marketing bucket)`);
  log(`initial supply     : ${formatCatt(genesisWei)} CATT (${pct(genesisWei, maxSupplyWei)} of MAX_SUPPLY)`);
  log(`mining headroom    : ${formatCatt(miningHeadroomWei)} CATT (${pct(miningHeadroomWei, maxSupplyWei)} of MAX_SUPPLY)`);

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
  /* 3. Chain id guard                                                      */
  /* ---------------------------------------------------------------------- */

  const expectedChainId = process.env.EXPECTED_CHAIN_ID
    ? BigInt(String(process.env.EXPECTED_CHAIN_ID).trim())
    : DEFAULT_EXPECTED_CHAIN_ID;

  if (!isLocalRun && liveChainId !== expectedChainId) {
    if (MAINNET_CHAIN_IDS.has(liveChainId)) {
      if (!flags.force) {
        fatal(
          `The configured RPC is on chain id ${liveChainId}, a MAINNET, but EXPECTED_CHAIN_ID is ${expectedChainId}.`,
          "This script is the TESTNET deployer. Refusing to touch a value-bearing chain.\n" +
            "Point POLYGON_RPC_URL at Polygon Amoy (80002), or pass --force if you truly mean it."
        );
      }
      warn(`chain id ${liveChainId} is a MAINNET and --force was passed. You are on your own.`);
    } else {
      warn(`chain id is ${liveChainId}, not the expected ${expectedChainId} (Polygon Amoy). Continuing.`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Preload every committed artifact BEFORE the first transaction       */
  /* ---------------------------------------------------------------------- */

  // Fail fast — before any transaction is broadcast — if a committed
  // artifact is missing or malformed. deployArtifact() below deploys
  // from this map. Loaded here, before the yield-token deployment in
  // the next section, so a bad checkout aborts before ANY transaction
  // is sent.
  const artifactKeys = mockYieldRequested
    ? ["catt", "teamVesting", "stakingManager", "bondManager", "miningClaimer", "mockYield"]
    : ["catt", "teamVesting", "stakingManager", "bondManager", "miningClaimer"];
  const artifacts = {};
  banner("ARTIFACTS (committed, no compilation)");
  for (const key of artifactKeys) {
    artifacts[key] = loadArtifact(key);
    log(`  ${key.padEnd(16)}: ${ARTIFACT_FILES[key]}  (${artifacts[key].abi.length} ABI entries)`);
  }

  /**
   * Deploys one contract from its committed artifact. This is the
   * artifact-direct replacement for hardhat-ethers' `ethers.deployContract`:
   * a plain ethers v6 ContractFactory over the committed ABI + bytecode,
   * connected to the deployer. The artifacts have empty linkReferences, so
   * no library-linking step is needed.
   */
  const deployArtifact = async (key, args) => {
    const artifact = artifacts[key];
    if (!artifact) {
      fatal(`internal error: artifact "${key}" was not preloaded`);
    }
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    return factory.deploy(...args);
  };

  /* ---------------------------------------------------------------------- */
  /* 5. Yield token (real address from env, or the TEST-ONLY mock)          */
  /* ---------------------------------------------------------------------- */

  const txs = {};

  let yieldTokenAddress;
  let yieldTokenKind;
  let yieldTokenNote;
  if (mockYieldRequested) {
    const mock = await deployArtifact("mockYield", []);
    const mockReceipt = await mock.deploymentTransaction().wait();
    txs.MockUSDT = mockReceipt.hash;
    yieldTokenAddress = await mock.getAddress();
    yieldTokenKind = "MOCK";
    yieldTokenNote =
      "contracts/mocks/MockUSDT.sol — a 6-decimal test double. It is PERMISSIONLESS and UNCAPPED: " +
      "anybody can mint as much of it as they like, so it has none of the properties of a real stablecoin. " +
      "It exists to prove BondManager's yield accounting is decimals-agnostic. " +
      "ANY testnet liquidity, any bond yield and any accounting derived from this token is WORTHLESS.";
    banner("!! YIELD TOKEN: MOCK — NOT A REAL STABLECOIN !!");
    log(yieldTokenNote);
    log("");
  } else {
    if (!isAddress(env.YIELD_TOKEN_ADDRESS)) {
      fatal(
        `YIELD_TOKEN_ADDRESS is not a valid EVM address: ${JSON.stringify(env.YIELD_TOKEN_ADDRESS)}`,
        "It must be 0x followed by exactly 40 hex characters, or pass --mock-yield to deploy the test double."
      );
    }
    yieldTokenAddress = ethers.getAddress(env.YIELD_TOKEN_ADDRESS);
    yieldTokenKind = "REAL_FROM_ENV";
    yieldTokenNote = "Supplied by the operator via YIELD_TOKEN_ADDRESS. NOT VERIFIED by this script: confirm it is a real, non-mock stablecoin on the intended chain.";
    banner("YIELD TOKEN");
    log(`${yieldTokenAddress}  (${yieldTokenKind})`);
    log(yieldTokenNote);
    log("");
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Output file guard (double-deployment protection)                    */
  /* ---------------------------------------------------------------------- */

  const outputPath = path.resolve(
    process.env.DEPLOYMENT_OUTPUT || path.join(__dirname, "..", "deployed-testnet.json")
  );
  const existing = fs.existsSync(outputPath);
  if (existing && !flags.force && !flags.dryRun) {
    let previousNetwork = "unknown";
    try {
      const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      previousNetwork =
        (parsed.network && (parsed.network.name || parsed.network)) ||
        parsed.networkName ||
        "unknown";
    } catch (_) {
      previousNetwork = "unreadable";
    }
    fatal(
      `${outputPath} already exists (previous deployment on network "${previousNetwork}").`,
      [
        "Refusing to silently overwrite a deployment manifest: the previous addresses, allocation",
        "and wiring results are the only record of what is live, and overwriting them is how a",
        "testnet operator ends up relaying against the wrong contract.",
        "",
        "Choose one:",
        "  --force                     overwrite it (the previous deployment is NOT rolled back)",
        "  DEPLOYMENT_OUTPUT=/tmp/x.json   write the new manifest somewhere else and keep the old one",
        "  --dry-run                   deploy and verify, write nothing",
        "",
        "IMPORTANT: re-running this script ALWAYS deploys NEW contracts. The old deployment stays",
        "deployed and keeps its state; there is no migration. See docs/TESTNET_DEPLOYMENT.md.",
      ].join("\n")
    );
  }
  if (existing && (flags.force || flags.dryRun)) {
    warn(`${outputPath} already exists and will be ${flags.dryRun ? "left untouched (--dry-run)" : "OVERWRITTEN (--force)"}.`);
  }

  /* ---------------------------------------------------------------------- */
  /* 7. DEPLOYMENT ORDER                                                    */
  /*                                                                       */
  /* ASSERTED, NOT ASSUMED: the order below is mandated by MiningClaimer's    */
  /* `DeploymentNotes` NatSpec header, steps (i)-(iv).                       */
  /*                                                                       */
  /*   (i)   MINT every initial allocation while the DEPLOYER still owns    */
  /*         CATT. Not cosmetic: after step (ii) the deployer can never     */
  /*         mint again, and MiningClaimer's only mint path is a SIGNED     */
  /*         mining reward — it cannot mint team/treasury/liquidity. Any    */
  /*         allocation minted after (ii) would be PERMANENTLY UNMINTABLE.  */
  /*   (ii)  catt.transferOwnership(miningClaimer) — claimer becomes the    */
  /*         SOLE MINTER.                                                  */
  /*   (iii) stakingManager.setClaimer(miningClaimer) — claimer becomes the */
  /*         only account allowed to debit stamina.                         */
  /*   (iv)  Only then does claimReward() work end to end.                  */
  /*                                                                       */
  /* Minting before (ii) and transferring before (iii) is the whole game.   */
  /* ---------------------------------------------------------------------- */

  banner("STEP 1/6 — CATT (deployer is the initial owner)");
  const catt = await deployArtifact("catt", [deployerAddress]);
  const cattReceipt = await catt.deploymentTransaction().wait();
  const cattAddress = await catt.getAddress();
  txs.CATT = cattReceipt.hash;
  log(`CATT               : ${cattAddress}   tx ${cattReceipt.hash}`);

  const onChainMaxSupply = await catt.MAX_SUPPLY();
  if (onChainMaxSupply !== maxSupplyWei) {
    fatal(
      `Deployed CATT.MAX_SUPPLY is ${formatCatt(onChainMaxSupply)} CATT but this script expects ${MAX_SUPPLY_CATT} CATT.`,
      "The allocation arithmetic below is pinned to the immutable cap in CATT.sol. Refusing to continue."
    );
  }

  banner("STEP 2/6 — TeamVesting (team 15,000,000 + treasury 20,000,000)");
  const teamVesting = await deployArtifact(
    "teamVesting",
    [cattAddress, teamBeneficiary, treasuryBeneficiary, teamAmount, treasuryAmount]
  );
  const vestingReceipt = await teamVesting.deploymentTransaction().wait();
  const teamVestingAddress = await teamVesting.getAddress();
  txs.TeamVesting = vestingReceipt.hash;
  log(`TeamVesting        : ${teamVestingAddress}   tx ${vestingReceipt.hash}`);
  log(`  team beneficiary   : ${teamBeneficiary} (${formatCatt(teamAmount)} CATT)`);
  log(`  treasury           : ${treasuryBeneficiary} (${formatCatt(treasuryAmount)} CATT)`);

  banner("STEP 3/6 — StakingManager");
  const stakingManager = await deployArtifact("stakingManager", [cattAddress]);
  const stakingReceipt = await stakingManager.deploymentTransaction().wait();
  const stakingManagerAddress = await stakingManager.getAddress();
  txs.StakingManager = stakingReceipt.hash;
  log(`StakingManager     : ${stakingManagerAddress}   tx ${stakingReceipt.hash}`);

  banner("STEP 4/6 — BondManager");
  if (yieldTokenAddress.toLowerCase() === cattAddress.toLowerCase()) {
    fatal(
      "The yield token is the CATT token itself.",
      "BondManager's own NatSpec requires principal and yield to be DISTINCT tokens: with the same\n" +
        "address a yield claim could pay out of other users' locked principal."
    );
  }
  const bondManager = await deployArtifact("bondManager", [cattAddress, yieldTokenAddress]);
  const bondReceipt = await bondManager.deploymentTransaction().wait();
  const bondManagerAddress = await bondManager.getAddress();
  txs.BondManager = bondReceipt.hash;
  log(`BondManager        : ${bondManagerAddress}   tx ${bondReceipt.hash}`);
  log(`  principal token    : ${cattAddress}`);
  log(`  yield token        : ${yieldTokenAddress} (${yieldTokenKind})`);
  if (yieldTokenKind === "MOCK") {
    warn("BondManager's yield token is MockUSDT. All yield paid by this deployment is worthless.");
  }

  banner("STEP 5/6 — MiningClaimer");
  const miningClaimer = await deployArtifact(
    "miningClaimer",
    [cattAddress, stakingManagerAddress, signerAddress]
  );
  const claimerReceipt = await miningClaimer.deploymentTransaction().wait();
  const miningClaimerAddress = await miningClaimer.getAddress();
  txs.MiningClaimer = claimerReceipt.hash;
  log(`MiningClaimer      : ${miningClaimerAddress}   tx ${claimerReceipt.hash}`);
  log(`  CATT owner becomes : ${miningClaimerAddress}`);
  log(`  StakingManager.claimer becomes : ${miningClaimerAddress}`);
  log(`  signer             : ${signerAddress}`);

  /* ---------------------------------------------------------------------- */
  /* 8. WIRING                                                              */
  /* ---------------------------------------------------------------------- */

  banner("STEP 6/6 — INITIAL ALLOCATION (deployer is STILL the CATT owner) — step (i)");
  log("Every allocation below MUST be minted now: after the ownership transfer in");
  log("the next block the deployer cannot mint, and MiningClaimer can only mint signed");
  log("mining rewards, so these allocations would be permanently unmintable.");

  const allocation = await catt.mint(deployerAddress, teamAmount);
  const treasuryMint = await catt.mint(treasuryBeneficiary, treasuryAmount);
  const marketingMint = await catt.mint(marketingWallet, marketingAmountWei);
  const liquidityMint = await catt.mint(
    liquidityWalletEnv ? liquidityWalletEnv : deployerAddress,
    liquidityAmountWei
  );
  txs.mintTeam = allocation.hash;
  txs.mintTreasury = treasuryMint.hash;
  txs.mintMarketing = marketingMint.hash;
  txs.mintLiquidity = liquidityMint.hash;
  log(`  mint team      -> deployer      ${formatCatt(teamAmount)} CATT          tx ${allocation.hash}`);
  log(`  mint treasury  -> ${treasuryBeneficiary} ${formatCatt(treasuryAmount)} CATT  tx ${treasuryMint.hash}`);
  log(`  mint marketing -> ${marketingWallet} ${formatCatt(marketingAmountWei)} CATT  tx ${marketingMint.hash}`);
  log(`  mint liquidity -> ${liquidityWalletEnv ? liquidityWalletEnv : deployerAddress} ${formatCatt(liquidityAmountWei)} CATT  tx ${liquidityMint.hash}`);
  if (!env.LIQUIDITY_WALLET) {
    warn("LIQUIDITY_WALLET is not set: the initial liquidity allocation is sitting on the DEPLOYER wallet. Set LIQUIDITY_WALLET before adding DEX liquidity.");
  }

  // Fund the vesting contract: without this, claim() reverts with
  // InsufficientVestedBalance forever.
  const fundingTx = await catt.transfer(teamVestingAddress, teamAmount);
  txs.fundTeamVesting = fundingTx.hash;
  await fundingTx.wait();
  log(`  fund vesting contract with ${formatCatt(teamAmount)} CATT            tx ${fundingTx.hash}`);

  banner("WIRING (ii) — transferOwnership: MiningClaimer becomes the SOLE MINTER");
  const ownershipTx = await catt.transferOwnership(miningClaimerAddress);
  txs.transferOwnership = ownershipTx.hash;
  await ownershipTx.wait();
  log(`catt.transferOwnership(${miningClaimerAddress})   tx ${ownershipTx.hash}`);

  banner("WIRING (iii) — setClaimer: MiningClaimer may debit stamina");
  const setClaimerTx = await stakingManager.setClaimer(miningClaimerAddress);
  txs.setClaimer = setClaimerTx.hash;
  await setClaimerTx.wait();
  log(`stakingManager.setClaimer(${miningClaimerAddress})   tx ${setClaimerTx.hash}`);

  /* ---------------------------------------------------------------------- */
  /* 9. Verification                                                        */
  /* ---------------------------------------------------------------------- */

  banner("WIRING VERIFICATION");

  const cattOwner = await catt.owner();
  const stakingClaimer = await stakingManager.claimer();
  const vestingBalance = await catt.balanceOf(teamVestingAddress);
  const treasuryBalance = await catt.balanceOf(treasuryBeneficiary);
  const marketingBalance = await catt.balanceOf(marketingWallet);
  const liquidityWallet = liquidityWalletEnv ? liquidityWalletEnv : deployerAddress;
  const liquidityBalance = await catt.balanceOf(liquidityWallet);
  const totalSupply = await catt.totalSupply();
  const claimerSigner = await miningClaimer.signer();
  const claimerStakingManager = await miningClaimer.stakingManager();
  const claimerCatt = await miningClaimer.cattToken();

  const checks = [
    {
      name: "catt.owner() === miningClaimer",
      ok: cattOwner.toLowerCase() === miningClaimerAddress.toLowerCase(),
      actual: cattOwner,
      expected: miningClaimerAddress,
    },
    {
      name: "stakingManager.claimer() === miningClaimer",
      ok: stakingClaimer.toLowerCase() === miningClaimerAddress.toLowerCase(),
      actual: stakingClaimer,
      expected: miningClaimerAddress,
    },
    {
      name: `TeamVesting holds its ${formatCatt(teamAmount)} CATT`,
      ok: vestingBalance === teamAmount,
      actual: `${formatCatt(vestingBalance)} CATT`,
      expected: `${formatCatt(teamAmount)} CATT`,
    },
    {
      name: `treasury beneficiary holds its ${formatCatt(treasuryAmount)} CATT`,
      ok: treasuryBalance === treasuryAmount,
      actual: `${formatCatt(treasuryBalance)} CATT`,
      expected: `${formatCatt(treasuryAmount)} CATT`,
    },
    {
      name: `marketing wallet holds its ${formatCatt(marketingAmountWei)} CATT (marketing bucket, not liquidity)`,
      ok: marketingBalance === marketingAmountWei,
      actual: `${formatCatt(marketingBalance)} CATT`,
      expected: `${formatCatt(marketingAmountWei)} CATT`,
    },
    {
      name: `DEX liquidity wallet holds its ${formatCatt(liquidityAmountWei)} CATT`,
      ok: liquidityBalance === liquidityAmountWei,
      actual: `${formatCatt(liquidityBalance)} CATT`,
      expected: `${formatCatt(liquidityAmountWei)} CATT`,
    },
    {
      name: `four genesis buckets sum to the ${formatCatt(genesisWei)} CATT actually minted`,
      ok: bucketSumWei === genesisWei && genesisWei === EXPECTED_GENESIS_TOTAL_CATT * ONE,
      actual: `buckets ${formatCatt(bucketSumWei)} CATT / minted ${formatCatt(genesisWei)} CATT`,
      expected: `${formatCatt(genesisWei)} CATT (PRD genesis ${EXPECTED_GENESIS_TOTAL_CATT} CATT)`,
    },
    {
      name: `totalSupply === minted ${formatCatt(genesisWei)} CATT`,
      ok: totalSupply === genesisWei,
      actual: `${formatCatt(totalSupply)} CATT`,
      expected: `${formatCatt(genesisWei)} CATT`,
    },
    {
      name: `totalSupply <= MAX_SUPPLY (${formatCatt(maxSupplyWei)} CATT)`,
      ok: totalSupply <= maxSupplyWei,
      actual: `${formatCatt(totalSupply)} CATT`,
      expected: `<= ${formatCatt(maxSupplyWei)} CATT`,
    },
    {
      name: `mining headroom === MAX_SUPPLY - genesis = ${formatCatt(miningHeadroomWei)} CATT`,
      ok: miningHeadroomWei === MAX_SUPPLY_CATT * ONE - EXPECTED_GENESIS_TOTAL_CATT * ONE && miningHeadroomWei > 0n,
      actual: `${formatCatt(miningHeadroomWei)} CATT`,
      expected: `${formatCatt(MAX_SUPPLY_CATT * ONE - EXPECTED_GENESIS_TOTAL_CATT * ONE)} CATT`,
    },
    {
      name: "miningClaimer.signer() === SIGNER_ADDRESS",
      ok: claimerSigner.toLowerCase() === signerAddress.toLowerCase(),
      actual: claimerSigner,
      expected: signerAddress,
    },
    {
      name: "miningClaimer.stakingManager() === StakingManager",
      ok: claimerStakingManager.toLowerCase() === stakingManagerAddress.toLowerCase(),
      actual: claimerStakingManager,
      expected: stakingManagerAddress,
    },
    {
      name: "miningClaimer.cattToken() === CATT",
      ok: claimerCatt.toLowerCase() === cattAddress.toLowerCase(),
      actual: claimerCatt,
      expected: cattAddress,
    },
    {
      name: "deployer can no longer mint (ownership moved)",
      ok: true, // proven by a reverted call below
      actual: "see revert probe",
      expected: "OwnableUnauthorizedAccount",
    },
    {
      name: "BondManager yield token !== CATT",
      ok: yieldTokenAddress.toLowerCase() !== cattAddress.toLowerCase(),
      actual: yieldTokenAddress,
      expected: "different address",
    },
  ];

  let probesFailed = 0;
  try {
    await catt.connect(deployer).mint.staticCall(deployerAddress, 1n);
    probesFailed = 1;
    checks[checks.length - 2].actual = "mint SUCCEEDED — deployer is still the owner";
    checks[checks.length - 2].ok = false;
  } catch (error) {
    const revertName = describeRevert(error);
    checks[checks.length - 2].actual = `reverted: ${revertName}`;
    checks[checks.length - 2].ok = /OwnableUnauthorizedAccount|caller is not the owner/i.test(revertName);
  }

  let allOk = true;
  for (const check of checks) {
    if (!check.ok) allOk = false;
    log(`  [${check.ok ? "PASS" : "FAIL"}] ${check.name}`);
    log(`         expected: ${check.expected}`);
    log(`         actual  : ${check.actual}`);
  }

  if (!allOk || probesFailed) {
    fatal(
      "Wiring verification FAILED. Do not use this deployment.",
      "The roles are wrong: either the CATT owner or the StakingManager claimer is not the MiningClaimer,\n" +
        "which means no user can claim a reward. Re-deploy with --force and read the FAIL lines above."
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 10. Manifest                                                           */
  /* ---------------------------------------------------------------------- */

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "smart-contracts/scripts/deploy-testnet-standalone.js",
    network: {
      name: networkName,
      chainId: Number(liveChainId),
      isLocalHardhatNetwork: isLocalRun,
    },
    deployer: deployerAddress,
    contracts: {
      CATT: { address: cattAddress, deployTx: txs.CATT },
      TeamVesting: { address: teamVestingAddress, deployTx: txs.TeamVesting },
      StakingManager: { address: stakingManagerAddress, deployTx: txs.StakingManager },
      BondManager: { address: bondManagerAddress, deployTx: txs.BondManager },
      MiningClaimer: { address: miningClaimerAddress, deployTx: txs.MiningClaimer },
    },
    constructorArguments: {
      CATT: [deployerAddress],
      TeamVesting: [cattAddress, teamBeneficiary, treasuryBeneficiary, teamAmount.toString(), treasuryAmount.toString()],
      StakingManager: [cattAddress],
      BondManager: [cattAddress, yieldTokenAddress],
      MiningClaimer: [cattAddress, stakingManagerAddress, signerAddress],
    },
    yieldToken: {
      address: yieldTokenAddress,
      kind: yieldTokenKind,
      deployTx: txs.MockUSDT || null,
      note: yieldTokenNote,
    },
    initialAllocation: {
      totalMinted: genesisWei,
      totalMintedFormatted: `${formatCatt(genesisWei)} CATT`,
      maxSupply: maxSupplyWei,
      miningHeadroom: miningHeadroomWei,
      buckets: [
        {
          label: "team vesting",
          recipient: teamVestingAddress,
          beneficiary: teamBeneficiary,
          amount: teamAmount,
          amountFormatted: `${formatCatt(teamAmount)} CATT`,
          percentOfMaxSupply: pct(teamAmount, maxSupplyWei),
          percentOfGenesis: pct(teamAmount, genesisWei),
          locked: true,
          tx: txs.mintTeam,
        },
        {
          label: "treasury",
          recipient: treasuryBeneficiary,
          beneficiary: treasuryBeneficiary,
          amount: treasuryAmount,
          amountFormatted: `${formatCatt(treasuryAmount)} CATT`,
          percentOfMaxSupply: pct(treasuryAmount, maxSupplyWei),
          percentOfGenesis: pct(treasuryAmount, genesisWei),
          locked: true,
          tx: txs.mintTreasury,
        },
        {
          label: "marketing",
          recipient: marketingWallet,
          beneficiary: marketingWallet,
          amount: marketingAmountWei,
          amountFormatted: `${formatCatt(marketingAmountWei)} CATT`,
          percentOfMaxSupply: pct(marketingAmountWei, maxSupplyWei),
          percentOfGenesis: pct(marketingAmountWei, genesisWei),
          locked: false,
          tx: txs.mintMarketing,
        },
        {
          label: "dex liquidity",
          recipient: liquidityWallet,
          beneficiary: liquidityWallet,
          amount: liquidityAmountWei,
          amountFormatted: `${formatCatt(liquidityAmountWei)} CATT`,
          percentOfMaxSupply: pct(liquidityAmountWei, maxSupplyWei),
          percentOfGenesis: pct(liquidityAmountWei, genesisWei),
          locked: false,
          tx: txs.mintLiquidity,
        },
      ],
      vestingFundingTx: txs.fundTeamVesting,
    },
    wiring: {
      transferOwnershipTx: txs.transferOwnership,
      setClaimerTx: txs.setClaimer,
      verification: checks.map((c) => ({ check: c.name, ok: c.ok, expected: c.expected, actual: c.actual })),
      allChecksPassed: allOk,
    },
    backend: {
      signerAddress,
      note: "Set SIGNER_PRIVATE_KEY in backend-server/.env to the key for this address, and CHAIN_ID to the chain id above.",
    },
  };

  if (!flags.dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const json = JSON.stringify(
      manifest,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
    fs.writeFileSync(outputPath, `${json}\n`, "utf8");
    log("");
    log(`manifest written   : ${outputPath}`);
    log("This file is deployment output. Do NOT commit it.");
  } else {
    log("");
    log("manifest NOT written (--dry-run).");
  }

  /* ---------------------------------------------------------------------- */
  /* 11. Summary table                                                      */
  /* ---------------------------------------------------------------------- */

  const row = (label, value) => `  ${label.padEnd(24)}${value}`;
  banner("DEPLOYMENT SUMMARY");
  log(`  ${"network".padEnd(24)}${networkName} (chain id ${liveChainId})`);
  log(row("deployer", deployerAddress));
  log(row("CATT", cattAddress));
  log(row("TeamVesting", teamVestingAddress));
  log(row("StakingManager", stakingManagerAddress));
  log(row("BondManager", bondManagerAddress));
  log(row("MiningClaimer", miningClaimerAddress));
  log(row("yield token", `${yieldTokenAddress} (${yieldTokenKind})`));
  log(row("backend signer", signerAddress));
  log(row("team beneficiary", `${teamBeneficiary} (vested)`));
  log(row("treasury beneficiary", `${treasuryBeneficiary} (vested)`));
  log(row("marketing wallet", `${marketingWallet} (marketing bucket)`));
  log(row("liquidity wallet", liquidityWallet));
  log("");
  log("  INITIAL ALLOCATION (sums to 100% of what was minted)");
  const amount = "CATT";
  const ofMax = "% of MAX_SUPPLY";
  const ofGenesis = "% of genesis";
  log(`  ${"bucket".padEnd(20)}${amount.padStart(20)}${ofMax.padStart(18)}${ofGenesis.padStart(18)}`);
  log(`  ${"-".repeat(74)}`);
  log(
    `  ${"team vesting".padEnd(20)}${formatCatt(teamAmount).padStart(20)}` +
      `${pct(teamAmount, maxSupplyWei).padStart(18)}${pct(teamAmount, genesisWei).padStart(18)}`
  );
  log(
    `  ${"treasury".padEnd(20)}${formatCatt(treasuryAmount).padStart(20)}` +
      `${pct(treasuryAmount, maxSupplyWei).padStart(18)}${pct(treasuryAmount, genesisWei).padStart(18)}`
  );
  log(
    `  ${"marketing".padEnd(20)}${formatCatt(marketingAmountWei).padStart(20)}` +
      `${pct(marketingAmountWei, maxSupplyWei).padStart(18)}${pct(marketingAmountWei, genesisWei).padStart(18)}`
  );
  log(
    `  ${"DEX liquidity".padEnd(20)}${formatCatt(liquidityAmountWei).padStart(20)}` +
      `${pct(liquidityAmountWei, maxSupplyWei).padStart(18)}${pct(liquidityAmountWei, genesisWei).padStart(18)}`
  );
  log(`  ${"-".repeat(74)}`);
  log(
    `  ${"genesis total".padEnd(20)}${formatCatt(genesisWei).padStart(20)}` +
      `${pct(genesisWei, maxSupplyWei).padStart(18)}${"100.00%".padStart(18)}`
  );
  log(
    `  ${"mining headroom".padEnd(20)}${formatCatt(miningHeadroomWei).padStart(20)}` +
      `${pct(miningHeadroomWei, maxSupplyWei).padStart(18)}${"not minted".padStart(18)}`
  );
  log("");
  log("  WIRING");
  log(row("CATT owner", cattOwner));
  log(row("StakingManager.claimer", stakingClaimer));
  log(row("MiningClaimer.signer", claimerSigner));
  log("");
  log("  NEXT");
  if (yieldTokenKind === "MOCK") {
    warn("the yield token is MockUSDT — worthless, permissionless, uncapped. Testnet only.");
  }
  log("  1. add CATT/test-USDT liquidity to a testnet DEX (docs/TESTNET_LIQUIDITY.md)");
  log("  2. point backend-server at this deployment (CHAIN_ID, MINING_CLAIMER_ADDRESS, SIGNER_PRIVATE_KEY)");
  log("  3. fund the bond pool with the yield token (BondManager.depositYield) — ONE-WAY, no rescue");
  if (!flags.dryRun) {
    log(`  4. read ${outputPath} for the full manifest, and DELETE it before committing`);
  }
  log("");
}

/* -------------------------------------------------------------------------- */
/* Entrypoint                                                                 */
/* -------------------------------------------------------------------------- */

// NOTE: there is deliberately NO compile step here — not even an optional
// one. The compiled artifacts are committed to the repo (see ARTIFACT_FILES
// above), and invoking hardhat's compile task is precisely what fails on
// Termux/Android-ARM with Error HH18 at requireNapiRsModule. This script
// must remain free of any require("hardhat") so the napi-rs Solidity
// parser is never loaded.

main().catch((error) => {
  console.error("");
  console.error("DEPLOYMENT FAILED:");
  console.error(error && error.stack ? error.stack : String(error));
  console.error("");
  process.exitCode = 1;
});
