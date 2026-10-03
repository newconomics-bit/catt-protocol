# ⚠️ NOT MAINNET-READY — TESTNET ONLY ⚠️

> **Everything in this document is about Polygon Amoy, a public testnet whose tokens
> have NO value and can be recreated by anyone at any time. No real funds are
> involved in any step below. Do not reuse any of this procedure on Polygon
> mainnet (chain id 137) or any other value-bearing chain.**
>
> Outstanding gates that must ALL be closed before anyone considers a mainnet
> deployment. None of them are closed today:
>
> 1. **External security audit** of all five contracts (`CATT`, `TeamVesting`,
>    `StakingManager`, `BondManager`, `MiningClaimer`). Nothing here has been
>    reviewed by a third party; only the repo's own test suite (167 tests) exists.
> 2. **Verified release APK** — only debug builds have been produced. The signed,
>    reproducible release artifact and its provenance are not done.
> 3. **Seed-phrase / key-custody backup flow** for end users (wallet recovery,
>    restore verification) is unimplemented.
> 4. **Telemetry threshold review** — the anti-cheat penalties and the
>    accept boundary (`score >= 60`) have not been tuned against real device
>    data; a lone battery flatline currently sits exactly on the pass line.
> 5. Real yield-token selection, a real sponsor revenue model, and an
>    operational plan for the irreversible bond pool (see below).
>
> Related reading: [`TESTNET_DEPLOYMENT.md`](./TESTNET_DEPLOYMENT.md) (the
> operator runbook) and [`../PRD.md`](../PRD.md) (tokenomics, Section 3.3).

---

# 1. What "liquidity" means here

Liquidity in this protocol is **three separate things**, and confusing them is
the most common operator mistake:

| Pool | What it holds | Who can withdraw | Where it goes |
|---|---|---|---|
| **DEX pair** (CATT / test-USDT) | CATT + test stablecoin, in a constant-product AMM | anyone who holds LP tokens | whoever holds the LP tokens |
| **Staking vault** (`StakingManager`) | CATT staked for Stamina | drip only: 10% per 84h, per address | the staker |
| **Bond pool** (`BondManager`) | the sponsor **yield token** (stablecoin), **not** CATT | **nobody. ever.** | bondholders, pro-rata |

This document covers the DEX pair (how to create it) and the bond pool (how it
is funded and why it is one-way). The staking vault is not a liquidity pool: it
is a lock with a drip release, and it has no admin withdrawal path either.

---

# 2. Pairing $CATT with a test stablecoin on Polygon Amoy

## 2.1 Testnet tokens have no value — read this first

* Polygon Amoy is a public testnet. Its tokens are worthless and are not backed
  by anything. Amoy can be reset, and it has been.
* Adding "liquidity" costs **test** POL (gas) and test tokens only.
* **No real funds are involved in any step of this document.** Never put real
  MATIC/POL, real USDT or any other real asset into an Amoy transaction, and
  never reuse a mainnet private key to sign one.
* A CATT/test-USDT price on Amoy is a **sandbox artefact**, not a valuation.
  It exists only so the app's swap path, slippage maths and wallet flows have
  something to talk to.

## 2.2 Which AMM to use

**There is no canonical Uniswap deployment on Polygon Amoy.** Uniswap's official
deployment list covers Polygon mainnet (chain id 137) only; Mumbai was deprecated
in 2024 and Amoy was never given first-party pools. Anyone quoting you an "Amoy
Uniswap router" address is quoting a third-party deployment that you must verify
yourself. Pick one of these, in order of preference:

1. **Deploy your own Uniswap V2 core + periphery to Amoy (recommended).**
   You then know the bytecode, you can read it, and you control the factory and
   router addresses. This is the standard way to get a pool on a chain that has
   no incumbent DEX, and it costs only test gas. Steps:
   * `git clone` the `Uniswap/v2-core` and `Uniswap/v2-periphery` repositories at
     a pinned tag, install their dependencies in `smart-contracts/` **or** in a
     separate throwaway Hardhat project outside this repository;
   * deploy `UniswapV2Factory` (from `v2-core/contracts/UniswapV2Factory.sol`)
     with `feeTo = address(0)` so the protocol fee stays off;
   * deploy `UniswapV2Router02` (from `v2-periphery/contracts/UniswapV2Router02.sol`)
     with the factory you just deployed, `WETH9` at the **Amoy** WETH address
     (verify it on the Amoy block explorer — do not copy the mainnet WMATIC
     address), and a treasury address of your choosing;
   * record both addresses. They belong in your operator notes, not in this
     repository.
