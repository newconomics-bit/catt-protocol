# ⚠️ NOT MAINNET-READY — TESTNET DEPLOYMENT RUNBOOK ⚠️

> **This runbook deploys CATT Protocol to a public TESTNET (Polygon Amoy, chain
> id 80002). Testnet tokens have NO value, Amoy can be reset at any time, and NO
> step here involves real funds. Never run it against Polygon mainnet (chain id
> 137) or any value-bearing chain: the script aborts on a mainnet chain id
> unless you pass `--force`, and `--force` on a mainnet is not a supported
> operation at all.**
>
> Gates that must be closed before anyone treats this as production — see the
> full list at the top of [`TESTNET_LIQUIDITY.md`](./TESTNET_LIQUIDITY.md):
> external audit, verified release APK, seed-phrase backup flow, telemetry
> threshold review.
>
> Companion document: [`TESTNET_LIQUIDITY.md`](./TESTNET_LIQUIDITY.md) (DEX
> pairing and the bond-pool funding note).

---

## 0. What you are about to deploy

| Contract | Constructor | Role it ends up with |
|---|---|---|
| `CATT` | `(initialOwner)` | Owned by **`MiningClaimer`** — the sole minter of $CATT |
| `TeamVesting` | `(catt, teamBeneficiary, treasuryBeneficiary, 15e6e18, 20e6e18)` | Holds 15,000,000 CATT for the team leg (treasury leg is paid directly to the treasury wallet) |
| `StakingManager` | `(catt)` | `claimer` set to **`MiningClaimer`** |
| `BondManager` | `(catt, yieldToken)` | Holds sponsor yield token, no rescue |
| `MiningClaimer` | `(catt, stakingManager, backendSigner)` | Owns CATT; debits stamina on claims |

### The initial allocation

| Bucket | Amount | % of `MAX_SUPPLY` | % of genesis | Notes |
|---|---:|---:|---:|---|
| Team vesting | 15,000,000 CATT | 15.00% | 23.07% | locked: 1-year cliff, then 3 years linear |
| Treasury | 20,000,000 CATT | 20.00% | 30.76% | paid to `TREASURY_BENEFICIARY`; *registered* in `TeamVesting`'s schedule |
| Liquidity | 30,000,000 CATT | 30.00% | 46.15% | free float for the DEX pair |
| **Genesis mint** | **65,000,000 CATT** | **65.00%** | **100.00%** | the sum of the three rows above |
| Mining headroom | 35,000,000 CATT | 35.00% | — | never minted here; the mining emission budget |

Why genesis is 65M and not 100M: `MiningClaimer` becomes the **sole** minter
after the ownership transfer, and every mining reward mints *on top of* the
genesis supply. Minting the full `MAX_SUPPLY` at genesis would leave zero
headroom and make **every single claim revert** with `MintExceedsMaxSupply`. The
script refuses to run if you configure `INITIAL_SUPPLY` at or above
`MAX_SUPPLY`, and it prints both columns above so the split is auditable.
`INITIAL_SUPPLY` must also be `> 35,000,000` so the liquidity bucket is positive.

---

## 1. Prerequisites

```bash
cd smart-contracts
npm ci                 # node_modules is git-ignored; never commit it
npx hardhat compile    # ALWAYS run from inside smart-contracts/
npx hardhat test       # expect: 167 passing, 0 failing, 0 pending
```

> **Known hazard in this repo:** running `npx hardhat` from the repository root
> pulls `hardhat@3` from the registry and fails with `HHE22`. Always `cd
> smart-contracts` first.

Fund the deployer with **test** MATIC/POL from the Amoy faucet. `PRIVATE_KEY` is
read by `hardhat.config.js`; it accepts a comma-separated list of keys, and the
first one is the deployer.

---

## 2. Environment variables

The script reads **no** key material from disk beyond what `hardhat.config.js`
already loads (`.env` via `dotenv`). Copy `smart-contracts/.env.example` to
`smart-contracts/.env` (git-ignored) or export the variables in your shell.

### Required

