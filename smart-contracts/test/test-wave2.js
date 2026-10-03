const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Wave 2 test suite for the CATT Protocol.
 *
 * Covers StakingManager, i.e. the whole "Learn-to-Earn" staking economy of
 * PRD Section 3.3:
 *   - Tiered staking math : the requirement is `10% + 5% per level` of the
 *                           caller's CURRENT CATT balance, capped at 90%.
 *   - Stamina             : a flat +50 per successful stake, debited only by
 *                           the rotated `claimer` role (the PRD 3.2 relay).
 *   - Drip unstaking      : a 10.00% (1000 bps) release per request, with an
 *                           84-hour cooldown, i.e. the PRD's anti-dump design.
 *
 * All token amounts are BigInt base units (18 decimals). No floats are used
 * anywhere, including in the percentage checks, which are expressed as integer
 * BigInt multiplications and divisions.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE = 10n ** 18n;
const ALICE_BALANCE = 1_000_000n * ONE;
const BOB_BALANCE = 1_000_000n * ONE;
const HOUR = 3_600n;
const UNSTAKE_COOLDOWN = 302_400n; // 84 hours, i.e. 3.5 days
const DRIP_BPS = 1_000n;
const BPS_DENOMINATOR = 10_000n;

// The largest number of consecutive exact-requirement stakes a 1M-token holder
// can make: every stake removes 10%..90% of the REMAINING balance, so the
// requirement eventually floors to zero and one more stake would hit
// `ZeroAmount`. 35 stakes take such a holder from level 0 to level 35.
const MAX_ESCALATIONS = 35n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Timestamp of the block that contains `tx`, as a BigInt: wait for the receipt
 * to learn the block number, then read that block's timestamp.
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

/**
 * Stakes exactly `requiredStakeFor(user)` — the cheapest legal stake — so the
 * caller escalates exactly one level per call.
 *
 * @param {object} staking StakingManager contract
 * @param {object} user signer to stake as
 * @returns {Promise<bigint>} the amount staked
 */
async function stakeRequired(staking, user) {
  const amount = await staking.requiredStakeFor(user.address);
  await staking.connect(user).stakeForStamina(amount);
  return amount;
}

/**
 * Stakes exactly `count` times in a row, escalating one level per stake.
 *
 * @param {object} staking StakingManager contract
 * @param {object} user signer to stake as
 * @param {bigint} count number of consecutive stakes
 */
