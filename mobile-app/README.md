# CATT Protocol — mobile client (`catt_app`)

Android-first Flutter client for CATT Protocol ($CATT): read a mission, clear
the focus trap, answer, and let the backend Judge decide. Rewards are claimed
**gaslessly** — the app never signs a transaction and never needs MATIC.

## Run it

```bash
flutter pub get
flutter run \
  --dart-define=CATT_BACKEND_URL=http://10.0.2.2:3000 \
  --dart-define=CATT_RPC_URL=https://your-polygon-rpc \
  --dart-define=CATT_TOKEN_ADDRESS=0x...
```

Every endpoint is a `String.fromEnvironment` in `lib/config.dart`. Defaults:
backend `http://10.0.2.2:3000` (the host, from an Android emulator), RPC and
token address empty. There are **no secrets in this app and nowhere to put
one** — the only key it holds is the reader's own wallet key, in the Android
Keystore via `flutter_secure_storage`.

## Verify it

```bash
flutter analyze   # must be clean
flutter test      # 121 tests, no device and no chain required
```

## Shape of the code

| Concern | Where | External dependency, and its fake |
|---|---|---|
| Judge HTTP | `lib/services/api_client.dart` | `http.Client` → `MockClient` |
| Wallet key | `lib/services/wallet_service.dart` | `KeyStore` → `InMemoryKeyStore` |
| Telemetry | `lib/services/telemetry_service.dart` | clock / scheduler / battery / sink, all injected |
| Balance read | `lib/services/chain_service.dart` | `ChainReader` → `UnconfiguredChainReader` |
| State | `lib/state/app_state.dart` | one `ChangeNotifier`, no globals |

## The three rules this codebase is built around

1. **Never re-shuffle.** Paragraph order and the trap index come from the
   server, which seeds them from the session id. The Judge grades the submitted
   highlight against that exact layout, so the client stores and renders it
   verbatim.
2. **Never fabricate telemetry.** `battery_temp` is whatever the platform
   reports, or `null` when it reports nothing — `battery_plus` 7.x has no
   temperature API at all, and the reader is warned rather than handed a
   plausible number. A coordinate is recorded once, where it happened; a window
   with no touch reports `null`, never the previous coordinate.
3. **Never sign.** Claims are relayed by the backend. There is no signing code
   in this app to audit.

## Graceful degradation

| Missing | Behaviour |
|---|---|
| Battery temperature sensor | sample reports `batteryTempC: null`; the reader shows a notice |
| RPC / token address | wallet balance shows `—` |
| RPC unreachable or rate-limited | wallet balance shows `—`, no exception |
| `/api/relay` returns 503 (no relayer) | the signed reward still stands, with a notice |
| Stamina route (not in the MVP contract) | stamina shows `—` |
| Judge unreachable | "No verdict yet" — explicitly *not* a failed attempt |
| Telemetry upload fails | reported as a status; the reading session continues |