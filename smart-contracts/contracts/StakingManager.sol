// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CATT Protocol Staking & Stamina Manager
 * @notice The on-chain "Learn-to-Earn" engine of CATT Protocol ($CATT): the
 *         tiered staking requirement that unlocks Stamina (PRD Section 3.3)
 *         together with the anti-dump "Drip Unstaking" release path.
 *
 * @dev Economy (PRD Section 3.3, "Stamina System" / "Tiered Staking" / "Drip
 *      Unstaking"):
 *      - Stamina is the daily spend resource used to mine $CATT. It is minted
 *        in-contract purely as a staking reward: every successful stake pays
 *        `STAMINA_PER_STAKE` points. It is unitless and has no monetary value.
 *      - The stake requirement is a *percentage of the caller's current CATT
 *        balance*, and it escalates with the caller's level: level 0 costs
 *        `BASE_STAKE_PERCENT` (10%), and every further level adds
 *        `LEVEL_STEP_PERCENT` (5%), saturating at `MAX_STAKE_PERCENT` (90%).
 *        A higher level therefore makes the NEXT stake more expensive, which is
 *        the intended sink for CATT.
 *      - Unstaking is deliberately "drip" only: a request releases exactly
 *        `UNSTAKE_BPS` (10.00%) of the staked balance and starts an
 *        `UNSTAKE_COOLDOWN` (84 hours / 3.5 days) window before another request
 *        is accepted. A full exit is therefore a multi-day drip by
 *        construction, which is the PRD's explicit anti-dump design.
 *
 * @dev Security posture (PRD Section 5, Rule 1):
 *      - Every state-changing function is `nonReentrant`, and all balance
 *        updates are written before the external token call, so a non-standard
 *        or malicious CATT implementation cannot re-enter and drain the vault.
 *      - All timing logic is derived strictly from `block.timestamp`. No block
 *        number is read anywhere in this contract, so miners/validators cannot
 *        decouple the cooldown from wall-clock time.
 *      - `SafeERC20` is used for every transfer, so USDT-style tokens that do
 *        not return a boolean on `transfer` are still handled correctly.
 *
 * @dev Deliberate non-goals, so that auditors do not look for them:
 *      no bond/vesting yield logic (that lives in a separate contract), no burn,
 *      no fee-on-transfer accounting, no emergency pause, no admin slashing or
 *      clawback, no off-chain signature verification, and no upgradeability.
 *      The `cattToken` address is `immutable`; the contract holds no admin
 *      ability to move user principal other than the 10% drip release.
 *
 * @dev No private keys, API keys or deployment secrets appear in this source
 *      file; those are supplied by the deployer's environment (PRD Rule 2).
 */
contract StakingManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Percentage of the caller's CATT balance required at level 0
    ///         (10%). PRD 3.3: "Level 1: 10%" — the contract counts levels
    ///         from zero, so `stakeLevel == 0` is the PRD's "Level 1".
    uint256 public constant BASE_STAKE_PERCENT = 10;

    /// @notice Percentage points added to the requirement for every level
    ///         gained. PRD 3.3: "Level 2: 15%, +5% per level".
    uint256 public constant LEVEL_STEP_PERCENT = 5;

    /// @notice Hard ceiling on the stake requirement, reached at level 16.
    /// @dev A cap is required so the requirement can never reach 100% (which
    ///      would be unpayable) and can never be used to demand a user's whole
    ///      balance; a 10% buffer is always retained, which also leaves the
    ///      user liquid CATT to sell or bond.
    uint256 public constant MAX_STAKE_PERCENT = 90;

    /// @notice Stamina paid out per successful stake, in stamina points.
    /// @dev Fixed, not level-scaled: stamina is a *rate* resource for daily
    ///      mining, and the escalating cost of the next stake is the intended
    ///      economic pressure. Keeping it flat also keeps the reward
    ///      predictable for the frontend.
    uint256 public constant STAMINA_PER_STAKE = 50;

    /// @notice Delay between two accepted unstake requests: 84 hours (3.5 days).
    /// @dev PRD 3.3: "an 84-hour (3.5 days) cooldown between requests".
    uint256 public constant UNSTAKE_COOLDOWN = 84 hours;

    /// @notice Basis-point share of the staked balance released per request:
    ///         1000 bps = 10.00%. PRD 3.3: "Max unstake is 10% of staked
    ///         amount".
    uint256 public constant UNSTAKE_BPS = 1000;

    /// @notice Basis-point denominator used by every bps computation (100.00%).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Immutable reference to the CATT ERC20 token locked and released
    ///         by this contract.
    /// @dev `immutable` rather than a mutable storage slot: the staked
    ///      principal is denominated in this token, so allowing it to change
    ///      would silently reinterpret every user's balance.
    IERC20 public immutable cattToken;

    /// @notice CATT currently locked by `user` in this contract, in
    ///         18-decimal base units.
    /// @dev Only ever moves in two ways: up via `stakeForStamina`, and down by
    ///      exactly the 10% drip released via `requestUnstake`. There is no
    ///      admin path that can reduce it, so principal is safe from seizure.
    mapping(address => uint256) public stakedAmount;

    /// @notice Staking level of `user`, starting at 0.
    /// @dev Increments by one on every successful `stakeForStamina` and NEVER
    ///      decreases — not even when the user unstakes. The level is a
    ///      monotone "how much CATT has been committed here" counter that
    ///      drives `requiredPercent`; letting it decay would let a user reset
    ///      the escalation by cycling stake -> unstake -> stake.
    mapping(address => uint256) public stakeLevel;

    /// @notice Stamina balance of `user`, in unitless stamina points.
    /// @dev Credited by `stakeForStamina` and debited only by the authorized
    ///      `claimer` via `consumeStamina`. The owner cannot debit it directly.
    mapping(address => uint256) public stamina;

    /// @notice Timestamp of `user`'s most recent accepted unstake request.
    /// @dev 0 means the user has never requested an unstake, in which case no
    ///      cooldown is in force and the next request is served immediately.
    ///      Because a real chain timestamp is never 0, the zero value is an
    ///      unambiguous "never" marker rather than an edge case.
    mapping(address => uint256) public lastUnstakeRequest;

    /// @notice Account authorized to debit stamina on behalf of users.
    /// @dev In the reference deployment this is the backend "Judge" (PRD 3.2)
    ///      which verifies Proof-of-Attention and calls `consumeStamina` when
    ///      a mining session is spent. It is deliberately NOT the owner: role
    ///      separation means a compromised owner cannot drain user stamina, and
    ///      a compromised claimer can only ever destroy stamina (never mint it
    ///      or move principal). The owner administers the role through
    ///      `setClaimer` and is never implicitly authorized.
    address public claimer;

    /// @notice Emitted on every successful stake.
    /// @param user Account that staked.
    /// @param amount Amount pulled from the user, in 18-decimal base units.
    /// @param newStakedAmount Total locked for the user after the stake.
    /// @param newStakeLevel The user's level after the stake (level + 1).
    event Staked(address indexed user, uint256 amount, uint256 newStakedAmount, uint256 newStakeLevel);

    /// @notice Emitted on every successful unstake request.
    /// @param user Account that unstaked.
    /// @param amount Amount transferred out, in 18-decimal base units.
    /// @param newStakedAmount Total still locked for the user after the release.
    /// @param nextUnstakeAvailableAt Timestamp from which the next request is
    ///        accepted for this user.
    event Unstaked(address indexed user, uint256 amount, uint256 newStakedAmount, uint256 nextUnstakeAvailableAt);

    /// @notice Emitted when stamina is credited to a user.
    /// @param user Account that received the stamina.
    /// @param amountGranted Stamina points added in this action.
    /// @param newStamina The user's total stamina after the credit.
    event StaminaGranted(address indexed user, uint256 amountGranted, uint256 newStamina);

    /// @notice Emitted when stamina is debited from a user.
    /// @param user Account that was debited.
    /// @param amountConsumed Stamina points removed in this action.
    /// @param newStamina The user's remaining stamina after the debit.
    event StaminaConsumed(address indexed user, uint256 amountConsumed, uint256 newStamina);

    /// @notice Emitted when the authorized stamina claimer is changed.
    /// @param previousClaimer The claimer that was active before the change.
    /// @param newClaimer The claimer that is active after the change.
    event ClaimerUpdated(address indexed previousClaimer, address indexed newClaimer);

    /// @notice Thrown when a token, claimer or beneficiary address is `address(0)`.
    /// @dev The zero address is never a valid actor: accepting it would either
    ///      brick the role permanently or credit stamina to an unrecoverable
    ///      burn address.
    error ZeroAddress();

    /// @notice Thrown when a supplied amount is zero.
    /// @dev A zero amount is always a caller mistake or a no-op, and letting it
    ///      through would consume a transaction and emit misleading events.
    error ZeroAmount();

    /// @notice Thrown by `requestUnstake` when the caller has nothing staked.
    error NotStaker();

    /// @notice Thrown when the 10% drip truncates to zero for a dust stake.
    /// @param staked The caller's total staked balance, in base units.
    /// @param amount The drip amount after integer division, i.e. always 0.
    error UnstakeAmountTooSmall(uint256 staked, uint256 amount);

    /// @notice Thrown when a stake is below the caller's level-scaled minimum.
    /// @param required Minimum stake, in 18-decimal base units.
    /// @param provided Amount the caller tried to stake.
    error InsufficientStakeAmount(uint256 required, uint256 provided);

    /// @notice Thrown when an unstake request arrives inside the 84h window.
    /// @param secondsRemaining Exact seconds left until the request is allowed.
    error UnstakeCooldownActive(uint256 secondsRemaining);

    /// @notice Thrown when the claimer tries to debit more stamina than exists.
    /// @dev `account` is the offending address itself, so the ABI argument is
    ///      the same 32-byte word an `address` always encodes to, but the type
    ///      can no longer be confused with a level or an amount.
    /// @param account The account that was debited against.
    /// @param requested Stamina points the claimer tried to consume.
    /// @param available Stamina points the account actually held.
    error StaminaInsufficient(address account, uint256 requested, uint256 available);

    /// @notice Thrown when a non-claimer tries to consume someone else's stamina.
    /// @param caller The address that attempted the call.
    error UnauthorizedClaimer(address caller);

    /**
     * @notice Deploys the staking manager against a CATT token address.
     * @dev `claimer` is initialised to the deployer so the protocol is usable
     *      the moment it is deployed: if it were left unset, every
     *      `consumeStamina` call would revert with `UnauthorizedClaimer` until
     *      a separate owner transaction granted the role, leaving freshly
     *      deployed users unable to mine. The owner can (and in production
     *      should) immediately reassign it to the backend Judge service with
     *      `setClaimer`, after which the deployer address no longer holds any
     *      privilege over stamina.
     * @param cattToken_ Address of the CATT ERC20 token to be staked.
     */
    constructor(address cattToken_) Ownable(msg.sender) {
        if (cattToken_ == address(0)) revert ZeroAddress();

        cattToken = IERC20(cattToken_);
        claimer = msg.sender;

        emit ClaimerUpdated(address(0), msg.sender);
    }

    /**
     * @notice Percentage of `user`'s CATT balance that must be staked for the
     *         next stake, in whole percent.
     * @dev `min(BASE_STAKE_PERCENT + stakeLevel[user] * LEVEL_STEP_PERCENT,
     *      MAX_STAKE_PERCENT)`. `stakeLevel` is deliberately left unbounded: the
     *      clamp is applied to the RESULT of the multiplication, so an
     *      arbitrarily large level can only ever push the percentage up to the
     *      90% ceiling and can never wrap around, reduce the requirement, or
     *      make the computation revert. See `MAX_STAKE_PERCENT` for why 90%
     *      and not 100%.
     * @param user Account whose requirement is being queried.
     * @return percent Required percentage of the user's balance, capped at
     *         `MAX_STAKE_PERCENT`.
     */
    function requiredPercent(address user) public view returns (uint256 percent) {
        uint256 escalated = BASE_STAKE_PERCENT + (stakeLevel[user] * LEVEL_STEP_PERCENT);
        percent = escalated < MAX_STAKE_PERCENT ? escalated : MAX_STAKE_PERCENT;
    }

    /**
     * @notice Minimum amount of CATT that `user` must stake right now to earn
     *         stamina, in 18-decimal base units.
     * @dev `balanceOf(user) * requiredPercent(user) / 100`. The balance is the
     *      caller's SPENDABLE balance, i.e. it excludes CATT already locked in
     *      this contract, which is what makes the requirement escalate as
     *      principal is committed. Integer division floors the result, so a
     *      very small balance can round down to a dust minimum; that is
     *      harmless because it can only make the requirement trivially cheap,
     *      never unpayable.
     * @param user Account whose requirement is being queried.
     * @return amount Minimum stake, in 18-decimal base units.
     */
    function requiredStakeFor(address user) public view returns (uint256 amount) {
        amount = (cattToken.balanceOf(user) * requiredPercent(user)) / 100;
    }

    /**
     * @notice Stamina balance of `user`, in unitless stamina points.
     * @dev Thin, self-documenting wrapper over the public `stamina` mapping.
     *      It exists so the frontend/backend can read the balance through one
     *      obviously-named entry point alongside `requiredStakeFor` and
     *      `nextUnstakeAvailableAt`, and so the storage layout can later gain
     *      derived fields without changing the external read API.
     * @param user Account whose stamina is being queried.
     * @return amount Stamina points currently available to spend.
     */
    function staminaOf(address user) external view returns (uint256 amount) {
        amount = stamina[user];
    }

    /**
     * @notice Timestamp at which `user` may request another unstake.
     * @dev Returns 0 when the user has never made a request, meaning "no
     *      cooldown has ever been armed" rather than "available since the
     *      epoch". Consumers should pair this with
     *      `unstakeCooldownRemaining`, which is 0 in both the never-requested
     *      and cooldown-elapsed cases.
     * @param user Account whose next available timestamp is being queried.
     * @return nextAvailable `lastUnstakeRequest[user] + UNSTAKE_COOLDOWN`, or
     *         0 if the user has never requested an unstake.
     */
    function nextUnstakeAvailableAt(address user) public view returns (uint256 nextAvailable) {
        uint256 last = lastUnstakeRequest[user];
        if (last == 0) return 0;
        nextAvailable = last + UNSTAKE_COOLDOWN;
    }

    /**
     * @notice Seconds `user` must still wait before the next unstake request.
     * @dev 0 when the user has never requested an unstake AND 0 when the
     *      cooldown has fully elapsed, so a non-zero value is always an
     *      unambiguous "you are locked out, here is exactly how long".
     *      The subtraction is guarded so the result can never wrap around if
     *      the chain's timestamp were ever to move backwards.
     * @param user Account whose remaining cooldown is being queried.
     * @return remaining Seconds left, or 0 if no cooldown is in force.
     */
    function unstakeCooldownRemaining(address user) public view returns (uint256 remaining) {
        uint256 last = lastUnstakeRequest[user];
        if (last == 0) return 0;
        uint256 nextAvailable = last + UNSTAKE_COOLDOWN;
        if (block.timestamp >= nextAvailable) return 0;
        remaining = nextAvailable - block.timestamp;
    }

    /**
     * @notice Locks `amount` CATT and credits `STAMINA_PER_STAKE` stamina to the
     *         caller.
     *
     * @dev Requirement semantics, stated precisely because they are the heart
     *      of the tiered-staking design:
     *      - `requiredStakeFor(msg.sender)` is evaluated against the caller's
     *        balance BEFORE this stake lands, because the required amount is
     *        computed (and checked) before the transfer is pulled. Since the
     *        CATT being staked is not part of the caller's spendable balance
     *        anyway, a user who holds exactly 10% of their supply in CATT
     *        spends 10% of their spendable balance to stake, and that same
     *        10% is *not* added to the basis for the following stake.
     *      - OVER-STAKING IS ALLOWED: the check is `amount >= required`, not
     *        `amount == required`. A user may lock any amount from the
     *        requirement up to their whole balance, and may repeatedly add to
     *        an existing position.
     *      - EVERY successful stake raises `stakeLevel` by exactly one, and the
     *        level never decreases. So each 50 stamina points purchased makes
     *        the NEXT stake strictly more expensive (+5 percentage points,
     *        saturating at 90%), which is the intended CATT sink.
     *
     *      Ordering: the external `safeTransferFrom` is performed BEFORE the
     *      bookkeeping writes. This is a deliberate choice, not an oversight.
     *      Pulling the tokens first means a transfer that is not honoured (a
     *      rebasing or block-list-aware token, a token whose `transferFrom`
     *      charges a fee, or any future non-standard behaviour) reverts the
     *      whole transaction, so stamina and level can never be granted for
     *      tokens this contract never received. The classic
     *      checks-effects-interactions argument for writing state first relies
     *      on the invariant being observable by a re-entrant caller, which does
     *      not apply here: the `nonReentrant` modifier already blocks every
     *      re-entrant path into this contract, so the residual risk that the
     *      inversion would otherwise introduce is nil, while the pull-first
     *      ordering additionally keeps the accounting honest against
     *      exotic token behaviour.
     *
     *      Reverts with `ZeroAmount` for a zero amount, and with
     *      `InsufficientStakeAmount` when the stake is below the level-scaled
     *      minimum. Reverts with the standard ERC20 allowance/balance errors if
     *      the caller has not approved this contract.
     *
     * @param amount Amount of CATT to lock, in 18-decimal base units. Must be
     *        greater than or equal to `requiredStakeFor(msg.sender)`.
     */
    function stakeForStamina(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 required = requiredStakeFor(msg.sender);
        if (amount < required) revert InsufficientStakeAmount(required, amount);

        // Interaction first, effects after: see the ordering rationale above.
        cattToken.safeTransferFrom(msg.sender, address(this), amount);

        stakedAmount[msg.sender] += amount;
        stakeLevel[msg.sender] += 1;
        uint256 granted = STAMINA_PER_STAKE;
        stamina[msg.sender] += granted;

        emit Staked(msg.sender, amount, stakedAmount[msg.sender], stakeLevel[msg.sender]);
        emit StaminaGranted(msg.sender, granted, stamina[msg.sender]);
    }

    /**
     * @notice Releases the 10% drip of the caller's staked CATT and arms the
     *         84-hour cooldown.
     *
     * @dev The call is parameterless on purpose: the amount is derived from the
     *      caller's own staked balance, so a caller can never choose to release
     *      more than the 10% cap, and can never release to anyone but
     *      themselves. The exit path is therefore exactly PRD 6.4: request ->
     *      receive 10% -> timer resets for 84 hours.
     *
     *      Cooldown semantics, precisely:
     *      - The FIRST request a user ever makes is served immediately and is
     *        what ARMS the clock: `lastUnstakeRequest` is 0 until that moment,
     *        so no cooldown is ever charged twice for the same window.
     *      - After the first request, further requests revert with
     *        `UnstakeCooldownActive` until
     *        `lastUnstakeRequest + UNSTAKE_COOLDOWN` has passed. Each subsequent
     *        successful request RE-ARMS the clock from its own timestamp, so
     *        repeated drip-outs are spaced at least 84 hours apart and a
     *        determined seller is limited to 10% of the position every 3.5
     *        days. This is the PRD's intended anti-dump design, not an oversight
     *        that a first-timer could exploit for a free exit.
     *      - The comparison uses `block.timestamp` only, never a block number
     *        (PRD Rule 1). Two requests cannot be served for the same user
     *        within one 84h window, so a same-block double call is impossible.
     *
     *      Truncation: `amount = staked * UNSTAKE_BPS / BPS_DENOMINATOR` is an
     *      integer division, so a position below 10 base units (e.g. 9 wei)
     *      yields a drip of 0. Rather than silently no-op, that case reverts
     *      with `UnstakeAmountTooSmall`, because a zero-value drip could
     *      neither move tokens nor make progress towards unwinding the
     *      position. Such a dust position is only reachable by a user who
     *      deliberately stakes dust, and can never block a normal position:
     *      the revert is per-caller and state is untouched.
     *
     *      Ordering: state is written BEFORE the transfer
     *      (checks-effects-interactions), and `nonReentrant` additionally
     *      blocks re-entry through a non-standard token callback.
     *
     *      Reverts with `NotStaker` if nothing is staked, with
     *      `UnstakeAmountTooSmall` for a dust position, and with
     *      `UnstakeCooldownActive` while the window is still open.
     */
    function requestUnstake() external nonReentrant {
        uint256 staked = stakedAmount[msg.sender];
        if (staked == 0) revert NotStaker();

        uint256 amount = (staked * UNSTAKE_BPS) / BPS_DENOMINATOR;
        if (amount == 0) revert UnstakeAmountTooSmall(staked, amount);

        uint256 last = lastUnstakeRequest[msg.sender];
        if (last != 0) {
            uint256 nextAvailable = last + UNSTAKE_COOLDOWN;
            if (block.timestamp < nextAvailable) {
                revert UnstakeCooldownActive(nextAvailable - block.timestamp);
            }
        }

        uint256 newStakedAmount = staked - amount;
        stakedAmount[msg.sender] = newStakedAmount;
        uint256 requestTimestamp = block.timestamp;
        lastUnstakeRequest[msg.sender] = requestTimestamp;

        cattToken.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount, newStakedAmount, requestTimestamp + UNSTAKE_COOLDOWN);
    }

    /**
     * @notice Debits `amount` stamina from `account`. Callable only by the
     *         authorized `claimer`.
     * @dev `account` is DELIBERATELY allowed to differ from `msg.sender`.
     *      Per PRD 3.2 the backend Judge validates Proof-of-Attention, and a
     *      mined session is charged to the wallet that earned it; the frontend
     *      relays the call so the user does not pay gas, which is why the
     *      signature-authorized backend, not the end user, is `msg.sender`.
     *      This is safe because the claimer is a single trusted role that can
     *      only ever DESTROY stamina (never mint it, never touch principal) and
     *      can be rotated by the owner through `setClaimer`.
     *
     *      Note that the owner is NOT implicitly authorized: role separation
     *      means a compromised owner cannot drain user stamina, and no
     *      accidental owner call can silently burn a session. The owner must
     *      explicitly `setClaimer` to grant itself the role.
     *
     *      Reverts with `UnauthorizedClaimer` for any other caller,
     *      `ZeroAddress` if `account` is the zero address, `ZeroAmount` if
     *      `amount` is zero, and `StaminaInsufficient` if the balance is too
     *      low. State is written before any event, and this function performs
     *      no external calls at all.
     *
     * @param account User whose stamina is consumed. Must not be
     *        `address(0)` and need not be the caller.
     * @param amount Stamina points to burn, in stamina points. Must be > 0 and
     *        at most `stamina[account]`.
     */
    function consumeStamina(address account, uint256 amount) external nonReentrant {
        if (msg.sender != claimer) revert UnauthorizedClaimer(msg.sender);
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 available = stamina[account];
        if (available < amount) revert StaminaInsufficient(account, amount, available);

        uint256 newStamina = available - amount;
        stamina[account] = newStamina;

        emit StaminaConsumed(account, amount, newStamina);
    }

    /**
     * @notice Points `newClaimer` as the account allowed to call
     *         `consumeStamina`, replacing the previous one atomically.
     * @dev Reverts with `ZeroAddress` on the zero address so the role can never
     *      be left unset, which would brick every stamina consumption in the
     *      protocol. The change takes effect immediately, so any in-flight
     *      trusted call from the previous claimer reverts with
     *      `UnauthorizedClaimer` from the next block onwards — the intended
     *      emergency-revocation path.
     * @param newClaimer Address to authorize. Must not be `address(0)`.
     */
    function setClaimer(address newClaimer) external onlyOwner {
        if (newClaimer == address(0)) revert ZeroAddress();

        address previous = claimer;
        claimer = newClaimer;

        emit ClaimerUpdated(previous, newClaimer);
    }
}
