/**
 * CATT Protocol — THE BACKEND'S MIRROR OF THE FROZEN ON-CHAIN CONSTANTS.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ===========================================================================
 * Task 3.1 asks the backend simulator to "export `STAMINA_PER_STAKE` from the
 * contracts/config so the backend uses the exact same source of truth". The
 * contracts are FROZEN for this wave, so the config file is not something this
 * wave may add, and reading the value out of a compiled artifact at runtime
 * would couple the Judge to the contracts build output (it may not exist in a
 * deployment image, and a rebuild would silently change backend behaviour).
 *
 * So the mirror lives HERE, in the backend, and the source of truth stays where
 * it was: the `.sol` file. Every entry below names the exact file and symbol it
 * mirrors, and `test/reset-schedule.test.js` contains the DRIFT TEST that reads
 * the contract SOURCE as text and fails the moment a value moves. That test is
 * the whole point of this file: a hand-written mirror is only trustworthy while
 * something proves it has not drifted.
 *
 * ===========================================================================
 * WHAT IS *NOT* HERE, AND WHY (DO NOT ADD THESE)
 * ===========================================================================
 *   - THE STREAK MULTIPLIER. `STREAK_BASE_BPS`, `STREAK_STEP_BPS` and
 *     `STREAK_MAX_BPS` in `economics.js` are NOT contract constants and are not
 *     mirrored anywhere in `smart-contracts/contracts/`. They are backend-side
 *     economic policy with no on-chain counterpart. Putting them in this file
 *     would put a comment on them saying "mirrors StakingManager.sol" that is
 *     simply untrue, and a drift test would have nothing to compare against.
 *     They stay in `economics.js`, where they are already frozen.
 *   - ANYTHING THAT IS NOT DECLARED AS A `constant` IN A `.sol` FILE. If the
 *     backend needs a number that the chain does not declare, it is backend
 *     policy and belongs in the module that owns the mechanic.
 *
 * ===========================================================================
 * UNITS
 * ===========================================================================
 * Values are `bigint` where they are token amounts or `uint256` contract
 * quantities (an 18-decimal CATT base unit does not survive `Number`), and a
 * plain integer where the contract literal is a small dimensionless ratio.
 * The `CATT` base-unit scale (`10 ** 18`) is deliberately NOT folded into any
 * export here: `MAX_SUPPLY_CATT` is the human-readable token count in whole
 * CATT, which is what a supply cap is reasoned about in.
 */

"use strict";

/**
 * The on-chain constants the backend depends on, as a frozen record.
 *
 * @type {Readonly<Record<string, bigint>>}
 */
const CONTRACT_CONSTANTS = Object.freeze({
  /**
   * Stamina POINTS credited per successful `stakeForStamina`.
   *
   * Mirrors `StakingManager.sol`, symbol `STAMINA_PER_STAKE`
   * (`uint256 public constant STAMINA_PER_STAKE = 50;`).
   *
   * The backend consequence is that `content.js#DEFAULT_DAILY_STAMINA_CAP` is
   * exactly one stake's worth of stamina, which is why the drift test also
   * asserts that equality: a change on either side without the other is a bug
   * in one of them.
   */
  STAMINA_PER_STAKE: 50n,

  /**
   * The hard cap on the total number of CATT tokens that will ever exist, in
   * WHOLE CATT (not 18-decimal base units).
   *
   * Mirrors `CATT.sol`, symbol `MAX_SUPPLY`
   * (`uint256 public constant MAX_SUPPLY = 100_000_000 * 10 ** 18;`). The
   * contract expresses it in base units; the backend reasons in whole tokens,
   * so the `10 ** 18` factor is unwound here ONCE, at the mirror, rather than
   * being left for every caller to divide.
   */
  MAX_SUPPLY_CATT: 100_000_000n,

  /**
   * The denominator of every bps computation (100.00%).
   *
   * Mirrors `StakingManager.sol`, symbol `BPS_DENOMINATOR`
   * (`uint256 public constant BPS_DENOMINATOR = 10_000;`).
   *
   * `economics.js` has its own `BPS_ONE`, which is a DIFFERENT quantity with
   * the same value: a scale factor in the reward pipeline, not a mirror of a
   * contract constant. The two are asserted equal rather than conflated.
   */
  BPS_DENOMINATOR: 10_000n,

  /**
   * Basis-point share of the staked balance released per unstake request
   * (1000 bps = 10.00%).
   *
   * Mirrors `StakingManager.sol`, symbol `UNSTAKE_BPS`
   * (`uint256 public constant UNSTAKE_BPS = 1000;`).
   *
   * The backend does not compute unstakes today; the value is mirrored because
   * it is a declared chain constant the backend must not contradict if it ever
   * surfaces an unstake estimate, and a drift test over declared constants is
   * cheaper than rediscovering the literal later.
   */
  UNSTAKE_BPS: 1000n,

  /**
   * Hard ceiling on the stake requirement, in percent of balance (reached at
   * level 16).
   *
   * Mirrors `StakingManager.sol`, symbol `MAX_STAKE_PERCENT`
   * (`uint256 public constant MAX_STAKE_PERCENT = 90;`).
   */
  MAX_STAKE_PERCENT: 90n,

  /**
   * Percentage points added to the stake requirement per level gained
   * (PRD 3.3: "Level 2: 15%, +5% per level").
   *
   * Mirrors `StakingManager.sol`, symbol `LEVEL_STEP_PERCENT`
   * (`uint256 public constant LEVEL_STEP_PERCENT = 5;`).
   */
  LEVEL_STEP_PERCENT: 5n,
});