| Variable | Meaning | Failure mode if wrong |
|---|---|---|
| `PRIVATE_KEY` | Deployer key, `0x` + 64 hex. Comma-separated for several keys; the first signs. Not needed on the in-process `hardhat` network. | script exits listing it as missing |
| `POLYGON_RPC_URL` | **Amoy** JSON-RPC endpoint (chain id 80002) | script exits listing it as missing |
| `SIGNER_ADDRESS` | Backend Judge address → `MiningClaimer.signer` | validated: must be `0x` + 40 hex and non-zero, else the script aborts before deploying anything. A typo here means **no user can ever claim** |
| `TEAM_BENEFICIARY` | 15,000,000 CATT vesting beneficiary | must be a valid address |
| `TREASURY_BENEFICIARY` | 20,000,000 CATT vesting beneficiary | must differ from `TEAM_BENEFICIARY` (`TeamVesting` reverts `DuplicateBeneficiary`) |
| `YIELD_TOKEN_ADDRESS` | Real stablecoin for `BondManager` | **Required unless you use the mock** (§3). Must not equal the CATT address |

### Optional

| Variable | Default | Meaning |
|---|---|---|
| `MOCK_YIELD` | `false` | `true` deploys `contracts/mocks/MockUSDT.sol` and uses it as the yield token. Test-only. |
| `LIQUIDITY_WALLET` | the deployer | Recipient of the 30,000,000 CATT liquidity allocation. The script warns loudly when it is unset. |
| `INITIAL_SUPPLY` | `65000000` | Genesis mint in whole CATT. `> 35000000`, `< 100000000`. |
| `DEPLOYMENT_OUTPUT` | `smart-contracts/deployed-testnet.json` | Where the manifest is written. **Deployment output — never commit it.** |
| `EXPECTED_CHAIN_ID` | `80002` | Chain id the deployment is expected to run on. Mismatch warns; a *mainnet* id aborts unless `--force`. |
| `FORCE` | `false` | `true` overwrites an existing manifest (see §5). |
| `DRY_RUN` | `false` | `true` deploys and verifies but writes no manifest. |
| `POLYGONSCAN_API_KEY` | — | Not used by the script; for source verification only. |

### Flags vs. environment variables

`hardhat@2`'s `run` task **rejects any argument it does not define**
(`Unrecognized param --mock-yield`), so under `npx hardhat run` use the env
equivalents above. The CLI flags are still parsed from `argv` and work when the
script is invoked directly with node (which compiles first):

```bash
node scripts/deploy-testnet.js --mock-yield --dry-run
```

---

## 3. Deploy

### 3a. Dry run against the in-process network (nothing is broadcast)

```bash
cd smart-contracts
SIGNER_ADDRESS=0x...  TEAM_BENEFICIARY=0x...  TREASURY_BENEFICIARY=0x... \
MOCK_YIELD=true DEPLOYMENT_OUTPUT=/tmp/deployed-testnet.json \
npx hardhat run scripts/deploy-testnet.js
```

This exercises every step of the wiring, prints the allocation table and the
verification results, and writes the manifest outside the repo.

### 3b. Real testnet deployment

```bash
cd smart-contracts
# .env holds PRIVATE_KEY, POLYGON_RPC_URL (Amoy), SIGNER_ADDRESS,
# TEAM_BENEFICIARY, TREASURY_BENEFICIARY, LIQUIDITY_WALLET
MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon
```

`hardhat.config.js` defines a single `polygon` network that reads
`POLYGON_RPC_URL` and `PRIVATE_KEY`; there is no separate Amoy network alias,
so **point `POLYGON_RPC_URL` at Amoy** and let the script's chain-id guard
(§4) confirm you got it. The script refuses to continue if the live chain id is
a known mainnet id and `--force` was not passed.

With a real stablecoin instead of the mock, drop `MOCK_YIELD` and set
`YIELD_TOKEN_ADDRESS` to a stablecoin you have verified on the Amoy explorer.

### Deployment order (why the script is not re-orderable)

`MiningClaimer`'s own `DeploymentNotes` NatSpec mandates this order, and the
script asserts it in a comment block above the deployment steps:

1. `(i)` mint **every** initial allocation **while the deployer still owns CATT**.
   After the transfer below, the deployer can never mint again and the claimer's
   only mint path is a *signed mining reward*, so any allocation minted later
   would be **permanently unmintable**.
2. `(ii)` `catt.transferOwnership(miningClaimer)` — the claimer becomes the
   **sole minter**.
3. `(iii)` `stakingManager.setClaimer(miningClaimer)` — the claimer becomes the
   only account that may debit stamina.
