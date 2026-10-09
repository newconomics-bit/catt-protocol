# CATT Protocol — Termux-Only Operations Runbook

**Audience**: Founder operating EXCLUSIVELY from Android phone (Termux + mobile browser). No laptop exists in this project's ops.

---

## 1. One-Time Termux Setup

Run these **once** in Termux:

```bash
# Update packages
pkg update && pkg upgrade -y

# Core tools
pkg install -y git nodejs-lts openjdk-17 python3 openssl termux-api

# Android SDK (for local APK builds if needed)
# NOTE: For CI APK factory, you DON'T need Android SDK locally.
# The GitHub Action builds it. Skip this section unless you want local builds.
pkg install -y android-tools unzip wget
mkdir -p $HOME/android-sdk
cd $HOME/android-sdk
wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
unzip -q commandlinetools-linux-11076708_latest.zip
rm commandlinetools-linux-11076708_latest.zip
yes | ./cmdline-tools/bin/sdkmanager --licenses >/dev/null
./cmdline-tools/bin/sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;28.2.13676358"

# Set env vars (add to ~/.bashrc or ~/.zshrc)
cat >> ~/.bashrc <<'EOF'
export ANDROID_HOME=$HOME/android-sdk
export ANDROID_SDK_ROOT=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
export JAVA_HOME=/data/data/com.termux/files/usr/lib/jvm/java-17-openjdk
export PATH=$PATH:$JAVA_HOME/bin
EOF
source ~/.bashrc

# Verify
flutter --version  # Should show 3.47.6 after flutter install below
java --version     # Should show 17
node --version     # Should show 20+
```

### Install Flutter (one-time)

```bash
# Flutter 3.47.6 stable
cd $HOME
git clone https://github.com/flutter/flutter.git -b stable --depth 1
export PATH="$PATH:$HOME/flutter/bin"
flutter --version  # Must show 3.47.6 / Dart 3.13.5
flutter config --android-sdk "$ANDROID_HOME"
flutter config --jdk-dir "$JAVA_HOME"
flutter doctor -v  # Accept licenses: flutter doctor --android-licenses
```

---

## 2. Clone Repository

```bash
cd $HOME
git clone https://github.com/<YOUR_ORG>/<YOUR_REPO>.git catt-protocol
cd catt-protocol
```

---

## 3. Smart Contracts Deployment (Polygon Amoy)

### 3.1 Install Dependencies (smart-contracts ONLY)

```bash
cd $HOME/catt-protocol/smart-contracts
npm ci
```

### 3.2 Create `.env` from Template

```bash
cp .env.example .env
# Edit .env with your values (use a text editor like nano or vim)
nano .env
```

**Required values for `.env`:**

| Variable | Description | Example |
|----------|-------------|---------|
| `POLYGON_RPC_URL` | Amoy RPC endpoint (Infura/Alchemy/QuickNode) | `https://polygon-amoy.g.alchemy.com/v2/xxxx` |
| `PRIVATE_KEY` | Deployer private key (0x + 64 hex). **Funded with Amoy MATIC** | `0xabc...` |
| `SIGNER_ADDRESS` | Backend Judge address → becomes `MiningClaimer.signer` | `0x123...` |
| `TEAM_BENEFICIARY` | 15M CATT vesting beneficiary | `0x456...` |
| `TREASURY_BENEFICIARY` | 20M CATT vesting beneficiary (MUST differ from team) | `0x789...` |
| `MARKETING_WALLET` | 15M CATT marketing (REQUIRED, no default) | `0xaaa...` |
| `LIQUIDITY_WALLET` | 10M CATT DEX liquidity (optional, defaults to deployer) | `0xbbb...` |
| `YIELD_TOKEN_ADDRESS` | Real stablecoin OR use `MOCK_YIELD=true` | `0xccc...` |
| `POLYGONSCAN_API_KEY` | Optional, for contract verification | `ABCDEF...` |

**Get Amoy MATIC**: https://faucet.polygon.technology/ (paste deployer address)

