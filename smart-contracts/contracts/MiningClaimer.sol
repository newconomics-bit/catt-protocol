// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./CATT.sol";
import "./StakingManager.sol";

/**
 * @title CATT Protocol Mining Claimer
 * @notice The signature-verified settlement layer of the CATT "Learn-to-Earn"
 *         mining loop (PRD Section 3.2, "Signature Generator", and PRD Section
 *         6.2, "Mining Loop"). It closes the off-chain/on-chain loop: the
 *         backend Judge (PRD 3.2) runs the Anti-Cheat Engine, and when a user
 *         passes Proof-of-Attention it signs an EIP-712 statement. This contract
 *         verifies that signature, debits the stamina the mining session cost,
 *         and mints the signed $CATT reward to the user.
 *
 * @dev The loop this contract closes, verbatim from PRD 6.2:
 *      "User selects Mission -> Reads Article (triggers telemetry) -> Hits
 *      Focus Trap -> Passes Quiz -> Backend signs transaction -> User claims
 *      $CATT." Everything before "Backend signs" is off-chain and out of scope
 *      here; everything from "Backend signs" onwards is enforced on-chain.
 *
 * @dev CROSS-LANGUAGE CONTRACT (must byte-match the backend signer):
 *      - Domain name:    "CATT Protocol"  (passed to `EIP712`)
 *      - Domain version: "1"              (passed to `EIP712`)
 *      - chainId:         the live `block.chainid` (OpenZeppelin injects it)
 *      - verifyingContract: `address(this)` (OpenZeppelin injects it)
 *      - Type string, field order fixed and significant:
 *        `ClaimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline)`
 *        The `encodeData` struct order in `_claimStructHash` is `user`,
 *        `reward`, `staminaCost`, `nonce`, `deadline` — identical. The type
 *        hash literal and the encode order are two separate places where a
 *        mismatch would silently produce an unverifiable signature, so both are
 *        pinned here and the actual hash is built in exactly one private helper
 *        (`_claimStructHash`) that both `claimReward` and `hashClaim` use, so
 *        the two public entry points cannot drift apart.
 *
 * @dev Replay protection has two independent layers:
 *      - The `deadline` is inside the signed struct hash, so a signature is
 *        only usable until the timestamp it was issued against.
 *      - The `nonce` is inside the signed struct hash AND is recorded in the
 *        `usedNonces` mapping before any external call, so even a signature
 *        that stays valid for a long window can be spent exactly once.
 *
 * @dev Security posture (PRD Section 5, Rule 1):
 *      - `claimReward` is `nonReentrant`, and it follows
 *        checks-effects-interactions strictly: every check, then the
 *        `usedNonces` write, then the two external calls, then the event. The
 *        nonce is therefore consumed before any value leaves the protocol, so
 *        neither re-entry nor a downstream failure can mint twice.
 *      - All timing is derived strictly from `block.timestamp`; no block
 *        number is read anywhere in this contract.
 *      - There is no arithmetic in the settlement path: `reward` and
 *        `staminaCost` are consumed exactly as the signer committed to them,
 *        so no rounding, no fee and no share math exists to be mis-computed.
 *
 * @dev Deliberate non-goals, so that auditors do not look for them:
 *      - NO PERMIT2, NO META-TRANSACTIONS, NO EIP-2612 PERMIT. The claim is
 *        deliberately gasless from the *reward* point of view (the user does
 *        not need CATT to claim, and the backend pays the gas if it relays),
 *        but there is no meta-transaction implementation here at all.
 *      - NO OFF-CHAIN SIGNATURE ISSUANCE OR VERIFICATION. This contract only
 *        *checks* a signature; it never asks, receives or stores a Judge
 *        decision, an attestation, a telemetry report or an API response.
 *      - NO BACKEND OR MOBILE CODE. The Anti-Cheat Engine, the content
 *        randomizer and the app live in `/backend-server` and `/mobile-app`
 *        respectively (PRD Rule 3).
 *      - NO BATCH CLAIMS: one signature, one claim, one reward.
 *      - NO CLAIM FEE: the reward is minted in full to the user.
 *      - NO PAUSE: a signer that is compromised is revoked by rotation, not
 *        by a pause switch.
 *      - NO UPGRADEABILITY: not proxyable, not initializable, no admin
 *        storage writes beyond `signer`.
 *      - NO RE-SIGNING OR RELAYING OF ANOTHER USER'S CLAIM: `user` is baked
 *        into the signature, so a third party can submit a claim but can only
 *        ever trigger a payout to the address the backend signed for.
 *      - NO RECOVERY OF A BURNED NONCE (see `usedNonces`).
 *
 * @dev No private keys, API keys or deployment secrets appear in this source
 *      file. The backend signing key lives only in the Judge service's
 *      environment (PRD Rule 2); the on-chain contract only ever learns the
 *      signer's *address*.
 *
 * @dev DeploymentNotes — required deployment order, and the two roles this
 *      contract must hold:
 *
 *      This contract needs BOTH of the following roles, and they are granted
 *      by the deployment script in this exact order:
 *        (1) the CATT `Ownable` role — after this contract becomes the owner
 *            of `CATT` it is the SOLE account that can call `mint`, and
 *            therefore the only account from which mining rewards can ever be
 *            printed; and
 *        (2) the `StakingManager.claimer` role — only `claimer` may call
 *            `StakingManager.consumeStamina`, so it is the only account that
 *            can debit user stamina.
 *
 *      The steps, in order:
 *        (i)   MINT EVERY INITIAL ALLOCATION (team, treasury, liquidity,
 *              airdrop — anything that should exist at genesis) with the
 *              DEPLOYER still the owner of `CATT`. This ordering is not
 *              cosmetic: the moment `CATT` ownership is transferred to this
 *              contract, the deployer can no longer mint, and because this
 *              contract exposes no way to mint arbitrary allocations (its only
 *              mint path is a signed mining reward), any allocation minted
 *              after the transfer would be permanently unmintable.
 *        (ii)  `cattToken.transferOwnership(address(claimer))` — from the
 *              deployer, which must still be the owner per step (i).
 *        (iii) `stakingManager.setClaimer(address(claimer))` — from the
 *              `StakingManager` owner, granting the stamina-debit role.
 *        (iv)  Only after (ii) and (iii) does `claimReward` work end to end;
 *              before that point it reverts with `UnauthorizedClaimer` or
 *              `OwnableUnauthorizedAccount` respectively.
 *
 *      After (iv) this contract is the sole minter of $CATT and the only
 *      account that can debit stamina, which means the trust root of the
 *      whole economy is: (a) the `signer` key, which alone decides who gets
 *      minted what, and (b) the `Ownable` owner of THIS contract, which alone
 *      decides who that signer is.
 *
 *      Role separation, stated explicitly because it is easy to conflate:
 *      the backend Judge is the `signer` HERE (it produces EIP-712
 *      signatures); the backend Judge is *not* the `StakingManager.claimer`
 *      (that is this contract, so stamina can only ever be debited as part of
 *      a verified claim); and the backend Judge is *not* the `CATT` owner
 *      (that is this contract too). The Judge's key can therefore only ever
 *      cause `stamina -> reward` conversions at a rate the signer chose; it
 *      cannot move user principal, cannot mint without paying stamina, and
 *      cannot grant itself any other privilege.
 */
