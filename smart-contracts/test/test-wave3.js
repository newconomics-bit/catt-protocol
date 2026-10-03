const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Wave 3 test suite for the CATT Protocol.
 *
 * Covers BondManager, i.e. the PRD Section 3.3 "Real Yield Bonds" economy:
 *   - 1-based tiers        : 30/90/180 day terms with 1x/2x/3x yield weight.
 *   - principal lock       : `withdrawPrincipal` always reverts (no early exit).
 *   - weighted pro-rata    : a sponsor deposit is split by
 *                            `points = principal * tierWeight`.
 *   - checkpointed accrual : `accYieldPerPoint` + a per-bond `accSnapshot` taken
 *                            AT CREATION, so a bond can never earn from a
 *                            deposit made before it existed.
 *   - redemption at maturity, permissionless to call but never redirectable.
 *
 * Every USDT amount is a 6-decimal base unit, deliberately: MockUSDT overrides
 * `decimals()` to 6, so these tests prove BondManager makes no 18-decimal
 * assumption about its yield token. CATT is 18-decimal throughout.
 *
 * All arithmetic is BigInt base units. Where a test needs an exact split, the
 * deposit is chosen so that `amount * 1e18 / totalPoints` is integral; where
 * the split is deliberately dirty, the truncation is the thing under test.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATT = (n) => ethers.parseUnits(String(n), 18);
const USDT = (n) => ethers.parseUnits(String(n), 6);
const ONE_CATT = 10n ** 18n;

const ACC_PRECISION = 10n ** 18n; // mirrors BondManager.ACC_PRECISION
const DAY = 86_400n;

const TIER_DURATION = { 1: 30n * DAY, 2: 90n * DAY, 3: 180n * DAY };
const TIER_WEIGHT = { 1: 1n, 2: 2n, 3: 3n };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timestamp of the block that contains `tx`, as a BigInt. */
async function blockTimestampOf(tx) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  return BigInt(block.timestamp);
}

/** Independent JS model of the accumulator increment added by a deposit. */
function incrementFor(amount, totalPoints) {
  return (amount * ACC_PRECISION) / totalPoints;
}

/** Independent JS model of the amount actually credited by a deposit. */
function distributedFor(increment, totalPoints) {
  return (increment * totalPoints) / ACC_PRECISION;
}

/** `bondInfo` as a plain object, with the labelled fields kept. */
async function readBond(bonds, bondId) {
  const i = await bonds.bondInfo(bondId);
  return {
    holder: i[0],
    principal: i[1],
    tier: i[2],
    createdAt: i[3],
    maturesAt: i[4],
    points: i[5],
    accruedYield: i[6],
    closed: i[7],
  };
}

/**
 * Opens a bond and returns its id, creation timestamp and maturity.
 *
 * @param {object} bonds BondManager
 * @param {object} holder signer to bond with
 * @param {bigint} amountCATT principal in whole CATT
 * @param {number} tier 1-based tier
 */
async function openBond(bonds, holder, amountCATT, tier) {
  const principal = CATT(amountCATT);
  const tx = await bonds.connect(holder).buyBond(principal, tier);
  const createdAt = await blockTimestampOf(tx);
  return {
    bondId: await bonds.totalBondsCreated(),
    principal,
    tier: BigInt(tier),
    points: await (await readBond(bonds, await bonds.totalBondsCreated())).points,
    createdAt,
    maturesAt: createdAt + TIER_DURATION[tier],
  };
}

/** Sponsor deposit, pinned to the next block so the accumulator step is exact. */
async function deposit(bonds, owner, amount) {
  return bonds.connect(owner).depositYield(amount);
}

/**
 * Sum over `bondIds` of the yield the contract still HOLDS for them, i.e. the
 * claimable part only.
 *
 * `accruedYield` is deliberately excluded: it has already been transferred out
 * of the contract, so adding it to the balance would count the same units
 * twice. The exact solvency identity is therefore
 *     usdt.balanceOf(bonds) == unallocatedYield + SUM(pendingYield)
 * while the separate, lifetime-accounting identity is
 *     SUM(deposits) == unallocatedYield + SUM(pendingYield + accruedYield).
 * Both are asserted in C8.
 */
async function totalClaimable(bonds, bondIds) {
  let sum = 0n;
  for (const id of bondIds) {
    sum += await bonds.pendingYield(id);
  }
  return sum;
}

