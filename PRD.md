# PRODUCT REQUIREMENTS DOCUMENT (PRD)
**Project Name:** CATT Protocol
**Ticker:** $CATT
**Version:** 1.0 (MVP)
**Target Launch:** Q3 2024

## 1. EXECUTIVE SUMMARY
CATT Protocol is a Web3 "Learn-to-Earn" platform built on the Attention Economy. Users monetize their focused attention (reading educational content and passing comprehension quizzes) to mine $CATT tokens. Unlike traditional P2E projects that suffer from hyperinflation, CATT implements strict deflationary tokenomics, hardware-level anti-cheat mechanisms, and B2B-sponsored Real Yield Bonds. The core philosophy: "Yield your Attention, Harvest your Cognition."

## 2. CORE PROBLEM & SOLUTION
*   **Problem:** Traditional crypto airdrops and mining apps are exploited by bots/emulators. Furthermore, most P2E economies collapse because token printing outpaces real demand.
*   **Solution:** 
    1.  **Proof-of-Attention:** Mining is verified through reading time, micro-interactions, and hardware telemetry.
    2.  **Hardware Anti-Cheat:** Utilizing battery temperature, touch telemetry (swipe speed/coordinates), and gyroscope/accelerometer data to detect emulators.
    3.  **Deflationary Tokenomics:** Tiered Staking for Stamina and a "Drip Unstaking" mechanism to prevent market dumps.
    4.  **Real Yield:** Token value is backed by B2B sponsors paying for educational article distribution.

## 3. CORE PRODUCT FEATURES (MVP)

### 3.1 Mobile Application (Client-Side)
*   **Bounty Board:** Gamified UI displaying reading missions (Easy, Medium, Hard/Sponsored).
*   **Reading Interface:** Article viewer with randomized paragraph ordering and randomized "Focus Traps" (e.g., swipe to continue, tap an image) to defeat auto-scrollers.
*   **Validation:** Quizzes and text-highlighting tasks post-reading.
*   **Telemetry Collection:** Silent background collection of battery temperature, screen-on time, and touch coordinates (X,Y) sent to the backend every 5 seconds.

### 3.2 Backend Server (The Judge)
*   **Content Randomizer:** API that shuffles article structures per user session.
*   **Anti-Cheat Engine:** 
    *   Analyzes reading speed vs. comprehension accuracy.
    *   Checks battery temperature anomalies (to detect server farms/emulators).
    *   Detects pixel-perfect bot touches vs. human micro-movements.
*   **Signature Generator:** If user passes validation, backend generates a cryptographic signature allowing the user to claim $CATT via Smart Contract (Gasless transaction).

### 3.3 Blockchain & Tokenomics ($CATT)
*   **Stamina System:** Users need "Stamina" to mine daily.
*   **Tiered Staking:** To replenish Stamina, users must stake $CATT. The required staking percentage increases per level (Level 1: 10%, Level 2: 15%, +5% per level).
*   **Drip Unstaking (Anti-Dump):** Users cannot unstake 100% at once. Max unstake is 10% of staked amount, with an 84-hour (3.5 days) cooldown between requests.
*   **Real Yield Bonds:** Users can lock $CATT into Bonds (30/90/180 days) to earn yields generated from B2B sponsor revenues, not token inflation.

### 3.4 Token Allocation

The hard cap `MAX_SUPPLY` of **100,000,000 $CATT** is split into a **60,000,000 genesis mint** plus a **40,000,000 mining emission budget** that is minted gradually on-chain, one signed mining reward at a time, by `MiningClaimer`.

| bucket | amount | % of `MAX_SUPPLY` (100M) | % of genesis (60M) |
|---|---|---|---|
| Team vesting | 15,000,000 | 15.0% | 25.00% |
| Treasury | 20,000,000 | 20.0% | 33.33% |
| Marketing | 15,000,000 | 15.0% | 25.00% |
| DEX liquidity | 10,000,000 | 10.0% | 16.67% |
| **genesis total** | **60,000,000** | **60.0%** | **100%** |

Mining headroom is **40,000,000 $CATT** (40% of `MAX_SUPPLY`) and is **never minted at genesis**; it is the emission budget `MiningClaimer` draws from.

