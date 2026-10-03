const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// The backend Judge's EIP-712 signer is exercised as the REAL cross-side
// consumer: this is the module that actually runs in `backend-server`, loaded
// through a relative path so that any drift between the JS type string /
// domain and the Solidity contract shows up here as a failing test rather than
// as an unfunded claim in production.
const signerLib = require("../../backend-server/signer.js");

/**
 * Wave 4 test suite for the CATT Protocol.
 *
 * Covers `MiningClaimer`, the signature-verified settlement layer of the PRD
 * Section 3.2 "Signature Generator" + Section 6.2 "Mining Loop" loop:
 *
 *   - A: CROSS-SIDE COMPATIBILITY. `backend-server/signer.js` and the Solidity
 *         contract must build a byte-identical EIP-712 domain and digest, the
 *         signature must recover to the on-chain `signer`, and the chainId must
 *         really be inside the domain.
 *   - B: DEPLOYMENT WIRING. The claimer must be the SOLE minter of CATT and the
 *         ONLY account allowed to debit stamina, and every genesis allocation
 *         must have been minted by the deployer BEFORE the handover.
 *   - C: HAPPY PATH. Relayer-friendly settlement, strict `>` deadline semantics,
 *         accumulation over several nonces and per-user nonce independence.
 *   - D: TAMPERING & EXPIRY. Every field of the signed struct is load-bearing.
 *   - E: SIGNER ROTATION. Immediate revocation, owner-gated, non-destructive.
 *   - F: ATOMICITY & INVARIANTS. A failed claim mints nothing, burns no
 *         stamina and releases its nonce.
 *
 * All amounts are BigInt base units; CATT is 18-decimal throughout. Every
 * timestamp is pinned with `time.latest()` / `time.setNextBlockTimestamp()` so
 * that the boundary assertions (`block.timestamp > deadline`) are exact rather
 * than approximate.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATT = (n) => ethers.parseUnits(String(n), 18);
const ONE = 10n ** 18n;
const MAX_SUPPLY = 100_000_000n * ONE;

/** Genesis allocation each of alice/bob/carol receives from the deployer. */
const INITIAL_ALLOCATION = CATT(10_000);
/** Total minted before the CATT ownership handover, i.e. the fixture supply. */
const GENESIS_SUPPLY = INITIAL_ALLOCATION * 3n;

/** Mirrors `StakingManager.STAMINA_PER_STAKE`. */
const STAMINA_PER_STAKE = 50n;

/** The EIP-712 type string, pinned here independently of both implementations. */
const CLAIM_REWARD_TYPE_STRING =
  "ClaimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline)";
/** keccak256 of the type string above, as the contract pins it as a literal. */
const CLAIM_REWARD_TYPEHASH =
  "0xdf05b3ddedb4baa93c41ae1686cb09d30f486c5eaf3f4d33e0b69af0d0ead50d";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Signs a claim with the given backend key via the production JS signer.
 *
 * @param {import("ethers").Wallet} keyWallet Wallet whose PRIVATE KEY is the backend key.
 * @param {{user: string, reward: bigint, staminaCost: bigint, nonce: bigint, deadline: bigint}} claim
 * @param {bigint} chainId EIP-712 domain chain id (the live one, or a wrong one on purpose).
 * @param {string} verifyingContract Deployed MiningClaimer address.
 * @returns {{signature: string, digest: string, signer: string, claim: object, domain: object}}
 */
function signClaimFor(keyWallet, claim, chainId, verifyingContract) {
  return signerLib.signClaim({
    privateKey: keyWallet.privateKey,
    chainId: Number(chainId),
    verifyingContract,
    ...claim,
  });
}

/** Builds a claim object with the fields in the canonical (significant) order. */
function claimFor(user, reward, staminaCost, nonce, deadline) {
  return { user: user.address, reward, staminaCost, nonce, deadline };
}

/**
 * Grants `user` exactly one lot of 50 stamina.
 *
 * WHY THIS IS A PRECONDITION FOR EVERY CLAIM TEST: stamina is unitless and is
 * only ever created by `StakingManager.stakeForStamina`, so a user with zero
 * stamina cannot mine at all. At stake level 1 the requirement is 10% of the
 * caller's SPENDABLE CATT balance, so staking exactly `requiredStakeFor(user)`
 * costs 10% of the balance and grants exactly 50 stamina. A SECOND stake would
 * cost 15% (the level is bumped by one on every successful stake) and grant
 * another 50, so the level-1 path is the cheapest way to reach exactly 50.
 *
 * @param {object} staking Deployed StakingManager.
 * @param {object} user Signer to stake as.
 * @returns {Promise<bigint>} the amount of CATT locked up by the stake.
 */
async function grantStamina(staking, user) {
  const required = await staking.requiredStakeFor(user.address);
  await staking.connect(user).stakeForStamina(required);
  return required;
}

/**
 * Grants `n` lots of 50 stamina, escalating the stake cost by 5 percentage
 * points per additional level (10%, 15%, 20%, ...).
 */
async function grantStaminaLots(staking, user, n) {
  let total = 0n;
  for (let i = 0; i < n; i += 1) {
    total += await grantStamina(staking, user);
  }
  return total;
}

/**
 * Reverts-payload reader for custom errors that are NOT part of the calling
 * contract's ABI.
 *
 * `claimReward` deliberately lets OpenZeppelin's own `ECDSA.recover` revert
 * bubble up unwrapped, so a malformed signature surfaces as
 * `ECDSAInvalidSignatureLength` — an error declared in node_modules' ECDSA.sol
 * and therefore absent from `MiningClaimer`'s ABI. `revertedWithCustomError`
 * cannot be used for it, so the raw 4-byte selector is compared instead, which
 * is exactly what the EVM does.
 *
 * @param {Promise<any>} promise
 * @param {string} errorSignature e.g. "ECDSAInvalidSignatureLength(uint256)"
 * @returns {Promise<bigint>} the decoded single argument, when the error has one.
 */
