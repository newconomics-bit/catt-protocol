const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Wave 1 test suite for the CATT Protocol.
 *
 * Two contracts are covered:
 *   - CATT        : ERC20 + Ownable with an immutable MAX_SUPPLY hard cap.
 *   - TeamVesting : linear vesting for the team (15%) and treasury (20%)
 *                   allocations, 1-year cliff + 3-year linear window.
 *
 * All token amounts are BigInt base units (18 decimals). No floats are used
 * anywhere, including in the tolerance comparisons, which are expressed as
 * integer BigInt multiplications.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE = 10n ** 18n;
const MAX_SUPPLY = 100_000_000n * ONE;
const TEAM_ALLOC = 15_000_000n * ONE;
const TREASURY_ALLOC = 20_000_000n * ONE;
const VESTING_FUNDING = TEAM_ALLOC + TREASURY_ALLOC; // 35M = 35% of MAX_SUPPLY
const DAY = 86_400n;
const CLIFF = 365n * DAY;
const DURATION = 4n * 365n * DAY;
const WINDOW = DURATION - CLIFF; // 3 years of linear vesting

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Independent JS re-implementation of the on-chain vesting curve, used to
 * cross-check the contract at exact timestamps.
 *
 *   total == 0                                -> 0
 *   ts <= start + cliff                       -> 0
 *   ts >= start + duration                    -> total
 *   otherwise                                 -> total * (ts - (start + cliff)) / (duration - cliff)
 *
 * @param {{total: bigint, startTime: bigint, cliffDuration: bigint, duration: bigint}} allocation
 * @param {bigint} timestamp
 * @returns {bigint}
 */
function vestedAt(allocation, timestamp) {
  const { total, startTime, cliffDuration, duration } = allocation;
  if (total === 0n) return 0n;
  if (timestamp <= startTime + cliffDuration) return 0n;
  if (timestamp >= startTime + duration) return total;
  return (total * (timestamp - (startTime + cliffDuration))) / (duration - cliffDuration);
}

/** Schedule descriptor matching what TeamVesting stores on-chain. */
function scheduleOf(total, startTime) {
  return { total, startTime, cliffDuration: CLIFF, duration: DURATION };
}

/**
 * Timestamp of the block that contains `tx`, as a BigInt: wait for the receipt
 * to learn the block number, then read that block's timestamp.
 *
 * (hardhat-ethers v3.1.3 does expose `contract.deploymentTransaction()`, which
 * is verified to work; it is used for the deployment timestamps below. This
 * helper is the general form used for arbitrary claim transactions.)
 *
 * @param {object} tx a transaction response
 * @returns {Promise<bigint>}
 */
async function blockTimestampOf(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return BigInt(block.timestamp);
}

/** Timestamp of the current head block, as a BigInt. */
async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployCATTFixture() {
  const [deployer, alice, bob, attacker] = await ethers.getSigners();
  const catt = await ethers.deployContract("CATT", [deployer.address]);
  await catt.waitForDeployment();
  return { catt, deployer, alice, bob, attacker };
}

async function deployFullyMintedCATTFixture() {
  const base = await deployCATTFixture();
  const { catt, deployer } = base;
  const preMinted = MAX_SUPPLY - 1000n;
  await catt.mint(deployer.address, preMinted);
  return { ...base, preMinted };
}

async function deployVestingFixture() {
  const [deployer, team, treasury, attacker, alice] = await ethers.getSigners();

  const catt = await ethers.deployContract("CATT", [deployer.address]);
  await catt.waitForDeployment();

  const vesting = await ethers.deployContract("TeamVesting", [
    catt.target,
    team.address,
    treasury.address,
    TEAM_ALLOC,
    TREASURY_ALLOC,
  ]);
  await vesting.waitForDeployment();

  // The schedule starts at the vesting deployment block's timestamp.
  const startTime = await blockTimestampOf(vesting.deploymentTransaction());

  await catt.mint(deployer.address, VESTING_FUNDING);
  await catt.transfer(vesting.target, VESTING_FUNDING);

  return { catt, vesting, deployer, team, treasury, attacker, alice, startTime };
}

async function deployTwoVestingsFixture() {
  const [deployer, teamA, treasuryA, teamB, treasuryB, attacker, alice] = await ethers.getSigners();

  const catt = await ethers.deployContract("CATT", [deployer.address]);
  await catt.waitForDeployment();

  const vestingA = await ethers.deployContract("TeamVesting", [
    catt.target,
    teamA.address,
    treasuryA.address,
    TEAM_ALLOC,
    TREASURY_ALLOC,
  ]);
  const vestingB = await ethers.deployContract("TeamVesting", [
    catt.target,
    teamB.address,
    treasuryB.address,
    TEAM_ALLOC,
    TREASURY_ALLOC,
  ]);
  await vestingA.waitForDeployment();
  await vestingB.waitForDeployment();

  const startA = await blockTimestampOf(vestingA.deploymentTransaction());
  const startB = await blockTimestampOf(vestingB.deploymentTransaction());

  await catt.mint(deployer.address, VESTING_FUNDING * 2n);
  await catt.transfer(vestingA.target, VESTING_FUNDING);
  await catt.transfer(vestingB.target, VESTING_FUNDING);

  return {
    catt,
    vestingA,
    vestingB,
    deployer,
    teamA,
    treasuryA,
    teamB,
    treasuryB,
    attacker,
    alice,
    startA,
    startB,
  };
}