/**
 * The declaration each mirrored constant must match, in the form the drift test
 * needs: the file to read, the symbol to look for, and the literal string that
 * symbol is declared with.
 *
 * `literal` is the exact SOURCE TEXT of the value, not a normalised form, so a
 * contract that changes `50` to `50n` or to an expression is caught as drift
 * rather than silently accepted by a lenient parse.
 *
 * `derived` marks the entries whose backend value is NOT the literal: for
 * `MAX_SUPPLY_CATT` the contract declares `100_000_000 * 10 ** 18` base units
 * and the backend unwinds the `10 ** 18` once, so the test asserts on the
 * `100_000_000` factor rather than on the whole expression.
 *
 * @type {ReadonlyArray<Readonly<{ name: string, file: string, symbol: string,
 *   literal: string, derived: boolean, note: string }>>}
 */
const CONTRACT_CONSTANT_MIRRORS = Object.freeze([
  Object.freeze({
    name: "STAMINA_PER_STAKE",
    file: "smart-contracts/contracts/StakingManager.sol",
    symbol: "STAMINA_PER_STAKE",
    literal: "50",
    derived: false,
    note: "stamina points per stake, unitless",
  }),
  Object.freeze({
    name: "MAX_SUPPLY_CATT",
    file: "smart-contracts/contracts/CATT.sol",
    symbol: "MAX_SUPPLY",
    literal: "100_000_000",
    derived: true,
    note: "the 100_000_000 token factor of `100_000_000 * 10 ** 18` base units",
  }),
  Object.freeze({
    name: "BPS_DENOMINATOR",
    file: "smart-contracts/contracts/StakingManager.sol",
    symbol: "BPS_DENOMINATOR",
    literal: "10_000",
    derived: false,
    note: "bps denominator, 100.00%",
  }),
  Object.freeze({
    name: "UNSTAKE_BPS",
    file: "smart-contracts/contracts/StakingManager.sol",
    symbol: "UNSTAKE_BPS",
    literal: "1000",
    derived: false,
    note: "per-request unstake share",
  }),
  Object.freeze({
    name: "MAX_STAKE_PERCENT",
    file: "smart-contracts/contracts/StakingManager.sol",
    symbol: "MAX_STAKE_PERCENT",
    literal: "90",
    derived: false,
    note: "ceiling on the stake requirement, percent",
  }),
  Object.freeze({
    name: "LEVEL_STEP_PERCENT",
    file: "smart-contracts/contracts/StakingManager.sol",
    symbol: "LEVEL_STEP_PERCENT",
    literal: "5",
    derived: false,
    note: "requirement growth per level, percent points",
  }),
]);

/**
 * The `10 ** 18` base-unit scale of `CATT`, unwound from `MAX_SUPPLY` exactly
 * once, here, so no caller has to remember it.
 *
 * Mirrors `CATT.sol`'s ERC20 `decimals() === 18` (via OpenZeppelin's
 * `ERC20`), and `MAX_SUPPLY = 100_000_000 * 10 ** 18`.
 *
 * @type {bigint}
 */
const CATT_BASE_UNITS = 10n ** 18n;

/**
 * The contract file that declares `MAX_SUPPLY`, named here so the drift test and
 * any future tooling do not have to hardcode the path in two places.
 *
 * @type {string}
 */
const CATT_CONTRACT_FILE = "smart-contracts/contracts/CATT.sol";

/**
 * The contract file that declares the staking constants.
 *
 * @type {string}
 */
const STAKING_MANAGER_CONTRACT_FILE = "smart-contracts/contracts/StakingManager.sol";

module.exports = {
  CONTRACT_CONSTANTS,
  CONTRACT_CONSTANT_MIRRORS,
  CATT_BASE_UNITS,
  CATT_CONTRACT_FILE,
  STAKING_MANAGER_CONTRACT_FILE,
};
