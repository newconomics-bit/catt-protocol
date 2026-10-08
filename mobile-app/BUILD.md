# Building & Running the CATT Protocol Mobile App

Local build checklist for `mobile-app/` (the CATT Protocol Flutter client).

This document covers how to get a **debug APK** onto a device or emulator. It does
**not** claim that a debug APK is a releasable artifact — see
[A debug APK is not a release artifact](#a-debug-apk-is-not-a-release-artifact).

---

## Table of contents

1. [Prerequisites and pinned versions](#1-prerequisites-and-pinned-versions)
2. [`flutter doctor -v` checklist](#2-flutter-doctor--v-checklist)
3. [Environment variables](#3-environment-variables)
4. [Build, test and install](#4-build-test-and-install)
5. [Pointing the app at a backend (`--dart-define`)](#5-pointing-the-app-at-a-backend---dart-define)
6. [Android manifest: permissions and SDK levels](#6-android-manifest-permissions-and-sdk-levels)
7. [Where the build output goes](#7-where-the-build-output-goes)
8. [Environment-specific: Maven Central 403 behind a TLS-intercepting proxy](#8-environment-specific-maven-central-403-behind-a-tls-intercepting-proxy)
9. [Troubleshooting table](#9-troubleshooting-table)
10. [A debug APK is not a release artifact](#10-a-debug-apk-is-not-a-release-artifact)

---

## 1. Prerequisites and pinned versions

| Component | Version | Where it is pinned |
| --- | --- | --- |
| Flutter | **3.47.6** stable (Dart **3.13.5**, DevTools 2.60.0) | your SDK install |
| JDK | **17** (17.0.20+ works) | `android/app/build.gradle.kts` sets `sourceCompatibility`/`targetCompatibility` to `VERSION_17` and the Kotlin `jvmTarget` to `JVM_17` |
| Android SDK platform | **36** (`compileSdk`/`targetSdk` = `flutter.compileSdkVersion`/`flutter.targetSdkVersion` = 36) | Flutter Gradle plugin default |
| Android build-tools | **36.0.0** | what Flutter/AGP selects for SDK 36 |
| Android NDK | **28.2.13676358** | `ndkVersion = flutter.ndkVersion` |
| Android Gradle Plugin | **9.1.0** | `android/settings.gradle.kts` |
| Kotlin Gradle plugin | **2.4.0** | `android/settings.gradle.kts` |
| Gradle | **9.3.1** (wrapper) | `android/gradle/wrapper/gradle-wrapper.properties` |
| minSdk | **24** (effective — see §6) | `maxOf(flutter.minSdkVersion, 23)` |

Do not edit the AGP/Kotlin/Gradle versions in `android/settings.gradle.kts` or the
wrapper properties to "fix" a build. They are the versions the Flutter 3.47.6 Gradle
plugin was validated against; change the Flutter SDK instead.

### Install checklist

```bash
# 1. Flutter 3.47.6 stable
git clone https://github.com/flutter/flutter.git -b stable ~/flutter
# or: download the 3.47.6 stable archive, then unpack it somewhere on PATH

flutter --version          # must say 3.47.6 / Dart 3.13.5

# 2. JDK 17
#    macOS:  brew install --cask temurin@17
#    Ubuntu: sudo apt-get install -y openjdk-17-openjdk
#    Windows: install Temurin 17, or use the JDK bundled with Android Studio
export JAVA_HOME=/path/to/jdk-17

# 3. Android SDK (platform 36 + build-tools 36.0.0)
#    Easiest: install Android Studio, then use its SDK Manager to add
#    "Android SDK Platform 36" and "Android SDK Build-Tools 36.0.0".
#    Headless alternative (command-line tools only):
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"

flutter config --android-sdk "$ANDROID_HOME"
flutter config --jdk-dir "$JAVA_HOME"
```

The NDK is **not** required for a normal debug build of this app — it is only pulled
in because `build.gradle.kts` declares `ndkVersion = flutter.ndkVersion`. If Gradle
asks you to install NDK `28.2.13676358`, accept it (see [NDK mismatch](#ndk-mismatch)).

---

## 2. `flutter doctor -v` checklist

Run `flutter doctor -v` and check these specific lines:

```
[✓] Flutter (Channel stable, 3.47.6, ...)
[✓] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Platform android-36, build-tools 36.0.0
    • Java version OpenJDK Runtime Environment (build 17.0.20...)
    • All Android licenses accepted.
[✓] Connected device (...)
```

What each entry means **for this app specifically**:

| `flutter doctor` entry | Required? | Why it matters for `mobile-app` |
| --- | --- | --- |
| `Flutter 3.47.6 stable` | **Yes, exact** | The Dart SDK constraint in `pubspec.yaml` is `^3.13.5` and the Gradle plugin resolves `compileSdk`/`minSdk`/`ndkVersion` from this SDK. A different Flutter version silently changes the Android target levels. |
| `[✓] Android toolchain` | **Yes** | Without it `flutter build apk` cannot run at all. |
| `• All Android licenses accepted.` | **Yes** | If false, the build dies with `License for package Android SDK Platform <N> not accepted`. Fix with `flutter doctor --android-licenses`. |
| `• Java version ... 17.x` | **Yes** | A JDK 11 or 21 default breaks `VERSION_17`/`JVM_17` agreement. Use `flutter config --jdk-dir` rather than relying on `JAVA_HOME` alone — `flutter` prefers its configured JDK. |
| `• Platform android-36, build-tools 36.0.0` | **Yes** | `compileSdk`/`targetSdk` are 36. |
| `[✗] Chrome` | **No** | This app ships Android (and has a `linux/` desktop target). Web is irrelevant; ignore it. |
| `[✗] Linux toolchain` (clang/CMake/ninja/pkg-config) | **No** | Only needed for the Linux desktop target. Android builds are unaffected. |
| `[✓] Connected device` | Only to *run* | Needed for `flutter run` / `adb install`, **not** for `flutter build apk`. A headless machine can build with no device attached. |
| `[!] Network resources` | Only if failing | Only consulted for `flutter pub` version checks; harmless to ignore. |

---

## 3. Environment variables

On a normal machine with Flutter and Android Studio installed you usually need
**none** of these. Set them when the SDKs live outside their default locations, or
in CI/containers.

```bash
# macOS / Linux
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64   # any JDK 17
export ANDROID_HOME=$HOME/Library/Android/sdk          # macOS default
export ANDROID_SDK_ROOT=$ANDROID_HOME                  # deprecated alias, still read by AGP
export PATH=$PATH:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
```

| Variable | Needed? | Notes |
| --- | --- | --- |
| `JAVA_HOME` | Only if not auto-detected | Must point at a **JDK 17**. |
| `ANDROID_HOME` | Only if the SDK is not at the default location | |
| `ANDROID_SDK_ROOT` | Rarely | Legacy alias. Set it equal to `ANDROID_HOME` if you set the latter. |
| `GRADLE_USER_HOME` | Only to relocate the Gradle cache | Defaults to `~/.gradle`. Set it to reuse a pre-warmed dependency cache (see [§8](#8-environment-specific-maven-central-403-behind-a-tls-intercepting-proxy)) or to sandbox writes in CI. |

Per-OS defaults:

- **macOS** — `ANDROID_HOME=$HOME/Library/Android/sdk`; get the JDK path with
  `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`.
- **Linux** — `ANDROID_HOME=$HOME/Android/Sdk` (or your distro's package path).
- **Windows (PowerShell)** —
  `$env:JAVA_HOME="C:\Program Files\Java\jdk-17"`;
  `$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"`.
  `flutter doctor --android-licenses` and `sdkmanager` work the same way.
  On Windows the Gradle daemon's `org.gradle.jvmargs` are read from
  `gradle.properties` exactly as on Unix.

---

## 4. Build, test and install

All commands run from `mobile-app/`.

```bash
cd mobile-app

# 1. Resolve Dart dependencies
flutter pub get

# 2. Static analysis — must be clean
flutter analyze

# 3. Unit/widget tests
flutter test

# 4. Debug APK
flutter build apk --debug
```

Expected healthy results at the time of writing:

- `flutter analyze` → `No issues found!` (0 errors, 0 warnings)
- `flutter test` → **149 tests, all passing**
- `flutter build apk --debug` → `✓ Built build/app/outputs/flutter-apk/app-debug.apk`

### Installing onto a device or emulator

```bash
# List targets
flutter devices

# Build, install and launch in one step (debug, with hot reload)
flutter run

# Or install an already-built APK
adb install -r build/app/outputs/flutter-apk/app-debug.apk

# Start an emulator first if you have an AVD (Android Studio: Device Manager)
emulator -avd <your-avd-name>
```

`flutter run --dart-define=...` (see §5) is the normal way to develop against a
local backend, because the debugger attaches over the network — which is exactly why
the debug/profile manifests add the `INTERNET` permission.

### Building for a specific ABI (optional)

The debug APK is a **fat APK** (~150 MB) bundling `arm64-v8a`, `armeabi-v7a` and
`x86_64`. To shrink it while iterating on a single target:

```bash
flutter build apk --debug --target-platform android-arm64
```

### Release builds (signed, distributable)

**Prerequisites (one-time setup):**

1. **Generate a release keystore** (keep it OUTSIDE the repo, e.g. `android/keystore/release.keystore`):
   ```bash
   mkdir -p android/keystore
   keytool -genkeypair -v -keystore android/keystore/release.keystore \
     -alias release -keyalg RSA -keysize 2048 -validity 10000 \
     -storepass YOUR_STORE_PASSWORD -keypass YOUR_KEY_PASSWORD
   ```
   - `YOUR_STORE_PASSWORD` and `YOUR_KEY_PASSWORD` must be strong, unique passwords.
   - Record them in a password manager. **Losing the keystore or passwords = losing the ability to update the app on Play Store.**

2. **Create `android/keystore.properties` from the template** (this file is gitignored):
   ```bash
   cp android/keystore.properties.example android/keystore.properties
   # Edit android/keystore.properties with your real values
   ```

3. **Build the signed release APK:**
   ```bash
   cd mobile-app
   flutter build apk --release \
     --dart-define=CATT_BACKEND_URL=https://your-backend.example \
     --dart-define=CATT_RPC_URL=https://polygon-amoy-rpc.example \
     --dart-define=CATT_TOKEN_ADDRESS=0x... \
     --dart-define=CATT_NETWORK_NAME="Polygon Amoy"
   ```
   Output: `mobile-app/build/app/outputs/flutter-apk/app-release.apk` (signed, optimized, shrunk).

4. **Build the signed App Bundle (for Play Store):**
   ```bash
   flutter build appbundle --release \
     --dart-define=CATT_BACKEND_URL=https://your-backend.example \
     --dart-define=CATT_RPC_URL=https://polygon-amoy-rpc.example \
     --dart-define=CATT_TOKEN_ADDRESS=0x... \
     --dart-define=CATT_NETWORK_NAME="Polygon Amoy"
   ```
   Output: `mobile-app/build/app/outputs/bundle/release/app-release.aab`

**How it works:**
- `android/app/build.gradle.kts` reads `android/keystore.properties` (if present) and configures the `release` signing config.
- If `keystore.properties` is absent (e.g., in CI), it falls back to debug signing — **the resulting APK is NOT distributable**.
- ProGuard/R8 shrinking is enabled for release (`isMinifyEnabled = true`, `isShrinkResources = true`).
- Rules are in `android/app/proguard-rules.pro`.

**Verify the signature:**
```bash
# Check the APK is signed with your release key (not debug)
apksigner verify --print-certs mobile-app/build/app/outputs/flutter-apk/app-release.apk
# Should show YOUR certificate fingerprint, NOT the debug certificate
```

> ⚠️ **NEVER commit `keystore.properties` or `*.keystore` / `*.jks` files.** They are in `android/.gitignore`. If accidentally committed, rotate the keystore immediately.

---

## 5. Pointing the app at a backend (`--dart-define`)

Every externally-reachable endpoint is supplied at build time; nothing is hardcoded
and there are **no secrets** (the Judge is a public HTTP service and the RPC endpoint
is a public Polygon node used for read-only `balanceOf` calls). The real flag names
are read from `lib/config.dart` and are exactly:

| `--dart-define` key | Default when unset | Meaning |
| --- | --- | --- |
| `CATT_BACKEND_URL` | `http://10.0.2.2:3000` | Base URL of the backend Judge, no trailing slash. The default is the **Android emulator's** alias for the host machine. |
| `CATT_RPC_URL` | *(empty)* | Public JSON-RPC endpoint for read-only balance reads. Empty is a supported, tested degraded mode: the wallet screen shows `—` instead of crashing. |
| `CATT_TOKEN_ADDRESS` | *(empty)* | Address of the `$CATT` ERC-20 token. Empty disables the balance read. |
| `CATT_NETWORK_NAME` | `Polygon` | Human-readable chain name shown in the wallet screen. |

```bash
flutter run \
  --dart-define=CATT_BACKEND_URL=http://10.0.2.2:3000 \
  --dart-define=CATT_RPC_URL=https://polygon-rpc.com \
  --dart-define=CATT_TOKEN_ADDRESS=0x... \
  --dart-define=CATT_NETWORK_NAME=Polygon
```

Notes:

- The balance read only runs when **both** `CATT_RPC_URL` and `CATT_TOKEN_ADDRESS`
  are non-empty (`AppConfig.isRpcConfigured`).
- On a **physical device** `10.0.2.2` does not resolve — use your machine's LAN IP
  (e.g. `http://192.168.1.20:3000`) and make sure the backend binds `0.0.0.0`.
- Cleartext HTTP is fine for the emulator default but Android blocks cleartext on
  release builds by default; use `https://` for anything non-local.
- Values are baked into the binary at compile time, so changing them requires a
  rebuild (or `flutter run`).

---

## 6. Android manifest: permissions and SDK levels

`android/app/src/main/AndroidManifest.xml` is the source of truth.

**Permission — exactly one:**

```xml
<uses-permission android:name="android.permission.INTERNET"/>
```

The app is a thin client over the backend Judge and a read-only Polygon RPC, so it
needs network access and nothing else: **no** location, camera, contacts or storage
permissions. `flutter create` adds `INTERNET` only to the debug/profile manifests,
so it is declared in the main manifest for release builds too. The debug APK also
carries a `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` signature permission that AGP
injects automatically — that is build-tool generated, not authored.

**SDK levels** (verified with `aapt2 dump badging` on a built APK):

| Key | Value | Source |
| --- | --- | --- |
| `compileSdk` | 36 | `flutter.compileSdkVersion` |
| `targetSdk` | 36 | `flutter.targetSdkVersion` |
| `minSdk` | **24** | `maxOf(flutter.minSdkVersion, 23)` — Flutter's floor is already 24, so the `maxOf` is a no-op and the effective minimum is 24. |
| `applicationId` | `com.cattprotocol.catt_app` | `build.gradle.kts` |
| `versionName` / `versionCode` | `1.0.0` / `1` | from `pubspec.yaml` |

`minSdk` 23 is mentioned in the build file because `flutter_secure_storage`'s
AES-GCM Keystore path needs Android 6.0 (API 23). Flutter 3.47.6 already requires
24, which is above that floor.

> ⚠️ **XML comments in an `AndroidManifest.xml` may not contain `--`.** It is
> illegal per the XML spec and makes the manifest unparseable, which surfaces as an
> opaque `ManifestMerger2$MergeFailureException: Error parsing ...` rather than a
> useful message. This has bitten this repo once already. Never paste a
> `--dart-define` / `--flag` into an XML comment; reword it as `dart-define`.

---

## 7. Where the build output goes

`android/build.gradle.kts` redirects the Gradle build directory out of `android/`:

```kotlin
val newBuildDir: Directory = rootProject.layout.buildDirectory.dir("../../build").get()
```

so everything lands under **`mobile-app/build/`**:

| Path | Contents |
| --- | --- |
| `build/app/outputs/flutter-apk/app-debug.apk` | the debug APK |
| `build/` (root) | Gradle intermediates, redirected here |
| `android/.gradle/`, `android/.kotlin/` | Gradle + Kotlin plugin caches |
| `android/local.properties` | generated; holds your local `flutter.sdk` / `sdk.dir` |
| `android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java` | generated by `flutter pub get` |

`mobile-app/.gitignore` ignores `build/`, `.dart_tool/` and
`.flutter-plugins-dependencies`; `mobile-app/android/.gitignore` ignores `/.gradle`,
`/local.properties` and `GeneratedPluginRegistrant.java`. **None of the above should
ever be staged.** (The Kotlin Gradle plugin also creates an `android/.kotlin/`
directory, which no ignore rule currently covers. It is empty after a normal debug
build so git does not report it, but add `.kotlin/` to
`mobile-app/android/.gitignore` defensively before it ever gains files.)

To force a clean rebuild:

```bash
cd mobile-app/android && ./gradlew clean     # or: rm -rf build android/.gradle
```

---

## 8. Environment-specific: Maven Central 403 behind a TLS-intercepting proxy

> **Normally unnecessary.** This section applies only to CI containers, corporate
> proxies or anything behind a **TLS-intercepting** egress proxy. On a normal
> developer machine Maven Central is reachable and you should never need this.

**Symptom.** A build that has never resolved Gradle plugins before fails like this,
with no obvious cause:

```
FAILURE: Build completed with 1 failure.
> Could not resolve org.jetbrains.kotlin:kotlin-stdlib:2.4.0.
   > Could not GET "https://repo.maven.apache.org/maven2/...".
     > Received status code 403 from server: Forbidden
```

**Cause.** An intercepting proxy (e.g. a Cloudflare/egress MITM) returns **HTTP 403**
for `repo.maven.apache.org` and `repo1.maven.org`. Note that
`https://plugins.gradle.org/m2/...` also fails: it **303-redirects** into Maven
Central for non-portal artifacts. `dl.google.com` (the `google()` repository) is
usually *not* affected, which is why AGP itself resolves and only the Kotlin
dependencies fail.

**Fix — a Gradle init script, outside the repository.** Put this at
`$GRADLE_USER_HOME/init.d/00-central-mirror.gradle` (e.g.
`/tmp/gradle-home/init.d/00-central-mirror.gradle` if you set
`GRADLE_USER_HOME=/tmp/gradle-home`). It prepends the Google-hosted Maven Central
mirror and rewrites the blocked repository URLs:

```groovy
def MIRROR_URL = 'https://maven-central.storage-download.googleapis.com/maven2/'
def BLOCKED = [
    'https://repo.maven.apache.org/maven2',
    'https://repo1.maven.org/maven2',
    'http://repo.maven.apache.org/maven2',
    'http://repo1.maven.org/maven2',
]

def prependMirror = { repos ->
    if (repos == null || repos.findByName('centralMirror') != null) return
    def mirror = repos.maven { r -> r.name = 'centralMirror'; r.url = MIRROR_URL }
    repos.remove(mirror)
    repos.add(0, mirror)
}

def rewrite = { repos ->
    if (repos == null) return
    repos.all { repo ->
        if (repo instanceof org.gradle.api.artifacts.repositories.MavenArtifactRepository) {
            def u = repo.url?.toString()?.replaceAll('/$', '')
            if (u != null && BLOCKED.contains(u)) repo.url = MIRROR_URL
        }
    }
}

def configurePluginManagement = { settings ->
    def repos = settings.pluginManagement.repositories
    prependMirror(repos)
    // Adding any repository suppresses Gradle's implicit default
    // (gradlePluginPortal), so re-declare it: org.gradle.kotlin.kotlin-dsl
    // is published only to the Plugin Portal, not to Maven Central.
    boolean hasPortal = repos.any { it.name?.toLowerCase()?.contains('plugin') }
    if (!hasPortal) repos.gradlePluginPortal()
    rewrite(repos)
}

gradle.beforeSettings { settings ->
    configurePluginManagement(settings)
    try { rewrite(settings.dependencyResolutionManagement.repositories) } catch (ignored) {}
}
gradle.settingsEvaluated { settings ->
    configurePluginManagement(settings)
    try { rewrite(settings.dependencyResolutionManagement.repositories) } catch (ignored) {}
}
gradle.allprojects { project ->
    rewrite(project.buildscript.repositories)
    rewrite(project.repositories)
}
```

Two subtleties that are easy to get wrong:

- In `pluginManagement` you may **prepend** the mirror, but you must **re-declare
  `gradlePluginPortal()`**, because `org.gradle.kotlin.kotlin-dsl` (used by Flutter's
  included build) is published *only* to the Plugin Portal.
- In every *other* repository container you must **rewrite the URL** of the blocked
  repository rather than **adding** a new one. Adding a project repository trips
  `RepositoriesMode.FAIL_ON_PROJECT_REPOS` in Flutter's included build
  (`packages/flutter_tools/gradle`), which fails differently.

Also note a common follow-on symptom: if `curl`/Gradle fail TLS verification
(`PKIX path building failed`), the proxy's CA is not trusted. Add its certificate to
the system store (`/usr/local/share/ca-certificates/` + `update-ca-certificates`) and
to the Java truststore. This is environment repair — **never commit it, and never put
it in the repository.**

---

## 9. Troubleshooting table

| Symptom | Cause | Fix |
| --- | --- | --- |
| `License for package Android SDK Platform <N> not accepted` / `sdkmanager` license prompt | Android SDK licenses not accepted | `flutter doctor --android-licenses` and accept all, or `yes \| sdkmanager --licenses`. Confirm with `flutter doctor -v` → `All Android licenses accepted.` |
| `sdkmanager: command not found` | Command-line tools not on `PATH` | Add `$ANDROID_HOME/cmdline-tools/latest/bin` to `PATH` (see [§3](#3-environment-variables)). Or install them from <https://developer.android.com/studio#command-line-tools-only>. Re-run `flutter config --android-sdk "$ANDROID_HOME"`. |
| `Could not resolve org.jetbrains.kotlin:kotlin-stdlib … 403 Forbidden` | Maven Central blocked by a TLS-intercepting proxy | See [§8](#8-environment-specific-maven-central-403-behind-a-tls-intercepting-proxy). Environment-specific; normally unnecessary. |
| `Gradle build daemon disappeared unexpectedly`, or the machine is OOM-killed during `:app:compileDebugKotlin` | `android/gradle.properties` sets `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m` — that is a **large** heap, and `-XX:+HeapDumpOnOutOfMemoryError` writes a multi-GB dump | On a small machine, **do not edit the repo file**; override per invocation: `GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=1g" flutter build apk --debug`. If you are on an 8 GB or 16 GB laptop, 2g–4g is the realistic range. |
| `NDK not found` / `No version of NDK matched the requested version 28.2.13676358` | `build.gradle.kts` pins `ndkVersion = flutter.ndkVersion` (28.2.13676358) and it is not installed | `sdkmanager --install "ndk;28.2.13676358"`. Do **not** "fix" it by editing `ndkVersion` — a mismatched NDK silently changes native plugin builds. `web3dart`/`flutter_secure_storage` do not need custom native code, so a normal debug APK build never actually invokes the NDK. |
| `flutter pub get` fails with a network / TLS / certificate error | Interception, proxy or offline | Verify with `curl -I https://pub.dev`. Behind a corporate proxy set `https_proxy`. Fully offline: `flutter pub get --offline` works only if the package cache is already populated (run `flutter pub get` once while online first). |
| `Flutter SDK version mismatch` / `flutter pub get` resolves a different SDK constraint | Flutter version drift | `flutter --version` must be 3.47.6 (Dart 3.13.5) to satisfy `environment: sdk: ^3.13.5` in `pubspec.yaml`. |
| `e: MainActivity.kt:NN: Unresolved reference '<some android constant>'` | The constant is `@SystemApi` in AOSP and is **stripped from the public `android.jar`**, so apps cannot reference it by name. `BatteryManager.BATTERY_PROPERTY_TEMPERATURE` (raw id `5`), `BATTERY_PROPERTY_STATE_OF_HEALTH` and `BATTERY_PROPERTY_CYCLE_COUNT` are all in this category — `android.jar` only ships `CAPACITY`, `CHARGE_COUNTER`, `CURRENT_AVERAGE`, `CURRENT_NOW`, `ENERGY_COUNTER` and `STATUS`. | Raising `compileSdk` will **not** help. Declare the raw id yourself next to your other constants — this repo does it as `private const val PROP_BATTERY_TEMPERATURE = 5` in `MainActivity`'s companion object — and use the fully public `getIntProperty(int)`, or read the sticky `ACTION_BATTERY_CHANGED` → `EXTRA_TEMPERATURE` extra instead. |
| `ManifestMerger2$MergeFailureException: Error parsing .../AndroidManifest.xml` with no line number | The manifest is not well-formed XML. The usual cause is a `--` sequence inside an XML comment (e.g. a pasted `--dart-define`), or a stray unescaped `&`/`<` in an attribute | Validate directly: `python3 -c "import xml.dom.minidom;xml.dom.minidom.parse('android/app/src/main/AndroidManifest.xml')"` reports the exact line and column. Reword the comment — the fix for this repo was the header comment's `` (`--dart-define= `` run on line 2. See [§6](#6-android-manifest-permissions-and-sdk-levels). |
| `adb: no devices/emulators found` | No device attached | `adb devices`; start an AVD via Android Studio's Device Manager or `emulator -avd <name>`. Remember `flutter build apk` does **not** need a device. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | An installed build was signed with a different key | `adb uninstall com.cattprotocol.catt_app`, then reinstall. |
| `Execution failed for task ':app:processDebugMainManifest'` about a missing `applicationId`/namespace, after a Flutter upgrade | Stale generated files | `cd mobile-app/android && ./gradlew clean`, delete `mobile-app/build` and `mobile-app/android/.gradle`, re-run `flutter pub get`. |

---

## 10. A debug APK is not a release artifact

A successful `flutter build apk --debug` proves the project **assembles**: Dart
analyzes, the Kotlin plugin compiles, the manifest merges, resources link and the DEX
is produced. It proves nothing about release readiness. Do not treat a green debug
build as a shippable artifact.

Specifically, a debug APK is:

- **Unsigned for distribution** — `build.gradle.kts` signs `release` with the
  **debug** keys (an unremoved Flutter template TODO). There is no real keystore, no
  Play upload key and no signing config in the repo.
- **Not optimised** — debug mode ships the Dart kernel (`kernel_blob.bin`) and runs
  in JIT with asserts and debug symbols enabled. It is roughly 150 MB, versus a few
  MB for a real release build.
- **Fat-ABI** — bundles `arm64-v8a`, `armeabi-v7a` and `x86_64` in one package.
- **Unreviewed for security** — no ProGuard/R8, no shrinker, no resource shrinking,
  and no verification that the release toolchain keeps working.

### What still gates a release build

These are tracked as the PRD's **Mainnet Gates** work (in progress, in parallel with
this document). Refer to `PRD.md` for the authoritative wording and current status —
this file deliberately does not duplicate it. In summary, a release build is gated on:

1. **Seed-phrase / key-backup flow** — wallet recovery and backup must be complete
   and user-verifiable before any real funds are involved. An unrecoverable wallet is
   a total loss for the user, and no amount of green CI substitutes for it.
2. **External audit** — an independent review of the smart contracts, the Judge's
   signature authority and the anti-cheat scoring. A debug build demonstrates that
   the code *compiles*; it says nothing about whether the signing path or the
   telemetry scorer is correct or safe.
3. **Telemetry threshold review** — the anti-cheat penalties, the
   `TELEMETRY_PASS_SCORE` accept boundary, and the battery flatline / impossible
   detection thresholds must be reviewed against real device data before real
   $CATT is at stake. Several of these are deliberately pinned at boundary values
   (e.g. a lone flatline scoring exactly at the pass mark), so their behaviour on
   live data needs an explicit sign-off.

Until all three are cleared, and a real signing key plus a release keystore exist,
`flutter build apk --debug` is a **development** artifact only.