/** Read the on-chain `Allocation` struct for `beneficiary`. */
async function readAllocation(vesting, beneficiary) {
  const a = await vesting.allocations(beneficiary);
  return {
    total: a.total,
    released: a.released,
    startTime: a.startTime,
    cliffDuration: a.cliffDuration,
    duration: a.duration,
  };
}

/** `released` field of an allocation, without reading the whole struct. */
async function releasedOf(vesting, beneficiary) {
  const a = await vesting.allocations(beneficiary);
  return a.released;
}

// ===========================================================================
// A. CATT token metadata (4)
// ===========================================================================

describe("A. CATT token metadata", function () {
  it("A1: exposes the name 'CATT Protocol' and the symbol 'CATT'", async function () {
    const { catt } = await loadFixture(deployCATTFixture);
    expect(await catt.name()).to.equal("CATT Protocol");
    expect(await catt.symbol()).to.equal("CATT");
  });

  it("A2: uses 18 decimals", async function () {
    const { catt } = await loadFixture(deployCATTFixture);
    expect(await catt.decimals()).to.equal(18n);
  });

  it("A3: MAX_SUPPLY is exactly 100,000,000 CATT in base units", async function () {
    const { catt } = await loadFixture(deployCATTFixture);
    const expected = 100_000_000_000_000_000_000_000_000n;
    expect(expected).to.equal(100_000_000n * 10n ** 18n);
    expect(MAX_SUPPLY).to.equal(expected);
    expect(await catt.MAX_SUPPLY()).to.equal(expected);
  });

  it("A4: totalSupply is 0 immediately after deployment", async function () {
    const { catt } = await loadFixture(deployCATTFixture);
    expect(await catt.totalSupply()).to.equal(0n);
  });
});

// ===========================================================================
// B. CATT ownership (3)
// ===========================================================================

describe("B. CATT ownership", function () {
  it("B1: the deploying signer is the initial owner", async function () {
    const { catt, deployer } = await loadFixture(deployCATTFixture);
    expect(await catt.owner()).to.equal(deployer.address);
  });

  it("B2: transferOwnership moves the owner", async function () {
    const { catt, deployer, alice } = await loadFixture(deployCATTFixture);
    await catt.transferOwnership(alice.address);
    expect(await catt.owner()).to.equal(alice.address);
    expect(await catt.owner()).to.not.equal(deployer.address);
  });

  it("B3: after a transfer the old owner can no longer mint and the new owner can", async function () {
    const { catt, deployer, alice } = await loadFixture(deployCATTFixture);
    await catt.transferOwnership(alice.address);

    await expect(catt.connect(deployer).mint(deployer.address, ONE))
      .to.be.revertedWithCustomError(catt, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);

    await catt.connect(alice).mint(alice.address, ONE);
    expect(await catt.balanceOf(alice.address)).to.equal(ONE);
  });
});

// ===========================================================================
// C. CATT mint restriction, owner only (5)
// ===========================================================================