/** Sum over `bondIds` of the yield already paid out to their holders. */
async function totalPaid(bonds, bondIds) {
  let sum = 0n;
  for (const id of bondIds) {
    sum += (await readBond(bonds, id)).accruedYield;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `owner` is the B2B sponsor treasury and BondManager owner; `alice` and `bob`
 * are bondholders; `carol` is an unrelated third party used for every
 * authorization check. USDT is 6-decimal MockUSDT, CATT is 18-decimal.
 */
async function deployBondsFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  const catt = await ethers.deployContract("CATT", [owner.address]);
  await catt.waitForDeployment();

  const usdt = await ethers.deployContract("MockUSDT");
  await usdt.waitForDeployment();

  const bonds = await ethers.deployContract("BondManager", [catt.target, usdt.target]);
  await bonds.waitForDeployment();

  // Sponsor funding: 1,000,000 USDT, approved up front.
  await usdt.mint(owner.address, USDT(1_000_000));
  await usdt.connect(owner).approve(bonds.target, ethers.MaxUint256);

  // Bondholders: 10,000 CATT each, approved up front.
  for (const user of [alice, bob, carol]) {
    await catt.mint(user.address, CATT(10_000));
    await catt.connect(user).approve(bonds.target, ethers.MaxUint256);
  }

  return { catt, usdt, bonds, owner, alice, bob, carol };
}

/**
 * The canonical "known configuration": one open tier-1 bond of 1,000 CATT
 * held by alice, so 1,000e18 points are live and nothing else is.
 */
async function singleTier1BondFixture() {
  const base = await deployBondsFixture();
  const { catt, bonds, alice } = base;

  const cattBefore = await catt.balanceOf(alice.address);
  const b = await openBond(bonds, alice, 1000, 1);

  return { ...base, cattBefore, bondId: b.bondId, principal: b.principal, createdAt: b.createdAt, maturesAt: b.maturesAt };
}

/**
 * "Known configuration" #2: alice holds 1,000 CATT in tier 1 (1,000 points)
 * and bob holds 1,000 CATT in tier 3 (3,000 points), a clean 1:3 weight split
 * over 4,000e18 total points.
 */
async function twoBond13Fixture() {
  const base = await deployBondsFixture();
  const { bonds, alice, bob } = base;

  const a = await openBond(bonds, alice, 1000, 1);
  const b = await openBond(bonds, bob, 1000, 3);

  return { ...base, a, b, totalPoints: a.points + b.points };
}

// ===========================================================================
// A. Tiers and bond creation (8)
// ===========================================================================

describe("A. BondManager tiers and bond creation", function () {
  it("A1: exposes the tier table, ACC_PRECISION and 1-based weights", async function () {
    const { bonds, catt, usdt } = await loadFixture(deployBondsFixture);

    expect(await bonds.TIER_COUNT()).to.equal(3n);
    expect(await bonds.ACC_PRECISION()).to.equal(ACC_PRECISION);
    expect(await bonds.ACC_PRECISION()).to.equal(10n ** 18n);

    // The two tokens deliberately have DIFFERENT decimals.
    expect(await usdt.decimals()).to.equal(6n);
    expect(await catt.decimals()).to.equal(18n);

    // Durations, in seconds, exactly.
    expect(TIER_DURATION[1]).to.equal(2_592_000n);
    expect(TIER_DURATION[2]).to.equal(7_776_000n);
    expect(TIER_DURATION[3]).to.equal(15_552_000n);
    expect(await bonds.TIER_1_DURATION()).to.equal(TIER_DURATION[1]);
    expect(await bonds.TIER_2_DURATION()).to.equal(TIER_DURATION[2]);
    expect(await bonds.TIER_3_DURATION()).to.equal(TIER_DURATION[3]);

    for (const tier of [1, 2, 3]) {
      expect(await bonds.tierDuration(tier)).to.equal(TIER_DURATION[tier]);
      expect(await bonds.tierWeight(tier)).to.equal(TIER_WEIGHT[tier]);
      // tierInfo must agree with the two individual views, not just be present.
      const info = await bonds.tierInfo(tier);
      expect(info[0]).to.equal(TIER_DURATION[tier]);
      expect(info[1]).to.equal(TIER_WEIGHT[tier]);
    }

    expect(await bonds.tierWeight(1)).to.equal(1n);
    expect(await bonds.tierWeight(2)).to.equal(2n);
    expect(await bonds.tierWeight(3)).to.equal(3n);
  });

  it("A2: buyBond(1000 CATT, tier 1) returns id 1 and records the bond exactly", async function () {
    const { catt, bonds, alice, bondId, principal, createdAt, maturesAt, cattBefore } = await loadFixture(
      singleTier1BondFixture
    );

    expect(bondId).to.equal(1n);
    expect(await bonds.totalBondsCreated()).to.equal(1n);

    const b = await readBond(bonds, 1n);
    expect(b.holder).to.equal(alice.address);
    expect(b.principal).to.equal(principal);
    expect(b.principal).to.equal(CATT(1000));
    expect(b.principal).to.equal(1000n * ONE_CATT);
    expect(b.tier).to.equal(1n);
    // points == principal * tierWeight(1) == principal * 1.
    expect(b.points).to.equal(CATT(1000));
    expect(b.points).to.equal(b.principal * TIER_WEIGHT[1]);
    expect(b.accruedYield).to.equal(0n);
    expect(b.closed).to.equal(false);
    expect(b.createdAt).to.equal(createdAt);
    expect(b.maturesAt).to.equal(createdAt + 30n * DAY);
    expect(b.maturesAt).to.equal(maturesAt);
    expect(await catt.balanceOf(alice.address)).to.equal(cattBefore - principal);
  });

  it("A3: tiers 2 and 3 buy the right duration and the right points", async function () {
    const { bonds, alice, bob } = await loadFixture(deployBondsFixture);

    // A fresh 1,000 CATT bond in each tier: same principal, 1x/2x/3x points.
    await bonds.connect(alice).buyBond(CATT(1000), 2);
    await bonds.connect(bob).buyBond(CATT(1000), 3);

    const two = await readBond(bonds, 1n);
    expect(two.tier).to.equal(2n);
    expect(two.points).to.equal(CATT(1000) * 2n);
    expect(two.points).to.equal(2000n * ONE_CATT);
    expect(two.maturesAt - two.createdAt).to.equal(90n * DAY);

    const three = await readBond(bonds, 2n);
    expect(three.tier).to.equal(3n);
    expect(three.points).to.equal(CATT(1000) * 3n);
    expect(three.points).to.equal(3000n * ONE_CATT);
    expect(three.maturesAt - three.createdAt).to.equal(180n * DAY);

    // 2,000e18 + 3,000e18 points are live.
    expect(await bonds.totalPoints()).to.equal(5000n * ONE_CATT);
  });

  it("A4: buyBond emits BondCreated with exact arguments", async function () {
    const { bonds, alice } = await loadFixture(deployBondsFixture);
    const principal = CATT(1000);

    const tx = await bonds.connect(alice).buyBond(principal, 1);
    const createdAt = await blockTimestampOf(tx);
    const maturesAt = createdAt + 30n * DAY;

    await expect(tx)
      .to.emit(bonds, "BondCreated")
      .withArgs(1n, alice.address, principal, 1, maturesAt, principal);
    // The emitted maturity is the one the record now holds.
    const b = await readBond(bonds, 1n);
    expect(b.maturesAt).to.equal(maturesAt);
    expect(b.createdAt).to.equal(createdAt);
    expect(b.maturesAt).to.equal(b.createdAt + 30n * DAY);
  });

  it("A5: the CATT actually moves and totalPoints rises by exactly the points", async function () {
    const { catt, bonds, alice, bondId, principal } = await loadFixture(singleTier1BondFixture);

    const b = await readBond(bonds, bondId);
    expect(await catt.balanceOf(bonds.target)).to.equal(principal);
    expect(await catt.balanceOf(alice.address)).to.equal(CATT(9_000));
    expect(await bonds.totalPoints()).to.equal(b.points);
    expect(await bonds.totalPoints()).to.equal(CATT(1000));
    expect(await bonds.totalBondsCreated()).to.equal(1n);
  });

  it("A6: bond ids are 1-based and sequential", async function () {
    const { bonds, alice, bob } = await loadFixture(deployBondsFixture);

    // A `staticCall` reads the id without creating anything.
    expect(await bonds.connect(alice).buyBond.staticCall(CATT(1000), 1)).to.equal(1n);
    expect(await bonds.connect(alice).buyBond.staticCall(CATT(500), 2)).to.equal(1n);
    expect(await bonds.totalBondsCreated()).to.equal(0n);

    await bonds.connect(alice).buyBond(CATT(1000), 1);
    expect(await bonds.totalBondsCreated()).to.equal(1n);
    expect((await readBond(bonds, 1n)).holder).to.equal(alice.address);
    await bonds.connect(bob).buyBond(CATT(400), 3);

    // The second bond, whoever opened it, is id 2.
    expect(await bonds.totalBondsCreated()).to.equal(2n);
    const second = await readBond(bonds, 2n);
    expect(second.holder).to.equal(bob.address);
    expect(second.principal).to.equal(CATT(400));
    expect(second.points).to.equal(CATT(400) * 3n);
    expect(await bonds.totalPoints()).to.equal(CATT(1000) + CATT(400) * 3n);
  });

  it("A7: invalid buyBond input reverts with the documented custom errors", async function () {
    const { bonds, catt, alice } = await loadFixture(deployBondsFixture);

    await expect(bonds.connect(alice).buyBond(0n, 1)).to.be.revertedWithCustomError(bonds, "ZeroAmount");
    // Tiers are 1-BASED, so 0 is as invalid as 4.
    await expect(bonds.connect(alice).buyBond(CATT(1000), 0))
      .to.be.revertedWithCustomError(bonds, "InvalidTier")
      .withArgs(0);
    await expect(bonds.connect(alice).buyBond(CATT(1000), 4))
      .to.be.revertedWithCustomError(bonds, "InvalidTier")
      .withArgs(4);

    // No allowance -> the CATT token's own error, not a BondManager error.
    await catt.connect(alice).approve(bonds.target, 0n);
    await expect(bonds.connect(alice).buyBond(CATT(1000), 1)).to.be.revertedWithCustomError(
      catt,
      "ERC20InsufficientAllowance"
    );

    // None of the failed attempts created a bond.
    expect(await bonds.totalBondsCreated()).to.equal(0n);
    expect(await bonds.totalPoints()).to.equal(0n);
    expect(await catt.balanceOf(bonds.target)).to.equal(0n);
  });

  it("A8: bondInfo reverts InvalidBondId for ids that were never created", async function () {
    const { bonds } = await loadFixture(deployBondsFixture);

    await expect(bonds.bondInfo(0n))
      .to.be.revertedWithCustomError(bonds, "InvalidBondId")
      .withArgs(0n);
    await expect(bonds.bondInfo(99n))
      .to.be.revertedWithCustomError(bonds, "InvalidBondId")
      .withArgs(99n);
    await expect(bonds.bondAccSnapshot(99n))
      .to.be.revertedWithCustomError(bonds, "InvalidBondId")
      .withArgs(99n);

    // The UI-facing estimate must NOT throw, it must read 0.
    expect(await bonds.pendingYield(0n)).to.equal(0n);
    expect(await bonds.pendingYield(99n)).to.equal(0n);
  });
});

// ===========================================================================
// B. Principal is locked (4)
// ===========================================================================

describe("B. Bond principal is locked / no early withdrawal", function () {
  it("B1: withdrawPrincipal reverts with BondLockedUntilMaturity and exact args", async function () {
    const { catt, bonds, alice, bondId, principal, createdAt, maturesAt } = await loadFixture(
      singleTier1BondFixture
    );

    // Pin the attempt to an exact instant so the third argument is exact.
    const attemptAt = maturesAt - 10n;
    await time.setNextBlockTimestamp(attemptAt);

    await expect(bonds.connect(alice).withdrawPrincipal(bondId))
      .to.be.revertedWithCustomError(bonds, "BondLockedUntilMaturity")
      .withArgs(bondId, maturesAt, attemptAt);

    // State is completely untouched by the failed attempt.
    expect(await catt.balanceOf(bonds.target)).to.equal(principal);
    expect(await catt.balanceOf(alice.address)).to.equal(CATT(9_000));
    expect(await bonds.totalPoints()).to.equal(principal);
    expect((await readBond(bonds, bondId)).maturesAt).to.equal(maturesAt);
    expect((await readBond(bonds, bondId)).createdAt).to.equal(createdAt);
  });

  it("B2: there is NO early exit one second before maturity, nor after it", async function () {
    const { catt, bonds, alice, bondId, principal, maturesAt } = await loadFixture(singleTier1BondFixture);

    const before = {
      alice: await catt.balanceOf(alice.address),
      staked: await catt.balanceOf(bonds.target),
      points: await bonds.totalPoints(),
    };
    expect(before.staked).to.equal(principal);

    // One second before maturity: still locked.
    await time.setNextBlockTimestamp(maturesAt - 1n);
    await expect(bonds.connect(alice).withdrawPrincipal(bondId))
      .to.be.revertedWithCustomError(bonds, "BondLockedUntilMaturity")
      .withArgs(bondId, maturesAt, maturesAt - 1n);

    // Exactly AT maturity: STILL locked. There is no early-exit path at all;
    // the only way out is `redeem`, which also pays the yield.
    await time.setNextBlockTimestamp(maturesAt);
    await expect(bonds.connect(alice).withdrawPrincipal(bondId))
      .to.be.revertedWithCustomError(bonds, "BondLockedUntilMaturity")
      .withArgs(bondId, maturesAt, maturesAt);

    // And long after maturity, for good measure.
    await time.setNextBlockTimestamp(maturesAt + 365n * DAY);
    await expect(bonds.connect(alice).withdrawPrincipal(bondId))
      .to.be.revertedWithCustomError(bonds, "BondLockedUntilMaturity")
      .withArgs(bondId, maturesAt, maturesAt + 365n * DAY);

    // Nothing moved at any point.
    expect(await catt.balanceOf(alice.address)).to.equal(before.alice);
    expect(await catt.balanceOf(bonds.target)).to.equal(before.staked);
    expect(await bonds.totalPoints()).to.equal(before.points);
    const b = await readBond(bonds, bondId);
    expect(b.closed).to.equal(false);
    expect(b.accruedYield).to.equal(0n);
  });

  it("B3: withdrawPrincipal on a redeemed bond reverts BondClosed", async function () {
    const { bonds, alice, bondId, maturesAt } = await loadFixture(singleTier1BondFixture);

    await time.setNextBlockTimestamp(maturesAt);
    await bonds.connect(alice).redeem(bondId);
    expect((await readBond(bonds, bondId)).closed).to.equal(true);

    // There is no principal left in the bond to be "locked".
    await expect(bonds.connect(alice).withdrawPrincipal(bondId))
      .to.be.revertedWithCustomError(bonds, "BondClosed")
      .withArgs(bondId);
  });

  it("B4: withdrawPrincipal on an unknown id reverts InvalidBondId", async function () {
    const { bonds, alice } = await loadFixture(singleTier1BondFixture);

    await expect(bonds.connect(alice).withdrawPrincipal(0n))
      .to.be.revertedWithCustomError(bonds, "InvalidBondId")
      .withArgs(0n);
    await expect(bonds.connect(alice).withdrawPrincipal(99n))
      .to.be.revertedWithCustomError(bonds, "InvalidBondId")
      .withArgs(99n);
  });
});

// ===========================================================================
// C. Weighted pro-rata yield (8)
// ===========================================================================

describe("C. Weighted pro-rata yield across deposits and bonds", function () {
  it("C1: one bond, one deposit -> pending is exactly the deposit and claims exactly", async function () {
    const { usdt, bonds, owner, alice, bondId, principal } = await loadFixture(singleTier1BondFixture);

    const amount = USDT(1000);
    await deposit(bonds, owner, amount);

    // 1,000 USDT = 1e9 base units, 1,000e18 points -> increment 1e6.
    expect(await bonds.accYieldPerPoint()).to.equal(incrementFor(amount, principal));
    expect(await bonds.accYieldPerPoint()).to.equal(1_000_000n);
    expect(await bonds.pendingYield(bondId)).to.equal(amount);
    expect(await bonds.pendingYield(bondId)).to.equal(1_000_000_000n);
    expect(await bonds.unallocatedYield()).to.equal(0n);

    const usdtBefore = await usdt.balanceOf(alice.address);
    await expect(bonds.connect(alice).claimYield(bondId))
      .to.emit(bonds, "YieldClaimed")
      .withArgs(bondId, alice.address, amount);

    // 6-decimal USDT, not 18-decimal: the payout is 1e9, not 1e27.
    expect(await usdt.balanceOf(alice.address)).to.equal(usdtBefore + amount);
    expect(await usdt.balanceOf(bonds.target)).to.equal(0n);
    expect((await readBond(bonds, bondId)).accruedYield).to.equal(amount);
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
  });

  it("C2: a 1:3 weight ratio splits one deposit 1:3", async function () {
    const { bonds, owner, a, b, totalPoints } = await loadFixture(twoBond13Fixture);

    expect(a.points).to.equal(CATT(1000));
    expect(b.points).to.equal(CATT(1000) * 3n);
    expect(totalPoints).to.equal(4000n * ONE_CATT);
    expect(await bonds.totalPoints()).to.equal(totalPoints);

    // 4,000 USDT = 4e9 over 4,000e18 points -> increment 1e6, i.e. 1 USDT/pt-unit.
    const amount = USDT(4000);
    await deposit(bonds, owner, amount);
    expect(await bonds.accYieldPerPoint()).to.equal(1_000_000n);

    const pendingAlice = await bonds.pendingYield(a.bondId);
    const pendingBob = await bonds.pendingYield(b.bondId);
    expect(pendingAlice).to.equal(USDT(1000));
    expect(pendingBob).to.equal(USDT(3000));
    // Exactly a 1:3 split, and the two together consume the whole deposit.
    expect(pendingBob).to.equal(pendingAlice * 3n);
    expect(pendingAlice + pendingBob).to.equal(amount);
    expect(pendingAlice + pendingBob).to.be.lessThanOrEqual(amount);
  });

  it("C3: equal principals in different tiers split BY WEIGHT, not by size", async function () {
    const { bonds, owner, alice, bob, carol } = await loadFixture(deployBondsFixture);

    // Case 1: identical 1,000 CATT principal, tiers 1 and 2 -> a 1:2 split.
    await bonds.connect(alice).buyBond(CATT(1000), 1); // 1,000e18 points
    await bonds.connect(bob).buyBond(CATT(1000), 2); // 2,000e18 points
    expect(await bonds.totalPoints()).to.equal(3000n * ONE_CATT);
    expect((await readBond(bonds, 1n)).principal).to.equal((await readBond(bonds, 2n)).principal);

    // 3,000 USDT = 3e9 over 3,000e18 points -> increment 1e6, i.e. exact.
    await deposit(bonds, owner, USDT(3000));
    expect(await bonds.accYieldPerPoint()).to.equal(1_000_000n);
    const t1 = await bonds.pendingYield(1n);
    const t2 = await bonds.pendingYield(2n);
    expect(t1).to.equal(USDT(1000));
    expect(t2).to.equal(USDT(2000));
    // Identical principals, yet a 1:2 split: the weighting is by TIER.
    expect(t2).to.equal(t1 * 2n);
    expect(t1).to.not.equal(t2);
    expect(t1 + t2).to.equal(USDT(3000));

    // Case 2: carol joins at tier 3 AFTER the first deposit, so her bond
    // snapshots the accumulator at 1e6 and earns only from deposit 2.
    await bonds.connect(carol).buyBond(CATT(1000), 3); // 3,000e18 points
    expect(await bonds.totalPoints()).to.equal(6000n * ONE_CATT);
    expect(await bonds.bondAccSnapshot(3n)).to.equal(1_000_000n);

    // 6,000 USDT = 6e9 over 6,000e18 points -> increment 1e6, accumulator 2e6.
    await deposit(bonds, owner, USDT(6000));
    expect(await bonds.accYieldPerPoint()).to.equal(2_000_000n);

    // tier 1: 1,000 points x 2e6. tier 2: 2,000 points x 2e6.
    // tier 3: 3,000 points x (2e6 - 1e6), because it joined after deposit 1.
    const p1 = await bonds.pendingYield(1n);
    const p2 = await bonds.pendingYield(2n);
    const p3 = await bonds.pendingYield(3n);
    expect(p1).to.equal(USDT(2000));
    expect(p2).to.equal(USDT(4000));
    expect(p3).to.equal(USDT(3000));
    // 1,000 CATT at tier 2 earns exactly twice 1,000 CATT at tier 1.
    expect(p2).to.equal(p1 * 2n);
    // Every deposited unit is accounted for, none of it double-counted.
    expect(p1 + p2 + p3).to.equal(USDT(9000));
  });

  it("C4: points combine size AND tier, so 3,000 CATT at 1x beats 1,000 CATT at 3x only when points differ", async function () {
    const { bonds, owner, alice, bob } = await loadFixture(deployBondsFixture);

    // 3,000 CATT tier 1 -> 3,000e18 points; 1,000 CATT tier 3 -> 3,000e18 points.
    await bonds.connect(alice).buyBond(CATT(3000), 1);
    await bonds.connect(bob).buyBond(CATT(1000), 3);
    expect(await bonds.totalPoints()).to.equal(6000n * ONE_CATT);
    const big = await readBond(bonds, 1n);
    const small = await readBond(bonds, 2n);
    expect(big.principal).to.equal(CATT(3000));
    expect(small.principal).to.equal(CATT(1000));
    // Principals differ 3:1 but the points are identical, so the split is even.
    expect(big.points).to.equal(small.points);
    expect(big.points).to.equal(3000n * ONE_CATT);

    // 1,200 USDT = 1.2e9 over 6,000e18 points -> increment 2e5. The increment is
    // integral, so the 600/600 split below is exact rather than dust-rounded.
    const amount = USDT(1200);
    await deposit(bonds, owner, amount);
    expect(await bonds.accYieldPerPoint()).to.equal(200_000n);

    const p1 = await bonds.pendingYield(1n);
    const p2 = await bonds.pendingYield(2n);
    expect(p1).to.equal(USDT(600));
    expect(p2).to.equal(USDT(600));
    expect(p1).to.equal(p2);
    expect(p1 + p2).to.equal(amount);
    // The larger principal does NOT earn more: points are principal * weight.
    expect(p1).to.equal(big.points * incrementFor(amount, big.points + small.points) / ACC_PRECISION);
  });

  it("C5: several sequential deposits accumulate into one pending figure", async function () {
    const { bonds, owner, alice, bondId, principal } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(500));
    const afterFirst = await bonds.accYieldPerPoint();
    await deposit(bonds, owner, USDT(1500));

    // 2,000 USDT total = 2e9 over 1,000e18 points.
    const expectedAcc = incrementFor(USDT(2000), principal);
    expect(expectedAcc).to.equal(2_000_000n);
    expect(afterFirst).to.equal(500_000n);
    expect(await bonds.accYieldPerPoint()).to.equal(expectedAcc);
    expect(await bonds.accYieldPerPoint()).to.equal(afterFirst + incrementFor(USDT(1500), principal));

    expect(await bonds.pendingYield(bondId)).to.equal(USDT(2000));
    expect(await bonds.pendingYield(bondId)).to.equal(2_000_000_000n);
    // The accumulator is monotone across deposits.
    expect(await bonds.accYieldPerPoint()).to.be.greaterThan(afterFirst);
  });

  it("C6: a deposit after a claim pays ONLY the new accrual, never a re-pay", async function () {
    const { usdt, bonds, owner, alice, bondId } = await loadFixture(singleTier1BondFixture);

    // First tranche: 500 USDT, all of it accrues.
    await deposit(bonds, owner, USDT(500));
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(500));
    const before = await usdt.balanceOf(alice.address);
    await bonds.connect(alice).claimYield(bondId);
    const first = (await usdt.balanceOf(alice.address)) - before;
    expect(first).to.equal(USDT(500));
    // Claiming emptied the position: nothing is claimable twice.
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
    expect((await readBond(bonds, bondId)).accruedYield).to.equal(USDT(500));

    // Second tranche: 1,000 USDT, paid on top of the 500 already collected.
    await deposit(bonds, owner, USDT(1000));
    const secondPending = await bonds.pendingYield(bondId);
    expect(secondPending).to.equal(USDT(1000));

    const mid = await usdt.balanceOf(alice.address);
    await bonds.connect(alice).claimYield(bondId);
    const second = (await usdt.balanceOf(alice.address)) - mid;

    // 500 + 1,000 = 1,500 total received, and the 500 is not paid again.
    expect(second).to.equal(USDT(1000));
    expect(first + second).to.equal(USDT(1500));
    expect(await usdt.balanceOf(alice.address)).to.equal(before + USDT(1500));
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
    expect((await readBond(bonds, bondId)).accruedYield).to.equal(USDT(1500));
    expect(await bonds.unallocatedYield()).to.equal(0n);
  });

  it("C7: depositYield reverts NoActiveBonds with no points and ZeroAmount on 0", async function () {
    const { bonds, owner, alice, usdt } = await loadFixture(deployBondsFixture);

    // No bond exists at all: nobody to allocate the yield to.
    await expect(deposit(bonds, owner, USDT(1000))).to.be.revertedWithCustomError(bonds, "NoActiveBonds");
    // Zero is rejected before the points check.
    await expect(deposit(bonds, owner, 0n)).to.be.revertedWithCustomError(bonds, "ZeroAmount");
    expect(await usdt.balanceOf(bonds.target)).to.equal(0n);

    // With one bond open, zero is still rejected, and a real deposit is fine.
    await bonds.connect(alice).buyBond(CATT(1000), 1);
    await expect(deposit(bonds, owner, 0n)).to.be.revertedWithCustomError(bonds, "ZeroAmount");
    await deposit(bonds, owner, USDT(1000));
    expect(await usdt.balanceOf(bonds.target)).to.equal(USDT(1000));
  });

  it("C8: the USDT accounting identity holds exactly, dust included", async function () {
    const { usdt, bonds, owner, alice, bob } = await loadFixture(deployBondsFixture);

    // Deliberately UNEQUAL principals that nevertheless produce EQUAL points:
    // 2,002 CATT tier 1 and 1,001 CATT tier 2 are 2,002e18 points each, so
    // 4,004e18 total. The deposits below do not divide evenly by 4,004, so
    // real rounding dust is produced and must be visible as unallocatedYield.
    await bonds.connect(alice).buyBond(CATT(2002), 1);
    await bonds.connect(bob).buyBond(CATT(1001), 2);
    const points1 = (await readBond(bonds, 1n)).points;
    const points2 = (await readBond(bonds, 2n)).points;
    expect(points1).to.equal(2002n * ONE_CATT);
    expect(points2).to.equal(2002n * ONE_CATT);
    const totalPoints = points1 + points2;
    expect(await bonds.totalPoints()).to.equal(4004n * ONE_CATT);

    // --- identity helper: balance == unallocated + sum(pending) -------------
    // `accruedYield` is money that has ALREADY left the contract, so it must
    // not be added to the balance. The claimable part is what is still held.
    const identity = async () => {
      const balance = await usdt.balanceOf(bonds.target);
      const unallocated = await bonds.unallocatedYield();
      const claimable = await totalClaimable(bonds, [1n, 2n]);
      expect(balance).to.equal(unallocated + claimable);
      return { balance, unallocated, claimable };
    };

    // Deposit 1: 1,000.123456 USDT = 1_000_123_456 base units.
    // increment = 1_000_123_456 * 1e18 / 4,004e18 = 249,781 (truncated).
    const d1 = 1_000_123_456n;
    const inc1 = incrementFor(d1, totalPoints);
    expect(inc1).to.equal(249_781n);
    const dist1 = distributedFor(inc1, totalPoints);
    expect(dist1).to.equal(1_000_123_124n);
    // 332 base units of the deposit cannot be credited to any bond.
    const dust1 = d1 - dist1;
    expect(dust1).to.equal(332n);
    expect(dust1).to.be.greaterThan(0n);

    await deposit(bonds, owner, d1);
    expect(await bonds.unallocatedYield()).to.equal(dust1);
    expect(await bonds.pendingYield(1n)).to.equal(2_002n * inc1);
    expect(await bonds.pendingYield(1n)).to.equal(500_061_562n);
    expect(await bonds.pendingYield(2n)).to.equal(2_002n * inc1);
    let s = await identity();
    expect(s.balance).to.equal(d1);
    expect(s.claimable).to.equal(dist1);

    // Deposit 2: another amount that does not divide evenly (3.000007 USDT).
    // increment = 3_000_007 / 4,004 = 749 (truncated), dust 1,011.
    const d2 = 3_000_007n;
    const inc2 = incrementFor(d2, totalPoints);
    expect(inc2).to.equal(749n);
    const dist2 = distributedFor(inc2, totalPoints);
    expect(dist2).to.equal(2_998_996n);
    const dust2 = d2 - dist2;
    expect(dust2).to.equal(1_011n);

    await deposit(bonds, owner, d2);
    expect(await bonds.unallocatedYield()).to.equal(dust1 + dust2);
    expect(await bonds.unallocatedYield()).to.equal(1_343n);
    // Both bonds have now earned from both deposits, still exactly.
    expect(await bonds.pendingYield(1n)).to.equal(2_002n * (inc1 + inc2));
    expect(await bonds.pendingYield(1n)).to.equal(501_561_060n);
    s = await identity();
    expect(s.balance).to.equal(d1 + d2);
    expect(s.balance).to.equal(1_003_123_463n);
    expect(s.claimable).to.equal(dist1 + dist2);
    expect(s.claimable).to.equal(1_003_122_120n);
    expect(s.unallocated + s.claimable).to.equal(s.balance);

    // The lifetime identity: every deposited unit is either still held,
    // already paid out, or is retained dust. Nothing is created or destroyed.
    const lifetime = s.unallocated + s.claimable + (await totalPaid(bonds, [1n, 2n]));
    expect(lifetime).to.equal(d1 + d2);
    expect(lifetime).to.equal(s.balance);

    // Claims move value out of the contract: it is no longer held, but it is
    // neither lost nor duplicated - it simply becomes "paid" instead of
    // "claimable", and the two sums still add up to everything deposited.
    const paid1 = 501_561_060n;
    await bonds.connect(alice).claimYield(1n);
    expect((await readBond(bonds, 1n)).accruedYield).to.equal(paid1);
    expect(await bonds.pendingYield(1n)).to.equal(0n);
    s = await identity();
    expect(s.balance).to.equal(d1 + d2 - paid1);
    expect(s.balance).to.equal(501_562_403n);
    expect(s.unallocated).to.equal(1_343n);
    expect(s.claimable).to.equal(paid1); // bob's share, untouched
    expect(s.unallocated + s.claimable + (await totalPaid(bonds, [1n, 2n]))).to.equal(d1 + d2);

    await bonds.connect(bob).claimYield(2n);
    s = await identity();
    expect(await bonds.pendingYield(2n)).to.equal(0n);
    // Everything except the retained dust has left the contract, exactly.
    expect(s.balance).to.equal(1_343n);
    expect(s.unallocated).to.equal(1_343n);
    expect(s.claimable).to.equal(0n);
    expect(s.unallocated + s.claimable + (await totalPaid(bonds, [1n, 2n]))).to.equal(d1 + d2);
    // Dust is retained, never redistributed to the bonds that were settled.
    expect(await bonds.accYieldPerPoint()).to.equal(inc1 + inc2);
  });
});