The genesis mint is deliberately below `MAX_SUPPLY` because mining claims mint *on top of* genesis: after the genesis allocation, `MiningClaimer` is the sole minter, so a full-cap (100,000,000) genesis mint would leave zero headroom and make **every** claim revert with `MintExceedsMaxSupply`. 60% of the cap is in circulation at genesis, and the remaining 40% is what mining has to live within.

## 4. TECH STACK ARCHITECTURE
*   **Mobile Frontend:** Flutter (Cross-platform, optimized for mid-range Android).
*   **Backend:** Node.js / Express, Supabase (PostgreSQL) for user data.
*   **Blockchain:** Polygon (MATIC) for low gas fees & Meta-Transactions.
*   **Smart Contracts:** Solidity ^0.8.20, OpenZeppelin, Hardhat for local testing.

## 5. AI ORCHESTRATION RULES & CONSTRAINTS (MANDATORY FOR AI AGENTS)
*   **Rule 1 (Security First):** AI must prioritize Smart Contract security. All financial logic (Staking, Unstaking, Bonds) must include Reentrancy Guards and strict timestamp validations.
*   **Rule 2 (No Hardcoded Keys):** AI must NEVER hardcode private keys or API secrets in the source code. Use `.env.example` templates.
*   **Rule 3 (Modular Code):** AI must separate mobile UI logic, backend anti-cheat logic, and smart contract logic strictly into their respective monorepo folders (`/mobile-app`, `/backend-server`, `/smart-contracts`).
*   **Rule 4 (Testing Mandatory):** AI must generate unit tests for all Solidity functions, especially the 84-hour cooldown logic and tiered staking math.

## 6. USER FLOWS (Happy Path)
1.  **Onboarding:** User connects wallet, selects interest topics.
2.  **Mining Loop:** User selects Mission -> Reads Article (triggers telemetry) -> Hits Focus Trap -> Passes Quiz -> Backend signs transaction -> User claims $CATT.
3.  **Staking Loop:** User runs out of Stamina -> Prompted to Stake 10% of balance -> Smart Contract locks tokens -> Stamina replenished.
4.  **Exit Loop:** User requests unstake -> Receives 10% -> Timer resets for 84 hours.

## Design Decisions & Known Limitations

The following are deliberate design decisions and accepted limitations of the MVP, recorded here so that they are not later mistaken for oversights. Each is covered by unit tests.

**1. The 84-hour unstake cooldown is per-address.** All cooldown and tier state in `StakingManager` is keyed by `msg.sender`, so a user who splits a position across several addresses gets several independent 10%-per-84h clocks and several independent level counters. The on-chain cooldown is therefore a BACKSTOP, not the primary control: sybil resistance is enforced off-chain by the Wave-4 identity gate, and the on-chain rule exists to bound the damage if that gate is bypassed. Accepted for MVP; on-chain identity/minting gating is a post-MVP hardening item.

**2. The stake tier curve saturates via geometric attrition.** Because the requirement is a percentage of the caller's *remaining spendable* balance, each successful stake removes 10-90% of what is left, so the requirement floors to zero and further staking becomes impossible after roughly 35 consecutive stakes from any practical starting balance. The escalation is accepted as-is for the MVP; a minimum-stake floor or a non-percentile cost curve is deferred.

**3. Bond principal has no early exit and the yield pool has no owner rescue.** `withdrawPrincipal` always reverts and there is deliberately no owner sweep function, so sponsor deposits can only ever reach bondholders. The trade-off is that funds are unrecoverable if bonds never mature. Accepted in favour of bondholder safety.

**4. Bond yield is pro-rata by `principal * tierWeight` using a checkpointed reward-per-point accumulator**, so a bond only ever earns from deposits made while it is open, and rounding dust is retained in the contract as `unallocatedYield` rather than redistributed (redistribution would retroactively re-price already-settled bonds).

Two clarifications on that last decision, both enforced on-chain and by test:

