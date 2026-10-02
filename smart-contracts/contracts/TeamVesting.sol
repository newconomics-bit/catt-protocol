// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CATT Protocol Team & Treasury Vesting
 * @notice Custody and linear release schedule for the two locked allocations of
 *         the CATT Protocol supply described in the PRD: Team (15%) and
 *         Treasury (20%). The contract holds CATT tokens and streams them to two
 *         named beneficiaries over a 1-year cliff followed by 3 years of linear
 *         vesting (4 years total from deployment).
 *
 * @dev Design notes:
 *      - Exactly two beneficiaries are registered, in the constructor. There is
 *        no registry, no array and no way to add or remove beneficiaries, which
 *        makes the allocation set fully known at deployment time.
 *      - CATT is an ERC20 token, so this contract needs no `receive()` /
 *        `fallback()`. The deployer funds the contract by transferring CATT
 *        into it with `IERC20(cattToken).transfer(address(vesting), amount)`
 *        (or `safeTransfer`) after deployment.
 *      - All release decisions are computed from `block.timestamp` on-chain.
 *        There is no pause, no admin clawback and no off-chain signature path,
 *        so the contract cannot be used to confiscate vested tokens.
 *      - No private keys, API keys or deployment secrets appear in this source
 *        file; those are supplied by the deployer's environment (PRD Rule 2).
 */