async function escalate(staking, user, count) {
  for (let i = 0n; i < count; i++) {
    await stakeRequired(staking, user);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployStakingFixture() {
  const [owner, alice, bob, attacker] = await ethers.getSigners();

  const catt = await ethers.deployContract("CATT", [owner.address]);
  await catt.waitForDeployment();

  const staking = await ethers.deployContract("StakingManager", [catt.target]);
  await staking.waitForDeployment();

  await catt.mint(alice.address, ALICE_BALANCE);
  await catt.mint(bob.address, BOB_BALANCE);

  // One up-front MaxUint256 approval: escalating many times must never need a
  // second approval, or the test would be measuring the fixture instead of the
  // contract.
  await catt.connect(alice).approve(staking.target, ethers.MaxUint256);
  await catt.connect(bob).approve(staking.target, ethers.MaxUint256);

  return { catt, staking, owner, alice, bob, attacker };
}

/**
 * Same as above, plus one deliberately small position for the attacker: with a
 * 10,000 wei balance the level-0 requirement is exactly 1,000 wei, so the drip
 * arithmetic (1,000 -> 100 out / 900 left -> 90 out / 810 left) is readable in
 * whole numbers.
 */
async function deployDripFixture() {
  const base = await deployStakingFixture();
  const { catt, staking, attacker } = base;

  await catt.mint(attacker.address, 10_000n);
  await catt.connect(attacker).approve(staking.target, ethers.MaxUint256);

  return base;
}

/** CATT held by the staking vault. */
async function vaultBalance(catt, staking) {
  return catt.balanceOf(staking.target);
}

// ===========================================================================
// A. Deployment & configuration (6)
// ===========================================================================

describe("A. Deployment & configuration", function () {
  it("A1: the economy constants are exactly the PRD's values", async function () {
    const { staking } = await loadFixture(deployStakingFixture);

    expect(await staking.BASE_STAKE_PERCENT()).to.equal(10n); // PRD 3.3 "Level 1: 10%"
    expect(await staking.LEVEL_STEP_PERCENT()).to.equal(5n); // PRD 3.3 "+5% per level"
    expect(await staking.MAX_STAKE_PERCENT()).to.equal(90n);
    expect(await staking.STAMINA_PER_STAKE()).to.equal(50n);

    // PRD 3.3: "Max unstake is 10% of staked amount" == 1000 bps of 10000.
    expect(await staking.UNSTAKE_BPS()).to.equal(1_000n);
    expect(await staking.BPS_DENOMINATOR()).to.equal(10_000n);
    expect((await staking.UNSTAKE_BPS()) * 100n).to.equal(
      (await staking.BPS_DENOMINATOR()) * 10n
    );
  });

  it("A2: UNSTAKE_COOLDOWN is exactly 302400 seconds, i.e. 84 hours", async function () {
    const { staking } = await loadFixture(deployStakingFixture);

    expect(await staking.UNSTAKE_COOLDOWN()).to.equal(302_400n);
    expect(await staking.UNSTAKE_COOLDOWN()).to.equal(84n * HOUR);
    expect(UNSTAKE_COOLDOWN).to.equal(302_400n);
    // 84h is exactly 3.5 days, the PRD's own phrasing: 2 * 84h == 7 days.
    expect(2n * UNSTAKE_COOLDOWN).to.equal(7n * 24n * HOUR);
  });

  it("A3: cattToken() returns the CATT address and owner() is the deployer", async function () {
    const { catt, staking, owner } = await loadFixture(deployStakingFixture);

    expect(await staking.cattToken()).to.equal(catt.target);
    expect(await staking.owner()).to.equal(owner.address);
  });

  it("A4: claimer() is the deployer at construction (deploy-time default)", async function () {
    const { staking, owner } = await loadFixture(deployStakingFixture);

    // Documented constructor default: the role is never left unset, so a fresh
    // deployment is immediately usable. The owner must rotate it away
    // explicitly to get real role separation.
    expect(await staking.claimer()).to.equal(owner.address);
    expect(await staking.claimer()).to.not.equal(ethers.ZeroAddress);
  });

  it("A5: deploying with the zero token address reverts with ZeroAddress", async function () {
    const { staking } = await loadFixture(deployStakingFixture);

    // `staking` is used here purely as the ABI source for decoding the custom
    // error; the reverting deployment never produces an instance.
    await expect(ethers.deployContract("StakingManager", [ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(staking, "ZeroAddress");
  });

  it("A6: the constructor emits ClaimerUpdated(address(0), deployer)", async function () {
    const { catt, owner } = await loadFixture(deployStakingFixture);

    const factory = await ethers.getContractFactory("StakingManager");
    const fresh = await factory.deploy(catt.target);
    await fresh.waitForDeployment();

    expect(await fresh.claimer()).to.equal(owner.address);
    await expect(fresh.deploymentTransaction())
      .to.emit(fresh, "ClaimerUpdated")
      .withArgs(ethers.ZeroAddress, owner.address);
  });
});

// ===========================================================================
// B. Tiered percentage math (6)
// ===========================================================================

describe("B. Tiered percentage math", function () {
  it("B1: a fresh user is level 0, needs 10%, and requiredStakeFor is balance*10/100", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    expect(await staking.stakeLevel(alice.address)).to.equal(0n);
    expect(await staking.requiredPercent(alice.address)).to.equal(10n);

    const expected = (ALICE_BALANCE * 10n) / 100n;
    expect(expected).to.equal(100_000n * ONE);
    expect(await staking.requiredStakeFor(alice.address)).to.equal(expected);
  });

  it("B2: each stake adds exactly 5 points — 1 -> 15%, 2 -> 20%, 3 -> 25%", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.stakeLevel(alice.address)).to.equal(1n);
    expect(await staking.requiredPercent(alice.address)).to.equal(15n);

    await stakeRequired(staking, alice);
    expect(await staking.stakeLevel(alice.address)).to.equal(2n);
    expect(await staking.requiredPercent(alice.address)).to.equal(20n);

    await stakeRequired(staking, alice);
    expect(await staking.stakeLevel(alice.address)).to.equal(3n);
    expect(await staking.requiredPercent(alice.address)).to.equal(25n);
  });

  it("B3: escalating 16 times reaches the 90% cap (level 16 -> 90)", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await escalate(staking, alice, 16n);

    const level = await staking.stakeLevel(alice.address);
    expect(level).to.equal(16n);
    // 10 + 16*5 == 90, exactly the cap.
    expect(10n + level * 5n).to.equal(await staking.MAX_STAKE_PERCENT());
    expect(await staking.requiredPercent(alice.address)).to.equal(90n);
  });

  it("B4: the percent STAYS at 90 at extreme levels — the cap never wraps or grows", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    await escalate(staking, alice, MAX_ESCALATIONS);

    const level = await staking.stakeLevel(alice.address);
    expect(level).to.equal(MAX_ESCALATIONS);
    expect(await staking.requiredPercent(alice.address)).to.equal(90n);
    expect(await staking.requiredPercent(alice.address)).to.equal(
      await staking.MAX_STAKE_PERCENT()
    );
    // Far past the cap point, and still exactly the cap: the clamp is applied
    // to the RESULT, so an unbounded level can only push the percentage up to
    // 90 — never past it, and never back down.
    expect(level).to.be.greaterThan(16n);
    expect(10n + level * 5n).to.be.greaterThan(90n);

    // 35 exact-requirement stakes is the practical maximum for a 1M holder: the
    // position is down to dust, so the next requirement floors to zero.
    expect(await catt.balanceOf(alice.address)).to.be.lessThan(100n);
    expect(await staking.requiredStakeFor(alice.address)).to.equal(0n);
  });

  it("B5: requiredStakeFor recomputes from the CURRENT spendable balance", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    const staked = await stakeRequired(staking, alice);
    expect(staked).to.equal(100_000n * ONE);

    // The staked CATT left alice's spendable balance, so the 15% requirement is
    // computed on 900,000 — strictly less than 15% of the ORIGINAL 1,000,000.
    const remainingBalance = await catt.balanceOf(alice.address);
    expect(remainingBalance).to.equal(ALICE_BALANCE - staked);

    const required = await staking.requiredStakeFor(alice.address);
    expect(required).to.equal((remainingBalance * 15n) / 100n);
    expect(required).to.equal(135_000n * ONE);
    expect(required).to.be.lessThan((ALICE_BALANCE * 15n) / 100n);
  });

  it("B6: requiredStakeFor floors the division (truncating, never rounding up)", async function () {
    const { catt, staking, attacker } = await loadFixture(deployStakingFixture);

    // 1,000,001 wei does not divide evenly by 100: 10% is 100,000.10 wei.
    await catt.mint(attacker.address, 1_000_001n);
    const balance = await catt.balanceOf(attacker.address);
    expect(balance).to.equal(1_000_001n);
    expect((balance * 10n) % 100n).to.equal(10n); // a real truncation happens

    const required = await staking.requiredStakeFor(attacker.address);
    expect(required).to.equal((balance * 10n) / 100n);
    expect(required).to.equal(100_000n); // 100,000.10 -> 100,000
  });
});

