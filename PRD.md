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