async function expectRevertWithSelector(promise, errorSignature) {
  const selector = ethers.id(errorSignature).slice(0, 10).toLowerCase();
  let raw = null;
  try {
    await promise;
  } catch (err) {
    // hardhat-ethers surfaces the revert payload in several places depending on
    // whether the ABI could decode it; check all of them, then fall back to
    // scraping the hex out of the human-readable message.
    const candidates = [
      err && err.data,
      err && err.error && err.error.data,
      err && err.revert && err.revert.data,
      typeof (err && err.message) === "string"
        ? (err.message.match(/0x[0-9a-fA-F]{8,}/) || [null])[0]
        : null,
    ];
    raw = candidates.find((c) => typeof c === "string" && c.length >= 10);
    expect(raw, `expected a revert payload for ${errorSignature}`).to.not.equal(null);
    expect(raw.slice(0, 10).toLowerCase(), `revert selector for ${errorSignature}`).to.equal(selector);
  }
  if (raw === null) {
    expect.fail(`expected ${errorSignature} to revert, but the call succeeded`);
  }
  const args = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + raw.slice(10));
  return args[0];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Deploys the mining loop exactly in the order `MiningClaimer`'s own
 * DeploymentNotes section mandates, and returns the fully wired system:
 *
 *   deployer --(initial mint)--> alice/bob/carol   [while deployer still owns CATT]
 *   deployer --(transferOwnership)--> claimer      [CATT mint role]
 *   deployer --(setClaimer)--------> claimer      [StakingManager stamina-debit role]
 *
 * ROLE MAP, which the tests keep distinct throughout:
 *   - `owner`  : the `Ownable` owner of MiningClaimer itself (= the deployer).
 *                It can only rotate the signer; it cannot mint or debit.
 *   - `claimer`: MiningClaimer's address, holding the CATT owner role and the
 *                StakingManager claimer role. It is the sole minter.
 *   - `signer` : the backend Judge's EVM address (a random key generated per
 *                fixture run; never hardcoded). It attests, it does not hold
 *                privileges of its own.
 */
async function deployMiningFixture() {
  const accounts = await ethers.getSigners();
  const [deployer, alice, bob, carol] = accounts;
  // An unrelated, FUNDED on-chain account used for the "non-owner" checks. A
  // random unfunded wallet would fail on gas, not on authorization.
  const attacker = accounts[5];

  // The backend Judge key and an unrelated key for the negative tests. Both are
  // generated per run, so no key material is ever committed (PRD Rule 2).
  const backendWallet = ethers.Wallet.createRandom();
  const otherWallet = ethers.Wallet.createRandom();

  const catt = await ethers.deployContract("CATT", [deployer.address]);
  await catt.waitForDeployment();

  const staking = await ethers.deployContract("StakingManager", [catt.target]);
  await staking.waitForDeployment();

  const claimer = await ethers.deployContract("MiningClaimer", [
    catt.target,
    staking.target,
    backendWallet.address,
  ]);
  await claimer.waitForDeployment();

  // (i) MINT EVERY INITIAL ALLOCATION while the deployer is STILL the CATT
  // owner. After the transfer in (ii) this is impossible forever, because
  // MiningClaimer's only mint path is a signed mining reward.
  for (const user of [alice, bob, carol]) {
    await catt.mint(user.address, INITIAL_ALLOCATION);
  }
  // Staking approvals are set up front so the tests can stake without noise.
  for (const user of [alice, bob, carol]) {
    await catt.connect(user).approve(staking.target, ethers.MaxUint256);
  }

  // (ii) hand the CATT mint role to the claimer, then (iii) the stamina-debit
  // role. Order matters for (ii) only in that the deployer must still own CATT.
  await catt.transferOwnership(claimer.target);
  await staking.setClaimer(claimer.target);

  // (iv) From here on `claimReward` works end to end.
  const { chainId } = await ethers.provider.getNetwork();

  return {
    catt,
    staking,
    claimer,
    deployer,
    alice,
    bob,
    carol,
    backendWallet,
    otherWallet,
    chainId,
    attacker,
  };
}

