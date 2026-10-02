// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CATT Protocol Token ($CATT)
 * @notice Minimal, auditable ERC20 token for the CATT Protocol "Learn-to-Earn"
 *         economy (Polygon). The token is intentionally feature-free: there is
 *         no burn, no pause, no tax and no transfer hook. All supply control is
 *         funnelled through a single owner-gated, hard-cap-guarded `mint`.
 *
 * @dev Tokenomics (PRD Section 3.3):
 *      - Maximum supply is 100,000,000 CATT and is enforced at the contract
 *        level by `MAX_SUPPLY`. This cap is immutable and will NEVER be raised.
 *      - The decimals decision is immutable: 18 decimals is inherited from
 *        OpenZeppelin's `ERC20` implementation and is deliberately NOT
 *        overridden, so the value can never drift or be mis-configured.
 *      - Deployment parameters (owner address, RPC endpoints, private keys)
 *        come from the deployer's environment. No key material is stored in
 *        this source file (PRD Rule 2).
 *
 * @dev The fixed 18-decimal choice is documented on the inherited function
 *      rather than on a local override, because overriding `decimals()` would
 *      create a second, mutable source of truth for the same number.
 */
contract CATT is ERC20, Ownable {
    /// @notice Hard cap on the total number of CATT tokens that will ever exist.
    /// @dev 100,000,000 CATT expressed in the token's 18-decimal base unit.
    ///      This is a permanent cap: the value is a compile-time `constant`
    ///      with no setter, no upgrade path and no privileged bypass, so the
    ///      total supply can never exceed it.
    uint256 public constant MAX_SUPPLY = 100_000_000 * 10 ** 18;

    /// @notice Emitted on every successful mint, complementing the standard
    ///         ERC20 `Transfer` event emitted by the token implementation.
    /// @param to Recipient of the freshly minted tokens.
    /// @param amount Amount minted, in 18-decimal base units.
    /// @param newTotalSupply Total supply of CATT after the mint completed.
    event Minted(address indexed to, uint256 amount, uint256 newTotalSupply);

    /// @notice Thrown when a mint would push the total supply above `MAX_SUPPLY`.
    /// @param requestedSupply Resulting total supply that was requested.
    /// @param maxSupply The immutable hard cap (`MAX_SUPPLY`).
    error MintExceedsMaxSupply(uint256 requestedSupply, uint256 maxSupply);

    /**
     * @notice Deploys the CATT token.
     * @param initialOwner Address granted the exclusive right to mint CATT.
     * @dev Ownership can be transferred or renounced by the owner afterwards
     *      through OpenZeppelin's `Ownable`. Renouncing it permanently disables
     *      `mint` while leaving every already-minted token fully transferable.
     */
    constructor(address initialOwner) ERC20("CATT Protocol", "CATT") Ownable(initialOwner) {}

    /**
     * @notice Mints new CATT tokens to `to`.
     * @dev Emits both `Transfer` (via the ERC20 implementation) and `Minted`.
     *
     *      Reverts with `MintExceedsMaxSupply` if the mint would take the total
     *      supply beyond the immutable `MAX_SUPPLY` cap. Reverts with OpenZeppelin's
     *      `ERC20InvalidReceiver` if `to` is the zero address. A zero `amount`
     *      is not rejected here; the inherited ERC20 transfer path is the single
     *      source of truth for receiver and amount validity.
     *
     * @param to Recipient of the minted tokens. Must not be `address(0)`.
     * @param amount Amount of CATT to mint, in 18-decimal base units.
     */
    function mint(address to, uint256 amount) external onlyOwner {
        uint256 currentSupply = totalSupply();
        uint256 requestedSupply = currentSupply + amount;
        if (requestedSupply > MAX_SUPPLY) {
            revert MintExceedsMaxSupply(requestedSupply, MAX_SUPPLY);
        }

        _mint(to, amount);

        emit Minted(to, amount, totalSupply());
    }
}
