// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT — TEST-ONLY USDT-style stablecoin double
 * @notice A deliberately minimal, deliberately UNSAFE stand-in for a
 *         6-decimal USDT, used only to prove that `BondManager` makes no
 *         assumption that its yield token has 18 decimals.
 *
 * @dev ####################################################################
 * @dev ### TEST-ONLY. MUST NEVER BE DEPLOYED TO A PUBLIC NETWORK.        ###
 * @dev ####################################################################
 *      This contract exists solely to live under `contracts/mocks/` and back
 *      the BondManager unit tests. It is imported by NOTHING in
 *      `contracts/` outside this folder, it is permissionless (anyone may
 *      mint), it has no access control, no pause and no supply cap, and it
 *      therefore has none of the guarantees a real stablecoin provides.
 *      Deploying it on Polygon — or anywhere else with real value — would let
 *      anyone print the token the bond pool pays out in.
 *
 *      The 6-decimal `decimals()` override is the whole point: it is what
 *      proves the yield accounting is decimals-agnostic, so the same contract
 *      works unchanged against a 6-decimal USDT and a 18-decimal DAI.
 */
contract MockUSDT is ERC20 {
    /// @notice Deploys the double named and symbolised as USDT.
    constructor() ERC20("Mock USDT", "USDT") {}

    /// @notice Mints `amount` base units to `to`.
    /// @dev Intentionally permissionless and uncapped, for the reasons given
    ///      in the contract header: this is a test double, not a token.
    /// @param to Recipient of the freshly minted tokens.
    /// @param amount Amount minted, in 6-decimal base units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Number of decimals of this token, fixed at 6 like real USDT.
    /// @dev Overrides the 18-decimal default inherited from OpenZeppelin's
    ///      `ERC20` on purpose, so tests exercise a non-18-decimal yield token.
    /// @return decimals Always 6.
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
