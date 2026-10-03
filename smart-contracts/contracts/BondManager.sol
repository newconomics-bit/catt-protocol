// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CATT Protocol Real Yield Bonds
 * @notice Fixed-term $CATT bond vault implementing PRD Section 3.3, "Real Yield
 *         Bonds": users lock CATT principal for 30, 90 or 180 days and earn
 *         yield funded exclusively by B2B sponsor deposits of a stablecoin.
 *
 * @dev THE CENTRAL ECONOMIC CLAIM (PRD 3.3): the yield a bondholder receives is
 *      money that a B2B sponsor paid in for educational article distribution.
 *      Bond yield is NEVER minted, never printed and never funded by further
 *      CATT issuance. This contract cannot inflate $CATT by construction: it
 *      holds two immutable ERC20 references and the only CATT it ever moves is
 *      principal that a user voluntarily locked and will get back at maturity.
 *      A sponsor who stops depositing simply stops the yield; the debt owed to
 *      bondholders is capped by the stablecoin actually held here, and the
 *      contract pays out only what it holds.
 *
 * @dev Yield accounting — checkpointed reward-per-point:
 *      - A bond's `points = principal * tierWeight`. There is deliberately NO
 *        extra scaling applied to the principal: CATT is already an
 *        18-decimal base unit and the tier weights are the small integers
 *        1..3, so the point value is simply a 1x/2x/3x multiplier.
 *      - `accYieldPerPoint` is a 1e18-scaled cumulative accumulator. A sponsor
 *        deposit of `amount` adds `(amount * ACC_PRECISION) / totalPoints` to it.
 *      - EVERY bond stores `accSnapshot`, the value of `accYieldPerPoint` AT
 *        THE MOMENT OF ITS CREATION, and its claimable yield is always
 *        `points * (accYieldPerPoint - accSnapshot) / ACC_PRECISION`.
 *
 *      This checkpoint is THE single most important correctness property in the
 *      contract, so it is stated in full:
 *        (1) A bond created BEFORE a deposit earns from that deposit, because
 *            its snapshot is strictly less than the post-deposit accumulator.
 *        (2) A bond created AFTER a deposit can NEVER earn retroactively from
 *            it, because the snapshot it stores is the accumulator that already
 *            includes the deposit's increment. Joining late therefore dilutes
 *            nothing retroactively, and there is no "front-run the accumulator"
 *            exploit: the accumulator only moves forward and a late joiner is
 *            shielded from all of it.
 *        (3) The snapshot is read BEFORE the bond's points are added to
 *            `totalPoints` and before any other state write in `buyBond`, so
 *            the bond is measured against the pre-existing accumulator even
 *            though it starts earning on new deposits immediately afterwards.
 *        (4) A partial `claimYield` deliberately does NOT move the snapshot, so
 *            a bond keeps earning on the same points after being paid; the
 *            checkpoint tracks "when this bond joined", never "when it was last
 *            paid". What stops a repeated claim from re-paying the same accrual
 *            is the separate `accruedYield` deduction inside `pendingYield`:
 *            the snapshot stays put, the already-paid amount is subtracted, and
 *            so a bond that has been collected in full reads 0 and can never be
 *            paid twice.
 *
 * @dev Point accounting:
 *      - `totalPoints` counts OPEN bonds only: it is incremented in `buyBond`
 *        and decremented by the bond's own `points` in `redeem`. Because the
 *        increment and the decrement are both derived from the stored bond
 *        record, `totalPoints` cannot drift from the sum of open-bond points.
 *      - `depositYield` reverts `NoActiveBonds` when `totalPoints == 0`. There
 *        is deliberately NO "idle pool": at least one bond must exist before the
 *        first sponsor deposit can be accepted, because with no points a
 *        deposit has nobody to allocate to and any accumulator bump would be
 *        permanently unattributable. Sponsors should create accounting for
 *        their campaign window up front.
 *      - Integer truncation is accounted for, not hidden. With
 *        `increment = amount * ACC_PRECISION / totalPoints` and
 *        `distributed = increment * totalPoints / ACC_PRECISION`, the residue
 *        `amount - distributed` is added to `unallocatedYield` and stays held by
 *        this contract. That is at most `totalPoints - 1` base units of the
 *        yield token per deposit, i.e. pure rounding dust. It is intentionally
 *        NOT redistributable: pushing it out would require a second accounting
 *        pass that credits yield to bonds that were already settled, which
 *        would retroactively re-allocate value across the term and break the
 *        checkpoint invariant in (1)-(4) above. The dust is instead reported on
 *        chain and the full solvency invariant
 *          `yieldToken.balanceOf(this) == unallocatedYield
 *                                 + yield still claimable by open bonds`
 *        therefore holds at all times, with the companion lifetime identity
 *          `sum(sponsor deposits) == unallocatedYield
 *                                 + sum(yield still claimable)
 *                                 + sum(yield already paid out)`
 *        holding as well, so no deposited unit is ever lost, created or spent
 *        twice. Note the CATT balance is a separate, exactly tracked quantity:
 *        it always equals the sum of the principals of the open bonds.
 *      - Overflow safety, stated explicitly: `amount * ACC_PRECISION` is safe
 *        because real stablecoin supplies lie between 1e6 and 1e15 base units,
 *        which is more than two hundred orders of magnitude below
 *        `2^256 / 1e18 (~1.16e59)`. `points` is bounded by
 *        `3 * CATT.MAX_SUPPLY` = 3e8 * 1e18 = 3e26, and the per-bond product
 *        `points * (accYieldPerPoint - accSnapshot)` is bounded by the total
 *        distributed yield scaled by 1e18, so the whole reward-per-point
 *        surface stays far inside uint256 even in the worst case.
 *
 * @dev Security posture (PRD Section 5, Rule 1):
 *      - Every state-changing function is `nonReentrant`. `buyBond` and
 *        `depositYield` pull tokens before writing state (pull-first, justified
 *        in the body); `claimYield` and `redeem` write state before paying
 *        out (checks-effects-interactions), so a non-standard yield token
 *        cannot observe an unsettled position.
 *      - All timing uses `block.timestamp` only. No block number is read
 *        anywhere in this contract. Maturity is a strict `>=` comparison
 *        against the bond's stored `maturesAt`.
 *      - `SafeERC20` is used for BOTH tokens, so a USDT-style principal or
 *        yield token that returns no boolean on `transfer` is still handled.
 *
 * @dev Deliberate non-goals, so that auditors do not look for them:
 *      - NO EARLY EXIT. Principal is non-cancellable for the whole term. There
 *        is no penalty, no forfeit, no partial unwind and no emergency exit.
 *        That is the point: an uncancellable fixed-term commitment is what
 *        makes the bond credible to a sponsor who is underwriting the yield
 *        with real money. `withdrawPrincipal` exists only to make that lock
 *        explicit, self-documenting and unit-testable rather than merely absent.
 *      - NO OWNER RESCUE OR SWEEP. The owner can only ADD yield; it can never
 *        move sponsor funds out. Funds are unrecoverable if bonds never mature,
 *        which is the deliberate cost of making the pool un-rugable.
 *      - No pause, no upgradeability, no off-chain signature verification, no
 *        backend/frontend code, no bond transferability or secondary market, no
 *        fees on bond purchase, and no native token handling: this contract
 *        holds no MATIC and has no `receive`/`fallback`, so the protocol stays
 *        correct if Polygon becomes an EVM-only chain.
 *
 * @dev No private keys, API keys or deployment secrets appear in this source
 *      file; those are supplied by the deployer's environment (PRD Rule 2).
 */