// ===========================================================================
// D. Checkpoint correctness (5)
// ===========================================================================

describe("D. Checkpoint correctness (accSnapshot taken at creation)", function () {
  it("D1: a bond created AFTER a deposit earns nothing from it", async function () {
    const { bonds, owner, alice, bob, bondId } = await loadFixture(singleTier1BondFixture);

    // A deposit happens with only alice's bond open.
    await deposit(bonds, owner, USDT(1000));
    const accAfterDeposit = await bonds.accYieldPerPoint();
    expect(accAfterDeposit).to.equal(1_000_000n);
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(1000));

    // Bob joins AFTER that deposit.
    await bonds.connect(bob).buyBond(CATT(1000), 1);
    const bobId = await bonds.totalBondsCreated();
    expect(bobId).to.equal(2n);

    // His snapshot is the FULL post-deposit accumulator, not zero: that is
    // exactly what shields him from the 1,000 USDT alice already earned.
    expect(await bonds.bondAccSnapshot(bobId)).to.equal(accAfterDeposit);
    expect(await bonds.bondAccSnapshot(bobId)).to.be.greaterThan(0n);
    expect(await bonds.accYieldPerPoint()).to.equal(accAfterDeposit);

    // So he starts at exactly zero, not at alice's 1,000 USDT.
    expect(await bonds.pendingYield(bobId)).to.equal(0n);
    // And alice is not diluted by his arrival: her pending is unchanged.
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(1000));
  });

  it("D2: a late bond earns from SUBSEQUENT deposits only, at the new weights", async function () {
    const { bonds, owner, alice, bob, bondId } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1000)); // 1,000 points live
    await bonds.connect(bob).buyBond(CATT(1000), 1); // now 2,000 points live
    const bobId = 2n;
    expect(await bonds.totalPoints()).to.equal(2_000n * ONE_CATT);
    const accBefore = await bonds.accYieldPerPoint();
    const alicePendingBefore = await bonds.pendingYield(bondId);

    // A second 1,000 USDT now splits evenly over the two open bonds.
    await deposit(bonds, owner, USDT(1000));
    const increment = incrementFor(USDT(1000), 2_000n * ONE_CATT);
    expect(increment).to.equal(500_000n);
    expect(await bonds.accYieldPerPoint()).to.equal(accBefore + increment);

    // Bob earned 500 USDT of THIS deposit and nothing of the first.
    const bobPending = await bonds.pendingYield(bobId);
    expect(bobPending).to.equal(USDT(500));
    // His whole lifetime yield is 500, never the 1,000 alice was paid.
    const bobInfo = await readBond(bonds, bobId);
    expect(bobInfo.accruedYield + bobPending).to.equal(USDT(500));
    expect(bobInfo.accruedYield + bobPending).to.not.equal(USDT(1000));

    // Alice's new share of the second deposit is also exactly 500, on top of
    // the 1,000 she had already earned.
    expect(await bonds.pendingYield(bondId) - alicePendingBefore).to.equal(USDT(500));
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(1500));

    await bonds.connect(bob).claimYield(bobId);
    expect((await readBond(bonds, bobId)).accruedYield).to.equal(USDT(500));
  });

  it("D3: a bond opened after several deposits still snapshots the current accumulator", async function () {
    const { bonds, owner, alice, carol, bondId } = await loadFixture(singleTier1BondFixture);

    // Three deposits of 1,000 / 2,000 / 3,000 USDT, all on alice's 1,000 points.
    await deposit(bonds, owner, USDT(1000));
    await deposit(bonds, owner, USDT(2000));
    await deposit(bonds, owner, USDT(3000));
    const accBefore = await bonds.accYieldPerPoint();
    expect(accBefore).to.equal(6_000_000n);
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(6000));

    // A third party joins only now.
    await bonds.connect(carol).buyBond(CATT(1000), 1);
    const carolId = await bonds.totalBondsCreated();
    expect(carolId).to.equal(2n);
    expect(await bonds.bondAccSnapshot(carolId)).to.equal(accBefore);
    expect(await bonds.pendingYield(carolId)).to.equal(0n);
    expect(await bonds.accYieldPerPoint()).to.equal(accBefore);
    // The late joiner diluted nothing that was already earned.
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(6000));

    // From now on he earns a full share: 6,000 USDT splits 3,000/3,000.
    await deposit(bonds, owner, USDT(6000));
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(9000));
    expect(await bonds.pendingYield(carolId)).to.equal(USDT(3000));
  });

  it("D4: claiming does not move the snapshot, so later deposits are earned in full", async function () {
    const { usdt, bonds, owner, alice, bondId } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1000));
    const snapshotBefore = await bonds.bondAccSnapshot(bondId);
    const accBefore = await bonds.accYieldPerPoint();
    expect(snapshotBefore).to.equal(0n); // joined before any deposit

    const usdtBefore = await usdt.balanceOf(alice.address);
    await bonds.connect(alice).claimYield(bondId);
    expect(await usdt.balanceOf(alice.address)).to.equal(usdtBefore + USDT(1000));

    // The snapshot is a "when I joined" checkpoint, not a "when I was paid"
    // checkpoint: claiming must not move it.
    expect(await bonds.bondAccSnapshot(bondId)).to.equal(snapshotBefore);
    expect(await bonds.accYieldPerPoint()).to.equal(accBefore);
    expect(await bonds.pendingYield(bondId)).to.equal(0n);

    // A later deposit is earned in full on the same points.
    await deposit(bonds, owner, USDT(1000));
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(1000));
    expect(await bonds.bondAccSnapshot(bondId)).to.equal(snapshotBefore);
  });

  it("D5: closing a bond removes its points from the pool", async function () {
    const { usdt, bonds, owner, alice, bob, a, b } = await loadFixture(twoBond13Fixture);

    expect(await bonds.totalPoints()).to.equal(4_000n * ONE_CATT);
    // Redeem alice's bond at exactly its maturity.
    await time.setNextBlockTimestamp(a.maturesAt);
    await bonds.connect(alice).redeem(a.bondId);
    expect(await bonds.totalPoints()).to.equal(3_000n * ONE_CATT);

    // A new deposit goes 100% to the only bond still open.
    const amount = USDT(3000);
    await deposit(bonds, owner, amount);
    expect(await bonds.pendingYield(a.bondId)).to.equal(0n); // closed
    expect(await bonds.pendingYield(b.bondId)).to.equal(amount);
    expect(await bonds.pendingYield(b.bondId)).to.equal(USDT(3000));
    // The closed bond's points are out of the denominator: 3,000 USDT over
    // 3,000e18 points is 1e6, and bob's 3,000e18 points take all of it.
    expect(await bonds.accYieldPerPoint()).to.equal(1_000_000n);
    expect(await totalClaimable(bonds, [b.bondId])).to.equal(amount);
    // The 1:3 split that existed before the close is gone: 100% now.
    expect(await totalClaimable(bonds, [a.bondId])).to.equal(0n);
    await bonds.connect(bob).claimYield(b.bondId);
    expect(await usdt.balanceOf(bob.address)).to.equal(USDT(3000));
    expect(await usdt.balanceOf(alice.address)).to.equal(0n);
  });
});

