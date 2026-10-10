# CATT Protocol — Pilot Runbook

This document describes how to run a pilot with 20–50 users on Polygon Amoy testnet.

---

## 1. Prerequisites

### Smart Contracts (Polygon Amoy)
- Deploy contracts to Amoy (chain id 80002) using `smart-contracts/scripts/deploy-testnet.js`
- Required environment variables (see `smart-contracts/.env.example`):
  - `POLYGON_RPC_URL` — Amoy RPC endpoint (Infura/Alchemy/QuickNode)
  - `PRIVATE_KEY` — Funded deployer key (needs Amoy MATIC for gas)
  - `SIGNER_ADDRESS` — Backend Judge address (becomes `MiningClaimer.signer`)
  - `TEAM_BENEFICIARY` — 15M CATT vesting beneficiary
  - `TREASURY_BENEFICIARY` — 20M CATT vesting beneficiary (must differ from team)
  - `MARKETING_WALLET` — 15M CATT marketing allocation (REQUIRED, no default)
  - `LIQUIDITY_WALLET` — 10M CATT DEX liquidity (optional, defaults to deployer)
  - `YIELD_TOKEN_ADDRESS` — Real stablecoin for BondManager (or use `MOCK_YIELD=true`)

Run (laptop/CI with a working hardhat toolchain):
```bash
cd smart-contracts
npx hardhat run scripts/deploy-testnet.js --network polygon
```

Run (Termux/Android-ARM — no hardhat; deploys from the committed
artifacts with plain ethers v6, because hardhat's Solidity parser
has no Android build and fails with Error HH18):
```bash
cd smart-contracts
node scripts/deploy-testnet-standalone.js
```
Output: `deployed-testnet.json` (do NOT commit).

### Backend Judge
- Copy `backend-server/.env.example` to `backend-server/.env` and fill:
  - `SIGNER_PRIVATE_KEY` — Private key for `SIGNER_ADDRESS` above
  - `CHAIN_ID=80002`
  - `MINING_CLAIMER_ADDRESS` — From deployment manifest
  - `RELAYER_PRIVATE_KEY` — Hot wallet for gasless relay (fund with Amoy MATIC)
  - `RPC_URL` — Same Amoy RPC as above
  - `CATT_STORE=sqlite` (for persistence)
  - `SQLITE_PATH=/var/lib/catt-judge/judge.db`
  - All `CATT_*` economy flags (defaults are ON per PRD §3.5)

Start:
```bash
cd backend-server
npm start
```