describe("C. CATT mint restriction (owner only)", function () {
  it("C1a: an owner mint increases the recipient balance and totalSupply", async function () {
    const { catt, alice } = await loadFixture(deployCATTFixture);
    const amount = 1_000n * ONE;
    await catt.mint(alice.address, amount);
    expect(await catt.balanceOf(alice.address)).to.equal(amount);
    expect(await catt.totalSupply()).to.equal(amount);
  });

  it("C1b: an owner mint emits Minted(to, amount, newTotalSupply)", async function () {
    const { catt, alice } = await loadFixture(deployCATTFixture);
    const first = 500n * ONE;
    const second = 250n * ONE;
    await catt.mint(alice.address, first);
    await expect(catt.mint(alice.address, second))
      .to.emit(catt, "Minted")
      .withArgs(alice.address, second, first + second);
  });

  it("C1c: an owner mint also emits a standard ERC20 Transfer from address(0)", async function () {
    const { catt, alice } = await loadFixture(deployCATTFixture);
    const amount = 42n * ONE;
    await expect(catt.mint(alice.address, amount))
      .to.emit(catt, "Transfer")
      .withArgs(ethers.ZeroAddress, alice.address, amount);
  });

  it("C2: a non-owner mint reverts with OwnableUnauthorizedAccount and mints nothing", async function () {
    const { catt, attacker } = await loadFixture(deployCATTFixture);
    await expect(catt.connect(attacker).mint(attacker.address, ONE))
      .to.be.revertedWithCustomError(catt, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
    expect(await catt.totalSupply()).to.equal(0n);
    expect(await catt.balanceOf(attacker.address)).to.equal(0n);
  });

  it("C3: minting to address(0) reverts with ERC20InvalidReceiver", async function () {
    const { catt } = await loadFixture(deployCATTFixture);
    await expect(catt.mint(ethers.ZeroAddress, ONE))
      .to.be.revertedWithCustomError(catt, "ERC20InvalidReceiver")
      .withArgs(ethers.ZeroAddress);
    expect(await catt.totalSupply()).to.equal(0n);
  });
});

// ===========================================================================
// D. CATT hard supply cap (5)
// ===========================================================================

describe("D. CATT hard supply cap", function () {
  it("D1a: minting exactly MAX_SUPPLY from zero succeeds", async function () {
    const { catt, deployer } = await loadFixture(deployCATTFixture);
    await catt.mint(deployer.address, MAX_SUPPLY);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);
    expect(await catt.balanceOf(deployer.address)).to.equal(MAX_SUPPLY);
  });

  it("D1b: minting the exact remaining headroom from a partial supply succeeds", async function () {
    const { catt, deployer, preMinted } = await loadFixture(deployFullyMintedCATTFixture);
    expect(await catt.totalSupply()).to.equal(preMinted);
    const headroom = MAX_SUPPLY - preMinted;
    expect(headroom).to.equal(1000n);
    await catt.mint(deployer.address, headroom);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);
  });

  it("D2: minting headroom + 1 wei reverts with MintExceedsMaxSupply(requested, MAX_SUPPLY)", async function () {
    const { catt, deployer, preMinted } = await loadFixture(deployFullyMintedCATTFixture);
    const headroom = MAX_SUPPLY - preMinted;
    await expect(catt.mint(deployer.address, headroom + 1n))
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + 1n, MAX_SUPPLY);
  });

  it("D3a: a failed over-cap mint leaves totalSupply unchanged", async function () {
    const { catt, deployer, preMinted } = await loadFixture(deployFullyMintedCATTFixture);
    await expect(catt.mint(deployer.address, MAX_SUPPLY))
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply");
    expect(await catt.totalSupply()).to.equal(preMinted);
  });

  it("D3b: ten 10M mints fill the cap exactly and 1 wei more reverts", async function () {
    const { catt, deployer } = await loadFixture(deployCATTFixture);
    const chunk = 10_000_000n * ONE;
    for (let i = 0; i < 10; i++) {
      await catt.mint(deployer.address, chunk);
    }
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);

    await expect(catt.mint(deployer.address, 1n))
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + 1n, MAX_SUPPLY);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);
  });
});

// ===========================================================================
// E. TeamVesting
// ===========================================================================