// ===========================================================================
// E. Redemption at maturity (7)
// ===========================================================================

describe("E. Redemption at maturity", function () {
  it("E1: redeem reverts BondNotMatured with exact args until block.timestamp >= maturesAt", async function () {
    const { usdt, bonds, owner, alice, bondId, maturesAt } = await loadFixture(singleTier1BondFixture);

    const early = maturesAt - 100n;
    await time.setNextBlockTimestamp(early);
    await expect(bonds.connect(alice).redeem(bondId))
      .to.be.revertedWithCustomError(bonds, "BondNotMatured")
      .withArgs(bondId, maturesAt, early);
    expect(await bonds.isMatured(bondId)).to.equal(false);

    // One second before maturity is still not matured.
    await time.setNextBlockTimestamp(maturesAt - 1n);
    await expect(bonds.connect(alice).redeem(bondId))
      .to.be.revertedWithCustomError(bonds, "BondNotMatured")
      .withArgs(bondId, maturesAt, maturesAt - 1n);
    expect(await bonds.isMatured(bondId)).to.equal(false);

    // At EXACTLY maturesAt the strict >= comparison opens the bond. A view call
    // reads the LATEST block, so a block has to be mined at that instant first:
    // pin it and spend one wei of the sponsor's own dust to mine it.
    await time.setNextBlockTimestamp(maturesAt);
    await usdt.connect(owner).transfer(alice.address, 1n);
    expect(await time.latest()).to.equal(maturesAt);
    expect(await bonds.isMatured(bondId)).to.equal(true);
    await expect(bonds.connect(alice).redeem(bondId)).to.emit(bonds, "BondRedeemed");
    expect((await readBond(bonds, bondId)).closed).to.equal(true);
  });

  it("E2: redemption returns the principal plus exactly the final pending yield", async function () {
    const { catt, usdt, bonds, owner, alice, bondId, principal, cattBefore, maturesAt } =
      await loadFixture(singleTier1BondFixture);

    // alice is down 1,000 CATT and holds no USDT before the redemption.
    expect(await catt.balanceOf(alice.address)).to.equal(cattBefore - principal);
    expect(await usdt.balanceOf(alice.address)).to.equal(0n);

    await deposit(bonds, owner, USDT(1000));
    const finalYield = await bonds.pendingYield(bondId);
    expect(finalYield).to.equal(USDT(1000));

    await time.setNextBlockTimestamp(maturesAt);
    await bonds.connect(alice).redeem(bondId);

    // CATT is back at exactly the pre-bond level.
    expect(await catt.balanceOf(alice.address)).to.equal(cattBefore);
    expect(await catt.balanceOf(alice.address)).to.equal(CATT(10_000));
    expect(await catt.balanceOf(bonds.target)).to.equal(0n);
    // USDT is up by exactly the yield, in 6 decimals.
    expect(await usdt.balanceOf(alice.address)).to.equal(finalYield);
    expect(await usdt.balanceOf(alice.address)).to.equal(USDT(1000));
    expect(await usdt.balanceOf(bonds.target)).to.equal(0n);
  });

  it("E3: redeem emits BondRedeemed with exact arguments", async function () {
    const { bonds, owner, alice, bondId, principal, maturesAt } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1234));
    const finalYield = await bonds.pendingYield(bondId);
    expect(finalYield).to.equal(USDT(1234));

    await time.setNextBlockTimestamp(maturesAt);
    await expect(bonds.connect(alice).redeem(bondId))
      .to.emit(bonds, "BondRedeemed")
      .withArgs(bondId, alice.address, principal, finalYield);
  });

  it("E4: after redemption the bond is closed, yields 0 pending, and its points are gone", async function () {
    const { bonds, owner, alice, bondId, principal, maturesAt } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1000));
    expect(await bonds.totalPoints()).to.equal(principal);

    await time.setNextBlockTimestamp(maturesAt);
    await bonds.connect(alice).redeem(bondId);

    const b = await readBond(bonds, bondId);
    expect(b.closed).to.equal(true);
    expect(b.principal).to.equal(principal); // record is preserved, not erased
    expect(b.accruedYield).to.equal(USDT(1000)); // final yield was paid
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
    expect(await bonds.totalPoints()).to.equal(0n);
    // The record still names its original holder and maturity.
    expect(b.holder).to.equal(alice.address);
    expect(b.maturesAt).to.equal(maturesAt);
  });

  it("E5: a second redeem and a late claimYield both revert BondClosed", async function () {
    const { bonds, owner, alice, bob, carol, bondId, maturesAt } = await loadFixture(
      singleTier1BondFixture
    );

    await deposit(bonds, owner, USDT(1000));
    await time.setNextBlockTimestamp(maturesAt);
    await bonds.connect(alice).redeem(bondId);

    // Reachable exactly once, by anyone, forever.
    for (const caller of [alice, bob, carol]) {
      await expect(bonds.connect(caller).redeem(bondId))
        .to.be.revertedWithCustomError(bonds, "BondClosed")
        .withArgs(bondId);
    }
    // The final yield was already paid by redeem, so there is nothing to claim.
    await expect(bonds.connect(alice).claimYield(bondId))
      .to.be.revertedWithCustomError(bonds, "BondClosed")
      .withArgs(bondId);
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
  });

  it("E6: redeem is permissionless but the payout always goes to the holder", async function () {
    const { catt, usdt, bonds, owner, alice, carol, bondId, principal, cattBefore, maturesAt } =
      await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1000));
    const finalYield = await bonds.pendingYield(bondId);

    const carolCatt = await catt.balanceOf(carol.address);
    const carolUsdt = await usdt.balanceOf(carol.address);

    // Carol triggers the redemption...
    await time.setNextBlockTimestamp(maturesAt);
    await bonds.connect(carol).redeem(bondId);

    // ...and both legs land on ALICE.
    expect(await catt.balanceOf(alice.address)).to.equal(cattBefore);
    expect(await usdt.balanceOf(alice.address)).to.equal(finalYield);
    expect((await readBond(bonds, bondId)).holder).to.equal(alice.address);

    // Carol gains nothing and keeps her 10,000 CATT.
    expect(await catt.balanceOf(carol.address)).to.equal(carolCatt);
    expect(await catt.balanceOf(carol.address)).to.equal(CATT(10_000));
    expect(await usdt.balanceOf(carol.address)).to.equal(carolUsdt);
    expect(principal).to.equal(CATT(1000));
  });

  it("E7: redeem on an unknown id reverts InvalidBondId", async function () {
    const { bonds, alice, carol } = await loadFixture(singleTier1BondFixture);

    for (const caller of [alice, carol]) {
      await expect(bonds.connect(caller).redeem(0n))
        .to.be.revertedWithCustomError(bonds, "InvalidBondId")
        .withArgs(0n);
      await expect(bonds.connect(caller).redeem(99n))
        .to.be.revertedWithCustomError(bonds, "InvalidBondId")
        .withArgs(99n);
    }
  });
});