### 3.3 Deploy Contracts

```bash
# Option A: With real yield token (set YIELD_TOKEN_ADDRESS in .env)
npx hardhat run scripts/deploy-testnet.js --network polygon

# Option B: With MockUSDT (test yield token)
MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon
```

**Output**: `deployed-testnet.json` (created in `smart-contracts/`). **Do NOT commit yet.**

### 3.4 Deploy Mock Yield Token (if needed separately)

```bash
# Deploys MockUSDT to Amoy and prints address
node ../scripts/deploy-mock-yield.js --network polygon

# Capture output for YIELD_TOKEN_ADDRESS:
# YIELD_TOKEN_ADDRESS=$(node ../scripts/deploy-mock-yield.js --network polygon 2>/dev/null | tail -1)
```

---

## 4. Commit & Push `deployed-amoy.json`

```bash
cd $HOME/catt-protocol
git add smart-contracts/deployed-testnet.json
git commit -m "chore: add Amoy deployment manifest"
git push origin main
```

> **Why commit this?** The CI workflow and backend need the contract addresses. It contains only public addresses and tx hashes — no private keys.

---

## 5. Backend Configuration

```bash
cd $HOME/catt-protocol/backend-server
cp .env.example .env
nano .env
```

**Fill from `deployed-testnet.json` + your secrets:**

```bash
# From deployment manifest (public)
CHAIN_ID=80002
MINING_CLAIMER_ADDRESS=0x...from manifest...

# Your secrets (NEVER commit)
SIGNER_PRIVATE_KEY=0x... # Private key for SIGNER_ADDRESS
RELAYER_PRIVATE_KEY=0x... # Hot wallet for gasless relay (fund with Amoy MATIC)
RPC_URL=https://polygon-amoy.g.alchemy.com/v2/xxxx # Same as POLYGON_RPC_URL

# Optional: enable admin pilot report (phone browser access)
ADMIN_TOKEN=$(openssl rand -hex 32)  # Generate once, save securely

# Storage (for pilot persistence)
CATT_STORE=sqlite
SQLITE_PATH=/data/data/com.termux/files/home/catt-judge/judge.db
```

---

## 6. Keystore Generation (for CI Release APK)

**Run ONCE**, save outputs securely (password manager).

```bash
cd $HOME/catt-protocol

# Generate keystore
mkdir -p android/keystore
keytool -genkeypair -v -keystore android/keystore/release.keystore \
  -alias release -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass YOUR_STORE_PASSWORD -keypass YOUR_KEY_PASSWORD

# Encode to base64 (for GitHub secret KESTORE_BASE64)
base64 -w 0 android/keystore/release.keystore

# Save these 4 values as GitHub Repository Secrets:
# 1. KESTORE_BASE64        <- output of above command
# 2. KEYSTORE_STORE_PASSWORD
# 3. KEYSTORE_KEY_ALIAS    <- "release"
# 4. KEYSTORE_KEY_PASSWORD
```

> **Never commit** `android/keystore/` or `keystore.properties`. They're in `.gitignore`.

---

## 7. GitHub Repository Secrets & Variables

Go to GitHub → Repository → Settings → Secrets and variables → Actions.

### Secrets (🔒)
| Name | Value |
|------|-------|
| `KESTORE_BASE64` | Base64-encoded keystore file |
| `KEYSTORE_STORE_PASSWORD` | Keystore store password |
| `KEYSTORE_KEY_ALIAS` | `release` |
| `KEYSTORE_KEY_PASSWORD` | Key password |

### Variables (📝)
| Name | Value |
|------|-------|
| `CATT_BACKEND_URL` | `https://your-backend.example` |
| `CATT_RPC_URL` | `https://polygon-amoy-rpc.example` |
| `CATT_TOKEN_ADDRESS` | CATT token address from `deployed-testnet.json` |
| `CATT_NETWORK_NAME` | `Polygon Amoy` |

---