// ===========================================================================
// C. Staking transfers (8)
// ===========================================================================

describe("C. Staking transfers", function () {
  it("C1: staking below the requirement reverts with InsufficientStakeAmount and moves no tokens", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    const required = await staking.requiredStakeFor(alice.address);
    const provided = required - 1n;

    const aliceBefore = await catt.balanceOf(alice.address);
    const vaultBefore = await vaultBalance(catt, staking);

    await expect(staking.connect(alice).stakeForStamina(provided))
      .to.be.revertedWithCustomError(staking, "InsufficientStakeAmount")
      .withArgs(required, provided);

    expect(await catt.balanceOf(alice.address)).to.equal(aliceBefore);
    expect(await vaultBalance(catt, staking)).to.equal(vaultBefore);
    expect(await staking.stakedAmount(alice.address)).to.equal(0n);
    expect(await staking.stakeLevel(alice.address)).to.equal(0n);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("C2: staking exactly the required amount succeeds", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    const required = await staking.requiredStakeFor(alice.address);
    await staking.connect(alice).stakeForStamina(required);

    expect(await staking.stakedAmount(alice.address)).to.equal(required);
    expect(await staking.stakeLevel(alice.address)).to.equal(1n);
    expect(await catt.balanceOf(alice.address)).to.equal(ALICE_BALANCE - required);
  });

  it("C3: over-staking is allowed and locks the full amount", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    const required = await staking.requiredStakeFor(alice.address);
    const amount = required * 5n;
    expect(amount).to.be.lessThan(ALICE_BALANCE);

    await staking.connect(alice).stakeForStamina(amount);

    // The check is `>=`, not `==`: a voluntary over-stake is fully locked.
    expect(await staking.stakedAmount(alice.address)).to.equal(amount);
    expect(await catt.balanceOf(alice.address)).to.equal(ALICE_BALANCE - amount);
    expect(await vaultBalance(catt, staking)).to.equal(amount);
  });

  it("C4: the tokens really move — user down, vault up, stakedAmount up", async function () {
    const { catt, staking, alice } = await loadFixture(deployStakingFixture);

    const aliceBefore = await catt.balanceOf(alice.address);
    const vaultBefore = await vaultBalance(catt, staking);
    const stakedBefore = await staking.stakedAmount(alice.address);

    const amount = await staking.requiredStakeFor(alice.address);
    expect(amount).to.be.greaterThan(0n);
    await staking.connect(alice).stakeForStamina(amount);

    expect(await catt.balanceOf(alice.address)).to.equal(aliceBefore - amount);
    expect(await vaultBalance(catt, staking)).to.equal(vaultBefore + amount);
    expect(await staking.stakedAmount(alice.address)).to.equal(stakedBefore + amount);
  });

  it("C5: stakeLevel rises by exactly 1 per stake and NEVER falls after an unstake", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.stakeLevel(alice.address)).to.equal(1n);

    await stakeRequired(staking, alice);
    expect(await staking.stakeLevel(alice.address)).to.equal(2n);

    const percentBefore = await staking.requiredPercent(alice.address);
    await staking.connect(alice).requestUnstake();

    // Dripping 10% back out must not let the user reset the escalation, which
    // would otherwise be free to cycle stake -> unstake -> stake.
    expect(await staking.stakeLevel(alice.address)).to.equal(2n);
    expect(await staking.requiredPercent(alice.address)).to.equal(percentBefore);
    expect(await staking.stakedAmount(alice.address)).to.be.greaterThan(0n);
  });

  it("C6: a stake emits Staked(user, amount, newStaked, newLevel)", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    // The requirement escalates with every stake, so each event is checked
    // against the level it was actually issued at.
    const req0 = await staking.requiredStakeFor(alice.address);
    expect(req0).to.equal(100_000n * ONE);

    await expect(staking.connect(alice).stakeForStamina(req0))
      .to.emit(staking, "Staked")
      .withArgs(alice.address, req0, req0, 1n);

    const req1 = await staking.requiredStakeFor(alice.address);
    expect(req1).to.equal(135_000n * ONE);

    await expect(staking.connect(alice).stakeForStamina(req1))
      .to.emit(staking, "Staked")
      .withArgs(alice.address, req1, req0 + req1, 2n);

    const req2 = await staking.requiredStakeFor(alice.address);
    expect(req2).to.equal(153_000n * ONE);

    await expect(staking.connect(alice).stakeForStamina(req2))
      .to.emit(staking, "Staked")
      .withArgs(alice.address, req2, req0 + req1 + req2, 3n);

    await expect(staking.connect(alice).stakeForStamina(req2))
      .to.emit(staking, "StaminaGranted")
      .withArgs(alice.address, 50n, 200n);
  });

  it("C7: staking without an allowance reverts in the token, and staking 0 reverts ZeroAmount", async function () {
    const { catt, staking, alice, attacker } = await loadFixture(deployStakingFixture);

    // Funded but never approved, so the ERC20 pull is what fails.
    await catt.mint(attacker.address, 1_000n * ONE);
    expect(await catt.allowance(attacker.address, staking.target)).to.equal(0n);

    const required = await staking.requiredStakeFor(attacker.address);
    await expect(staking.connect(attacker).stakeForStamina(required))
      .to.be.revertedWithCustomError(catt, "ERC20InsufficientAllowance")
      .withArgs(staking.target, 0n, required);

    // Zero is rejected before anything else, so an approved user cannot make a
    // free level by staking nothing.
    await expect(staking.connect(alice).stakeForStamina(0n))
      .to.be.revertedWithCustomError(staking, "ZeroAmount");
    expect(await staking.stakeLevel(alice.address)).to.equal(0n);
  });

  it("C8: after several stakes the vault holds exactly the sum of all stakedAmounts", async function () {
    const { catt, staking, alice, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    await stakeRequired(staking, alice);
    await stakeRequired(staking, alice);
    await stakeRequired(staking, bob);

    const aliceStaked = await staking.stakedAmount(alice.address);
    const bobStaked = await staking.stakedAmount(bob.address);
    expect(aliceStaked).to.be.greaterThan(0n);
    expect(bobStaked).to.be.greaterThan(0n);

    expect(await vaultBalance(catt, staking)).to.equal(aliceStaked + bobStaked);
    // Nothing escaped to anywhere else either.
    expect(await catt.balanceOf(alice.address)).to.equal(ALICE_BALANCE - aliceStaked);
    expect(await catt.balanceOf(bob.address)).to.equal(BOB_BALANCE - bobStaked);
  });
});