describe("E. TeamVesting", function () {
  it("E0: the fixture holds exactly 35% of MAX_SUPPLY and the deployer holds none", async function () {
    const { catt, vesting, deployer, startTime } = await loadFixture(deployVestingFixture);
    expect(VESTING_FUNDING).to.equal(35_000_000n * ONE);
    expect(await catt.totalSupply()).to.equal(VESTING_FUNDING);
    expect(await catt.balanceOf(vesting.target)).to.equal(VESTING_FUNDING);
    expect(await catt.balanceOf(deployer.address)).to.equal(0n);
    expect((VESTING_FUNDING * 100n) / MAX_SUPPLY).to.equal(35n);
    expect(startTime).to.be.greaterThan(0n);
  });

  describe("E1. constructor records both allocations", function () {
    it("E1a: the team allocation is 15,000,000 with 0 released", async function () {
      const { vesting, team } = await loadFixture(deployVestingFixture);
      const a = await readAllocation(vesting, team.address);
      expect(a.total).to.equal(TEAM_ALLOC);
      expect(a.total).to.equal(15_000_000n * ONE);
      expect(a.released).to.equal(0n);
    });

    it("E1b: the treasury allocation is 20,000,000 with 0 released", async function () {
      const { vesting, treasury } = await loadFixture(deployVestingFixture);
      const a = await readAllocation(vesting, treasury.address);
      expect(a.total).to.equal(TREASURY_ALLOC);
      expect(a.total).to.equal(20_000_000n * ONE);
      expect(a.released).to.equal(0n);
    });

    it("E1c: startTime is the deployment timestamp, cliff is 365d, duration is 4*365d", async function () {
      const { vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const a = await readAllocation(vesting, team.address);
      expect(a.startTime).to.equal(startTime);
      expect(a.cliffDuration).to.equal(365n * DAY);
      expect(a.duration).to.equal(4n * 365n * DAY);
      expect(a.duration - a.cliffDuration).to.equal(WINDOW);

      expect(await vesting.CLIFF_DURATION()).to.equal(365n * DAY);
      expect(await vesting.VESTING_DURATION()).to.equal(4n * 365n * DAY);
    });
  });

  describe("E2. lock behaviour during the 1-year cliff", function () {
    it("E2a: at startTime nothing is vested or releasable for either beneficiary", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      expect(await latestTimestamp()).to.be.lessThan(startTime + CLIFF);
      expect(await vesting.vestedAmount(team.address)).to.equal(0n);
      expect(await vesting.vestedAmount(treasury.address)).to.equal(0n);
      expect(await vesting.releasable(team.address)).to.equal(0n);
      expect(await vesting.releasable(treasury.address)).to.equal(0n);
    });

    it("E2b: 364 days in, nothing is vested or releasable for either beneficiary", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      // Still one day short of the cliff.
      await time.increase(364n * DAY);
      expect(await latestTimestamp()).to.be.lessThan(startTime + CLIFF);
      expect(await vesting.vestedAmount(team.address)).to.equal(0n);
      expect(await vesting.vestedAmount(treasury.address)).to.equal(0n);
      expect(await vesting.releasable(team.address)).to.equal(0n);
      expect(await vesting.releasable(treasury.address)).to.equal(0n);
    });

    it("E2c: claim() reverts with NothingToClaim for BOTH beneficiaries inside the cliff", async function () {
      const { vesting, team, treasury } = await loadFixture(deployVestingFixture);
      await time.increase(364n * DAY);
      await expect(vesting.connect(team).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
      await expect(vesting.connect(treasury).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
    });

    it("E2d: the tokens sit in the contract while nothing is claimable", async function () {
      const { catt, vesting, team, treasury } = await loadFixture(deployVestingFixture);
      await time.increase(364n * DAY);
      expect(await catt.balanceOf(vesting.target)).to.equal(VESTING_FUNDING);
      expect(await catt.balanceOf(team.address)).to.equal(0n);
      expect(await catt.balanceOf(treasury.address)).to.equal(0n);
      expect(await vesting.releasable(team.address)).to.equal(0n);
      expect(await vesting.releasable(treasury.address)).to.equal(0n);
    });

    it("E2e: at exactly startTime + CLIFF the vest is still 0 (the window opens strictly after)", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      // Mine a block pinned to exactly the cliff instant.
      await time.increaseTo(startTime + CLIFF);
      expect(await latestTimestamp()).to.equal(startTime + CLIFF);
      expect(await vesting.vestedAmount(team.address)).to.equal(0n);
      expect(await vesting.vestedAmount(treasury.address)).to.equal(0n);
      expect(await vesting.releasable(team.address)).to.equal(0n);
      expect(await vesting.releasable(treasury.address)).to.equal(0n);
    });
  });

  describe("E3. first claim just after the cliff", function () {
    it("E3a: one hour after the cliff a tiny, non-zero amount vests, equal to vestedAt()", async function () {
      const { vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);

      // 300s into the 94,608,000s window is ~0.000317% of the allocation.
      await time.increaseTo(startTime + CLIFF + 300n);
      const dust = await vesting.vestedAmount(team.address);
      expect(dust).to.equal(vestedAt(schedule, startTime + CLIFF + 300n));
      expect(dust).to.be.greaterThan(0n);
      expect((dust * 100_000n) / TEAM_ALLOC).to.be.lessThan(1000n); // < 0.001%

      // 3600s in is ~570 tokens, i.e. ~0.0038% of the allocation.
      await time.increaseTo(startTime + CLIFF + 3600n);
      const ts = await latestTimestamp();
      const vested = await vesting.vestedAmount(team.address);
      expect(ts).to.equal(startTime + CLIFF + 3600n);
      expect(vested).to.equal(vestedAt(schedule, ts));
      expect(vested).to.be.greaterThan(0n);
      expect(vested).to.be.lessThan(TEAM_ALLOC);
      expect((vested * 10_000n) / TEAM_ALLOC).to.be.lessThan(1000n); // < 0.01%
    });

    it("E3b: claim() pays the vested dust, drains releasable and records it as released", async function () {
      const { catt, vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);
      await time.increaseTo(startTime + CLIFF + 3600n);

      const before = await catt.balanceOf(team.address);
      const tx = await vesting.connect(team).claim();
      const ts = await blockTimestampOf(tx);
      const expected = vestedAt(schedule, ts);

      expect(expected).to.be.greaterThan(0n);
      expect(await catt.balanceOf(team.address)).to.equal(before + expected);

      // The claim block is the head block, so released == vested at ts and
      // nothing is left releasable at that instant.
      const released = await releasedOf(vesting, team.address);
      expect(released).to.equal(expected);
      expect(released).to.be.greaterThan(0n);
      expect(released).to.be.lessThan(TEAM_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(0n);
    });

    it("E3c: a back-to-back second claim releases ONLY the new accrual (no double-claim)", async function () {
      const { catt, vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);
      await time.increaseTo(startTime + CLIFF + 3600n);

      const tx1 = await vesting.connect(team).claim();
      const ts1 = await blockTimestampOf(tx1);
      const released1 = await releasedOf(vesting, team.address);
      expect(released1).to.equal(vestedAt(schedule, ts1));

      const balance1 = await catt.balanceOf(team.address);

      // Hardhat mines strictly increasing timestamps, so the second claim lands
      // exactly one second later. The accrued dust for that second is
      // TEAM_ALLOC / WINDOW ~= 158,547,000 wei, i.e. a back-to-back second
      // claim CANNOT revert; the property to assert is that it re-releases
      // nothing beyond the new accrual.
      const tx2 = await vesting.connect(team).claim();
      const ts2 = await blockTimestampOf(tx2);
      expect(ts2 - ts1).to.equal(1n);

      const released2 = await releasedOf(vesting, team.address);
      const newAccrual = vestedAt(schedule, ts2) - vestedAt(schedule, ts1);
      expect(newAccrual).to.be.greaterThan(0n);
      expect(released2 - released1).to.equal(newAccrual);
      expect(await catt.balanceOf(team.address)).to.equal(balance1 + newAccrual);
      // The first claim's tokens are never paid out a second time.
      expect(released2).to.be.lessThan(vestedAt(schedule, ts2) * 2n);
      expect(await vesting.releasable(team.address)).to.equal(0n);

      // Once fully vested, a further claim reverts and changes no bookkeeping.
      await time.increaseTo(startTime + DURATION);
      await vesting.connect(team).claim();
      const releasedAtEnd = await releasedOf(vesting, team.address);
      const balanceAtEnd = await catt.balanceOf(team.address);
      expect(releasedAtEnd).to.equal(TEAM_ALLOC);
      expect(balanceAtEnd).to.equal(TEAM_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(0n);

      await expect(vesting.connect(team).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
      expect(await releasedOf(vesting, team.address)).to.equal(releasedAtEnd);
      expect(await catt.balanceOf(team.address)).to.equal(balanceAtEnd);
    });
  });

  describe("E4. linear accrual", function () {
    it("E4a: team vests ~50% of 15M at the 2.5-year midpoint, matching vestedAt()", async function () {
      const { vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);
      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      const ts = await latestTimestamp();

      const vested = await vesting.vestedAmount(team.address);
      expect(vested).to.equal(vestedAt(schedule, ts));
      // Exactly 50% here, and well inside the 0.1% tolerance band.
      expect(vested).to.equal(TEAM_ALLOC / 2n);
      expect((TEAM_ALLOC / 2n) * 1000n).to.be.greaterThanOrEqual(vested * 999n);
    });

    it("E4b: treasury vests ~50% of 20M at the 2.5-year midpoint, matching vestedAt()", async function () {
      const { vesting, treasury, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TREASURY_ALLOC, startTime);
      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      const ts = await latestTimestamp();

      const vested = await vesting.vestedAmount(treasury.address);
      expect(vested).to.equal(vestedAt(schedule, ts));
      expect(vested).to.equal(TREASURY_ALLOC / 2n);
      expect((TREASURY_ALLOC / 2n) * 1000n).to.be.greaterThanOrEqual(vested * 999n);
    });

    it("E4c: the midpoint vests strictly more than just after the cliff, by >1000x", async function () {
      const { vesting, team, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + CLIFF + 3600n);
      const justAfterCliff = await vesting.vestedAmount(team.address);

      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      const midpoint = await vesting.vestedAmount(team.address);

      expect(midpoint).to.be.greaterThan(justAfterCliff);
      expect(midpoint).to.be.greaterThan(justAfterCliff * 1000n);
    });

    it("E4d: the team curve is strictly increasing across window samples and never exceeds the allocation", async function () {
      const { vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);
      const percents = [10n, 25n, 50n, 75n, 99n];
      const samples = [];

      for (const p of percents) {
        // Mine a block at each sample instant so the view reads that timestamp.
        await time.increaseTo(startTime + CLIFF + (WINDOW * p) / 100n);
        const ts = await latestTimestamp();
        const vested = await vesting.vestedAmount(team.address);
        expect(vested).to.equal(vestedAt(schedule, ts));
        expect(vested).to.be.lessThanOrEqual(TEAM_ALLOC);
        samples.push(vested);
      }

      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]).to.be.greaterThan(samples[i - 1]);
      }
    });
  });

  describe("E5. full vest at 4 years", function () {
    it("E5a: at startTime + DURATION both beneficiaries are vested to exactly their totals", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + DURATION);
      const ts = await latestTimestamp();
      expect(ts).to.equal(startTime + DURATION);

      expect(await vesting.vestedAmount(team.address)).to.equal(TEAM_ALLOC);
      expect(await vesting.vestedAmount(treasury.address)).to.equal(TREASURY_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(TEAM_ALLOC);
      expect(await vesting.releasable(treasury.address)).to.equal(TREASURY_ALLOC);
    });

    it("E5b: at full vest, releasable equals total minus what was already claimed", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      await vesting.connect(team).claim();
      const releasedMid = await releasedOf(vesting, team.address);
      expect(releasedMid).to.be.greaterThan(0n);

      await time.increaseTo(startTime + DURATION);
      expect(await vesting.vestedAmount(team.address)).to.equal(TEAM_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(TEAM_ALLOC - releasedMid);
      // Treasury never claimed, so its releasable is its full total.
      expect(await vesting.releasable(treasury.address)).to.equal(TREASURY_ALLOC);
    });

    it("E5c: the final claim pays exactly the remainder and zeroes releasable", async function () {
      const { catt, vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + DURATION);

      const teamBefore = await catt.balanceOf(team.address);
      await vesting.connect(team).claim();
      expect(await catt.balanceOf(team.address)).to.equal(teamBefore + TEAM_ALLOC);
      expect(await releasedOf(vesting, team.address)).to.equal(TEAM_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(0n);

      const treasuryBefore = await catt.balanceOf(treasury.address);
      await vesting.connect(treasury).claim();
      expect(await catt.balanceOf(treasury.address)).to.equal(treasuryBefore + TREASURY_ALLOC);
      expect(await releasedOf(vesting, treasury.address)).to.equal(TREASURY_ALLOC);
      expect(await vesting.releasable(treasury.address)).to.equal(0n);
    });

    it("E5d: repeated claims at 5 checkpoints drain both allocations exactly", async function () {
      const { catt, vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      const checkpoints = [
        CLIFF + WINDOW / 10n,
        CLIFF + WINDOW / 4n,
        CLIFF + WINDOW / 2n,
        CLIFF + (WINDOW * 3n) / 4n,
        DURATION,
      ];

      for (const offset of checkpoints) {
        await time.increaseTo(startTime + offset);
        await vesting.connect(team).claim();
        await vesting.connect(treasury).claim();
      }

      expect(await catt.balanceOf(team.address)).to.equal(TEAM_ALLOC);
      expect(await catt.balanceOf(treasury.address)).to.equal(TREASURY_ALLOC);
      expect(await catt.balanceOf(team.address) + (await catt.balanceOf(treasury.address))).to.equal(
        35_000_000n * ONE
      );
      expect(await catt.balanceOf(vesting.target)).to.equal(0n);
      expect(await catt.totalSupply()).to.equal(35_000_000n * ONE);

      await expect(vesting.connect(team).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
      await expect(vesting.connect(treasury).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
    });

    it("E5e: a claim pinned with setNextBlockTimestamp pays exactly vestedAt() at that timestamp", async function () {
      const { catt, vesting, team, startTime } = await loadFixture(deployVestingFixture);
      const schedule = scheduleOf(TEAM_ALLOC, startTime);
      const pinned = startTime + CLIFF + WINDOW / 3n;

      // Pin the next (claim) block to an exact instant, then claim into it.
      await time.setNextBlockTimestamp(pinned);
      const tx = await vesting.connect(team).claim();
      const ts = await blockTimestampOf(tx);
      expect(ts).to.equal(pinned);

      const expected = vestedAt(schedule, pinned);
      expect(expected).to.be.greaterThan(0n);
      expect(await catt.balanceOf(team.address)).to.equal(expected);
      expect(await releasedOf(vesting, team.address)).to.equal(expected);
    });
  });

  describe("E6. independence of the two allocations", function () {
    it("E6a: a team claim moves no treasury state beyond one second of pure time accrual", async function () {
      const { vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      const teamSchedule = scheduleOf(TEAM_ALLOC, startTime);
      const treasurySchedule = scheduleOf(TREASURY_ALLOC, startTime);

      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      const tsBefore = await latestTimestamp();
      const treasuryVestedBefore = await vesting.vestedAmount(treasury.address);
      const treasuryReleasedBefore = await releasedOf(vesting, treasury.address);
      expect(treasuryVestedBefore).to.equal(vestedAt(treasurySchedule, tsBefore));

      const tx = await vesting.connect(team).claim();
      const claimTs = await blockTimestampOf(tx);

      // The claim block is the head block, so this is the treasury reading at
      // the claim's own timestamp. The only movement is time-driven accrual.
      const treasuryVestedAfter = await vesting.vestedAmount(treasury.address);
      expect(treasuryVestedAfter).to.equal(vestedAt(treasurySchedule, claimTs));
      expect(treasuryVestedAfter - treasuryVestedBefore).to.equal(
        vestedAt(treasurySchedule, claimTs) - vestedAt(treasurySchedule, tsBefore)
      );

      // Released-based assertions are exact: untouched by the team claim.
      expect(await releasedOf(vesting, treasury.address)).to.equal(treasuryReleasedBefore);
      expect(treasuryReleasedBefore).to.equal(0n);
      const treasuryAlloc = await readAllocation(vesting, treasury.address);
      expect(treasuryAlloc.total).to.equal(TREASURY_ALLOC);
      expect(treasuryAlloc.total).to.equal(20_000_000n * ONE);

      // Sanity: the team allocation itself did move.
      expect(await releasedOf(vesting, team.address)).to.equal(vestedAt(teamSchedule, claimTs));
      expect(await releasedOf(vesting, team.address)).to.be.greaterThan(0n);
    });

    it("E6b: treasury claiming gets exactly its 20M and none of the team's 15M", async function () {
      const { catt, vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + DURATION);

      await vesting.connect(treasury).claim();
      expect(await catt.balanceOf(treasury.address)).to.equal(TREASURY_ALLOC);
      expect(await catt.balanceOf(team.address)).to.equal(0n);
      expect(await releasedOf(vesting, treasury.address)).to.equal(TREASURY_ALLOC);
      expect(await releasedOf(vesting, team.address)).to.equal(0n);

      // The team's full 15M is still available to the team.
      expect(await vesting.vestedAmount(team.address)).to.equal(TEAM_ALLOC);
      expect(await vesting.releasable(team.address)).to.equal(TEAM_ALLOC);
      expect(await catt.balanceOf(vesting.target)).to.equal(TEAM_ALLOC);
    });

    it("E6c: each beneficiary's released tracks only its own claim history", async function () {
      const { catt, vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
      const teamSchedule = scheduleOf(TEAM_ALLOC, startTime);
      const treasurySchedule = scheduleOf(TREASURY_ALLOC, startTime);

      await time.increaseTo(startTime + CLIFF + WINDOW / 4n);
      const txT1 = await vesting.connect(treasury).claim();
      const tsT1 = await blockTimestampOf(txT1);

      await time.increaseTo(startTime + CLIFF + WINDOW / 2n);
      const txM1 = await vesting.connect(team).claim();
      const tsM1 = await blockTimestampOf(txM1);

      await time.increaseTo(startTime + CLIFF + (WINDOW * 3n) / 4n);
      const txT2 = await vesting.connect(treasury).claim();
      const tsT2 = await blockTimestampOf(txT2);

      await time.increaseTo(startTime + CLIFF + (WINDOW * 7n) / 8n);
      const txM2 = await vesting.connect(team).claim();
      const tsM2 = await blockTimestampOf(txM2);

      // Each released equals that beneficiary's own vested amount at its own
      // most recent claim instant - nothing more.
      const teamReleased = await releasedOf(vesting, team.address);
      const treasuryReleased = await releasedOf(vesting, treasury.address);
      expect(teamReleased).to.equal(vestedAt(teamSchedule, tsM2));
      expect(treasuryReleased).to.equal(vestedAt(treasurySchedule, tsT2));
      expect(tsM1).to.be.lessThan(tsM2);
      expect(tsT1).to.be.lessThan(tsT2);

      // The treasury's release is NOT the team's last-claim instant amount:
      // each tracks its own history only.
      expect(treasuryReleased).to.not.equal(vestedAt(treasurySchedule, tsM2));
      expect(teamReleased).to.not.equal(vestedAt(teamSchedule, tsT2));

      // Balances track released 1:1 and the contract holds the remainder.
      expect(await catt.balanceOf(team.address)).to.equal(teamReleased);
      expect(await catt.balanceOf(treasury.address)).to.equal(treasuryReleased);
      expect(await catt.balanceOf(vesting.target)).to.equal(
        VESTING_FUNDING - teamReleased - treasuryReleased
      );
    });
  });

  describe("E7. unregistered addresses", function () {
    it("E7a: an unknown address reports 0 vested and 0 releasable even after full vest", async function () {
      const { vesting, attacker, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + DURATION);
      expect(await latestTimestamp()).to.be.greaterThanOrEqual(startTime + DURATION);
      expect(await vesting.vestedAmount(attacker.address)).to.equal(0n);
      expect(await vesting.releasable(attacker.address)).to.equal(0n);
    });

    it("E7b: an unknown address cannot claim even after full vest", async function () {
      const { catt, vesting, attacker, startTime } = await loadFixture(deployVestingFixture);
      await time.increaseTo(startTime + DURATION);
      await expect(vesting.connect(attacker).claim())
        .to.be.revertedWithCustomError(vesting, "NothingToClaim");
      expect(await catt.balanceOf(attacker.address)).to.equal(0n);
      expect(await catt.balanceOf(vesting.target)).to.equal(VESTING_FUNDING);
    });

    it("E7c: an unknown address has an all-zero allocation record", async function () {
      const { vesting, attacker } = await loadFixture(deployVestingFixture);
      const a = await readAllocation(vesting, attacker.address);
      expect(a.total).to.equal(0n);
      expect(a.released).to.equal(0n);
      expect(a.startTime).to.equal(0n);
      expect(a.cliffDuration).to.equal(0n);
      expect(a.duration).to.equal(0n);
    });
  });

  describe("E8. independent vesting deployments", function () {
    it("E8a: two fully-vested deployments pay out exactly their own 70M combined", async function () {
      const { catt, vestingA, vestingB, teamA, treasuryA, teamB, treasuryB, startA, startB } =
        await loadFixture(deployTwoVestingsFixture);

      // Vest both schedules; B started at or after A, so the later one suffices.
      const lastStart = startA > startB ? startA : startB;
      await time.increaseTo(lastStart + DURATION);

      await vestingA.connect(teamA).claim();
      await vestingA.connect(treasuryA).claim();
      await vestingB.connect(teamB).claim();
      await vestingB.connect(treasuryB).claim();

      const totalReleased =
        (await releasedOf(vestingA, teamA.address)) +
        (await releasedOf(vestingA, treasuryA.address)) +
        (await releasedOf(vestingB, teamB.address)) +
        (await releasedOf(vestingB, treasuryB.address));

      expect(totalReleased).to.equal(70_000_000n * ONE);
      expect(totalReleased).to.be.lessThanOrEqual(MAX_SUPPLY);
      expect(await catt.balanceOf(vestingA.target)).to.equal(0n);
      expect(await catt.balanceOf(vestingB.target)).to.equal(0n);
      expect(await catt.totalSupply()).to.equal(70_000_000n * ONE);
      expect(await catt.balanceOf(teamA.address)).to.equal(TEAM_ALLOC);
      expect(await catt.balanceOf(treasuryA.address)).to.equal(TREASURY_ALLOC);
      expect(await catt.balanceOf(teamB.address)).to.equal(TEAM_ALLOC);
      expect(await catt.balanceOf(treasuryB.address)).to.equal(TREASURY_ALLOC);
    });

    it("E8b: a fully vested and claimed vesting A means vesting B has released nothing", async function () {
      const { catt, vestingA, vestingB, teamA, treasuryA, teamB, treasuryB, startA, startB } =
        await loadFixture(deployTwoVestingsFixture);

      const lastStart = startA > startB ? startA : startB;
      await time.increaseTo(lastStart + DURATION);

      await vestingA.connect(teamA).claim();
      await vestingA.connect(treasuryA).claim();
      // Vesting A is now drained: a further claim reverts.
      await expect(vestingA.connect(teamA).claim())
        .to.be.revertedWithCustomError(vestingA, "NothingToClaim");

      // Vesting B is fully vested too, but nobody there has claimed yet.
      expect(await vestingB.vestedAmount(teamB.address)).to.equal(TEAM_ALLOC);
      expect(await vestingB.vestedAmount(treasuryB.address)).to.equal(TREASURY_ALLOC);
      expect(await releasedOf(vestingB, teamB.address)).to.equal(0n);
      expect(await releasedOf(vestingB, treasuryB.address)).to.equal(0n);
      expect(await catt.balanceOf(teamB.address)).to.equal(0n);
      expect(await catt.balanceOf(treasuryB.address)).to.equal(0n);
      expect(await catt.balanceOf(vestingB.target)).to.equal(VESTING_FUNDING);
    });
  });
});

// ===========================================================================
// F. End-to-end supply invariants (4)
// ===========================================================================

describe("F. End-to-end supply invariants", function () {
  it("F1: minting the full MAX_SUPPLY then 1 wei reverts and the supply holds at MAX_SUPPLY", async function () {
    const { catt, deployer, preMinted } = await loadFixture(deployFullyMintedCATTFixture);
    await catt.mint(deployer.address, MAX_SUPPLY - preMinted);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);

    await expect(catt.mint(deployer.address, 1n))
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + 1n, MAX_SUPPLY);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);
  });

  it("F2a: vesting claims never change totalSupply (they are transfers only)", async function () {
    const { catt, vesting, team, treasury, startTime } = await loadFixture(deployVestingFixture);
    const checkpoints = [CLIFF + WINDOW / 4n, CLIFF + WINDOW / 2n, CLIFF + (WINDOW * 3n) / 4n, DURATION];

    for (const offset of checkpoints) {
      await time.increaseTo(startTime + offset);
      await vesting.connect(team).claim();
      await vesting.connect(treasury).claim();
      expect(await catt.totalSupply()).to.equal(VESTING_FUNDING);
    }

    expect(await catt.totalSupply()).to.equal(35_000_000n * ONE);
    expect(await catt.balanceOf(team.address)).to.equal(TEAM_ALLOC);
    expect(await catt.balanceOf(treasury.address)).to.equal(TREASURY_ALLOC);
  });

  it("F2b: 35M vested plus the free 65M hits exactly MAX_SUPPLY, and vesting still pays out", async function () {
    const { catt, vesting, team, treasury, deployer, startTime } = await loadFixture(
      deployVestingFixture
    );
    await time.increaseTo(startTime + DURATION);

    const free = MAX_SUPPLY - VESTING_FUNDING;
    expect(free).to.equal(65_000_000n * ONE);
    await catt.mint(deployer.address, free);
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);

    await expect(catt.mint(deployer.address, 1n))
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + 1n, MAX_SUPPLY);

    await vesting.connect(team).claim();
    await vesting.connect(treasury).claim();
    expect(await catt.balanceOf(team.address)).to.equal(TEAM_ALLOC);
    expect(await catt.balanceOf(treasury.address)).to.equal(TREASURY_ALLOC);
    expect(await catt.balanceOf(vesting.target)).to.equal(0n);
    // The claims moved tokens around but never touched the supply.
    expect(await catt.totalSupply()).to.equal(MAX_SUPPLY);
  });

  it("F2c: the allocations are exactly 15% (team) and 20% (treasury) of MAX_SUPPLY", async function () {
    const { catt, vesting, team, treasury } = await loadFixture(deployVestingFixture);
    const maxSupply = await catt.MAX_SUPPLY();
    expect((await readAllocation(vesting, team.address)).total).to.equal(TEAM_ALLOC);
    expect((await readAllocation(vesting, treasury.address)).total).to.equal(TREASURY_ALLOC);
    expect((TEAM_ALLOC * 100n) / maxSupply).to.equal(15n);
    expect((TREASURY_ALLOC * 100n) / maxSupply).to.equal(20n);
    expect(VESTING_FUNDING).to.equal(35n * maxSupply / 100n);
  });
});