### Mobile App (Signed Release APK)
1. Generate keystore (one-time, keep OUTSIDE repo):
   ```bash
   mkdir -p mobile-app/android/keystore
   keytool -genkeypair -v -keystore mobile-app/android/keystore/release.keystore \
     -alias release -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Create `mobile-app/android/keystore.properties` from template (gitignored):
   ```bash
   cp mobile-app/android/keystore.properties.example mobile-app/android/keystore.properties
   # Edit with your keystore path, passwords, and alias
   ```
3. Build signed release APK:
   ```bash
   cd mobile-app
   flutter build apk --release \
     --dart-define=CATT_BACKEND_URL=https://your-backend.example \
     --dart-define=CATT_RPC_URL=https://polygon-amoy-rpc.example \
     --dart-define=CATT_TOKEN_ADDRESS=0x... \
     --dart-define=CATT_NETWORK_NAME="Polygon Amoy"
   ```
   Output: `build/app/outputs/flutter-apk/app-release.apk` (signed, optimized).

4. Verify signature:
   ```bash
   apksigner verify --print-certs build/app/outputs/flutter-apk/app-release.apk
   ```

---

## 2. Onboarding 20–50 Users

### Distribution
- Share the signed `app-release.apk` via secure channel (TestFlight alternative, direct download, or internal distribution).
- Provide each user with:
  - Backend URL (if different from build-time default)
  - Polygon Amoy faucet link: https://faucet.polygon.technology/ (for testnet MATIC if they need to claim manually — relay covers gas)
  - Brief onboarding guide: connect wallet → select mission → read → pass quiz → claim CATT.

### Wallet Setup
- App generates a local wallet on first launch (stored in `flutter_secure_storage`).
- **CRITICAL**: Seed-phrase backup is NOT IMPLEMENTED (Mainnet Gate #1). Users who lose device lose wallet permanently. Communicate this clearly.

---

## 3. Daily Observation Checklist

Run these checks each day during the pilot:

### Morning (04:00 WIB / 21:00 UTC rollover)
- [ ] **Season status**: Check `GET /api/stats` — verify active season, pool remaining, governor scale factor.
- [ ] **Active miners yesterday**: Note `activeMinersToday` from stats endpoint.
- [ ] **Daily budget consumed**: Check `dailyBudgetConsumed` vs 110,000 CATT budget.
- [ ] **Governor scale factor**: If `< 10000`, emission is being scaled down.

### Throughout the Day
- [ ] **Error rates**: Monitor logs for `SEASON_ALLOCATION_EXHAUSTED`, `DAILY_STAMINA_CAP_EXCEEDED`, relay failures.
- [ ] **Relay health**: Check `GET /api/relay/status` — relayer balance, configured status.
- [ ] **Telemetry quality**: Run `scripts/pilot-report.js` to see score distribution and `BATTERY_NOT_REPORTED` rate.

### End of Day
- [ ] **Run weekly report** (or daily during pilot):
  ```bash
  CATT_STORE=sqlite SQLITE_PATH=/var/lib/catt-judge/judge.db node scripts/pilot-report.js
  ```
- [ ] Record key metrics in pilot log:
  - Active miners (daily)
  - Total claims submitted / passed / failed
  - Governor scale factor (avg)
  - Season pool % remaining
  - Top FAIL reasons
  - BATTERY_NOT_REPORTED rate

---

## 4. KILL-SWITCH Procedure

If critical issues arise (exploit, runaway emission, safety concern):

### Immediate Pause (claims only)
Set env var and restart backend:
```bash
# In backend-server/.env
CATT_SEASONS=false
# OR set season epoch to future
CATT_SEASON_EPOCH=4102444800  # Year 2100
```
This makes every claim fail with `409 SEASON_NO_ACTIVE_SEASON` — no signatures issued, no nonces burned.

### Full Pause (backend + relay)
1. Stop backend process (`SIGTERM`).
2. Optionally revoke relayer key if compromised.

### Resume
1. Fix root cause.
2. Restore env vars (remove `CATT_SEASONS=false` or set real epoch).
3. Restart backend.
4. Verify `GET /api/health` and `GET /api/stats`.

---

## 5. Pilot Exit Criteria

The pilot is considered **successful** if ALL of the following are met over a 7-day window:

| Metric | Threshold | Measurement |
|--------|-----------|-------------|
| **Real-telemetry pass rate** | ≥ 70% | `(sessions with score ≥ 60) / (total graded sessions)` from `pilot-report.js` |
| **Budget drain accuracy** | Within 20% of simulation | Actual CATT emitted vs simulated (from `simulate-drain.js` with observed active miners) |
| **No critical bugs** | 0 | No P0 issues: double-mint, signature replay, nonce reuse, relay double-spend |
| **Relay success rate** | ≥ 95% | `relayedClaims / issuedClaims` from store |
| **BATTERY_NOT_REPORTED rate** | ≤ 10% | From `pilot-report.js` — high rate indicates emulator/device issues |

If ANY criterion fails, extend pilot, investigate, and re-evaluate.

---

## 6. Key Commands Reference

| Task | Command |
|------|---------|
| Deploy contracts (Amoy) | `cd smart-contracts && node scripts/deploy-testnet-standalone.js` (phone) or `cd smart-contracts && npx hardhat run scripts/deploy-testnet.js --network polygon` (laptop/CI) |
| Start backend | `cd backend-server && npm start` |
| Build release APK | `cd mobile-app && flutter build apk --release --dart-define=...` |
| Weekly report | `CATT_STORE=sqlite SQLITE_PATH=/var/lib/catt-judge/judge.db node scripts/pilot-report.js` |
| Check stats | `curl https://backend.example/api/stats` |
| Check relay | `curl https://backend.example/api/relay/status` |
| Simulate drain | `cd backend-server && node scripts/simulate-drain.js` |

---

## 7. Escalation Contacts

- **Smart contract issues**: Contract deployer (holds deployer key)
- **Backend/Judge issues**: Backend operator (holds signer/relayer keys)
- **Mobile app issues**: Flutter build engineer
- **Economics/governor tuning**: Founder (controls `CATT_*` env flags)

---

## 8. Post-Pilot Checklist

- [ ] Export SQLite database for analysis (`/var/lib/catt-judge/judge.db`)
- [ ] Run final `pilot-report.js` and archive output
- [ ] Document all observed FAIL reasons and telemetry anomalies
- [ ] Compare actual emission vs simulation (run `simulate-drain.js` with real active miner counts)
- [ ] Decision: **Proceed to Mainnet** / **Extend Pilot** / **Redesign**

---

**Note**: This pilot runs on TESTNET (Polygon Amoy). No real value is at risk. The kill-switch pauses emission but does not affect already-claimed tokens (they remain in user wallets on Amoy).