4. `(iv)` only now does `claimReward()` work end to end. Before (ii) a claim
   reverts `OwnableUnauthorizedAccount`; before (iii) it reverts
   `UnauthorizedClaimer`.

The script also funds `TeamVesting` with its 15,000,000 CATT **before** the
ownership transfer; without that, `claim()` reverts `InsufficientVestedBalance`
forever.

---

## 4. Verify the wiring

The script prints twelve checks and aborts if any fails. Re-check independently
after the fact with `cast` (Foundry) or any block explorer — on Amoy, use the
**Amoy** explorer, never the mainnet one:

```bash
export RPC=$POLYGON_RPC_URL

# 1. The claimer must be the CATT owner (sole minter)
cast call $CATT "owner()(address)" --rpc-url $RPC

# 2. The claimer must be the stamina claimer
cast call $STAKING "claimer()(address)" --rpc-url $RPC

# 3. The vesting contract must hold its 15,000,000 CATT
cast call $CATT "balanceOf(address)(uint256)" $VESTING --rpc-url $RPC

# 4. Total supply must equal the genesis mint and be <= MAX_SUPPLY
cast call $CATT "totalSupply()(uint256)" --rpc-url $RPC
cast call $CATT "MAX_SUPPLY()(uint256)" --rpc-url $RPC

# 5. The backend signer must match SIGNER_ADDRESS
cast call $CLAIMER "signer()(address)" --rpc-url $RPC

# 6. Cross-links inside the claimer
cast call $CLAIMER "cattToken()(address)" --rpc-url $RPC
cast call $CLAIMER "stakingManager()(address)" --rpc-url $RPC

# 7. The deployer must NO LONGER be able to mint (expect a revert)
cast send $CATT "mint(address,uint256)" $DEPLOYER 1 --private-key $PRIVATE_KEY --rpc-url $RPC
```

Expected: items 1 and 2 equal the `MiningClaimer` address; item 3 equals
`15000000000000000000000000`; item 4 equals your genesis mint
(`65000000000000000000000000` by default) and is below
`100000000000000000000000000`; item 7 reverts with `OwnableUnauthorizedAccount`.

Then point the backend at the deployment (`backend-server/.env`, keys already
documented in `backend-server/.env.example`):

```
CHAIN_ID=80002
MINING_CLAIMER_ADDRESS=<MiningClaimer>
SIGNER_PRIVATE_KEY=<key whose address is SIGNER_ADDRESS>
RELAYER_PRIVATE_KEY=<a separate hot key that only pays gas>
RPC_URL=<Amoy RPC>
```

---

## 5. `deployed-testnet.json`

```jsonc
{
  "generatedAt": "ISO-8601 timestamp",
  "network": { "name": "polygon", "chainId": 80002, "isLocalHardhatNetwork": false },
  "deployer": "0x...",
  "contracts": { "CATT": { "address": "0x...", "deployTx": "0x..." }, "...": {} },
  "constructorArguments": { "TeamVesting": ["0x...", "0x...", "0x...", "15...e18", "20...e18"] },
  "yieldToken": { "address": "0x...", "kind": "MOCK | REAL_FROM_ENV", "note": "..." },
  "initialAllocation": {
    "totalMinted": "65000000000000000000000000",
    "miningHeadroom": "35000000000000000000000000",
    "buckets": [ { "label": "team vesting", "amount": "...", "percentOfMaxSupply": "15.00%", "tx": "0x..." } ]
  },
  "wiring": { "transferOwnershipTx": "0x...", "setClaimerTx": "0x...", "verification": [ ... ], "allChecksPassed": true },
  "backend": { "signerAddress": "0x..." }
}
```

Reading it: `contracts.*.address` are the addresses to configure and verify;
`wiring.verification` is the machine-readable copy of the checks in §4;
`initialAllocation.buckets` proves the split sums to `totalMinted`.

**It is deployment output. Do not commit it.** It is not covered by the
repository's `.gitignore`, so either delete it after reading it, keep it outside
the repo (`DEPLOYMENT_OUTPUT=/tmp/...`), or add it to a local, uncommitted
ignore rule.

### Double-deployment guard