contract TeamVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One-year cliff: nothing is releasable before it elapses.
    uint256 public constant CLIFF_DURATION = 365 days;

    /// @notice Total vesting schedule length measured from `startTime`
    ///         (1-year cliff + 3 years of linear vesting).
    uint256 public constant VESTING_DURATION = 4 * 365 days;

    /// @notice Immutable reference to the CATT token held and released here.
    IERC20 public immutable cattToken;

    /// @notice Per-beneficiary vesting schedule and release bookkeeping.
    /// @param total Total CATT allocated to the beneficiary, in 18-decimal units.
    /// @param released Amount already transferred out to the beneficiary.
    /// @param startTime Timestamp at which the schedule began.
    /// @param cliffDuration Seconds of cliff after `startTime`.
    /// @param duration Seconds from `startTime` until the schedule is fully vested.
    struct Allocation {
        uint256 total;
        uint256 released;
        uint256 startTime;
        uint256 cliffDuration;
        uint256 duration;
    }

    /// @notice Vesting allocations keyed by beneficiary address.
    /// @dev A beneficiary absent from this mapping has a zero-valued
    ///      `Allocation`, which all views treat as "nothing allocated".
    mapping(address => Allocation) public allocations;

    /// @notice Thrown when the constructor or a future setter receives a zero address.
    error ZeroAddress();

    /// @notice Thrown when an allocation amount is zero.
    error ZeroAmount();

    /// @notice Thrown when both beneficiaries would be the same address.
    error DuplicateBeneficiary();

    /// @notice Thrown when the vesting schedule would be degenerate, i.e. when
    ///         there is no time window in which tokens vest linearly.
    error InvalidVestingSchedule();

    /// @notice Thrown when `claim()` is called by a beneficiary with nothing releasable.
    error NothingToClaim();

    /// @notice Thrown when the contract's CATT balance is lower than the
    ///         amount it is about to release (i.e. it was under-funded).
    error InsufficientVestedBalance();

    /**
     * @notice Deploys the vesting contract and registers both allocations.
     *
     * @dev Intended deployment values for the amounts (passed in by the
     *      deployer rather than hardcoded, so the contract stays agnostic of
     *      the token's supply configuration):
     *        - `teamAmount`      = 15_000_000 * 10 ** 18  (15% of the 100,000,000 CATT max supply)
     *        - `treasuryAmount`  = 20_000_000 * 10 ** 18  (20% of the 100,000,000 CATT max supply)
     *      After deployment the deployer must transfer exactly this much CATT
     *      into this contract; until then `claim()` reverts with
     *      `InsufficientVestedBalance`.
     *
     *      Both allocations start at `block.timestamp` with a 365-day cliff and
     *      a 4-year total schedule, so nothing is releasable during year 1 and
     *      the allocation streams linearly over the following 3 years, reaching
     *      100% exactly 4 years after deployment.
     *
     * @param cattToken_ Address of the CATT ERC20 token being vested.
     * @param teamBeneficiary Address entitled to the team allocation.
     * @param treasuryBeneficiary Address entitled to the treasury allocation.
     * @param teamAmount Team allocation, in 18-decimal base units. Must be > 0.
     * @param treasuryAmount Treasury allocation, in 18-decimal base units. Must be > 0.
     */
    constructor(
        address cattToken_,
        address teamBeneficiary,
        address treasuryBeneficiary,
        uint256 teamAmount,
        uint256 treasuryAmount
    ) Ownable(msg.sender) {
        if (cattToken_ == address(0)) revert ZeroAddress();
        if (teamBeneficiary == address(0)) revert ZeroAddress();
        if (treasuryBeneficiary == address(0)) revert ZeroAddress();
        if (teamAmount == 0 || treasuryAmount == 0) revert ZeroAmount();
        if (teamBeneficiary == treasuryBeneficiary) revert DuplicateBeneficiary();
        if (VESTING_DURATION <= CLIFF_DURATION) revert InvalidVestingSchedule();

        cattToken = IERC20(cattToken_);

        uint256 startTime = block.timestamp;
        allocations[teamBeneficiary] = Allocation({
            total: teamAmount,
            released: 0,
            startTime: startTime,
            cliffDuration: CLIFF_DURATION,
            duration: VESTING_DURATION
        });
        allocations[treasuryBeneficiary] = Allocation({
            total: treasuryAmount,
            released: 0,
            startTime: startTime,
            cliffDuration: CLIFF_DURATION,
            duration: VESTING_DURATION
        });
    }

    /**
     * @notice Amount of CATT that has vested for `beneficiary` at the current block.
     * @dev Vesting schedule, with `S = startTime`, `C = cliffDuration`, `D = duration`:
     *        - `now <= S + C`           -> 0 (nothing vests during the cliff)
     *        - `S + C < now < S + D`   -> `total * (now - (S + C)) / (D - C)`
     *        - `now >= S + D`          -> `total` (fully vested)
     *      `D` is the total schedule length from `S`, so the linear window is
     *      `D - C` (3 years with the 365-day cliff and 4-year duration), and the
     *      accumulator is bounded by that same window, which keeps the result
     *      within `[0, total]`. Integer division floors the result, so a
     *      beneficiary can never round up past `total`.
     * @param beneficiary Address whose allocation is being queried.
     * @return amount Cumulative vested amount, in 18-decimal base units.
     */
    function vestedAmount(address beneficiary) public view returns (uint256 amount) {
        Allocation memory allocation = allocations[beneficiary];
        if (allocation.total == 0) return 0;

        uint256 startTime = allocation.startTime;
        uint256 cliffDuration = allocation.cliffDuration;
        uint256 duration = allocation.duration;
        uint256 currentTime = block.timestamp;

        if (currentTime <= startTime + cliffDuration) return 0;

        uint256 vestingWindow = duration - cliffDuration;
        // Defensive guards. The constructor makes a zero or inverted window
        // impossible, but a division by zero would brick claims, so saturate to
        // the full amount instead of reverting.
        if (vestingWindow == 0) return allocation.total;
        if (currentTime >= startTime + duration) return allocation.total;

        // `elapsed` is bounded by `vestingWindow` here, so the linear result is
        // always <= total. The clamp below is belt-and-braces only.
        uint256 elapsed = currentTime - (startTime + cliffDuration);
        amount = (allocation.total * elapsed) / vestingWindow;
        if (amount > allocation.total) amount = allocation.total;
    }

    /**
     * @notice Amount of CATT `beneficiary` can still withdraw right now.
     * @param beneficiary Address whose allocation is being queried.
     * @return amount `vestedAmount(beneficiary)` minus the amount already released.
     */
    function releasable(address beneficiary) public view returns (uint256 amount) {
        Allocation memory allocation = allocations[beneficiary];
        if (allocation.total == 0) return 0;

        uint256 vested = vestedAmount(beneficiary);
        if (vested <= allocation.released) return 0;

        amount = vested - allocation.released;
    }

    /**
     * @notice Claims everything currently releasable by the caller.
     * @dev Funds always go to `msg.sender`; there is no way for one beneficiary
     *      to claim on behalf of another, so tokens can never be diverted.
     *      `released` is incremented before the external token call (checks
     *      effects / interactions) and `nonReentrant` blocks re-entrancy from a
     *      non-standard CATT implementation.
     *
     *      Reverts with `NothingToClaim` when the caller has no registered
     *      allocation or nothing has vested yet, and with
     *      `InsufficientVestedBalance` when this contract holds less CATT than
     *      the releasable amount (i.e. it was not fully funded by the deployer).
     */
    function claim() external nonReentrant {
        address beneficiary = msg.sender;
        uint256 amount = releasable(beneficiary);
        if (amount == 0) revert NothingToClaim();

        Allocation storage allocation = allocations[beneficiary];
        allocation.released += amount;

        if (cattToken.balanceOf(address(this)) < amount) revert InsufficientVestedBalance();

        cattToken.safeTransfer(beneficiary, amount);
    }
}