2. **Use a third-party Amoy DEX only if you verify it.** Before trusting a
   router: confirm the verified source on the Amoy block explorer is genuine
   Uniswap V2 periphery, confirm the factory's `getPair(CATT, testUSDT)` returns
   the pair you expect, and prefer a UI you can inspect. An unverified router on
   a testnet can only cost you test tokens — but it can also silently swap
   against a fake pair and make your "liquidity" test meaningless.
3. **Skip the DEX entirely.** For wiring tests you do not need an AMM: transfer
   CATT and test stablecoin to a couple of test wallets and point the app at
   them. Use this when you are testing mining, staking or bonds, and only add a
   pool when you are specifically testing the swap path.

Whichever you choose, the pool needs a **stablecoin on Amoy**. There is no
mainnet USDT bridged to Amoy, so use one of:

* the `MockUSDT` deployed by the deploy script with `--mock-yield`
  (`smart-contracts/contracts/mocks/MockUSDT.sol`, 6 decimals, **permissionless
  and uncapped** — anyone can print it, which is exactly why it must never be
  used anywhere real);
* a stablecoin from an Amoy faucet / public Amoy token list (verify the address
  on the Amoy explorer; test tokens get deployed and abandoned constantly).

The mock is usually the better choice for a testnet because its address is in
your `deployed-testnet.json` manifest and its supply is under your control.

## 2.3 Adding the liquidity

V2 constant-product mechanics, with the router from §2.2:

1. **Move tokens to the LP wallet.** The deployer (or `LIQUIDITY_WALLET`) holds
   the 10,000,000 CATT genesis DEX liquidity allocation. Approve the router:
   `CATT.approve(router, amount)` and `testUSDT.approve(router, amount)`.
2. **Pick a ratio, not a price.** The genesis supply and the test float only
   exist so the pool can trade; there is no "fair" ratio. A wide, cheap pool
   (a large stablecoin side against the CATT side) makes the test trades
   predictable and stops a single swap from emptying the pool.