If the manifest already exists the script **REFUSES to run** (exit code 1,
nothing is deployed) and prints the previous network name. It never silently
overwrites, because the manifest is the only record of what is live. Override
deliberately with `--force` / `FORCE=true`, or write elsewhere with
`DEPLOYMENT_OUTPUT`.

---

## 6. Rolling the backend signer

`MiningClaimer.setSigner(newSigner)` is `onlyOwner`. **The owner is the
`MiningClaimer`'s owner — the deployer EOA — not the backend.** The backend only
ever holds the *signer* role, which is a pure attester: it can cause
`stamina -> reward` conversions, and nothing else.

```bash
# 1. generate the new Judge key OFFLINE, never on a shared machine
cast wallet new --json > new-judge.json      # or your HSM/KMS equivalent

# 2. rotate on-chain (deployer key)
cast send $CLAIMER "setSigner(address)" $NEW_SIGNER \
  --private-key $DEPLOYER_KEY --rpc-url $RPC

# 3. confirm
cast call $CLAIMER "signer()(address)" --rpc-url $RPC
```

Properties that matter operationally:

* **Rotation is immediate and has no grace period.** Every unclaimed signature
  from the old key stops verifying in the very next block; in-flight claims
  revert `ClaimSignatureInvalid`. Have the backend hold unclaimed signatures (or
  issue short deadlines) so a planned rotation does not strand users mid-loop.
  For an emergency revocation, take that cost immediately.
* `setSigner` refuses the zero address (that would brick every future claim
  permanently).
* Rotation does **not** recover burned nonces and does not disturb settled
  balances. A nonce that already paid out is dead for the life of the deployment;
  the user gets a fresh nonce.
* Update `backend-server/.env`'s `SIGNER_PRIVATE_KEY` to the new key. If
  `MINING_CLAIMER_ADDRESS` or `CHAIN_ID` change, the EIP-712 domain separator
  changes and **every existing signature becomes invalid** — treat a redeploy as
  a signer rotation plus a backend restart.

## 7. Rolling the relayer key

The relayer only pays gas; it never signs a claim, so a compromised relayer
cannot forge anything — it can only drain its own balance. Keep it separate from
the signer key and hot.

```bash
# 1. new hot key funded with test POL only
cast wallet new --json > new-relayer.json

# 2. update backend-server/.env
#    RELAYER_PRIVATE_KEY=<new key>

# 3. restart the Judge, then confirm the published address changed
curl -s localhost:PORT/api/relay/status     # returns the relayer ADDRESS only
```

`GET /api/relay/status` publishes the relayer's public address and never the
key. The old relayer's residual balance is simply stranded; withdraw it from the
old address if you care (it is test POL).

---

## 8. Rollback / re-deploy

There is **no rollback, no proxy, no upgrade and no migration.** The contracts
are non-upgradeable and non-initializable by design. Concretely:

* **Re-running the deploy script always deploys brand-new contracts at new
  addresses.** The previous deployment stays live with its state: its own CATT
  supply, its own vesting schedule with its own start time, its own
  already-burned nonces, and its own bond pool (whose funds can never be moved,
  see [`TESTNET_LIQUIDITY.md` §3.3](./TESTNET_LIQUIDITY.md)).
* **Nothing can be pointed at the old contracts again.** Users of the old
  deployment would have to redeem/bond/unstake from the old addresses by hand.
* **State that cannot be recreated on a new deployment:** `TeamVesting`'s
  `startTime` (a new deployment restarts the 4-year schedule from scratch), all
  burned nonces (a fresh claimer accepts them again — irrelevant only because
  the old claimer is abandoned), and any bond pool balance.
* **The practical testnet rollback:** keep the old manifest, deploy again with
  `--force`, then update the backend's `MINING_CLAIMER_ADDRESS` and `CHAIN_ID`
  and restart. Users' mining sessions start over; nothing of value is lost
  because nothing is valuable.
* **If you only need to change configuration** (backend signer, claimer role,
  bond-pool funding) do **not** redeploy: `setSigner` (§6) and
  `StakingManager.setClaimer` exist for exactly that.

---

## 9. What this runbook does not cover

* No key material, no real addresses, no real fund values appear in it.
* No live transactions were executed while writing it; every command is a
  template for you to run with your own **test** keys on Amoy.
* Mainnet deployment instructions are deliberately absent. The five contracts
  have had **no external audit**, and the audit is the first gate.