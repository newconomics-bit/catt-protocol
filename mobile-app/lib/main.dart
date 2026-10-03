/// CATT Protocol mobile app — entry point.
///
/// Wiring only: build the dependency graph, install the theme, declare routes.
///
/// The graph is assembled here and nowhere else, which is what lets every test
/// substitute fakes (`MockClient`, `InMemoryKeyStore`, `FakeTelemetryClock`, a
/// hand-driven scheduler) for exactly the same objects the app runs.
///
/// RUNTIME COMPOSITION:
///   http.Client        -> ApiClient           (the five Judge routes)
///   KeyStore           -> WalletService       (private key in Android Keystore)
///   ChainReader        -> WalletView balance  (read-only eth_call)
///   clock/scheduler/
///   battery/sink       -> TelemetryService    (5-second batches)
library;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import 'config.dart';
import 'models/telemetry_sample.dart';
import 'screens/bounty_board_screen.dart';
import 'screens/onboarding_screen.dart';
import 'screens/reader_screen.dart';
import 'screens/result_screen.dart';
import 'screens/task_screen.dart';
import 'screens/wallet_screen.dart';
import 'services/api_client.dart';
import 'services/chain_service.dart';
import 'services/key_store.dart';
import 'services/telemetry_service.dart';
import 'services/wallet_service.dart';
import 'state/app_state.dart';

void main() {
  runApp(const CattApp());
}

/// The app widget. Takes an optional [state] so a test can mount the real
/// navigation stack with an injected [AppState].
class CattApp extends StatefulWidget {
  /// Creates the app with the production dependency graph.
  const CattApp({super.key, this.state});

  /// Pre-built state; when null the production graph is composed in [initState].
  final AppState? state;

  @override
  State<CattApp> createState() => _CattAppState();
}

class _CattAppState extends State<CattApp> {
  late final AppState _state = widget.state ?? buildAppState();
  late final bool _ownsState = widget.state == null;

  @override
  void dispose() {
    if (_ownsState) _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider<AppState>.value(
      value: _state,
      child: MaterialApp(
        title: 'CATT Protocol',
        debugShowCheckedModeBanner: false,
        theme: buildCattTheme(),
        initialRoute: '/',
        routes: <String, WidgetBuilder>{
          '/': (_) => const OnboardingScreen(),
          '/board': (_) => const BountyBoardScreen(),
          '/reader': (_) => const ReaderScreen(),
          '/task': (_) => const TaskScreen(),
          '/result': (_) => const ResultScreen(),
          '/wallet': (_) => const WalletScreen(),
        },
      ),
    );
  }
}

/// Composes the production dependency graph.
///
/// The only place `flutter_secure_storage`, `battery_plus`, `http` and
/// `web3dart` are actually instantiated. Every one of them sits behind an
/// abstraction that the tests replace, so no test touches a plugin channel.
AppState buildAppState({
  AppConfig? config,
  http.Client? httpClient,
}) {
  final effectiveConfig = config ?? AppConfig.fromEnvironment;
  final api = ApiClient(config: effectiveConfig, httpClient: httpClient);
  return AppState(
    api: api,
    wallet: WalletService(keyStore: SecureStorageKeyStore.createDefault()),
    chain: Web3ChainReader(config: effectiveConfig, httpClient: httpClient),
    telemetry: TelemetryService(
      // The uploader is the only place the app writes telemetry to the
      // network, and it sends exactly what the collector gathered: no
      // smoothing, no padding, no "plausible" substitutions.
      sink: (String sessionId, List<TelemetrySample> samples) =>
          api.postTelemetry(sessionId: sessionId, samples: samples),
    ),
    // battery_plus 7.x exposes no battery temperature at all, so this reports
    // "no sensor" honestly and the reader is warned rather than being handed a
    // fabricated number. See PlatformBatteryTelemetrySource.
    battery: PlatformBatteryTelemetrySource(),
  );
}

/// The app theme: large type and generous touch targets by default, aimed at
/// mid-range Android hardware and one-handed use.
ThemeData buildCattTheme() {
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2E7D32)),
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: Colors.black87, displayColor: Colors.black87),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(56),
        textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(56),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
  );
}