// ===========================================================================
// D. Stamina grant & consumption (6)
// ===========================================================================

describe("D. Stamina grant & consumption", function () {
  it("D1: every successful stake grants exactly +50 — 50, 100, 150", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(50n);

    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(100n);

    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(150n);

    // Exactly STAMINA_PER_STAKE each time, not a level-scaled amount.
    expect(150n).to.equal(3n * (await staking.STAMINA_PER_STAKE()));
  });

  it("D2: staminaOf(user) mirrors the stamina mapping", async function () {
    const { staking, alice, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    expect(await staking.staminaOf(alice.address)).to.equal(await staking.stamina(alice.address));
    expect(await staking.staminaOf(alice.address)).to.equal(50n);
    // A user who has never staked reports 0 through both entry points.
    expect(await staking.staminaOf(bob.address)).to.equal(0n);
    expect(await staking.staminaOf(bob.address)).to.equal(await staking.stamina(bob.address));
  });

  it("D3: the claimer consumes stamina, the balance drops by exactly amount, and StaminaGranted's mirror fires", async function () {
    const { staking, alice, owner } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(50n);

    // The deployer is the claimer at construction.
    await expect(staking.connect(owner).consumeStamina(alice.address, 20n))
      .to.emit(staking, "StaminaConsumed")
      .withArgs(alice.address, 20n, 30n);

    expect(await staking.staminaOf(alice.address)).to.equal(30n);
    expect(await staking.stamina(alice.address)).to.equal(30n);
  });

  it("D4: over-consuming reverts StaminaInsufficient(alice, requested, available)", async function () {
    const { staking, alice, owner } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(50n);

    await expect(staking.connect(owner).consumeStamina(alice.address, 51n))
      .to.be.revertedWithCustomError(staking, "StaminaInsufficient")
      .withArgs(alice.address, 51n, 50n);

    // Nothing moved.
    expect(await staking.staminaOf(alice.address)).to.equal(50n);

    await expect(staking.connect(owner).consumeStamina(alice.address, 0n))
      .to.be.revertedWithCustomError(staking, "ZeroAmount");

    await expect(staking.connect(owner).consumeStamina(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(staking, "ZeroAddress");
  });

  it("D5: the claimer may consume on BEHALIEF of another user (account != msg.sender)", async function () {
    const { staking, alice, attacker } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    // PRD 3.2 relay: the signature-authorized Judge service is msg.sender and
    // debits the wallet that earned the stamina.
    await staking.setClaimer(attacker.address);
    expect(await staking.claimer()).to.equal(attacker.address);

    await expect(staking.connect(attacker).consumeStamina(alice.address, 50n))
      .to.emit(staking, "StaminaConsumed")
      .withArgs(alice.address, 50n, 0n);

    expect(alice.address).to.not.equal(attacker.address);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    // The judge itself earned nothing and spent nothing.
    expect(await staking.staminaOf(attacker.address)).to.equal(0n);
  });

  it("D6: staking again after consuming stamina grants another +50 (no cap, it accumulates)", async function () {
    const { staking, alice, owner } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(100n);

    await staking.connect(owner).consumeStamina(alice.address, 100n);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);

    await expect(staking.connect(alice).stakeForStamina(await staking.requiredStakeFor(alice.address)))
      .to.emit(staking, "StaminaGranted")
      .withArgs(alice.address, 50n, 50n);

    // Stamina accrues on top of a non-zero balance; it is not reset by a spend.
    await stakeRequired(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(100n);
    expect(await staking.stakeLevel(alice.address)).to.equal(4n);
  });
});

// ===========================================================================
// E. Authorization (6)
// ===========================================================================

describe("E. Authorization", function () {
  it("E1: an unrelated attacker calling consumeStamina reverts UnauthorizedClaimer(caller)", async function () {
    const { staking, alice, attacker } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    await expect(staking.connect(attacker).consumeStamina(alice.address, 1n))
      .to.be.revertedWithCustomError(staking, "UnauthorizedClaimer")
      .withArgs(attacker.address);

    expect(await staking.staminaOf(alice.address)).to.equal(50n);
  });

  it("E2: a funded non-claimer user (bob) is rejected with his own address in the error", async function () {
    const { staking, alice, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    await expect(staking.connect(bob).consumeStamina(alice.address, 1n))
      .to.be.revertedWithCustomError(staking, "UnauthorizedClaimer")
      .withArgs(bob.address);

    await expect(staking.connect(bob).consumeStamina(bob.address, 1n))
      .to.be.revertedWithCustomError(staking, "UnauthorizedClaimer")
      .withArgs(bob.address);

    expect(await staking.staminaOf(alice.address)).to.equal(50n);
  });

  it("E3: the OWNER is not implicitly a claimer — after rotation the deployer is rejected", async function () {
    const { staking, alice, owner, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    // Before rotation the owner IS the claimer (deploy-time default).
    expect(await staking.claimer()).to.equal(owner.address);
    await staking.connect(owner).consumeStamina(alice.address, 10n);
    expect(await staking.staminaOf(alice.address)).to.equal(40n);

    await staking.connect(owner).setClaimer(bob.address);

    await expect(staking.connect(owner).consumeStamina(alice.address, 1n))
      .to.be.revertedWithCustomError(staking, "UnauthorizedClaimer")
      .withArgs(owner.address);

    expect(await staking.staminaOf(alice.address)).to.equal(40n);
  });

  it("E4: a non-owner calling setClaimer reverts with OwnableUnauthorizedAccount", async function () {
    const { staking, attacker } = await loadFixture(deployStakingFixture);

    await expect(staking.connect(attacker).setClaimer(attacker.address))
      .to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);

    expect(await staking.claimer()).to.not.equal(attacker.address);
  });

  it("E5: setClaimer(address(0)) reverts ZeroAddress, so the role can never be bricked", async function () {
    const { staking, owner } = await loadFixture(deployStakingFixture);

    await expect(staking.connect(owner).setClaimer(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(staking, "ZeroAddress");

    expect(await staking.claimer()).to.equal(owner.address);
  });

  it("E6: after rotation the new claimer can consume, the previous one cannot, and ClaimerUpdated fires", async function () {
    const { staking, alice, owner, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    await expect(staking.connect(owner).setClaimer(bob.address))
      .to.emit(staking, "ClaimerUpdated")
      .withArgs(owner.address, bob.address);

    expect(await staking.claimer()).to.equal(bob.address);

    await expect(staking.connect(owner).consumeStamina(alice.address, 1n))
      .to.be.revertedWithCustomError(staking, "UnauthorizedClaimer")
      .withArgs(owner.address);

    await staking.connect(bob).consumeStamina(alice.address, 50n);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });
});

// ===========================================================================
// F. Drip unstaking (7)
// ===========================================================================

describe("F. Drip unstaking", function () {
  it("F1: the FIRST request is served immediately (no cooldown for a first-timer)", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    expect(await staking.lastUnstakeRequest(alice.address)).to.equal(0n);
    expect(await staking.unstakeCooldownRemaining(alice.address)).to.equal(0n);
    expect(await staking.nextUnstakeAvailableAt(alice.address)).to.equal(0n);

    const tx = await staking.connect(alice).requestUnstake();
    const ts = await blockTimestampOf(tx);

    // Served on the very first attempt, and it is what ARMS the clock.
    expect(await staking.stakedAmount(alice.address)).to.be.greaterThan(0n);
    expect(await staking.lastUnstakeRequest(alice.address)).to.equal(ts);
  });

  it("F2: the release is exactly 10% of the staked amount — 1,000 staked -> 100 out, 900 left", async function () {
    const { catt, staking, attacker } = await loadFixture(deployDripFixture);

    const staked = await staking.requiredStakeFor(attacker.address);
    expect(staked).to.equal(1_000n);
    await staking.connect(attacker).stakeForStamina(staked);

    const balanceBefore = await catt.balanceOf(attacker.address);
    expect(balanceBefore).to.equal(10_000n - staked);

    await staking.connect(attacker).requestUnstake();

    expect(await catt.balanceOf(attacker.address)).to.equal(balanceBefore + 100n);
    expect(await staking.stakedAmount(attacker.address)).to.equal(900n);

    // The 10% is exactly UNSTAKE_BPS / BPS_DENOMINATOR of the staked balance.
    expect(100n).to.equal((staked * DRIP_BPS) / BPS_DENOMINATOR);
  });

  it("F3: the release is capped at 10% — a user can NEVER exit in one request", async function () {
    const { staking, attacker } = await loadFixture(deployDripFixture);

    const staked = await staking.requiredStakeFor(attacker.address);
    await staking.connect(attacker).stakeForStamina(staked);

    await staking.connect(attacker).requestUnstake();

    expect(await staking.stakedAmount(attacker.address)).to.equal(staked - 100n);
    // 90% of the position is still locked after the request.
    expect(await staking.stakedAmount(attacker.address)).to.equal((staked * 90n) / 100n);
    expect(await staking.stakedAmount(attacker.address)).to.be.greaterThan(staked / 2n);
  });

  it("F4: Unstaked carries (user, amount, newStakedAmount, requestTs + 302400)", async function () {
    const { staking, attacker } = await loadFixture(deployDripFixture);

    const staked = await staking.requiredStakeFor(attacker.address);
    await staking.connect(attacker).stakeForStamina(staked);

    // Derive the request timestamp from the mined block so the 4th argument is
    // exact rather than "whatever the clock says now".
    const tx = await staking.connect(attacker).requestUnstake();
    const ts = await blockTimestampOf(tx);

    await expect(tx)
      .to.emit(staking, "Unstaked")
      .withArgs(attacker.address, 100n, 900n, ts + UNSTAKE_COOLDOWN);

    expect(ts + UNSTAKE_COOLDOWN).to.equal(await staking.nextUnstakeAvailableAt(attacker.address));
  });

  it("F5: a user with nothing staked reverts NotStaker", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    expect(await staking.stakedAmount(alice.address)).to.equal(0n);

    await expect(staking.connect(alice).requestUnstake())
      .to.be.revertedWithCustomError(staking, "NotStaker");

    expect(await staking.lastUnstakeRequest(alice.address)).to.equal(0n);
  });

  it("F6: a dust position of 9 wei reverts UnstakeAmountTooSmall(9, 0)", async function () {
    const { catt, staking, attacker } = await loadFixture(deployStakingFixture);

    // A 90 wei balance makes the level-0 requirement exactly 9 wei.
    await catt.mint(attacker.address, 90n);
    await catt.connect(attacker).approve(staking.target, ethers.MaxUint256);
    const required = await staking.requiredStakeFor(attacker.address);
    expect(required).to.equal(9n);
    await staking.connect(attacker).stakeForStamina(required);

    expect(await staking.stakedAmount(attacker.address)).to.equal(9n);
    expect((9n * DRIP_BPS) / BPS_DENOMINATOR).to.equal(0n);

    await expect(staking.connect(attacker).requestUnstake())
      .to.be.revertedWithCustomError(staking, "UnstakeAmountTooSmall")
      .withArgs(9n, 0n);

    // Per-caller revert: state is untouched and nobody else is blocked.
    expect(await staking.stakedAmount(attacker.address)).to.equal(9n);
    expect(await staking.lastUnstakeRequest(attacker.address)).to.equal(0n);
  });

  it("F7: the vault balance equals the sum of stakedAmounts after drips (no leakage)", async function () {
    const { catt, staking, alice, bob, attacker } = await loadFixture(deployDripFixture);

    await stakeRequired(staking, alice);
    await stakeRequired(staking, bob);
    await staking.connect(attacker).stakeForStamina(await staking.requiredStakeFor(attacker.address));

    await staking.connect(attacker).requestUnstake();
    await staking.connect(alice).requestUnstake();

    const aliceStaked = await staking.stakedAmount(alice.address);
    const bobStaked = await staking.stakedAmount(bob.address);
    const attackerStaked = await staking.stakedAmount(attacker.address);

    expect(await vaultBalance(catt, staking)).to.equal(
      aliceStaked + bobStaked + attackerStaked
    );
    // The drip came out of the attacker's position only.
    expect(attackerStaked).to.equal(900n);
    expect(bobStaked).to.equal(BOB_BALANCE / 10n);
    expect(aliceStaked).to.equal(90_000n * ONE);
  });
});

// ===========================================================================
// G. The 84-hour cooldown (8)
// ===========================================================================

describe("G. The 84-hour cooldown", function () {
  it("G1: a second request 1s later reverts UnstakeCooldownActive(302399)", async function () {
    const { staking, attacker } = await loadFixture(deployDripFixture);

    await staking.connect(attacker).stakeForStamina(
      await staking.requiredStakeFor(attacker.address)
    );
    const tx = await staking.connect(attacker).requestUnstake();
    const firstTs = await blockTimestampOf(tx);

    // Pin the rejecting block to exactly firstTs + 1, so the error argument is
    // deterministic: 302400 - 1 == 302399.
    await time.setNextBlockTimestamp(firstTs + 1n);
    await expect(staking.connect(attacker).requestUnstake())
      .to.be.revertedWithCustomError(staking, "UnstakeCooldownActive")
      .withArgs(UNSTAKE_COOLDOWN - 1n);

    expect(UNSTAKE_COOLDOWN - 1n).to.equal(302_399n);
    // The rejected request changed nothing at all.
    expect(await staking.stakedAmount(attacker.address)).to.equal(900n);
    expect(await staking.lastUnstakeRequest(attacker.address)).to.equal(firstTs);
  });

  it("G2: unstakeCooldownRemaining matches nextUnstakeAvailableAt - block.timestamp", async function () {
    const { staking, alice } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);

    // Never requested: no cooldown, and no "next available" either.
    expect(await staking.unstakeCooldownRemaining(alice.address)).to.equal(0n);
    expect(await staking.nextUnstakeAvailableAt(alice.address)).to.equal(0n);

    await staking.connect(alice).requestUnstake();

    // Pin the clock so the view reads a known timestamp.
    await time.increaseTo((await staking.lastUnstakeRequest(alice.address)) + 500n);
    const now = await latestTimestamp();

    const remaining = await staking.unstakeCooldownRemaining(alice.address);
    const next = await staking.nextUnstakeAvailableAt(alice.address);

    expect(remaining).to.be.greaterThan(0n);
    expect(remaining).to.be.lessThan(UNSTAKE_COOLDOWN);
    expect(remaining).to.equal(next - now);
    expect(remaining).to.equal(UNSTAKE_COOLDOWN - 500n);
  });

  it("G3: nextUnstakeAvailableAt == lastUnstakeRequest + 302400, and is 0 before any request", async function () {
    const { staking, alice, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    expect(await staking.lastUnstakeRequest(alice.address)).to.equal(0n);
    expect(await staking.nextUnstakeAvailableAt(alice.address)).to.equal(0n);

    const tx = await staking.connect(alice).requestUnstake();
    const ts = await blockTimestampOf(tx);

    const last = await staking.lastUnstakeRequest(alice.address);
    const next = await staking.nextUnstakeAvailableAt(alice.address);
    expect(last).to.equal(ts);
    expect(next).to.equal(last + UNSTAKE_COOLDOWN);
    expect(next - last).to.equal(302_400n);

    // Unrelated users keep their own (zero) state.
    expect(await staking.lastUnstakeRequest(bob.address)).to.equal(0n);
    expect(await staking.nextUnstakeAvailableAt(bob.address)).to.equal(0n);
    expect(await staking.unstakeCooldownRemaining(bob.address)).to.equal(0n);
  });

  it("G4: 83h59m59s is still locked; exactly nextUnstakeAvailableAt is served", async function () {
    const { staking, attacker } = await loadFixture(deployDripFixture);

    await staking.connect(attacker).stakeForStamina(
      await staking.requiredStakeFor(attacker.address)
    );
    const tx = await staking.connect(attacker).requestUnstake();
    const firstTs = await blockTimestampOf(tx);
    const nextAvailable = firstTs + UNSTAKE_COOLDOWN;

    // 83h59m59s == 302399s == one second short of the deadline.
    await time.setNextBlockTimestamp(nextAvailable - 1n);
    await expect(staking.connect(attacker).requestUnstake())
      .to.be.revertedWithCustomError(staking, "UnstakeCooldownActive")
      .withArgs(1n);

    // The reverting call mined nothing, so jump straight to the deadline and
    // check the head block is exactly on it.
    await time.increaseTo(nextAvailable);
    expect(await latestTimestamp()).to.equal(nextAvailable);
    expect(await staking.unstakeCooldownRemaining(attacker.address)).to.equal(0n);

    await staking.connect(attacker).requestUnstake();
    expect(await staking.stakedAmount(attacker.address)).to.equal(810n);
  });

  it("G5: the second drip is 10% of the REDUCED staked amount — 900 -> 90 out, 810 left", async function () {
    const { catt, staking, attacker } = await loadFixture(deployDripFixture);

    await staking.connect(attacker).stakeForStamina(
      await staking.requiredStakeFor(attacker.address)
    );
    await staking.connect(attacker).requestUnstake();
    expect(await staking.stakedAmount(attacker.address)).to.equal(900n);

    const balanceAfterFirst = await catt.balanceOf(attacker.address);

    // Wait out the full cooldown, then drip again.
    await time.increaseTo(await staking.nextUnstakeAvailableAt(attacker.address));
    await staking.connect(attacker).requestUnstake();

    expect(await staking.stakedAmount(attacker.address)).to.equal(810n);
    expect(await catt.balanceOf(attacker.address)).to.equal(balanceAfterFirst + 90n);
    // 10% of 900, NOT 10% of the original 1,000.
    expect(90n).to.equal((900n * DRIP_BPS) / BPS_DENOMINATOR);
    expect(90n).to.not.equal(100n);
  });

  it("G6: the clock RE-ARMS from the second request, so a third immediate request reverts", async function () {
    const { staking, attacker } = await loadFixture(deployDripFixture);

    await staking.connect(attacker).stakeForStamina(
      await staking.requiredStakeFor(attacker.address)
    );
    const tx1 = await staking.connect(attacker).requestUnstake();
    const ts1 = await blockTimestampOf(tx1);

    await time.increaseTo(ts1 + UNSTAKE_COOLDOWN);
    const tx2 = await staking.connect(attacker).requestUnstake();
    const ts2 = await blockTimestampOf(tx2);

    expect(ts2).to.be.greaterThan(ts1);
    expect(await staking.lastUnstakeRequest(attacker.address)).to.equal(ts2);
    expect(await staking.nextUnstakeAvailableAt(attacker.address)).to.equal(
      ts2 + UNSTAKE_COOLDOWN
    );
    // The window restarted from the SECOND request, not the first.
    expect(await staking.nextUnstakeAvailableAt(attacker.address)).to.not.equal(
      ts1 + UNSTAKE_COOLDOWN
    );

    await time.setNextBlockTimestamp(ts2 + 1n);
    await expect(staking.connect(attacker).requestUnstake())
      .to.be.revertedWithCustomError(staking, "UnstakeCooldownActive")
      .withArgs(UNSTAKE_COOLDOWN - 1n);

    expect(await staking.stakedAmount(attacker.address)).to.equal(810n);
  });

  it("G7: cooldowns are INDEPENDENT per user — bob is served while alice is locked out", async function () {
    const { staking, alice, bob } = await loadFixture(deployStakingFixture);

    await stakeRequired(staking, alice);
    await stakeRequired(staking, bob);

    const aliceTx = await staking.connect(alice).requestUnstake();
    const aliceTs = await blockTimestampOf(aliceTx);
    const aliceNext = await staking.nextUnstakeAvailableAt(alice.address);
    const aliceRemainingBefore = await staking.unstakeCooldownRemaining(alice.address);

    // Advance a known amount, then let bob transact twice (stake + drip).
    await time.increaseTo(aliceTs + 1_000n);
    const beforeBob = await latestTimestamp();
    const remainingAtPin = await staking.unstakeCooldownRemaining(alice.address);
    expect(remainingAtPin).to.equal(aliceNext - beforeBob);

    // Bob is completely unaffected by alice's window.
    await staking.connect(bob).requestUnstake();
    expect(await staking.lastUnstakeRequest(bob.address)).to.be.greaterThan(0n);
    expect(await staking.nextUnstakeAvailableAt(bob.address)).to.be.greaterThan(0n);

    const afterBob = await latestTimestamp();
    expect(afterBob).to.be.greaterThan(beforeBob);

    // Alice's deadline is untouched; her remaining time only decreased by the
    // blocks that were actually mined in between.
    expect(await staking.nextUnstakeAvailableAt(alice.address)).to.equal(aliceNext);
    expect(await staking.lastUnstakeRequest(alice.address)).to.equal(aliceTs);
    expect(await staking.unstakeCooldownRemaining(alice.address)).to.equal(
      aliceNext - afterBob
    );
    expect(aliceRemainingBefore).to.be.greaterThan(await staking.unstakeCooldownRemaining(alice.address));

    // And alice is genuinely still locked out.
    await time.setNextBlockTimestamp(aliceNext - 1n);
    await expect(staking.connect(alice).requestUnstake())
      .to.be.revertedWithCustomError(staking, "UnstakeCooldownActive")
      .withArgs(1n);
  });

  it("G8: after two full drips only 19% of the original position has been released", async function () {
    const { catt, staking, attacker } = await loadFixture(deployDripFixture);

    const original = await staking.requiredStakeFor(attacker.address);
    expect(original).to.equal(1_000n);
    await staking.connect(attacker).stakeForStamina(original);

    const balanceAfterStake = await catt.balanceOf(attacker.address);
    await staking.connect(attacker).requestUnstake();
    expect(await catt.balanceOf(attacker.address)).to.equal(balanceAfterStake + 100n);

    await time.increaseTo(await staking.nextUnstakeAvailableAt(attacker.address));
    await staking.connect(attacker).requestUnstake();
    expect(await catt.balanceOf(attacker.address)).to.equal(balanceAfterStake + 190n);

    // 100 + 90 = 190 released, i.e. 19.00% of the original 1,000. The
    // anti-dump design: 81% is still locked and needs nine more drips.
    const released = 190n;
    expect(released).to.equal((original * 19n) / 100n);
    expect((released * 100n) / original).to.equal(19n);
    expect(await staking.stakedAmount(attacker.address)).to.equal(original - released);
    expect(await staking.stakedAmount(attacker.address)).to.equal(810n);

    // Confirm the arithmetic the contract used, drip by drip: 10% of 1,000 is
    // 100, then 10% of the remaining 900 is 90.
    const drip1 = (original * DRIP_BPS) / BPS_DENOMINATOR;
    const drip2 = ((original - drip1) * DRIP_BPS) / BPS_DENOMINATOR;
    expect(drip1).to.equal(100n);
    expect(drip2).to.equal(90n);
    expect(drip1 + drip2).to.equal(released);
  });
});