// ===========================================================================
// F. Claim authorization and invariants (6)
// ===========================================================================

describe("F. Claim authorization and solvency invariants", function () {
  it("F1: only the holder can claim, and the holder's own claim works", async function () {
    const { usdt, bonds, owner, alice, bob, carol, bondId } = await loadFixture(singleTier1BondFixture);
    await deposit(bonds, owner, USDT(1000));

    // Another bondholder is still a stranger to this bond.
    await expect(bonds.connect(bob).claimYield(bondId))
      .to.be.revertedWithCustomError(bonds, "NotBondHolder")
      .withArgs(bondId, bob.address);
    await expect(bonds.connect(carol).claimYield(bondId))
      .to.be.revertedWithCustomError(bonds, "NotBondHolder")
      .withArgs(bondId, carol.address);

    // Neither attempt paid anybody.
    expect(await usdt.balanceOf(bob.address)).to.equal(0n);
    expect(await usdt.balanceOf(carol.address)).to.equal(0n);
    expect(await usdt.balanceOf(alice.address)).to.equal(0n);
    expect(await bonds.pendingYield(bondId)).to.equal(USDT(1000));

    // The holder's own claim succeeds, and pays the holder.
    await expect(bonds.connect(alice).claimYield(bondId)).to.emit(bonds, "YieldClaimed");
    expect(await usdt.balanceOf(alice.address)).to.equal(USDT(1000));
    expect(await usdt.balanceOf(bob.address)).to.equal(0n);
  });

  it("F2: claimYield with nothing accrued reverts NothingToClaim", async function () {
    const { bonds, owner, alice, bondId } = await loadFixture(singleTier1BondFixture);

    // No deposit yet.
    await expect(bonds.connect(alice).claimYield(bondId))
      .to.be.revertedWithCustomError(bonds, "NothingToClaim")
      .withArgs(bondId);

    // Already collected everything.
    await deposit(bonds, owner, USDT(1000));
    await bonds.connect(alice).claimYield(bondId);
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
    await expect(bonds.connect(alice).claimYield(bondId))
      .to.be.revertedWithCustomError(bonds, "NothingToClaim")
      .withArgs(bondId);
  });

  it("F3: claiming does not extend the term, change points, or move the snapshot", async function () {
    const { bonds, owner, alice, bondId, maturesAt } = await loadFixture(singleTier1BondFixture);

    await deposit(bonds, owner, USDT(1000));
    const before = await readBond(bonds, bondId);
    const snapshotBefore = await bonds.bondAccSnapshot(bondId);
    const pointsBefore = await bonds.totalPoints();

    await bonds.connect(alice).claimYield(bondId);

    const after = await readBond(bonds, bondId);
    expect(after.points).to.equal(before.points);
    expect(after.maturesAt).to.equal(before.maturesAt);
    expect(after.maturesAt).to.equal(maturesAt);
    expect(after.createdAt).to.equal(before.createdAt);
    expect(after.principal).to.equal(before.principal);
    expect(after.tier).to.equal(before.tier);
    expect(await bonds.bondAccSnapshot(bondId)).to.equal(snapshotBefore);
    expect(await bonds.totalPoints()).to.equal(pointsBefore);
    // Only the accrued bookkeeping changed.
    expect(after.accruedYield).to.equal(USDT(1000));
    expect(after.closed).to.equal(false);
  });

  it("F4: repeated partial claims never pay more than the total earned", async function () {
    const { usdt, bonds, owner, alice, bondId } = await loadFixture(singleTier1BondFixture);

    // Tranche 1: 1,000 USDT, collected immediately.
    await deposit(bonds, owner, USDT(1000));
    const start = await usdt.balanceOf(alice.address);
    await bonds.connect(alice).claimYield(bondId);
    const first = (await usdt.balanceOf(alice.address)) - start;
    expect(first).to.equal(USDT(1000));

    // Tranche 2: 2,500 USDT more, collected immediately.
    await deposit(bonds, owner, USDT(2500));
    const mid = await usdt.balanceOf(alice.address);
    await bonds.connect(alice).claimYield(bondId);
    const second = (await usdt.balanceOf(alice.address)) - mid;
    expect(second).to.equal(USDT(2500));

    // The sum of the transfers equals the total deposited, exactly once each.
    expect(first + second).to.equal(USDT(3500));
    expect(await usdt.balanceOf(alice.address) - start).to.equal(USDT(3500));
    expect((await readBond(bonds, bondId)).accruedYield).to.equal(USDT(3500));
    expect(await bonds.pendingYield(bondId)).to.equal(0n);
    expect(await usdt.balanceOf(bonds.target)).to.equal(0n);
  });

  it("F5: the CATT held equals the sum of OPEN bond principals at every stage", async function () {
    const { catt, bonds, alice, bob } = await loadFixture(deployBondsFixture);

    const openPrincipal = async () => {
      let sum = 0n;
      for (let id = 1n; id <= (await bonds.totalBondsCreated()); id++) {
        const b = await readBond(bonds, id);
        if (!b.closed) sum += b.principal;
      }
      return sum;
    };

    expect(await catt.balanceOf(bonds.target)).to.equal(0n);
    expect(await catt.balanceOf(bonds.target)).to.equal(await openPrincipal());

    await bonds.connect(alice).buyBond(CATT(3000), 1);
    await bonds.connect(bob).buyBond(CATT(1000), 3);
    expect(await catt.balanceOf(bonds.target)).to.equal(CATT(4000));
    expect(await catt.balanceOf(bonds.target)).to.equal(await openPrincipal());

    // Redeem one leg: the principal leaves with the holder.
    const first = await readBond(bonds, 1n);
    await time.setNextBlockTimestamp(first.createdAt + TIER_DURATION[1]);
    await bonds.connect(alice).redeem(1n);
    expect(await catt.balanceOf(bonds.target)).to.equal(CATT(1000));
    expect(await catt.balanceOf(bonds.target)).to.equal(await openPrincipal());
    expect(await openPrincipal()).to.equal(CATT(1000));

    // And a new bond is added on top of the remaining one.
    await bonds.connect(alice).buyBond(CATT(500), 1);
    expect(await catt.balanceOf(bonds.target)).to.equal(CATT(1500));
    expect(await catt.balanceOf(bonds.target)).to.equal(await openPrincipal());
  });

  it("F6: the USDT held covers every outstanding yield obligation throughout", async function () {
    const { usdt, bonds, owner, alice, bob, a, b } = await loadFixture(twoBond13Fixture);
    const ids = [a.bondId, b.bondId];

    const covers = async () => {
      const balance = await usdt.balanceOf(bonds.target);
      const owed = (await bonds.unallocatedYield()) + (await totalClaimable(bonds, ids));
      expect(balance).to.be.greaterThanOrEqual(owed);
      return owed;
    };

    await deposit(bonds, owner, USDT(4000));
    let owed = await covers();
    expect(owed).to.equal(USDT(4000));

    // After a partial claim: the outstanding total drops by exactly what was
    // paid out, and the contract keeps the remaining obligation covered.
    await bonds.connect(alice).claimYield(a.bondId);
    expect((await readBond(bonds, a.bondId)).accruedYield).to.equal(USDT(1000));
    expect(await bonds.pendingYield(a.bondId)).to.equal(0n);
    expect(await bonds.pendingYield(b.bondId)).to.equal(USDT(3000));
    expect(await covers()).to.equal(USDT(3000));
    expect(await usdt.balanceOf(bonds.target)).to.equal(USDT(3000));

    // A further deposit is covered on top of what is still owed. 1,000 USDT over
    // 4,000e18 points is 2.5e5, so it splits 250 (alice, 1,000 pts) / 750 (bob,
    // 3,000 pts) on top of the 3,000 USDT bob still has from deposit 1.
    await deposit(bonds, owner, USDT(1000));
    expect(await bonds.pendingYield(a.bondId)).to.equal(USDT(250));
    expect(await bonds.pendingYield(b.bondId)).to.equal(USDT(3750));
    expect(await covers()).to.equal(USDT(4000));
    expect(await usdt.balanceOf(bonds.target)).to.equal(USDT(4000));

    // Bob is redeemed at maturity: his principal returns, his yield is paid.
    // His lifetime accrual is 3,000 pts x 1.25e6 = 3,750 USDT.
    await time.setNextBlockTimestamp(b.maturesAt);
    await bonds.connect(alice).redeem(b.bondId); // permissionless, but pays bob
    expect((await readBond(bonds, b.bondId)).accruedYield).to.equal(USDT(3750));
    expect(await usdt.balanceOf(bob.address)).to.equal(USDT(3750));
    expect(await usdt.balanceOf(bonds.target)).to.equal(USDT(250));
    // Only alice's still-unclaimed 250 USDT is owed, and it is covered.
    expect(await covers()).to.equal(USDT(250));
    expect(await bonds.totalPoints()).to.equal(a.points);

    // Alice collects the remainder; the pool is empty and nothing is left over.
    await bonds.connect(alice).claimYield(a.bondId);
    expect(await usdt.balanceOf(alice.address)).to.equal(USDT(1250));
    expect(await usdt.balanceOf(bonds.target)).to.equal(0n);
    expect(await covers()).to.equal(0n);
    expect(await bonds.unallocatedYield()).to.equal(0n);
  });
});