// ---------------------------------------------------------------------------
// A. Cross-side signature compatibility
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: A. Cross-side EIP-712 compatibility (backend-server/signer.js)", function () {
  it("A1: hashClaim returns EXACTLY the digest signer.js computes, and the two domains are identical", async function () {
    const { claimer, alice, chainId } = await loadFixture(deployMiningFixture);

    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);

    // On-chain digest: what `claimReward` will recompute from the call arguments.
    const onChain = await claimer.hashClaim(
      alice.address,
      claim.reward,
      claim.staminaCost,
      claim.nonce,
      claim.deadline
    );
    // Off-chain digest: what the production backend actually signs.
    const offChain = signerLib.claimDigest({
      chainId,
      verifyingContract: claimer.target,
      claim: signerLib.buildClaim(claim),
    });

    expect(ethers.getBytes(offChain)).to.deep.equal(ethers.getBytes(onChain));

    // The domain is the other half of the digest, so compare it field by field.
    const jsDomain = signerLib.buildDomain({ chainId, verifyingContract: claimer.target });
    const onChainDomain = await claimer.eip712Domain();

    expect(jsDomain.name).to.equal("CATT Protocol");
    expect(jsDomain.name).to.equal(onChainDomain.name);
    expect(jsDomain.version).to.equal("1");
    expect(jsDomain.version).to.equal(onChainDomain.version);
    expect(jsDomain.chainId).to.equal(Number(chainId));
    expect(jsDomain.chainId).to.equal(Number(onChainDomain.chainId));
    expect(ethers.getAddress(jsDomain.verifyingContract)).to.equal(claimer.target);
    expect(onChainDomain.verifyingContract).to.equal(claimer.target);
  });

  it("A2: the JS type string and struct hash are byte-identical to the contract's pinned literals", async function () {
    const { claimer, alice, chainId } = await loadFixture(deployMiningFixture);

    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 7n, deadline);

    // 1. The encoded type string, derived from the JS module alone.
    const encoder = ethers.TypedDataEncoder.from(signerLib.CLAIM_REWARD_TYPES);
    expect(encoder.encodeType("ClaimReward")).to.equal(CLAIM_REWARD_TYPE_STRING);
    // ...and therefore the type hash the contract hardcodes as a literal.
    expect(ethers.id(CLAIM_REWARD_TYPE_STRING)).to.equal(CLAIM_REWARD_TYPEHASH);

    // 2. The struct hash, computed two independent ways: through the typed-data
    //    encoder, and by hand as the contract does it (`abi.encode` of the
    //    typehash followed by the five fields IN ORDER).
    const fromEncoder = encoder.hashStruct("ClaimReward", claim);
    const fromAbiEncode = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "uint256", "uint256", "uint256", "uint256"],
        [
          CLAIM_REWARD_TYPEHASH,
          alice.address,
          claim.reward,
          claim.staminaCost,
          claim.nonce,
          claim.deadline,
        ]
      )
    );
    expect(fromEncoder).to.equal(fromAbiEncode);
  });

  it("A3: a signature from signer.js recovers to the backend address and is a 65-byte hex string", async function () {
    const { claimer, alice, chainId, backendWallet } = await loadFixture(deployMiningFixture);

    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const signed = signClaimFor(backendWallet, claim, chainId, claimer.target);

    // 65 bytes = r(32) || s(32) || v(1), so 132 hex characters plus "0x".
    expect(signed.signature.startsWith("0x")).to.equal(true);
    expect(signed.signature.length).to.equal(132);
    expect(ethers.getBytes(signed.signature).length).to.equal(65);

    // The signature is over the RAW digest (no EIP-191 prefix), which is what
    // Solidity's `ECDSA.recover(bytes32, bytes)` expects.
    expect(ethers.recoverAddress(signed.digest, signed.signature)).to.equal(backendWallet.address);
    expect(signed.signer).to.equal(backendWallet.address);
  });

  it("A4: a signature made for a DIFFERENT chainId is rejected with ClaimSignatureInvalid", async function () {
    const { claimer, alice, chainId, backendWallet } = await loadFixture(deployMiningFixture);

    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);

    // The domain is the ONLY thing that differs, so this proves chainId really
    // is part of the signed data rather than decoration.
    const wrong = signClaimFor(backendWallet, claim, chainId + 1n, claimer.target);
    const onChainDigest = await claimer.hashClaim(
      alice.address,
      claim.reward,
      claim.staminaCost,
      claim.nonce,
      claim.deadline
    );
    // The signature recovers to a *different* address when replayed against the
    // real digest, which is precisely why the contract rejects it.
    const recoveredOnRealDigest = ethers.recoverAddress(onChainDigest, wrong.signature);
    expect(recoveredOnRealDigest).to.not.equal(backendWallet.address);

    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, wrong.signature)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid")
      .withArgs(backendWallet.address, recoveredOnRealDigest);
  });
});

// ---------------------------------------------------------------------------
// B. Deployment wiring
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: B. Deployment wiring", function () {
  it("B1: the claimer is simultaneously the CATT owner and the StakingManager claimer", async function () {
    const { catt, staking, claimer, deployer } = await loadFixture(deployMiningFixture);

    expect(await catt.owner()).to.equal(claimer.target);
    expect(await staking.claimer()).to.equal(claimer.target);
    // The deployer kept OWNERSHIP of the StakingManager, but deliberately did
    // not take the claimer role for itself: role separation means the owner of
    // the staking contract cannot drain stamina on its own.
    expect(await staking.owner()).to.equal(deployer.address);
    expect(await staking.claimer()).to.not.equal(deployer.address);
    // MiningClaimer's own owner is the deployer, and that role can ONLY rotate
    // the signer.
    expect(await claimer.owner()).to.equal(deployer.address);
  });

  it("B2: the deployer can no longer mint directly", async function () {
    const { catt, alice, deployer } = await loadFixture(deployMiningFixture);

    const supplyBefore = await catt.totalSupply();
    await expect(catt.connect(deployer).mint(alice.address, CATT(1)))
      .to.be.revertedWithCustomError(catt, "OwnableUnauthorizedAccount")
      .withArgs(deployer.address);
    expect(await catt.totalSupply()).to.equal(supplyBefore);
    expect(await catt.balanceOf(alice.address)).to.equal(INITIAL_ALLOCATION);
  });

  it("B3: the genesis allocations were minted BEFORE the handover (10,000 each, 30,000 total)", async function () {
    const { catt, alice, bob, carol } = await loadFixture(deployMiningFixture);

    expect(await catt.balanceOf(alice.address)).to.equal(INITIAL_ALLOCATION);
    expect(await catt.balanceOf(bob.address)).to.equal(INITIAL_ALLOCATION);
    expect(await catt.balanceOf(carol.address)).to.equal(INITIAL_ALLOCATION);
    expect(await catt.totalSupply()).to.equal(CATT(30_000));
    expect(await catt.totalSupply()).to.equal(GENESIS_SUPPLY);
    expect(await catt.totalSupply()).to.be.lessThan(await catt.MAX_SUPPLY());
  });

  it("B4: the immutable wiring and the signer role point at the right addresses", async function () {
    const { catt, staking, claimer, backendWallet } = await loadFixture(deployMiningFixture);

    expect(await claimer.cattToken()).to.equal(catt.target);
    expect(await claimer.stakingManager()).to.equal(staking.target);
    expect(await claimer.signer()).to.equal(backendWallet.address);
    // The genesis SignerUpdated(address(0), signer) is the documented signal
    // that the role was set at construction rather than left unset.
    expect(await claimer.isNonceUsed(backendWallet.address, 0n)).to.equal(false);
  });
});