* A bond's `accSnapshot` is taken at *creation* and is never moved again — not by a claim, not by a redemption. It records "when this bond joined", never "when this bond was last paid", so a bond keeps earning on exactly the same points after being paid. What prevents a repeated claim from re-paying the same accrual is a separate deduction of the already-paid `accruedYield` inside the claimable-yield view, not any movement of the checkpoint.
* Because the accumulator is 1e18-scaled and denominated in the yield token's own base units, the yield token is decimals-agnostic: the same accounting works unchanged against a 6-decimal stablecoin and an 18-decimal one. Integer truncation on every deposit is bounded and reported as `unallocatedYield`, and the pool is always fully accountable: the contract's stablecoin balance equals the retained dust plus the yield still claimable, and every deposited unit is either still held, already paid out, or retained as dust.

## Mainnet Gates

This section records what MUST exist and be verified before CATT Protocol handles real money. It is a gate list, not a status log — do not mark anything as satisfied that is not.

Each gate below is a concrete, checkable requirement followed by its current honest status. None of them are closed.

### 1. Seed-phrase backup flow — NOT IMPLEMENTED

**Requirement.** Before real funds, a user who loses or wipes their device must be able to export a recovery phrase and re-import it on a replacement device, restoring the same wallet and the same mining history attribution. Losing the key must be a documented, accepted risk with a stated user-facing warning — not an afterthought discovered after a support ticket.

**Status.** NOT IMPLEMENTED. The mobile app generates a local wallet and stores the private key in `flutter_secure_storage`. There is no seed-phrase display, no export, and no import anywhere in the codebase. A user who loses their device today loses the wallet and every claim that wallet could ever have made, permanently and unrecoverably, and the app gives them no warning that this is the case. This is the single largest gap between "a working testnet client" and "a product that holds user money", and it is open.

### 2. Verified release APK — DEBUG BUILD ONLY, NO RELEASE ARTIFACT

**Requirement.** A signed release build (`flutter build appbundle` or `flutter build apk --release`), reproducible from a pinned and recorded toolchain, with a verified signature (certificate fingerprint checked against an expected value) and a provenance check attesting the artifact was built from this commit. The full local recipe must live in the repository so any third party can reproduce the build.

**Status.** PARTIAL — and the part that is proven is narrower than it looks.

What IS now proven: `flutter build apk --debug` **does** assemble in this repository. A debug APK was produced (`mobile-app/build/app/outputs/flutter-apk/app-debug.apk`, ~155 MB, fat ABI), and that build is what proved the Android manifest and the Kotlin `MethodChannel` (`com.cattprotocol/battery`, `getTemperatureC` / `getLevelPercent` / `isTemperatureSupported`) correct — `aapt2 dump badging` reports package `com.cattprotocol.catt_app`, minSdk 24, targetSdk 36, compileSdk 36, the `android.permission.INTERNET` permission and the label `CATT Protocol`, and the `MainActivity` classes are present in the packaged DEX. `mobile-app/BUILD.md` records the complete local build recipe and the failures already solved.

What is NOT proven: a DEBUG build is not a release artifact. It is unminified, unshrunk, unsigned with a throwaway debug key, carries the debug signing identity, and is not the binary that would ever be distributed. No release build has been attempted, no keystore or signing configuration exists, no signature has been verified, and no provenance attestation exists. The `>=60` telemetry pass-threshold review (see gate 4) and the `mobile-app/BUILD.md` checklist remain cross-referenced open items: neither is closed by a debug build.

### 3. External contract audit — NONE PERFORMED

**Requirement.** An independent third-party audit of every Solidity contract in this repository — `CATT`, `TeamVesting`, `StakingManager`, `BondManager` and `MiningClaimer` — must be completed, and every finding must be remediated (or explicitly accepted in writing) before mainnet. The audit must explicitly cover, at minimum:

