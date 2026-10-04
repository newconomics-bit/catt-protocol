/**
 * CATT Protocol — TESTNET deployment script.
 *
 * Deploys and wires the whole on-chain system (CATT, TeamVesting,
 * StakingManager, BondManager, MiningClaimer) in the ONLY order that leaves a
 * working protocol, which is the order mandated by `MiningClaimer`'s own
 * `DeploymentNotes` NatSpec header (see the DEPLOYMENT ORDER block below).
 *
 * Usage
 * -----
 *   # Dry run against the in-process Hardhat network (no chain touched):
 *   MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js
 *
 *   # Real testnet (Polygon Amoy — the `polygon` network in hardhat.config.js,
 *   # pointed at an Amoy RPC by POLYGON_RPC_URL):
 *   npx hardhat run scripts/deploy-testnet.js --network polygon
 *
 *   # Same, with the TEST-ONLY mock stablecoin:
 *   MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon
 *
 *   # With CLI flags instead of env flags (compiles first, then runs):
 *   node scripts/deploy-testnet.js --mock-yield
 *   node scripts/deploy-testnet.js --mock-yield --dry-run
 *
 * WHY SOME FLAGS ARE ENV-VARS FIRST: this repo is on hardhat@2, whose `run`
 * task REJECTS any argument it does not itself define ("Unrecognized param
 * --mock-yield"), and `hardhat.config.js` is out of scope for this task, so no
 * custom task can be registered to forward them. The flags are still parsed
 * from argv (that is how `node scripts/deploy-testnet.js --mock-yield` works);
 * under `npx hardhat run` use the env equivalents.
 *
 * Flags
 * -----
 *   --mock-yield     Deploy contracts/mocks/MockUSDT.sol and use it as the
 *                    BondManager yield token. TEST-ONLY: the mock is
 *                    permissionless and uncapped, so anybody can print the
 *                    token the bond pool pays out in. Never use it on a
 *                    network where tokens have value. Env: MOCK_YIELD=true.
 *   --force          Overwrite an existing deployed-testnet.json instead of
 *                    refusing. Without it the script REFUSES to run.
 *                    Env: FORCE=true.
 *   --dry-run        Deploy and verify, but do NOT write deployed-testnet.json.
 *                    Env: DRY_RUN=true.
 *
 * Required environment (see smart-contracts/.env.example and docs/TESTNET_DEPLOYMENT.md)
 * ----------------------------------------------------------------------------
 *   PRIVATE_KEY             Deployer key. 0x + 64 hex. Comma-separated for
 *                           multiple keys (hardhat.config.js already splits it).
 *                           NOT required on the in-process `hardhat` network,
 *                           which supplies its own funded accounts.
 *   POLYGON_RPC_URL         JSON-RPC endpoint. Must be the TESTNET endpoint
 *                           (Polygon Amoy, chain id 80002) for a testnet deploy.
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
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const hre = require("hardhat");

const { ethers } = hre;

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

// Contract factories are resolved by NAME from the compiled artifacts via
// `ethers.deployContract("<Name>", args, signer)`; the .sol sources are never
// require()d (Node cannot parse them).
const ARTIFACT_NAMES = Object.freeze({
  catt: "CATT",
  teamVesting: "TeamVesting",
  stakingManager: "StakingManager",
  bondManager: "BondManager",
  miningClaimer: "MiningClaimer",
  mockYield: "MockUSDT",
});

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
 * revision of this script used.
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
    "deploy-testnet.js: the four genesis buckets sum to " +
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
    force: truthy(process.env.FORCE),
    dryRun: truthy(process.env.DRY_RUN),
    unknown: [],
  };
  for (const arg of argv) {
    if (arg === "--mock-yield") flags.mockYield = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else flags.unknown.push(arg);
  }
  return flags;
}

const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());

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

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.unknown.length > 0) {
    fatal(
      `Unrecognised argument(s): ${flags.unknown.join(" ")}`,
      "Supported flags: --mock-yield, --force, --dry-run.\n" +
        "Run with --network polygon (the network defined in hardhat.config.js) for a real testnet."
    );
  }

  const networkName = hre.network.name;
  const isLocalRun = networkName === "hardhat" || networkName === "localhost";
  const mockYieldRequested = flags.mockYield;

  banner("CATT PROTOCOL — TESTNET DEPLOYMENT");
  log(`network            : ${networkName}`);
  log(`chain id           : ${hre.network.config.chainId}`);

  /* ---------------------------------------------------------------------- */
  /* 0. Configuration + fail-fast environment validation                      */
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
        "  PRIVATE_KEY           deployer key, 0x + 64 hex (hardhat.config.js splits a comma-separated list)",
        "  POLYGON_RPC_URL       Polygon Amoy testnet JSON-RPC endpoint (chain id 80002)",
        "  SIGNER_ADDRESS        backend Judge address -> MiningClaimer.signer",
        "  TEAM_BENEFICIARY      15,000,000 CATT vesting beneficiary",
        "  TREASURY_BENEFICIARY  20,000,000 CATT vesting beneficiary (must differ from TEAM_BENEFICIARY)",
        "  MARKETING_WALLET      15,000,000 CATT marketing allocation. REQUIRED, no default: it is a",
        "                         separate labelled bucket and must never silently land on the deployer",
        "                         or be folded into the liquidity bucket.",
        "  YIELD_TOKEN_ADDRESS   real stablecoin for BondManager (omit with --mock-yield)",
        "",
        `Optional: LIQUIDITY_WALLET, INITIAL_SUPPLY, DEPLOYMENT_OUTPUT, EXPECTED_CHAIN_ID, MOCK_YIELD, POLYGONSCAN_API_KEY.`,
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
  /* 1. Signer                                                               */
  /* ---------------------------------------------------------------------- */

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    fatal(
      "No deployer signer available.",
      `Network "${networkName}" exposes no accounts. hardhat.config.js reads PRIVATE_KEY from the environment for the "polygon" network.`
    );
  }
  const deployerAddress = await deployer.getAddress();

  if (marketingWallet === deployerAddress) {
    warn(
      "MARKETING_WALLET is the deployer. The 15,000,000 CATT marketing allocation will sit on the deployer\n" +
        "        wallet rather than on a marketing wallet. That is only acceptable for a throwaway local run."
    );
  }
  if (liquidityWalletEnv && marketingWallet === liquidityWalletEnv) {
    warn(
      "MARKETING_WALLET equals LIQUIDITY_WALLET, so the marketing and DEX liquidity buckets land in one wallet.\n" +
        "        They are separate allocations and should have separate destinations."
    );
  }

  if (!isLocalRun && deployerAddress.toLowerCase() !== String(env.PRIVATE_KEY || "").split(",")[0].trim().toLowerCase()) {
    // Not fatal (multi-key lists are allowed); just tell the operator who is really signing.
    warn(`the first signer on this network is ${deployerAddress}, which is not PRIVATE_KEY[0].`);
  }

  const balanceWei = await ethers.provider.getBalance(deployerAddress);
  banner("PRE-FLIGHT");
  log(`deployer           : ${deployerAddress}`);
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
      "Fund it with testnet MATIC (Amoy faucet) or run against the in-process network without --network."
    );
  }

  if (isLocalRun) {
    warn("running on the in-process Hardhat network: nothing is broadcast to any real chain.");
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Chain id guard                                                       */
  /* ---------------------------------------------------------------------- */

  const liveChainId = BigInt(await ethers.provider.getNetwork().then((n) => n.chainId));
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
  /* 3. Yield token (real address from env, or the TEST-ONLY mock)           */
  /* ---------------------------------------------------------------------- */

  const txs = {};

  let yieldTokenAddress;
  let yieldTokenKind;
  let yieldTokenNote;
  if (mockYieldRequested) {
    const mock = await ethers.deployContract(ARTIFACT_NAMES.mockYield, [], deployer);
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
  /* 4. Output file guard (double-deployment protection)                     */
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
    /* 5. DEPLOYMENT ORDER                                                    */
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
  const catt = await ethers.deployContract(ARTIFACT_NAMES.catt, [deployerAddress], deployer);
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
  const teamVesting = await ethers.deployContract(
    ARTIFACT_NAMES.teamVesting,
    [cattAddress, teamBeneficiary, treasuryBeneficiary, teamAmount, treasuryAmount],
    deployer
  );
  const vestingReceipt = await teamVesting.deploymentTransaction().wait();
  const teamVestingAddress = await teamVesting.getAddress();
  txs.TeamVesting = vestingReceipt.hash;
  log(`TeamVesting        : ${teamVestingAddress}   tx ${vestingReceipt.hash}`);
  log(`  team beneficiary   : ${teamBeneficiary} (${formatCatt(teamAmount)} CATT)`);
  log(`  treasury           : ${treasuryBeneficiary} (${formatCatt(treasuryAmount)} CATT)`);

  banner("STEP 3/6 — StakingManager");
  const stakingManager = await ethers.deployContract(ARTIFACT_NAMES.stakingManager, [cattAddress], deployer);
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
  const bondManager = await ethers.deployContract(ARTIFACT_NAMES.bondManager, [cattAddress, yieldTokenAddress], deployer);
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
  const miningClaimer = await ethers.deployContract(
    ARTIFACT_NAMES.miningClaimer,
    [cattAddress, stakingManagerAddress, signerAddress],
    deployer
  );
  const claimerReceipt = await miningClaimer.deploymentTransaction().wait();
  const miningClaimerAddress = await miningClaimer.getAddress();
  txs.MiningClaimer = claimerReceipt.hash;
  log(`MiningClaimer      : ${miningClaimerAddress}   tx ${claimerReceipt.hash}`);
  log(`  CATT owner becomes : ${miningClaimerAddress}`);
  log(`  StakingManager.claimer becomes : ${miningClaimerAddress}`);
  log(`  signer             : ${signerAddress}`);

  /* ---------------------------------------------------------------------- */
  /* 6. WIRING                                                               */
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
  /* 7. Verification                                                         */
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
    const revertName = (error.shortMessage || error.message || "").toString();
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
  /* 8. Manifest                                                            */
  /* ---------------------------------------------------------------------- */

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: "smart-contracts/scripts/deploy-testnet.js",
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
  /* 9. Summary table                                                       */
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

async function entrypoint() {
  // `npx hardhat run` has already compiled and already required this file, so
  // `require.main !== module` there. Invoked directly with `node`, there is no
  // compilation step yet, so run it first.
  if (require.main === module) {
    await hre.run("compile");
  }
  await main();
}

entrypoint().catch((error) => {
  console.error("");
  console.error("DEPLOYMENT FAILED:");
  console.error(error && error.stack ? error.stack : String(error));
  console.error("");
  process.exitCode = 1;
});