## 8. Tag & Release (Triggers CI APK Factory)

```bash
cd $HOME/catt-protocol

# Create annotated tag (version must match pubspec.yaml version)
git tag -a v1.0.0 -m "Release v1.0.0"

# Push tag (triggers .github/workflows/release-apk.yml)
git push origin v1.0.0
```

**Monitor**: GitHub → Actions → "Release APK Factory" workflow.

**Artifacts**: 
- Download APK from workflow "Artifacts" 
- OR from GitHub Release page (auto-created on success)

---

## 9. Admin Pilot Report (Phone Browser)

Once backend is running and `ADMIN_TOKEN` is set:

```bash
# Open in mobile browser (Termux can launch it)
termux-open-url "https://your-backend.example/api/admin/pilot-report?token=$ADMIN_TOKEN"

# Or with curl
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-backend.example/api/admin/pilot-report | jq .
```

Returns JSON with 5 privacy-minimal aggregations:
- `telemetryScoreDistribution`
- `batteryNotReportedRate`
- `failReasonCounts`
- `missionsPerUserPerDay`
- `governorEngagements`

---

## 10. Env Checklist Generator (One Command)

```bash
cd $HOME/catt-protocol
node scripts/print-env-checklist.js
```

Outputs exact `backend-server/.env` lines with public values filled and secrets as placeholders.

---

## 11. Battery / Wake-Lock Notes (Critical for Termux)

**Termux kills background processes when screen off.** For long-running ops:

```bash
# Acquire wake lock (prevents CPU sleep)
termux-wake-lock

# Keep screen on (optional, drains battery)
termux-wake-lock && termux-brightness 10

# Release when done
termux-wake-unlock
```

**For backend server** (run in background):
```bash
# Start with wake lock
termux-wake-lock
cd $HOME/catt-protocol/backend-server
npm start > backend.log 2>&1 &

# Check it's running
curl http://localhost:3000/api/health

# To stop
pkill -f "node src/server.js"
termux-wake-unlock
```

**For npm/hardhat commands** (can take minutes):
```bash
termux-wake-lock
# ... run deploy, tests, etc ...
termux-wake-unlock
```

**Battery optimization**: Disable for Termux in Android Settings → Apps → Termux → Battery → Unrestricted.

---

## 12. Quick Reference Card

| Task | Command |
|------|---------|
| Deploy contracts (Amoy) | `cd smart-contracts && MOCK_YIELD=true npx hardhat run scripts/deploy-testnet.js --network polygon` |
| Deploy MockUSDT | `node scripts/deploy-mock-yield.js --network polygon` |
| Start backend | `cd backend-server && termux-wake-lock && npm start` |
| Stop backend | `pkill -f "node src/server.js" && termux-wake-unlock` |
| View pilot report | `termux-open-url "https://backend.example/api/admin/pilot-report?token=$ADMIN_TOKEN"` |
| Generate env checklist | `node scripts/print-env-checklist.js` |
| Create release tag | `git tag -a v1.0.1 -m "Release v1.0.1" && git push origin v1.0.1` |
| View CI logs | Open GitHub Actions in mobile browser |
| Download release APK | From GitHub Release assets in mobile browser |

---

## 13. Troubleshooting

| Issue | Fix |
|-------|-----|
| `flutter: command not found` | `export PATH="$PATH:$HOME/flutter/bin"` |
| `java: not found` | `pkg install openjdk-17 && export JAVA_HOME=...` |
| `gradle: daemon disappeared` | `GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx2g" flutter build apk ...` |
| `License not accepted` | `flutter doctor --android-licenses` (accept all) |
| `keystore: keystore password incorrect` | Check GitHub secrets match exactly |
| `backend: ADMIN_REPORT_DISABLED` | Set `ADMIN_TOKEN` in backend `.env` and restart |
| `deploy: deployer has no MATIC` | Fund from https://faucet.polygon.technology/ |

---

**All steps verified executable from Termux on Android phone. No laptop required.**