// ---------------------------------------------------------------------------
// C. Happy path
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: C. Happy path and relayer settlement", function () {
  it("C1: a correctly signed claim mints the reward and consumes exactly the stamina", async function () {
    const { catt, staking, claimer, alice, bob, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // Stamina precondition: alice has none until she stakes.
    await grantStamina(staking, alice);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);

    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const balanceBefore = await catt.balanceOf(alice.address);
    const supplyBefore = await catt.totalSupply();

    // bob is an UNRELATED relayer: the gasless PRD 3.2 flow. The reward still
    // goes to alice, because `user` is inside the signed struct.
    await expect(
      claimer
        .connect(bob)
        .claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.emit(claimer, "RewardClaimed")
      .withArgs(alice.address, CATT(25), STAMINA_PER_STAKE, 1n, backendWallet.address);

    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore + CATT(25));
    expect(await catt.balanceOf(bob.address)).to.equal(INITIAL_ALLOCATION);
    expect(await catt.totalSupply()).to.equal(supplyBefore + CATT(25));
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    expect(await staking.stakedAmount(alice.address)).to.equal(CATT(1_000));
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(true);
  });

  it("C2: the claim is RELAYER-FRIENDLY — bob and carol both relay alice's claims, alice is always paid", async function () {
    const { catt, staking, claimer, alice, bob, carol, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // alice mines twice, paying for two lots of 50 stamina.
    await grantStaminaLots(staking, alice, 2);
    const aliceBefore = await catt.balanceOf(alice.address);
    const bobBefore = await catt.balanceOf(bob.address);
    const carolBefore = await catt.balanceOf(carol.address);

    const deadline = BigInt(await time.latest()) + 3600n;
    const relayers = [bob, carol];
    const rewards = [CATT(3), CATT(4)];

    for (let i = 0; i < relayers.length; i += 1) {
      const claim = claimFor(alice, rewards[i], STAMINA_PER_STAKE, BigInt(i + 1), deadline);
      const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

      // The relayer is `msg.sender`; the reward NEVER goes to the relayer,
      // because `user` is inside the signed struct.
      await expect(
        claimer
          .connect(relayers[i])
          .claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
      )
        .to.emit(claimer, "RewardClaimed")
        .withArgs(alice.address, rewards[i], STAMINA_PER_STAKE, BigInt(i + 1), backendWallet.address);
    }

    expect(await catt.balanceOf(alice.address)).to.equal(aliceBefore + CATT(7));
    // Neither relayer gained a single wei.
    expect(await catt.balanceOf(bob.address)).to.equal(bobBefore);
    expect(await catt.balanceOf(carol.address)).to.equal(carolBefore);
    // Alice paid 100 stamina for 7 CATT, not the relayers.
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    expect(await staking.staminaOf(bob.address)).to.equal(0n);
    expect(await staking.staminaOf(carol.address)).to.equal(0n);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(true);
    expect(await claimer.isNonceUsed(alice.address, 2n)).to.equal(true);
  });

  it("C3: claiming exactly AT the deadline succeeds (strict `>` expiry semantics)", async function () {
    const { claimer, alice, chainId, backendWallet, staking } = await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(5), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    // Pin the NEXT block — the one that will contain the claim — to exactly the
    // deadline second, so the boundary assertion is exact rather than
    // approximate.
    await time.setNextBlockTimestamp(deadline);

    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.emit(claimer, "RewardClaimed")
      .withArgs(alice.address, CATT(5), STAMINA_PER_STAKE, 1n, backendWallet.address);

    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(true);
  });

  it("C4: several sequential nonces each settle and the rewards accumulate", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // Three stakes (levels 1, 2, 3 at 10% / 15% / 20% of the shrinking
    // balance) buy 150 stamina, i.e. three claims of 50.
    await grantStaminaLots(staking, alice, 3);
    expect(await staking.staminaOf(alice.address)).to.equal(3n * STAMINA_PER_STAKE);

    const rewards = [CATT(10), CATT(20), CATT(30)];
    const deadline = BigInt(await time.latest()) + 3600n;
    const supplyBefore = await catt.totalSupply();
    const balanceBefore = await catt.balanceOf(alice.address);

    for (let i = 0; i < rewards.length; i += 1) {
      const nonce = BigInt(i + 1);
      const claim = claimFor(alice, rewards[i], STAMINA_PER_STAKE, nonce, deadline);
      const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);
      await claimer.claimReward(
        alice.address,
        claim.reward,
        claim.staminaCost,
        claim.nonce,
        claim.deadline,
        signature
      );
      expect(await claimer.isNonceUsed(alice.address, nonce)).to.equal(true);
      expect(await staking.staminaOf(alice.address)).to.equal(BigInt(2 - i) * STAMINA_PER_STAKE);
    }

    const total = rewards.reduce((a, b) => a + b, 0n);
    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore + total);
    expect(await catt.totalSupply()).to.equal(supplyBefore + total);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("C5: nonces are tracked PER USER — the same nonce works for alice and for bob", async function () {
    const { catt, staking, claimer, alice, bob, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    await grantStamina(staking, bob);

    const deadline = BigInt(await time.latest()) + 3600n;
    const sharedNonce = 1n;
    const aliceClaim = claimFor(alice, CATT(7), STAMINA_PER_STAKE, sharedNonce, deadline);
    const bobClaim = claimFor(bob, CATT(9), STAMINA_PER_STAKE, sharedNonce, deadline);

    const aliceSig = signClaimFor(backendWallet, aliceClaim, chainId, claimer.target).signature;
    const bobSig = signClaimFor(backendWallet, bobClaim, chainId, claimer.target).signature;

    await claimer.claimReward(
      alice.address,
      aliceClaim.reward,
      aliceClaim.staminaCost,
      aliceClaim.nonce,
      aliceClaim.deadline,
      aliceSig
    );

    // Bob's namespace is completely independent: nonce 1 is still free for him.
    expect(await claimer.isNonceUsed(bob.address, sharedNonce)).to.equal(false);
    expect(await claimer.isNonceUsed(alice.address, sharedNonce)).to.equal(true);

    const bobBalanceBefore = await catt.balanceOf(bob.address);
    await claimer.claimReward(
      bob.address,
      bobClaim.reward,
      bobClaim.staminaCost,
      bobClaim.nonce,
      bobClaim.deadline,
      bobSig
    );

    expect(await claimer.isNonceUsed(bob.address, sharedNonce)).to.equal(true);
    expect(await catt.balanceOf(bob.address)).to.equal(bobBalanceBefore + CATT(9));
    expect(await catt.balanceOf(alice.address)).to.equal(CATT(9_000) + CATT(7));
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    expect(await staking.staminaOf(bob.address)).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// D. Signature tampering & expiry
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: D. Signature tampering and expiry", function () {
  it("D1: a signature from the WRONG key reverts ClaimSignatureInvalid(signer, recovered)", async function () {
    const { claimer, staking, alice, chainId, backendWallet, otherWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);

    // otherWallet signs the IDENTICAL claim; only the key differs, so the
    // digest is the contract's digest and recovery yields otherWallet exactly.
    const { signature } = signClaimFor(otherWallet, claim, chainId, claimer.target);
    const recovered = ethers.recoverAddress(
      await claimer.hashClaim(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline),
      signature
    );
    expect(recovered).to.equal(otherWallet.address);

    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid")
      .withArgs(backendWallet.address, otherWallet.address);

    // No state moved: the signature gate is evaluated before anything else.
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
  });

  it("D2: TAMPERED reward — signed for 25, submitted as 26 — is rejected", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const supplyBefore = await catt.totalSupply();
    await expect(
      claimer.claimReward(alice.address, CATT(26), claim.staminaCost, claim.nonce, claim.deadline, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");

    // Not one wei of the extra 1 CATT was minted, and no stamina was spent.
    expect(await catt.totalSupply()).to.equal(supplyBefore);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
  });

  it("D3: TAMPERED user — alice's signature replayed against bob — is rejected and pays nobody", async function () {
    const { catt, staking, claimer, alice, bob, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const aliceBefore = await catt.balanceOf(alice.address);
    const bobBefore = await catt.balanceOf(bob.address);
    const supplyBefore = await catt.totalSupply();

    await expect(
      claimer.claimReward(bob.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");

    expect(await catt.balanceOf(alice.address)).to.equal(aliceBefore);
    expect(await catt.balanceOf(bob.address)).to.equal(bobBefore);
    expect(await catt.totalSupply()).to.equal(supplyBefore);
    // Neither user's nonce space was touched by the failed attempt.
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await claimer.isNonceUsed(bob.address, 1n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
  });

  it("D4: TAMPERED nonce and TAMPERED deadline are each independently rejected", async function () {
    const { staking, claimer, alice, chainId, backendWallet } = await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    // nonce bumped by one
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, 2n, claim.deadline, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");
    // deadline pushed one second later
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, deadline + 1n, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");
    // deadline pulled one second earlier
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, deadline - 1n, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");

    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await claimer.isNonceUsed(alice.address, 2n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
  });

  it("D5: TAMPERED staminaCost — signed for 50, submitted as 51 — is rejected", async function () {
    const { staking, claimer, alice, chainId, backendWallet } = await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    await expect(
      claimer.claimReward(alice.address, claim.reward, 51n, claim.nonce, claim.deadline, signature)
    ).to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid");

    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
  });

  it("D6: an EXPIRED claim reverts ClaimExpired(deadline, currentTime) and changes nothing", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    // Deadline already in the past, then pin the claim block one second after
    // it so BOTH error arguments are exact rather than approximate.
    const now = BigInt(await time.latest());
    const deadline = now - 1n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const submitAt = now + 1n;
    await time.setNextBlockTimestamp(submitAt);

    const supplyBefore = await catt.totalSupply();
    const balanceBefore = await catt.balanceOf(alice.address);

    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimExpired")
      .withArgs(deadline, submitAt);

    // Nothing minted, no stamina spent, and the nonce is FREE again because the
    // whole transaction reverted.
    expect(await catt.totalSupply()).to.equal(supplyBefore);
    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
  });

  it("D7: a REPLAYED nonce reverts ClaimAlreadyUsed(user, nonce) and mints nothing extra", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    await claimer.claimReward(
      alice.address,
      claim.reward,
      claim.staminaCost,
      claim.nonce,
      claim.deadline,
      signature
    );
    const balanceAfterFirst = await catt.balanceOf(alice.address);
    const supplyAfterFirst = await catt.totalSupply();
    expect(balanceAfterFirst).to.equal(CATT(9_000) + CATT(25));

    // The byte-identical second submission: the signature is still valid and
    // still inside its deadline, so only the nonce check can stop it.
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimAlreadyUsed")
      .withArgs(alice.address, 1n);

    expect(await catt.balanceOf(alice.address)).to.equal(balanceAfterFirst);
    expect(await catt.totalSupply()).to.equal(supplyAfterFirst);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("D8: a MALFORMED signature (0x1234) reverts inside OpenZeppelin's ECDSA.recover", async function () {
    const { staking, claimer, alice } = await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;

    // MiningClaimer deliberately does NOT wrap ECDSA's own revert, so the
    // failure surfaces as OpenZeppelin's `ECDSAInvalidSignatureLength`, which
    // is declared in node_modules and therefore absent from this ABI — hence
    // the raw-selector assertion.
    const length = await expectRevertWithSelector(
      claimer.claimReward(alice.address, CATT(25), STAMINA_PER_STAKE, 1n, deadline, "0x1234"),
      "ECDSAInvalidSignatureLength(uint256)"
    );
    expect(length).to.equal(2n);

    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
  });

  it("D9: claimReward with user == address(0) reverts ZeroAddress before anything else", async function () {
    const { claimer } = await loadFixture(deployMiningFixture);

    const deadline = BigInt(await time.latest()) + 3600n;
    // The signature is junk on purpose: the zero-user check is step 0 of
    // `claimReward`, ahead of the signature gate, because every later step
    // dereferences `user`.
    await expect(
      claimer.claimReward(ethers.ZeroAddress, CATT(25), STAMINA_PER_STAKE, 1n, deadline, "0x1234")
    ).to.be.revertedWithCustomError(claimer, "ZeroAddress");
  });

  it("D10: an EMPTY signature reverts in the same ECDSA path, with length 0", async function () {
    const { staking, claimer, alice } = await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;

    const length = await expectRevertWithSelector(
      claimer.claimReward(alice.address, CATT(25), STAMINA_PER_STAKE, 1n, deadline, "0x"),
      "ECDSAInvalidSignatureLength(uint256)"
    );
    expect(length).to.equal(0n);

    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
  });
});

// ---------------------------------------------------------------------------
// E. Signer rotation
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: E. Signer rotation", function () {
  it("E1: rotation invalidates the OLD key IMMEDIATELY (no grace period) and the NEW key settles", async function () {
    const { catt, staking, claimer, alice, bob, chainId, backendWallet, otherWallet, deployer } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;

    // Signed by the outgoing backend key BEFORE the rotation.
    const oldClaim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const oldSig = signClaimFor(backendWallet, oldClaim, chainId, claimer.target).signature;

    await claimer.connect(deployer).setSigner(otherWallet.address);
    expect(await claimer.signer()).to.equal(otherWallet.address);

    // No overlap window, no pending-signature buffer: the very next block
    // already rejects the old key.
    await expect(
      claimer.claimReward(alice.address, oldClaim.reward, oldClaim.staminaCost, oldClaim.nonce, oldClaim.deadline, oldSig)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid")
      .withArgs(otherWallet.address, backendWallet.address);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);

    // The new key is accepted straight away, with the same nonce (which was
    // never burned by the rejected attempt).
    const newClaim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const newSig = signClaimFor(otherWallet, newClaim, chainId, claimer.target).signature;
    const balanceBefore = await catt.balanceOf(alice.address);

    await expect(
      claimer.connect(bob).claimReward(
        alice.address,
        newClaim.reward,
        newClaim.staminaCost,
        newClaim.nonce,
        newClaim.deadline,
        newSig
      )
    )
      .to.emit(claimer, "RewardClaimed")
      .withArgs(alice.address, CATT(25), STAMINA_PER_STAKE, 1n, otherWallet.address);

    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore + CATT(25));
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("E2: setSigner is owner-gated and refuses the zero address", async function () {
    const { claimer, backendWallet, deployer, attacker } = await loadFixture(deployMiningFixture);

    // The role can never be left unset, which would brick every future claim.
    await expect(claimer.connect(deployer).setSigner(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(claimer, "ZeroAddress")
      .withArgs();
    expect(await claimer.signer()).to.equal(backendWallet.address);

    // The signer is an attester role only; it holds no owner powers.
    await expect(claimer.connect(attacker).setSigner(attacker.address))
      .to.be.revertedWithCustomError(claimer, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
    expect(await claimer.signer()).to.equal(backendWallet.address);
  });

  it("E3: setSigner emits SignerUpdated(previous, new) and updates signer()", async function () {
    const { claimer, backendWallet, otherWallet, deployer } = await loadFixture(deployMiningFixture);

    await expect(claimer.connect(deployer).setSigner(otherWallet.address))
      .to.emit(claimer, "SignerUpdated")
      .withArgs(backendWallet.address, otherWallet.address);
    expect(await claimer.signer()).to.equal(otherWallet.address);

    // And it composes: rotating back is just another guarded update.
    await expect(claimer.connect(deployer).setSigner(backendWallet.address))
      .to.emit(claimer, "SignerUpdated")
      .withArgs(otherWallet.address, backendWallet.address);
    expect(await claimer.signer()).to.equal(backendWallet.address);
  });

  it("E4: rotation does NOT resurrect a consumed nonce or disturb settled balances", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet, otherWallet, deployer } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    await claimer.claimReward(
      alice.address,
      claim.reward,
      claim.staminaCost,
      claim.nonce,
      claim.deadline,
      signature
    );
    const settledBalance = await catt.balanceOf(alice.address);
    const settledSupply = await catt.totalSupply();
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(true);

    await claimer.connect(deployer).setSigner(otherWallet.address);

    // The burned nonce stays burned, and the balances are untouched.
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(true);
    expect(await catt.balanceOf(alice.address)).to.equal(settledBalance);
    expect(await catt.totalSupply()).to.equal(settledSupply);

    // Replaying the now-invalid old signature fails at the SIGNATURE gate, not
    // the nonce gate, because the old key is no longer trusted.
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimSignatureInvalid")
      .withArgs(otherWallet.address, backendWallet.address);

    // Re-signing the SAME (user, nonce) with the new key is still refused: a
    // used nonce is burned forever, with no admin override.
    const resigned = signClaimFor(otherWallet, claim, chainId, claimer.target).signature;
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, resigned)
    )
      .to.be.revertedWithCustomError(claimer, "ClaimAlreadyUsed")
      .withArgs(alice.address, 1n);

    expect(await catt.balanceOf(alice.address)).to.equal(settledBalance);
    expect(await catt.totalSupply()).to.equal(settledSupply);
  });
});

// ---------------------------------------------------------------------------
// F. Failure atomicity & invariants
// ---------------------------------------------------------------------------

describe("Wave 4 :: MiningClaimer :: F. Failure atomicity and economy invariants", function () {
  it("F1: INSUFFICIENT STAMINA reverts StaminaInsufficient, mints nothing and releases the nonce", async function () {
    const { catt, staking, claimer, carol, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // carol has 10,000 CATT but ZERO stamina: she never staked.
    expect(await staking.staminaOf(carol.address)).to.equal(0n);
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(carol, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const supplyBefore = await catt.totalSupply();
    const balanceBefore = await catt.balanceOf(carol.address);

    await expect(
      claimer.claimReward(carol.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(staking, "StaminaInsufficient")
      .withArgs(carol.address, STAMINA_PER_STAKE, 0n);

    expect(await catt.totalSupply()).to.equal(supplyBefore);
    expect(await catt.balanceOf(carol.address)).to.equal(balanceBefore);
    expect(await staking.staminaOf(carol.address)).to.equal(0n);
    // The nonce is NOT burned: no reward was paid for it.
    expect(await claimer.isNonceUsed(carol.address, 1n)).to.equal(false);
  });

  it("F2: a CAP-BREACHING reward reverts MintExceedsMaxSupply and consumes neither stamina nor nonce", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    await grantStamina(staking, alice);
    const supplyBefore = await catt.totalSupply();
    expect(supplyBefore).to.equal(GENESIS_SUPPLY);

    // One wei past the immutable 100,000,000 cap.
    const overCap = MAX_SUPPLY - supplyBefore + ONE;
    const deadline = BigInt(await time.latest()) + 3600n;
    const claim = claimFor(alice, overCap, STAMINA_PER_STAKE, 1n, deadline);
    const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);

    const balanceBefore = await catt.balanceOf(alice.address);

    // `consumeStamina` runs BEFORE `mint`, so this also proves the stamina debit
    // is unwound by the revert.
    await expect(
      claimer.claimReward(alice.address, claim.reward, claim.staminaCost, claim.nonce, claim.deadline, signature)
    )
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + ONE, MAX_SUPPLY);

    expect(await catt.totalSupply()).to.equal(supplyBefore);
    expect(await catt.totalSupply()).to.be.lessThan(MAX_SUPPLY);
    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore);
    expect(await staking.staminaOf(alice.address)).to.equal(STAMINA_PER_STAKE);
    expect(await claimer.isNonceUsed(alice.address, 1n)).to.equal(false);
  });

  it("F3: after each failure the SAME nonce can be used successfully — no reward lost, no nonce wasted", async function () {
    const { catt, staking, claimer, alice, carol, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // --- carol's stamina failure, then the same nonce settles for real.
    const deadline = BigInt(await time.latest()) + 3600n;
    const carolBig = claimFor(carol, CATT(25), STAMINA_PER_STAKE, 1n, deadline);
    const carolBigSig = signClaimFor(backendWallet, carolBig, chainId, claimer.target).signature;
    await expect(
      claimer.claimReward(carol.address, carolBig.reward, carolBig.staminaCost, 1n, carolBig.deadline, carolBigSig)
    )
      .to.be.revertedWithCustomError(staking, "StaminaInsufficient")
      .withArgs(carol.address, STAMINA_PER_STAKE, 0n);

    await grantStamina(staking, carol);
    const carolSmall = claimFor(carol, CATT(5), STAMINA_PER_STAKE, 1n, deadline);
    const carolSmallSig = signClaimFor(backendWallet, carolSmall, chainId, claimer.target).signature;
    await claimer.claimReward(
      carol.address,
      carolSmall.reward,
      carolSmall.staminaCost,
      1n,
      carolSmall.deadline,
      carolSmallSig
    );
    expect(await claimer.isNonceUsed(carol.address, 1n)).to.equal(true);
    expect(await catt.balanceOf(carol.address)).to.equal(CATT(9_000) + CATT(5));

    // --- alice's cap failure, then the SAME nonce settles for a valid amount.
    await grantStamina(staking, alice);
    const supplyNow = await catt.totalSupply();
    const overCap = MAX_SUPPLY - supplyNow + ONE;
    const aliceBig = claimFor(alice, overCap, STAMINA_PER_STAKE, 1n, deadline);
    const aliceBigSig = signClaimFor(backendWallet, aliceBig, chainId, claimer.target).signature;
    await expect(
      claimer.claimReward(alice.address, aliceBig.reward, aliceBig.staminaCost, 1n, aliceBig.deadline, aliceBigSig)
    )
      .to.be.revertedWithCustomError(catt, "MintExceedsMaxSupply")
      .withArgs(MAX_SUPPLY + ONE, MAX_SUPPLY);

    const aliceSmall = claimFor(alice, CATT(5), STAMINA_PER_STAKE, 1n, deadline);
    const aliceSmallSig = signClaimFor(backendWallet, aliceSmall, chainId, claimer.target).signature;
    await expect(
      claimer.claimReward(
        alice.address,
        aliceSmall.reward,
        aliceSmall.staminaCost,
        1n,
        aliceSmall.deadline,
        aliceSmallSig
      )
    )
      .to.emit(claimer, "RewardClaimed")
      .withArgs(alice.address, CATT(5), STAMINA_PER_STAKE, 1n, backendWallet.address);

    // Exactly the two small rewards were minted; both big ones minted nothing.
    expect(await catt.totalSupply()).to.equal(GENESIS_SUPPLY + CATT(5) + CATT(5));
    expect(await staking.staminaOf(carol.address)).to.equal(0n);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("F4: supply stays at or below MAX_SUPPLY at every step of a multi-claim sequence", async function () {
    const { catt, staking, claimer, alice, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // After the handover the ONLY way to grow supply is a signed reward, so the
    // cap can never be approached by a privileged direct mint.
    await grantStaminaLots(staking, alice, 4);
    expect(await staking.staminaOf(alice.address)).to.equal(4n * STAMINA_PER_STAKE);

    const rewards = [CATT(1), CATT(2), CATT(3), CATT(4)];
    const deadline = BigInt(await time.latest()) + 3600n;
    let cumulative = 0n;

    for (let i = 0; i < rewards.length; i += 1) {
      const nonce = BigInt(i + 1);
      const claim = claimFor(alice, rewards[i], STAMINA_PER_STAKE, nonce, deadline);
      const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);
      await claimer.claimReward(
        alice.address,
        claim.reward,
        claim.staminaCost,
        claim.nonce,
        claim.deadline,
        signature
      );
      cumulative += rewards[i];

      const supply = await catt.totalSupply();
      expect(supply).to.be.lessThan(await catt.MAX_SUPPLY());
      expect(supply).to.equal(GENESIS_SUPPLY + cumulative);
    }

    expect(cumulative).to.equal(CATT(10));
    expect(await catt.totalSupply()).to.equal(GENESIS_SUPPLY + CATT(10));
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
  });

  it("F5: the stamina ledger and the CATT supply stay exactly consistent across two users", async function () {
    const { catt, staking, claimer, alice, bob, chainId, backendWallet } =
      await loadFixture(deployMiningFixture);

    // alice buys 2 lots (100 stamina), bob buys 1 lot (50 stamina).
    await grantStaminaLots(staking, alice, 2);
    await grantStamina(staking, bob);
    expect(await staking.staminaOf(alice.address)).to.equal(2n * STAMINA_PER_STAKE);
    expect(await staking.staminaOf(bob.address)).to.equal(STAMINA_PER_STAKE);

    const plan = [
      { user: alice, reward: CATT(5), nonce: 1n },
      { user: bob, reward: CATT(7), nonce: 1n },
      { user: alice, reward: CATT(6), nonce: 2n },
    ];
    const deadline = BigInt(await time.latest()) + 3600n;
    const supplyBefore = await catt.totalSupply();
    const balanceBefore = {
      alice: await catt.balanceOf(alice.address),
      bob: await catt.balanceOf(bob.address),
    };

    let consumed = { alice: 0n, bob: 0n };
    let minted = 0n;
    let expectedBalance = { alice: balanceBefore.alice, bob: balanceBefore.bob };
    const keyOf = (u) => (u === alice ? "alice" : "bob");

    for (const step of plan) {
      const k = keyOf(step.user);
      const staminaBefore = await staking.staminaOf(step.user.address);
      // A claim can never consume more stamina than the user holds right now.
      expect(staminaBefore).to.be.greaterThanOrEqual(STAMINA_PER_STAKE);

      const claim = claimFor(step.user, step.reward, STAMINA_PER_STAKE, step.nonce, deadline);
      const { signature } = signClaimFor(backendWallet, claim, chainId, claimer.target);
      await claimer.claimReward(
        step.user.address,
        claim.reward,
        claim.staminaCost,
        claim.nonce,
        claim.deadline,
        signature
      );

      // Exactly the signed cost came out of the ledger, never more.
      const staminaAfter = await staking.staminaOf(step.user.address);
      expect(staminaBefore - staminaAfter).to.equal(STAMINA_PER_STAKE);
      consumed[k] += STAMINA_PER_STAKE;
      minted += step.reward;
      expectedBalance[k] += step.reward;
      expect(await catt.balanceOf(step.user.address)).to.equal(expectedBalance[k]);
    }

    // Granted == consumed, and nothing is left stranded in the ledger.
    expect(consumed.alice).to.equal(2n * STAMINA_PER_STAKE);
    expect(consumed.bob).to.equal(STAMINA_PER_STAKE);
    expect(await staking.staminaOf(alice.address)).to.equal(0n);
    expect(await staking.staminaOf(bob.address)).to.equal(0n);

    // Supply accounting: minted rewards == total supply delta.
    expect(minted).to.equal(CATT(18));
    expect(await catt.totalSupply()).to.equal(supplyBefore + minted);
    expect(await catt.balanceOf(alice.address)).to.equal(balanceBefore.alice + CATT(11));
    expect(await catt.balanceOf(bob.address)).to.equal(balanceBefore.bob + CATT(7));
  });
});