* the EIP-712 claim path (domain separator, nonce handling, signature replay, `usedNonces` and the role allowed to submit a claim);
* the checkpointed reward-per-point yield accounting (the `accSnapshot` semantics, the already-paid deduction, rounding dust as `unallocatedYield`, and the invariant that the contract's yield-token balance always equals retained dust plus claimable yield);
* the role separation between the CATT owner, the `StakingManager` claimer, the backend signer and the relayer — i.e. which key, if any, can cause unbounded value movement, and what happens if each is compromised independently.

**Status.** NOT STARTED. No Solidity contract in this repository has been audited by anyone, inside or outside the team. The contracts are covered by a 167-test local Hardhat suite written by the same authors as the contracts, which is not an audit and must not be presented as one. Nothing in this repository may be described as audited.

### 4. Real telemetry distribution review for the `>=60` pass threshold — NO REAL-DEVICE DATA

**Requirement.** A study of genuine device telemetry, gathered from real handsets across the low end of the Android market, must confirm that the chosen thresholds neither reject honest low-end devices nor admit emulators. As part of that study the fate of the `FLATLINE_DISQUALIFIES` policy must be decided explicitly.

**Status.** NOT STARTED. The `>=60` pass threshold (`TELEMETRY_PASS_SCORE`), every individual flag penalty (including the `BATTERY_FLATLINE` -40, `BATTERY_IMPOSSIBLE` -30, `PIXEL_PERFECT_TOUCH` -25, `INHUMAN_SCROLL_SPEED` -20, `BOT_LIKE_SEQUENCE` -100 and `BATTERY_NOT_REPORTED` 0), and the flatline disqualification rule were all chosen from synthetic fixtures written by the same people who wrote the scorer. Not one real-device sample has ever been scored. The `FLATLINE_DISQUALIFIES` policy in particular is a brand-new hardening change (a lone flatline used to score exactly 60 and pass; it is now disqualifying regardless of score) and it is entirely unvalidated against real hardware drift — including the legitimate case of a genuinely cool, thermally-stable device whose battery temperature barely moves over a session. Before mainnet, either the policy must be validated against real data or the exact conditions under which a constant temperature is legitimate must be enumerated and encoded.

### Known residual weaknesses proved by the red-team pass

These are open defects, not accepted trade-offs. They are recorded here so that they cannot be rediscovered later and mistaken for new findings, and because each one is a gate in its own right before mainnet.

**5. Concurrent relay race burns relayer gas — OPEN.** Two simultaneous `POST /api/relay` calls for the same nonce BOTH reach the chain: two broadcasts, one settles, one reverts with `ClaimAlreadyUsed`, and the observed HTTP statuses are `[200, 502]`. There is **no double mint** — the contract's `usedNonces` check neutralises the race — but the relayer pays gas for the losing broadcast, and which racer receives the 200 versus the 502 is a coin flip the client cannot distinguish from a genuine failure. The cause is deliberate: the double-relay guard is re-checked *after* the broadcast, so that a connection which dies mid-flight leaves the claim recorded rather than replayable. The fix is a per-nonce in-flight mutex taken before the broadcast; that trade-off must be made deliberately before mainnet, not by accident.

**6. Syndicate detector: the false positive against an honest repeat submitter is now CLOSED; the evasion is still OPEN.** This item was previously recorded as wholly open and partly of that is now stale. `listRecentSubmissions` has gained an optional `excludeUserAddress` filter, implemented in BOTH the memory adapter (`storage.js`) and the SQLite adapter (`sqlite-store.js`), and `POST /api/submit` now passes the submitted `user` as `excludeUserAddress`. A submitter's OWN submissions are therefore invisible to its own comparison. Three states, each measured:

* **False positive against an honest repeat submitter — CLOSED.** The same account resubmitting identical text now **passes**, with a distinct nonce, instead of being refused on the second attempt as `SYNDICATE_MATCH` at similarity exactly 1.0 with no signature issued. Writing the same thing twice is no longer punished.
* **Cross-account ring detection — PRESERVED.** Verified: five distinct accounts submitting identical text yield exactly **one** reward issued; the other four are refused. Similarity against the ring is exactly **1.0**. Excluding only the caller's own rows does not weaken the detector, because a syndicate is by definition composed of rows the caller does not own.
* **Evasion — STILL OPEN.** The `>0.9` similarity bar still survives word-order permutation (**1.0000**), case and punctuation changes (**1.0000**), one synonym swap (**0.9836**), two synonym swaps (**0.9677**) and one dropped word (**0.9831**) — but a wholesale rewrite scores **0.1277** and is not caught. Any ring disciplined enough to paraphrase still walks straight through. The corpus is also still only the last **50** submissions, so a ring that spaces its submits past that window remains invisible regardless of wording.

Excluding the caller's own rows costs an attacker marginally **more** window slots, not fewer: a ring of `k` members sharing a window now occupies `k-1` slots rather than `k`, because no member can see its own row. That is a negligible change and is not a meaningful new attack surface. The 50-row corpus bound is a **pre-existing limitation, not a hole introduced by this fix** — it is unchanged by it. The remaining open decision is how to catch the paraphrasing ring, and that has to be made on evidence rather than left as it stands.

### Known single-point-of-defence: `staminaCost = 0`

**7. `StakingManager`'s `ZeroAmount` guard is the ONLY on-chain defence against a zero-cost claim — CLOSED at the authoring layer, STILL OPEN at the contract layer.** There is now a second, independent `staminaCost > 0` validation, and it runs before a bad mission can ever exist at runtime. `content.js` exports `validateMission` / `validateContent` and a custom `InvalidMissionContent` error whose `.code` is `CONTENT_INVALID_MISSION` (mission) or `CONTENT_INVALID_ARTICLE` (article). Validation runs at **MODULE LOAD** — the final statement of `content.js` is `validateContent({ missions: MISSIONS, articles: ARTICLES })` — and is deliberately **NOT** wrapped in try/catch: a poisoned content file must **crash the Judge at boot** rather than silently serve a mission whose every claim would revert on-chain. Consequently a mission authored with `staminaCost = "0"` can no longer be loaded at all, and the livelock is closed at the authoring layer.

What this does NOT close is the original on-chain single point of defence. `StakingManager`'s `if (amount == 0) revert ZeroAmount();` in `consumeStamina` is still the ONLY contract-level check anywhere in the system that enforces `staminaCost > 0`; there is still no second check in the contract layer above it. Any value that reached the chain by a path other than the backend's validated content file would still pass it. A second, independent `staminaCost > 0` validation at the contract layer remains required before mainnet and is recorded as **OPEN**.

**8. Mission `staminaCost` is denominated in CATT base units while stamina is unitless points — the mining economy cannot currently settle a single claim — OPEN, CRITICAL.**

This is the most severe finding of the wave-8 tokenomics reconciliation. It is a **unit** defect, not a **sign** defect, and it silently disables the entire mining economy. Every one of the following is verifiable in the code:

* `StakingManager`'s own NatSpec states that stamina "is unitless and has no monetary value".
* `STAMINA_PER_STAKE = 50` stamina **points** are credited per successful `stakeForStamina`.
* `consumeStamina(account, amount)` requires `amount <= stamina[account]` and otherwise reverts `StaminaInsufficient`.
* But the three seeded missions in `backend-server/src/content.js` declare `staminaCost` as `1000000000000000000` / `2000000000000000000` / `3000000000000000000` — that is 1, 2 and 3 CATT expressed in **18-decimal base units**, not 1, 2 and 3 stamina points.

The cheapest mission therefore costs `1e18 / 50 = 2e16` successful stakes to cover, and no user can ever accumulate that much stamina. The consequence is unambiguous and total: **realised emission today is 0 CATT/day, no `claimReward` can ever settle, and the entire 40,000,000 mining headroom is completely untouched.** The mining loop described in §6 — submit, sign, claim — is inert.

Note explicitly that the new `staminaCost > 0` validation in `content.js` does **NOT** catch this, and could not: all three values are strictly positive. The defect is the UNIT, not the sign, so a positivity guard is the wrong instrument and the guard passing is **not** evidence of correctness. Item 7's authoring-layer closure must not be read as covering this.

This **invalidates the 40M headroom burn-down projection**. That projection's arithmetic remains valid as a statement about the reward side — what the contract would mint if claims settled — but it is **not a forecast of current behaviour** and must not be quoted as one. The emission schedule decision, including the 40M short-fall discussion, should therefore be **deferred until this unit mismatch is resolved**: fixing it changes how fast stamina is consumed per submission and therefore how fast the headroom drains, so choosing an emission schedule before the burn rate is correct would be choosing it on the wrong number.

The fix lives in `content.js` (backend seed data), **not** in a contract, so it does **not** require unfreezing the frozen contracts. It is nonetheless a tokenomics decision, because it sets the real exchange rate between attention and $CATT. It therefore requires an explicit human decision and is deliberately **not** made unilaterally here.