3. **Add liquidity** through the router's `addLiquidity(CATT, testUSDT, amountCATT,
   amountStablecoin, amountAMin, amountBMin, to, deadline)`. `to` is the wallet
   that receives the **LP tokens**. Add a deadline (a unix timestamp a few
   minutes out) — it is what protects you from a transaction that sits in the
   mempool.
4. **Read the minted LP amount** from the `LiquidityAdded` event, then verify
   `pair.balanceOf(you) > 0` and that the first `Sync` event shows the reserves
   you intended.
5. **Mint a test amount of the stablecoin to yourself** if you did not use the
   mock: the AMM needs both sides.

If you deploy the AMM by script instead of by UI, remember that `addLiquidity`
transfers **both** assets; approving only CATT reverts on the stablecoin leg.

## 2.4 Where the LP tokens go

**This is a real decision, not a detail.**

* **HOLD THEM IN A TEST WALLET YOU CONTROL, OFF THE DEPLOYER EOA.** The LP
  tokens are the only claim on the pool's reserves. Whoever holds them can
  withdraw everything.
* **Do not send LP tokens to the `MiningClaimer`, the `BondManager` or the
  `StakingManager`.** None of them can redeem LP tokens: they hold plain ERC20
  balances with no integration to an AMM. LP tokens sent to them are lost for
  good.
* **Do not send LP tokens to the `TeamVesting` contract.** It is a two-beneficiary
  linear vesting schedule with no third beneficiary and no recovery path; there
  is no way to register an LP holder, so the tokens would be permanently stuck.
* Burning LP tokens is optional and, for a testnet, pointless: it permanently
  reduces the pool's liquidity and there is no value to lock up. Lock the LP
  tokens in a time-locked contract instead if you want to *simulate* the
  promise.
* **Note it in your operator notes, not in git.** LP token addresses are
  wallet material; treat them like the deployer key.

---

# 3. Lending / staking liquidity note: how `BondManager.depositYield` is funded

## 3.1 What the pool actually holds

`BondManager` holds **the yield token (a stablecoin), never CATT**. Bondholders
lock CATT as *principal*; the *yield* they earn is paid in the sponsor's
stablecoin. So the "lending" leg of CATT Protocol is funded by **sponsor
revenue money**, not by minting tokens and not by selling CATT.

## 3.2 How a sponsor funds it

`depositYield(uint256 amount)` is `onlyOwner` and is the ONLY way into the pool:

1. The owner (the account that deployed the contracts — the sponsor treasury)
   holds the yield token and has already called
   `yieldToken.approve(bondManager, amount)`.
2. `bondManager.depositYield(amount)` pulls the tokens in and raises a
   checkpointed accumulator by `amount * 1e18 / totalPoints`.
3. Every currently open bond then earns pro-rata on
   `principal * tierWeight` (tiers 1/2/3 = 30/90/180 days at 1x/2x/3x weight).
   Bonds opened later only earn from deposits made while they are open — the
   `accSnapshot` taken at creation is never moved again.
4. Integer truncation residue is retained in the contract as
   `unallocatedYield` and is deliberately **not** redistributed, because
   redistributing it would retroactively re-price bonds that have already been
   settled. The invariant that matters: the contract's stablecoin balance always
   equals retained dust + yield still claimable.
5. Bondholders collect with `claimYield(bondId)` as often as they like (it is a
   collection, not an event: the term, the points and the checkpoint do not
   move) and take principal + final yield with `redeem(bondId)` at maturity.

## 3.3 IRREVERSIBILITY — read this before you deposit anything

**`depositYield` is ONE-WAY. There is deliberately no owner rescue, no sweep, no
refund, no pause, no way to withdraw the pool's balance.**

This is a documented design decision (PRD "Design Decisions & Known
Limitations" §3): the pool must never be ruggable by the very account that
funds it, and bond principal has no early exit either (`withdrawPrincipal`
always reverts). The price is that **funds are permanently unrecoverable if bonds
never mature**. Accepted in favour of bondholder safety.

Operator consequences, stated plainly:

* **Every deposit is final.** There is no "test amount, then undo". Do not fund
  the pool with anything you might want back, ever, including on testnet —
  because the habit is what will be repeated later.
* **A mistake in the amount is a mistake in the yield.** A 100x oversized
  `depositYield` permanently inflates every open bond's claim. It cannot be
  clawed back.
* **A deposit while NO bond is open reverts** with `NoActiveBonds` (there is no
  idle pool by design). The corollary matters for planning: **fund the pool
  AFTER users have opened bonds**, and prefer several smaller deposits over one
  large one, because a small number of deposits taken before the first bond
  cannot accrue to anyone retroactively but a deposit taken during a thin-bond
  window is spread very thin.
* **Deposits are not per-bond.** You cannot target a specific bondholder; the
  pro-rata split is automatic. That is the point of the accumulator.
* **Yield token choice is irreversible per deployment.** `BondManager`'s two
  token addresses are `immutable`; a wrong yield token cannot be replaced. The
  contracts are non-upgradeable and non-proxyable, so "fix it later" means
  "deploy a new `BondManager`, and migrate nothing — existing bonds stay in the
  old one".
* **Mock stablecoin on testnet:** with `MockUSDT` as the yield token, the pool
  pays out tokens anyone can mint at will. It exercises the accounting
  correctly (the accounting is decimals-agnostic: 6- and 18-decimal yield tokens
  behave identically) and proves nothing about real economics.

## 3.4 A safe testnet rehearsal

* Deploy with `--mock-yield` so the yield token address is in your manifest.
* Have at least one wallet `buyBond(amount, tier)` first, otherwise every
  `depositYield` reverts `NoActiveBonds`.
* Approve and deposit a small round number in the yield token's own base units
  (6 decimals for the mock: `1000 * 1e6`). Check `pendingYield(bondId)` and
  `claimYield(bondId)`, and confirm `unallocatedYield` behaves as documented.
* Do **not** try to undo it. There is no undo. That is the test.

---

# 4. What is NOT in this document

* No private keys, mnemonics, RPC credentials or real addresses.
* No live transactions were executed to produce it. Every command below is a
  template for you to run against Amoy with your own test keys.
* No invented fund values or valuations: the token amounts quoted are the
  protocol's own genesis allocation constants, not money.