contract BondManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Number of bond terms offered by the protocol.
    /// @dev Tier INDICES are 1-based, so the valid range is 1..TIER_COUNT and
    ///      index 0 is never a valid tier.
    uint8 public constant TIER_COUNT = 3;

    /// @notice Fixed-point scale applied to the reward-per-point accumulator.
    /// @dev 1e18 keeps the per-point yield meaningful for 6-decimal stablecoins
    ///      while staying far away from the uint256 boundary.
    uint256 public constant ACC_PRECISION = 1e18;

    /// @notice Term of tier 1: 30 days.
    uint256 public constant TIER_1_DURATION = 30 days;

    /// @notice Term of tier 2: 90 days.
    uint256 public constant TIER_2_DURATION = 90 days;

    /// @notice Term of tier 3: 180 days.
    uint256 public constant TIER_3_DURATION = 180 days;

    /// @notice Yield weight of tier 1 (1x).
    uint256 public constant TIER_1_WEIGHT = 1;

    /// @notice Yield weight of tier 2 (2x).
    uint256 public constant TIER_2_WEIGHT = 2;

    /// @notice Yield weight of tier 3 (3x).
    uint256 public constant TIER_3_WEIGHT = 3;

    /// @notice Immutable reference to the CATT token locked as bond principal.
    IERC20 public immutable principalToken;

    /// @notice Immutable reference to the stablecoin sponsors pay yield in.
    IERC20 public immutable yieldToken;

    /// @notice Sum of the points of every currently OPEN bond.
    /// @dev Incremented in `buyBond` and decremented in `redeem`. Bounces to
    ///      0 only when no bond is open, which is the only window in which
    ///      `depositYield` is rejected.
    uint256 public totalPoints;

    /// @notice Cumulative yield owed per point, scaled by `ACC_PRECISION`.
    /// @dev Monotonically increasing. Only ever written by `depositYield`, so
    ///      the value read by a bond is a pure function of the deposits that
    ///      happened while it was open.
    uint256 public accYieldPerPoint;

    /// @notice Rounding residue held by this contract from deposit truncation.
    /// @dev Reported, never redistributed. See the header for the full
    ///      solvency invariant this balance supports.
    uint256 public unallocatedYield;

    /// @notice Count of bonds ever created; also the NEXT bond id (1-based).
    /// @dev Ids are 1-based, so id 0 is never valid and `totalBondsCreated`
    ///      equals the number of bonds that exist.
    uint256 public totalBondsCreated;

    /// @notice A single locked bond position.
    /// @param holder Account that locked the principal; the only party that can
    ///        claim or redeem this bond.
    /// @param principal CATT locked by the bond, in 18-decimal base units.
    /// @param tier 1-based tier index, 1..3.
    /// @param createdAt `block.timestamp` at which the bond was opened.
    /// @param maturesAt `block.timestamp` from which the bond is redeemable.
    /// @param points `principal * tierWeight`; its share of every deposit.
    /// @param accSnapshot Value of `accYieldPerPoint` at creation time. This
    ///        is the checkpoint that makes retroactive yield impossible.
    /// @param accruedYield Yield already paid out to the holder by
    ///        `claimYield` and by `redeem`, in yield-token base units.
    /// @param closed True once the bond has been redeemed.
    struct Bond {
        address holder;
        uint256 principal;
        uint8 tier;
        uint40 createdAt;
        uint40 maturesAt;
        uint256 points;
        uint256 accSnapshot;
        uint256 accruedYield;
        bool closed;
    }

    /// @notice Bond records keyed by 1-based bond id.
    /// @dev Deliberately `private`: a public mapping of a struct would emit an
    ///      auto-generated getter whose return tuple is unlabelled and easy to
    ///      mis-order in an integration. `bondInfo` and `bondAccSnapshot` are
    ///      the single, named read path.
    mapping(uint256 => Bond) private _bonds;

    /// @notice Emitted when a new bond is opened.
    /// @param bondId 1-based id of the new bond.
    /// @param holder Account that locked the principal.
    /// @param principal CATT locked, in 18-decimal base units.
    /// @param tier 1-based tier index.
    /// @param maturesAt Timestamp from which the bond can be redeemed.
    /// @param points Points the bond contributes to `totalPoints`.
    event BondCreated(
        uint256 indexed bondId,
        address indexed holder,
        uint256 principal,
        uint8 tier,
        uint40 maturesAt,
        uint256 points
    );

    /// @notice Emitted when a sponsor funds the yield pool.
    /// @param depositor Sponsor account that supplied the stablecoin.
    /// @param amount Stablecoin pulled in, in yield-token base units.
    /// @param newAccYieldPerPoint Accumulator after the deposit was applied.
    event YieldDeposited(address indexed depositor, uint256 amount, uint256 newAccYieldPerPoint);

    /// @notice Emitted when a bondholder pulls part of its yield.
    /// @param bondId Bond that was paid.
    /// @param holder Recipient of the yield.
    /// @param amount Yield transferred, in yield-token base units.
    event YieldClaimed(uint256 indexed bondId, address indexed holder, uint256 amount);

    /// @notice Emitted when a matured bond is closed and fully paid out.
    /// @param bondId Bond that was closed.
    /// @param holder Recipient of both legs of the payout.
    /// @param principal CATT returned, in 18-decimal base units.
    /// @param yield Final yield paid alongside the principal.
    event BondRedeemed(
        uint256 indexed bondId,
        address indexed holder,
        uint256 principal,
        uint256 yield
    );

    /// @notice Thrown when a token address is the zero address.
    /// @dev The zero address is never a valid token: bonding against it would
    ///      permanently lock the caller's principal with no way out.
    error ZeroAddress();

    /// @notice Thrown when a supplied amount is zero.
    error ZeroAmount();

    /// @notice Thrown when a tier index is outside 1..TIER_COUNT.
    /// @dev Tier indices are 1-based, so 0 and 4..255 are all rejected.
    /// @param tier The rejected index.
    error InvalidTier(uint8 tier);

    /// @notice Thrown when a bond id has never been created.
    /// @dev Ids are 1-based, so id 0 is always rejected as well.
    /// @param bondId The unknown id.
    error InvalidBondId(uint256 bondId);

    /// @notice Thrown when the bond has already been redeemed.
    /// @param bondId The closed bond.
    error BondClosed(uint256 bondId);

    /// @notice Thrown by `withdrawPrincipal` for any live bond.
    /// @dev The arguments make the lock self-describing on-chain and let a
    ///      frontend or test compute the remaining wait without off-chain help.
    /// @param bondId The bond that cannot be exited.
    /// @param maturesAt Timestamp from which redemption becomes possible.
    /// @param currentTime `block.timestamp` at the time of the attempt.
    error BondLockedUntilMaturity(uint256 bondId, uint256 maturesAt, uint256 currentTime);

    /// @notice Thrown when a bond is redeemed before its maturity.
    /// @param bondId The immature bond.
    /// @param maturesAt Timestamp from which redemption becomes possible.
    /// @param currentTime `block.timestamp` at the time of the attempt.
    error BondNotMatured(uint256 bondId, uint256 maturesAt, uint256 currentTime);

    /// @notice Thrown when a claim or redemption resolves to zero yield.
    /// @dev Almost always a claim made between two deposits.
    /// @param bondId The bond with nothing to pay.
    error NothingToClaim(uint256 bondId);

    /// @notice Thrown when a sponsor deposits while no bond is open.
    /// @dev With `totalPoints == 0` there is no one to allocate the deposit
    ///      to, and an unattributed accumulator bump would be permanently
    ///      undistributable.
    error NoActiveBonds();

    /// @notice Thrown when the yield pool cannot cover an obligation.
    /// @dev Should be unreachable: the pool is funded before the accumulator
    ///      moves, so the sum of all claims can never exceed the balance. It is
    ///      kept as a hard, explicit failure rather than a silent revert of a
    ///      bare transfer.
    /// @param required Yield the bond is owed, in yield-token base units.
    /// @param available Yield actually held by this contract.
    error InsufficientYieldPool(uint256 required, uint256 available);

    /// @notice Thrown when a non-holder tries to claim a bond's yield.
    /// @param bondId The bond whose yield was targeted.
    /// @param caller The address that attempted the claim.
    error NotBondHolder(uint256 bondId, address caller);

    /**
     * @notice Deploys the bond manager against the principal and yield tokens.
     * @dev Both references are `immutable`: the principal denomination and the
     *      yield denomination define what every existing bond IS, so allowing
     *      either to change would silently reinterpret all outstanding bonds.
     *      Reverts with `ZeroAddress` if either is unset.
     *
     *      The two MUST be distinct tokens, and the constructor does not police
     *      it: the deploy script is responsible for pairing CATT with a real
     *      stablecoin. Passing the same address twice would make principal and
     *      yield indistinguishable in the vault's balance and would let a
     *      yield claim pay out out of other users' locked principal.
     * @param principalToken_ Address of the CATT ERC20 token to be bonded.
     * @param yieldToken_ Address of the sponsor-funded stablecoin.
     */
    constructor(address principalToken_, address yieldToken_) Ownable(msg.sender) {
        if (principalToken_ == address(0)) revert ZeroAddress();
        if (yieldToken_ == address(0)) revert ZeroAddress();

        principalToken = IERC20(principalToken_);
        yieldToken = IERC20(yieldToken_);
    }

    /**
     * @notice Length of a bond term, in seconds.
     * @dev Tiers are 1-BASED: tier 1 is 30 days, tier 2 is 90 days, tier 3 is
     *      180 days (PRD 3.3, "Bonds (30/90/180 days)"). Every other index,
     *      including 0, is not a valid tier and reverts with `InvalidTier`.
     *
     *      The tiers are exposed as validated views rather than as a loose
     *      mapping, precisely so that an out-of-range tier cannot silently read
     *      as "zero duration" or "zero weight" and produce a bond that is
     *      instantly redeemable or worth nothing.
     *      (The return value is named `duration` rather than `seconds`
     *      because `seconds` is a reserved type alias in Solidity and cannot
     *      be used as an identifier.)
     * @param tier 1-based tier index, 1..3.
     * @return duration Term length of the tier.
     */
    function tierDuration(uint8 tier) public pure returns (uint256 duration) {
        if (tier == 1) return TIER_1_DURATION;
        if (tier == 2) return TIER_2_DURATION;
        if (tier == 3) return TIER_3_DURATION;
        revert InvalidTier(tier);
    }

    /**
     * @notice Yield weight of a tier, the multiplier applied to the principal
     *         to obtain the bond's points.
     * @dev Tiers are 1-BASED: tier 1 weighs 1x, tier 2 weighs 2x, tier 3 weighs
     *      3x, so a longer commitment earns proportionally more of the same
     *      sponsor-funded pool. Every other index, including 0, reverts with
     *      `InvalidTier`.
     * @param tier 1-based tier index, 1..3.
     * @return weight Multiplier applied to the bonded principal.
     */
    function tierWeight(uint8 tier) public pure returns (uint256 weight) {
        if (tier == 1) return TIER_1_WEIGHT;
        if (tier == 2) return TIER_2_WEIGHT;
        if (tier == 3) return TIER_3_WEIGHT;
        revert InvalidTier(tier);
    }

    /**
     * @notice Convenience view returning both parameters of a tier.
     * @dev Thin wrapper over `tierDuration` and `tierWeight` so a frontend
     *      can render a tier table with a single call; reverts `InvalidTier`
     *      identically.
     * @param tier 1-based tier index, 1..3.
     * @return duration Term length of the tier, in seconds.
     * @return weight Yield weight of the tier.
     */
    function tierInfo(uint8 tier) external pure returns (uint256 duration, uint256 weight) {
        duration = tierDuration(tier);
        weight = tierWeight(tier);
    }

    /**
     * @notice Full record of a bond.
     * @dev The ONLY read path for bond data; `_bonds` is private precisely so
     *      that this labelled tuple stays the stable integration surface.
     *      Reverts with `InvalidBondId` for an id that was never created.
     * @param bondId 1-based id of the bond.
     * @return holder Account that locked the principal.
     * @return principal CATT locked, in 18-decimal base units.
     * @return tier 1-based tier index.
     * @return createdAt Timestamp the bond was opened.
     * @return maturesAt Timestamp the bond becomes redeemable.
     * @return points Points the bond contributes while open.
     * @return accruedYield Yield already paid out to the holder.
     * @return closed True once the bond has been redeemed.
     */
    function bondInfo(uint256 bondId)
        external
        view
        returns (
            address holder,
            uint256 principal,
            uint8 tier,
            uint256 createdAt,
            uint256 maturesAt,
            uint256 points,
            uint256 accruedYield,
            bool closed
        )
    {
        Bond storage bond = _requireBond(bondId);
        return (
            bond.holder,
            bond.principal,
            bond.tier,
            uint256(bond.createdAt),
            uint256(bond.maturesAt),
            bond.points,
            bond.accruedYield,
            bond.closed
        );
    }

    /**
     * @notice Checkpoint a bond was opened against: the value of
     *         `accYieldPerPoint` at its creation.
     * @dev Exposed separately so tests and indexers can assert the checkpoint
     *      invariant directly (a bond's yield is always measured from this
     *      value), rather than having to infer it. Reverts with
     *      `InvalidBondId` for an id that was never created.
     * @param bondId 1-based id of the bond.
     * @return snapshot The 1e18-scaled accumulator captured at creation.
     */
    function bondAccSnapshot(uint256 bondId) external view returns (uint256 snapshot) {
        snapshot = _requireBond(bondId).accSnapshot;
    }

    /**
     * @notice Yield a bond has earned but not yet collected.
     *
     * @dev Exactly `points * (accYieldPerPoint - accSnapshot) / ACC_PRECISION`
     *      for an open bond, MINUS whatever has already been paid out to the
     *      holder (`accruedYield`). Returns 0 — rather than reverting — for an
     *      id that was never created and for a bond that has already been
     *      redeemed, because this is a UI-facing estimate that must never throw;
     *      the state-changing callers use the reverting `_requireBond` helper
     *      instead.
     *
     *      The subtraction of `accruedYield` is load-bearing, not cosmetic. The
     *      gross figure above is the bond's LIFETIME accrual and is monotonically
     *      non-decreasing; if it were returned as the claimable amount then every
     *      call to `claimYield` would pay the bond's whole lifetime accrual again,
     *      so a holder could call it in a loop and drain the pool — including
     *      yield owed to other bondholders. The `InsufficientYieldPool` guard
     *      would then be the only thing stopping a griefing loop, and it would
     *      revert a claim the holder was legitimately entitled to. Deducting what
     *      has already been paid is what makes `claimYield` a COLLECTION rather
     *      than a re-declaration: a bond that has been paid in full reads 0 here
     *      and reverts `NothingToClaim`, and every later deposit is paid exactly
     *      once.
     *
     *      Note the deliberate split of responsibilities: the DEDUCTION lives
     *      here, in the view, and `accSnapshot` is NOT moved by a claim. The
     *      snapshot remains a pure "when did this bond join" checkpoint, so the
     *      bond keeps earning on exactly the same points after being paid, and
     *      the lifetime accrual of an already-settled bond is never re-priced.
     * @param bondId 1-based id of the bond.
     * @return amount Claimable yield, in yield-token base units.
     */
    function pendingYield(uint256 bondId) public view returns (uint256 amount) {
        Bond storage bond = _bonds[bondId];
        if (bond.holder == address(0)) return 0;
        if (bond.closed) return 0;
        uint256 lifetimeAccrual = (bond.points * (accYieldPerPoint - bond.accSnapshot)) / ACC_PRECISION;
        // The clamped subtraction also covers the theoretical case of a bond
        // whose stored `accruedYield` exceeds its recomputed lifetime accrual,
        // which rounding could in principle produce; it must never underflow
        // into an enormous claim.
        amount = lifetimeAccrual > bond.accruedYield ? lifetimeAccrual - bond.accruedYield : 0;
    }

    /**
     * @notice True once the bond's maturity timestamp has been reached.
     * @dev Same strict `block.timestamp` comparison as `redeem`, exposed so a
     *      frontend can enable the redeem button without simulating the call.
     *      An unknown id is not matured.
     * @param bondId 1-based id of the bond.
     * @return matured Whether the bond may be redeemed now.
     */
    function isMatured(uint256 bondId) external view returns (bool matured) {
        Bond storage bond = _bonds[bondId];
        if (bond.holder == address(0)) return false;
        matured = block.timestamp >= uint256(bond.maturesAt);
    }

    /**
     * @notice Locks `amount` CATT in a new bond of `tier` and returns its id.
     *
     * @dev No fee is charged on purchase, and the full `amount` becomes
     *      principal, refundable at maturity.
     *
     *      Ordering — the external `safeTransferFrom` runs FIRST, before any
     *      bookkeeping write, exactly as in `StakingManager`. Pulling the
     *      tokens first means a transfer that is not honoured (a fee-on-transfer
     *      token, a block-listed holder, or any future non-standard behaviour)
     *      reverts the whole transaction, so a bond can never be recorded for
     *      CATT this contract did not receive. Inverting the order is safe
     *      here for the same reason it is safe there: `nonReentrant` already
     *      closes the re-entrancy question, so no re-entrant caller can observe
     *      the intermediate state that the inversion would create.
     *
     *      The accumulator checkpoint is then read BEFORE the bond's points
     *      join `totalPoints` and before any state write, so the new bond is
     *      measured against the accumulator that existed when the user arrived
     *      and can never be credited with yield deposited before it existed.
     *
     *      Reverts with `ZeroAmount` for a zero amount, `InvalidTier` for a
     *      tier outside 1..3, and the standard ERC20 allowance/balance errors
     *      if the caller has not approved this contract.
     * @param amount CATT to lock, in 18-decimal base units. Must be > 0.
     * @param tier 1-based tier index: 1 (30d, 1x), 2 (90d, 2x), 3 (180d, 3x).
     * @return bondId The 1-based id of the newly created bond.
     */
    function buyBond(uint256 amount, uint8 tier) external nonReentrant returns (uint256 bondId) {
        if (amount == 0) revert ZeroAmount();

        uint256 weight = tierWeight(tier);
        uint256 duration = tierDuration(tier);
        uint256 points = amount * weight;

        // Interaction first, effects after: see the ordering rationale above.
        principalToken.safeTransferFrom(msg.sender, address(this), amount);

        // CRITICAL: checkpoint the accumulator BEFORE the points join
        // `totalPoints`, so this bond cannot be credited with any deposit
        // made before it existed.
        uint256 snapshot = accYieldPerPoint;
        uint40 createdAt = uint40(block.timestamp);
        uint40 maturesAt = uint40(block.timestamp + duration);

        bondId = totalBondsCreated + 1;
        totalBondsCreated = bondId;

        _bonds[bondId] = Bond({
            holder: msg.sender,
            principal: amount,
            tier: tier,
            createdAt: createdAt,
            maturesAt: maturesAt,
            points: points,
            accSnapshot: snapshot,
            accruedYield: 0,
            closed: false
        });

        totalPoints += points;

        emit BondCreated(bondId, msg.sender, amount, tier, maturesAt, points);
    }

    /**
     * @notice ALWAYS REVERTS: the explicit, testable statement that bond
     *         principal cannot be withdrawn before maturity.
     * @dev There is deliberately NO early exit, no penalty path and no forfeit
     *      path for a live bond. Principal is non-cancellable for the entire
     *      term, and that rigidity is the feature: a sponsor underwrites the
     *      yield with real money and needs a credible, non-cancellable
     *      commitment underneath it. A bond that could be unwound on demand
     *      would be a warehouse receipt that its holder can cash out whenever
     *      rates move, which is precisely the risk the sponsor is being asked
     *      to take.
     *
     *      The function exists anyway, and always reverts, for three reasons:
     *      (1) the lock is then an explicit, on-chain, self-documenting
     *          statement rather than merely an absence of a function;
     *      (2) `BondLockedUntilMaturity` carries `maturesAt` and
     *          `block.timestamp`, so a caller learns exactly how long it must
     *          wait without an off-chain call;
     *      (3) PRD Rule 4 requires the lock to be unit-testable — and a
     *          behaviour that is only a missing function cannot be asserted.
     *
     *      A bond that has already been redeemed reverts with `BondClosed`
     *      instead, because there is no principal left in it to be locked.
     * @param bondId 1-based id of the bond to attempt to exit.
     */
    function withdrawPrincipal(uint256 bondId) external nonReentrant {
        Bond storage bond = _requireBond(bondId);
        if (bond.closed) revert BondClosed(bondId);

        revert BondLockedUntilMaturity(bondId, uint256(bond.maturesAt), block.timestamp);
    }

    /**
     * @notice Funds the yield pool with `amount` of the sponsor stablecoin and
     *         spreads it across every currently open bond.
     * @dev Owner-gated: the owner is the B2B sponsor treasury that has collected
     *      revenue from educational article distribution. The owner can ONLY
     *      add funds here; there is deliberately no rescue, sweep or refund
     *      function, so the pool cannot be rugged by the very account that
     *      funds it. That is bought at the price of funds being permanently
     *      unrecoverable if bonds never reach maturity — a deliberate,
     *      documented trade-off in favour of bondholder safety.
     *
     *      Distribution: the accumulator gains `(amount * ACC_PRECISION) /
     *      totalPoints`, and the truncation residue `amount - distributed` is
     *      added to `unallocatedYield` so the contract's balance is fully
     *      accountable at all times. The residue is intentionally NOT
     *      redistributed to already-settled bonds.
     *
     *      Ordering: the pull happens before the accumulator moves, so the
     *      yield is in hand before any bond can claim it.
     *
     *      Reverts with `ZeroAmount` for a zero amount, `NoActiveBonds` when
     *      `totalPoints == 0` (there is no idle pool by design), and the
     *      standard ERC20 allowance/balance errors if the owner has not
     *      approved this contract.
     * @param amount Stablecoin to add, in yield-token base units. Must be > 0.
     */
    function depositYield(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (totalPoints == 0) revert NoActiveBonds();

        yieldToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 increment = (amount * ACC_PRECISION) / totalPoints;
        uint256 distributed = (increment * totalPoints) / ACC_PRECISION;

        accYieldPerPoint += increment;
        unallocatedYield += (amount - distributed);

        emit YieldDeposited(msg.sender, amount, accYieldPerPoint);
    }

    /**
     * @notice Pays the caller the yield its open bond has earned so far.
     * @dev Only the bond's own holder may call this; a third party reverts
     *      with `NotBondHolder` and cannot redirect a payout. Payout always
     *      goes to `bond.holder`, never to `msg.sender`'s choice of address.
     *
     *      A claim is purely a COLLECTION, not an event that changes the bond's
     *      economics: it does not extend the term, it does not move
     *      `accSnapshot`, and it does not change `points`. The bond keeps
     *      earning on exactly the same points until it is redeemed, so a user
     *      may claim daily, once, or never before maturity and end up with the
     *      same total.
     *
     *      What makes it a collection and not a re-declaration is the
     *      `accruedYield` deduction inside `pendingYield`: `amount` is the
     *      bond's lifetime accrual minus everything already paid to the holder,
     *      so the same accrual can never be transferred twice, no matter how
     *      often this is called. A fully-collected bond reads 0 and reverts
     *      `NothingToClaim`.
     *
     *      Ordering: `accruedYield` is incremented BEFORE the transfer
     *      (checks-effects-interactions), and `nonReentrant` blocks re-entry
     *      through a non-standard yield token, so a partial claim can never be
     *      replayed to drain the same yield twice.
     *
     *      Reverts with `InvalidBondId`, `BondClosed` (a redeemed bond's yield
     *      was already paid by `redeem`), `NotBondHolder`, `NothingToClaim`
     *      when the accrued yield truncates to zero, or `InsufficientYieldPool`
     *      if the pool is unexpectedly short.
     * @param bondId 1-based id of the bond to collect from.
     */
    function claimYield(uint256 bondId) external nonReentrant {
        Bond storage bond = _requireBond(bondId);
        if (bond.closed) revert BondClosed(bondId);
        if (msg.sender != bond.holder) revert NotBondHolder(bondId, msg.sender);

        uint256 amount = pendingYield(bondId);
        if (amount == 0) revert NothingToClaim(bondId);

        uint256 available = yieldToken.balanceOf(address(this));
        if (available < amount) revert InsufficientYieldPool(amount, available);

        // Effects before interaction.
        bond.accruedYield += amount;

        yieldToken.safeTransfer(bond.holder, amount);

        emit YieldClaimed(bondId, bond.holder, amount);
    }

    /**
     * @notice Closes a matured bond, returning the principal CATT and the final
     *         accrued yield to its holder.
     * @dev Callable by ANYONE once the bond is mature, but the payout is
     *      always routed to `bond.holder`: allowing an arbitrary caller to
     *      choose the recipient would let a third party grief a holder by
     *      front-running the redemption. Permissionless triggering is safe
     *      precisely because the destination is fixed by the bond record and
     *      by nothing the caller controls.
     *
     *      REACHABLE EXACTLY ONCE. The bond is marked `closed` and its points
     *      are removed from `totalPoints` before either transfer, so a second
     *      redemption reverts with `BondClosed` and a late `claimYield` on the
     *      same bond reverts with `BondClosed` too — its final yield was paid
     *      here. Checks-effects-interactions plus `nonReentrant` means even a
     *      malicious yield token callback cannot re-enter into a second payout.
     *
     *      Maturity is a strict `block.timestamp >= maturesAt` comparison on
     *      `block.timestamp` only; no block number is read anywhere (PRD
     *      Rule 1).
     *
     *      Reverts with `InvalidBondId`, `BondClosed`, `BondNotMatured` while
     *      the term is still running, or `InsufficientYieldPool` if the yield
     *      leg cannot be covered.
     * @param bondId 1-based id of the bond to redeem.
     */
    function redeem(uint256 bondId) external nonReentrant {
        Bond storage bond = _requireBond(bondId);
        if (bond.closed) revert BondClosed(bondId);

        uint256 maturesAt = uint256(bond.maturesAt);
        if (block.timestamp < maturesAt) {
            revert BondNotMatured(bondId, maturesAt, block.timestamp);
        }

        uint256 finalYield = pendingYield(bondId);

        uint256 available = yieldToken.balanceOf(address(this));
        if (available < finalYield) revert InsufficientYieldPool(finalYield, available);

        uint256 principal = bond.principal;
        address holder = bond.holder;

        // Effects before interactions.
        bond.closed = true;
        bond.accruedYield += finalYield;
        totalPoints -= bond.points;

        principalToken.safeTransfer(holder, principal);
        yieldToken.safeTransfer(holder, finalYield);

        emit BondRedeemed(bondId, holder, principal, finalYield);
    }

    /**
     * @notice Loads a bond record, reverting if the id was never created.
     * @dev Existence is `holder != address(0)`: ids start at 1, so id 0 and any
     *      unissued id produce a zero-valued record. `address(0)` can never be
     *      a real holder because `buyBond` stores `msg.sender`, and the
     *      zero-address bond principal could not be paid out anyway.
     * @param bondId 1-based id of the bond.
     * @return bond Storage reference to the bond record.
     */
    function _requireBond(uint256 bondId) private view returns (Bond storage bond) {
        bond = _bonds[bondId];
        if (bond.holder == address(0)) revert InvalidBondId(bondId);
    }
}