contract MiningClaimer is EIP712, Ownable, ReentrancyGuard {
    /// @notice EIP-712 struct hash for the mining claim, pinned as a literal so
    ///         the on-chain and off-chain encoders cannot disagree.
    /// @dev Exact pre-image:
    ///      `ClaimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline)`
    ///      Field order is part of the hash — reordering these fields changes
    ///      the value and every signature issued against the old order stops
    ///      verifying.
    bytes32 private constant CLAIM_REWARD_TYPEHASH =
        keccak256("ClaimReward(address user,uint256 reward,uint256 staminaCost,uint256 nonce,uint256 deadline)");

    /// @notice Immutable reference to the $CATT token minted as a mining reward.
    /// @dev `immutable` rather than a mutable storage slot: the reward is
    ///      denominated in this exact token, so allowing it to change would
    ///      silently reinterpret every signature the backend has ever issued.
    CATT public immutable cattToken;

    /// @notice Immutable reference to the StakingManager whose stamina this
    ///         contract debits as part of every claim.
    /// @dev `immutable` for the same reason as `cattToken`: stamina is
    ///      denominated in the ledger held by this exact manager, so a
    ///      swappable pointer would let rewards be paid against a foreign (or
    ///      empty) stamina ledger.
    StakingManager public immutable stakingManager;

    /// @notice Address whose EIP-712 signatures are accepted as claims.
    /// @dev This is the backend Judge (PRD 3.2): it runs the Anti-Cheat
    ///      Engine, and on a pass it signs the reward/stamina statement that
    ///      this contract settles. It is a pure *attester* role — it can mint
    ///      (indirectly, by signing) and it can burn stamina, but it holds no
    ///      token custody, no owner powers and no ability to move principal.
    ///      The owner rotates it with `setSigner`.
    address public signer;

    /// @notice Single-use markers for mined sessions, keyed by user then nonce.
    /// @dev Nonces are assigned by the backend and must be UNIQUE PER USER,
    ///      but they need not be sequential or ordered: uniqueness is the
    ///      entire security property, so a backend that issues them from a
    ///      counter, a database row id, or a random source is equally correct.
    ///      Strictly sequential per-user nonces (with a "next expected nonce"
    ///      check, which would also bound mapping growth) are a possible future
    ///      hardening item, deliberately deferred for the MVP because they
    ///      would let a single griefed future nonce block every later claim.
    ///
    ///      A USED NONCE IS BURNED FOREVER. There is no expiry, no reuse, no
    ///      refund and no admin override: `usedNonces[user][nonce]` is written
    ///      to `true` and can never return to `false`. This is intentional and
    ///      is the desired anti-replay semantics — a nonce that has paid out
    ///      once must never pay out again for the lifetime of the deployment.
    ///      The practical consequence is that a nonce griefed by a third party
    ///      (by submitting the user's own valid claim early) is unusable for
    ///      all time; the user simply asks the backend for a fresh nonce.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    /// @notice Emitted for every settled mining claim.
    /// @param user Account the reward was minted to; also the account whose
    ///        stamina was debited.
    /// @param reward Amount of CATT minted, in 18-decimal base units.
    /// @param staminaCost Stamina points debited from `user`.
    /// @param nonce Backend-issued nonce consumed by this claim. Permanently
    ///        burned once this event is observed.
    /// @param signer Address whose signature authorized the claim; equal to
    ///        the `signer` role at execution time.
    event RewardClaimed(address indexed user, uint256 reward, uint256 staminaCost, uint256 nonce, address indexed signer);

    /// @notice Emitted when the authorized signer is changed.
    /// @param previousSigner The signer that was active before the change.
    /// @param newSigner The signer that is active after the change.
    event SignerUpdated(address indexed previousSigner, address indexed newSigner);

    /// @notice Thrown when a token, staking manager or signer address is `address(0)`.
    /// @dev The zero address is never a valid actor here: a zero token or
    ///      manager would make the deployment permanently unusable, and a zero
    ///      signer would brick every claim (or worse, be an address whose key
    ///      nobody controls, so no signature could ever verify).
    error ZeroAddress();

    /// @notice Thrown when a well-formed signature recovers to an address that
    ///         is not the current `signer`.
    /// @dev Only covers the "signed by the wrong key" case. A malformed
    ///      `signature` does NOT reach this error: `ECDSA.recover` itself
    ///      reverts with OpenZeppelin's `ECDSAInvalidSignature` (or
    ///      `ECDSAInvalidSignatureLength`) before any comparison happens, and
    ///      that revert is deliberately NOT caught or wrapped. See
    ///      `claimReward` for why.
    /// @param expectedSigner The `signer` the contract currently trusts.
    /// @param recoveredSigner The address the submitted signature recovered to.
    error ClaimSignatureInvalid(address expectedSigner, address recoveredSigner);

    /// @notice Thrown when a claim arrives after its signed deadline.
    /// @param deadline The signed expiry timestamp that was passed.
    /// @param currentTime `block.timestamp` at execution, i.e. how late it is.
    error ClaimExpired(uint256 deadline, uint256 currentTime);

    /// @notice Thrown when a nonce has already been spent for this user.
    /// @param user The user whose nonce space was hit.
    /// @param nonce The already-consumed nonce.
    error ClaimAlreadyUsed(address user, uint256 nonce);

    /// @notice Thrown when ECDSA recovery fails outright, i.e. yields the
    ///         zero address or is otherwise unusable.
    /// @dev Kept as a distinct, explicit signal for a dead signature rather
    ///      than folding it into `ClaimSignatureInvalid`, so an indexer can
    ///      tell "wrong key" apart from "no key at all". Malformed signature
    ///      BYTES are a separate case again: OpenZeppelin's `ECDSA.recover`
    ///      rejects them itself and reverts with its own `ECDSAInvalidSignature`
    ///      before this contract can observe anything.
    error InvalidSignature();

    /**
     * @notice Deploys the mining claimer against a CATT token and a StakingManager.
     * @dev The signer is supplied at construction rather than left unset, so
     *      the contract is usable the moment it is deployed. All three
     *      addresses must be non-zero or the deployment reverts.
     *
     *      Emits `SignerUpdated(address(0), initialSigner_)` so an indexer
     *      sees a genesis value for the role instead of having to infer it
     *      from the constructor arguments, matching the pattern used by
     *      `StakingManager`'s `claimer`.
     * @param cattToken_ Address of the `CATT` ERC20 token to mint rewards from.
     * @param stakingManager_ Address of the `StakingManager` to debit stamina from.
     * @param initialSigner_ Address of the backend Judge (PRD 3.2) whose
     *        signatures are accepted.
     */
    constructor(address cattToken_, address stakingManager_, address initialSigner_)
        EIP712("CATT Protocol", "1")
        Ownable(msg.sender)
    {
        if (cattToken_ == address(0)) revert ZeroAddress();
        if (stakingManager_ == address(0)) revert ZeroAddress();
        if (initialSigner_ == address(0)) revert ZeroAddress();

        cattToken = CATT(cattToken_);
        stakingManager = StakingManager(stakingManager_);
        signer = initialSigner_;

        emit SignerUpdated(address(0), initialSigner_);
    }

    /**
     * @notice EIP-712 digest the backend, the frontend and the tests must all
     *         be signing for the given claim parameters.
     * @dev Exposed deliberately, as the single source of truth for the exact
     *      bytes a signature must cover. The backend should build its digest
     *      independently and the test suite can assert equality against this
     *      value; if the two ever disagree, the mismatch is a bug in the
     *      encoders, not something a user should discover on-chain.
     *
     *      Reads `block.chainid` and `address(this)` live, so the digest
     *      returned here is the digest that will be checked at execution time
     *      on the current chain. On any other chain, or against any other
     *      `MiningClaimer` deployment, the domain separator differs and a
     *      signature produced for this digest will not recover to the signer.
     * @param user Account the reward is for and whose stamina is charged.
     * @param reward CATT amount to mint, in 18-decimal base units.
     * @param staminaCost Stamina points to debit from `user`.
     * @param nonce Backend-issued, per-user-unique claim nonce.
     * @param deadline Unix timestamp after which the claim is no longer valid.
     * @return digest The final EIP-712 digest, i.e. `keccak256(0x1901 || domainSeparator || structHash)`.
     */
    function hashClaim(address user, uint256 reward, uint256 staminaCost, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32 digest)
    {
        digest = _hashTypedDataV4(_claimStructHash(user, reward, staminaCost, nonce, deadline));
    }

    /**
     * @notice Whether the given nonce has already been spent by `user`.
     * @dev Thin, self-documenting alias over the public `usedNonces` mapping,
     *      provided so the frontend can ask the question in the same
     *      vocabulary the claim flow uses. Read-only: it cannot be used to
     *      consume a nonce.
     * @param user Account whose nonce space is being queried.
     * @param nonce The nonce to test.
     * @return used True if the nonce was already consumed; false if it is still available.
     */
    function isNonceUsed(address user, uint256 nonce) external view returns (bool used) {
        used = usedNonces[user][nonce];
    }

    /**
     * @notice Settles one signed mining claim: debits `staminaCost` stamina from
     *         `user` and mints `reward` CATT to `user`.
     *
     * @dev `user` IS INTENTIONALLY INDEPENDENT OF `msg.sender`. The user
     *      submits (or a relayer submits on their behalf, which is what makes
     *      the PRD 3.2 "Gasless transaction" flow possible), but the reward
     *      ALWAYS goes to `user` and the stamina is ALWAYS debited from
     *      `user`. This is safe precisely because `user` is part of the signed
     *      struct hash: a third party can trigger a claim, but can only ever
     *      trigger a payout to the address the backend actually signed for, and
     *      can never redirect it. There is no "claim on behalf of" variant
     *      that would break this, and none is provided.
     *
     * @dev CHECK ORDER, which is deliberate:
     *      0. `user != address(0)`. Checked first because every later step
     *         dereferences `user`; a zero user would burn stamina against the
     *         zero address, which is unrecoverable.
     *      1. SIGNATURE. The EIP-712 digest is rebuilt from the call arguments
     *         and recovered, then compared against `signer`. This is the
     *         authorization gate, so it is evaluated before any state read or
     *         write: an unauthorized caller must not be able to burn a nonce,
     *         probe `usedNonces`, or make the contract do work on its behalf.
     *         Note the two distinct failure shapes, deliberately NOT merged:
     *         a MALFORMED signature (bad length, invalid `s`/`v`) makes
     *         `ECDSA.recover` revert with OpenZeppelin's own
     *         `ECDSAInvalidSignature`, which is not caught or wrapped here so
     *         the revert reason stays the library's; a well-formed signature
     *         from the WRONG KEY recovers successfully and surfaces as this
     *         contract's `ClaimSignatureInvalid(signer, recovered)`.
     *      2. DEADLINE, using a strict `>`: a claim is valid while
     *         `block.timestamp <= deadline`, so the backend controls the exact
     *         expiry instant, down to and including the deadline second.
     *      3. NONCE, checked after the signature because an unused, validly
     *         signed nonce is a normal user action while a replayed one is an
     *         attack, and the attacker cannot even reach this check without a
     *         valid signature. Checked before any write so a double-spend is
     *         rejected rather than self-healing.
     *
     *      EFFECTS BEFORE INTERACTIONS: `usedNonces[user][nonce]` is set to
     *      `true` BEFORE `consumeStamina` and `mint` are called. So a
     *      re-entrant call (or any external observer mid-call) can never see
     *      the nonce as available again, and the mint is only ever reached
     *      through an already-burned nonce. If `consumeStamina` or `mint`
     *      reverts — insufficient stamina, the hard cap reached, the owner role
     *      not yet granted — the ENTIRE transaction reverts, including this
     *      write, so the nonce is released again. That is correct and intended:
     *      a nonce is only permanently burned when a reward was actually paid
     *      for it, and a failed claim leaves the user free to retry.
     *      `nonReentrant` is a second, independent barrier on top of this.
     *
     *      There is no partial settlement: `consumeStamina` and `mint` are
     *      both required to succeed, so a reward is never minted without the
     *      stamina having been consumed and stamina is never consumed without
     *      the reward being minted.
     *
     *      This contract must hold the CATT `Ownable` role (it is the sole
     *      minter after deployment) AND the `StakingManager.claimer` role. See
     *      the DeploymentNotes block above for the required ordering, and
     *      note in particular that initial allocations MUST be minted by the
     *      deployer BEFORE CATT ownership is transferred here, since after the
     *      transfer the deployer can no longer mint and this contract has no
     *      other mint path.
     *
     * @param user Account the reward is minted to and whose stamina is
     *        debited. Intentionally independent of `msg.sender`.
     * @param reward Amount of CATT to mint, in 18-decimal base units.
     * @param staminaCost Stamina points to debit from `user`.
     * @param nonce Backend-issued nonce, unique per `user`, consumed forever
     *        by a successful call.
     * @param deadline Unix timestamp after which this claim is rejected; the
     *        claim is valid while `block.timestamp <= deadline`.
     * @param signature The backend's EIP-712 signature over
     *        `hashClaim(user, reward, staminaCost, nonce, deadline)`.
     */
    function claimReward(
        address user,
        uint256 reward,
        uint256 staminaCost,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        // 0. A zero user would burn stamina to an unrecoverable address.
        if (user == address(0)) revert ZeroAddress();

        // 1. Authorization: rebuild the digest from the call arguments and
        //    recover. Malformed bytes revert inside `ECDSA.recover` with
        //    OpenZeppelin's `ECDSAInvalidSignature`; a well-formed signature
        //    from the wrong key is reported as `ClaimSignatureInvalid`.
        bytes32 structHash = _claimStructHash(user, reward, staminaCost, nonce, deadline);
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (recovered == address(0)) revert InvalidSignature();
        if (recovered != signer) revert ClaimSignatureInvalid(signer, recovered);

        // 2. Expiry. Strict `>`, so the claim is valid through `deadline`
        //    itself and expires on the following second.
        if (block.timestamp > deadline) revert ClaimExpired(deadline, block.timestamp);

        // 3. Replay: the nonce must not have been spent by this user before.
        if (usedNonces[user][nonce]) revert ClaimAlreadyUsed(user, nonce);

        // 4. EFFECTS FIRST. The nonce is burned before any external call, so
        //    it cannot be consumed twice even if a downstream call re-enters
        //    or the downstream call fails. A revert below unwinds this write
        //    together with the rest of the transaction, releasing the nonce,
        //    which is correct because no reward was paid for it.
        usedNonces[user][nonce] = true;

        // 5. INTERACTIONS. Both must succeed or the whole claim reverts; there
        //    is no path that pays stamina without minting or vice versa.
        stakingManager.consumeStamina(user, staminaCost);
        cattToken.mint(user, reward);

        emit RewardClaimed(user, reward, staminaCost, nonce, signer);
    }

    /**
     * @notice Points `newSigner` as the address whose claim signatures are
     *         accepted, replacing the previous one atomically.
     * @dev ROTATION TAKES EFFECT IMMEDIATELY AND WITHOUT ANY GRACE PERIOD.
     *      A signature produced by the previous signer stops verifying the very
     *      next block: there is no pending-signature buffer, no overlap window
     *      and no "old key still good for N seconds" allowance, because the
     *      signature check compares against the `signer` value read in the same
     *      transaction, and that value is the new one from the block after this
     *      call is mined. In-flight claims signed by the outgoing key simply
     *      revert with `ClaimSignatureInvalid`. This is the intended
     *      emergency-revocation behaviour for a compromised backend Judge: the
     *      fastest possible kill switch beats a graceful handover, and the
     *      cost of a reverting claim is only the user's gas for a retry with a
     *      freshly signed nonce.
     *
     *      The trade-off is stated rather than hidden: rotating the signer
     *      invalidates every unclaimed signature from the old key, so the
     *      backend should sign short-lived deadlines (or hold a small queue of
     *      unsigned claims) so a planned rotation does not strand users
     *      mid-loop. Revoking an attacker is worth far more than preserving a
     *      handful of in-flight claims.
     *
     *      Reverts with `ZeroAddress` on the zero address so the role can never
     *      be left unset, which would brick every future claim and permanently
     *      freeze mining with no way to fix it.
     * @param newSigner Address to trust. Must not be `address(0)`.
     */
    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();

        address previous = signer;
        signer = newSigner;

        emit SignerUpdated(previous, newSigner);
    }

    /**
     * @notice Builds the EIP-712 struct hash for a mining claim.
     * @dev THE single place where the struct hash is constructed. Both
     *      `claimReward` (which signs) and `hashClaim` (which publishes the
     *      expected digest) route through this helper, so the bytes a user is
     *      asked to submit a signature for and the bytes the contract actually
     *      verifies are structurally incapable of drifting apart.
     *
     *      The field order MUST match the `ClaimReward(...)` type string
     *      encoded in `CLAIM_REWARD_TYPEHASH` exactly: `user`, `reward`,
     *      `staminaCost`, `nonce`, `deadline`.
     * @param user Account the reward is for and whose stamina is charged.
     * @param reward CATT amount to mint, in 18-decimal base units.
     * @param staminaCost Stamina points to debit from `user`.
     * @param nonce Backend-issued, per-user-unique claim nonce.
     * @param deadline Unix timestamp after which the claim is no longer valid.
     * @return structHash The EIP-712 struct hash for these parameters.
     */
    function _claimStructHash(address user, uint256 reward, uint256 staminaCost, uint256 nonce, uint256 deadline)
        private
        pure
        returns (bytes32 structHash)
    {
        structHash = keccak256(
            abi.encode(
                CLAIM_REWARD_TYPEHASH,
                user,
                reward,
                staminaCost,
                nonce,
                deadline
            )
        );
    }
}
