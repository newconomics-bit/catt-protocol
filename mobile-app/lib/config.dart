/// CATT Protocol — runtime configuration (PRD 5, Rule 2: no hardcoded secrets).
///
/// Every externally-reachable endpoint is supplied at build time with
/// `--dart-define`. Nothing here is a secret: the backend Judge is a public
/// HTTP service and the RPC endpoint is a public Polygon node used for
/// read-only `balanceOf` calls. There are no keys, mnemonics or API tokens in
/// this file, and there is nowhere in this app for one to be put.
///
/// Defaults are chosen for the Android emulator, where the host machine is
/// reachable at 10.0.2.2. `rpcUrl` defaults to EMPTY on purpose: with no RPC
/// configured the wallet screen shows `—` for the balance instead of crashing
/// (see `AppConfig.isRpcConfigured`).
library;

import 'package:flutter/foundation.dart';

/// Immutable, testable configuration snapshot.
@immutable
class AppConfig {
  /// Creates a configuration snapshot.
  const AppConfig({
    required this.backendBaseUrl,
    required this.rpcUrl,
    required this.cattTokenAddress,
    required this.networkName,
  });

  /// Base URL of the backend Judge, without a trailing slash.
  final String backendBaseUrl;

  /// Public JSON-RPC endpoint used for read-only balance reads. Empty when no
  /// RPC is configured, which is a supported (and tested) degraded mode.
  final String rpcUrl;

  /// Address of the $CATT ERC-20 token. Empty disables the balance read.
  final String cattTokenAddress;

  /// Human-readable chain name shown in the wallet screen.
  final String networkName;

  /// True when a read-only chain connection is possible.
  bool get isRpcConfigured => rpcUrl.trim().isNotEmpty && cattTokenAddress.trim().isNotEmpty;

  /// The configuration compiled into the app binary.
  ///
  /// Overridable without touching source:
  /// ```
  /// flutter run --dart-define=CATT_BACKEND_URL=https://judge.example \
  ///             --dart-define=CATT_RPC_URL=https://polygon-rpc.example \
  ///             --dart-define=CATT_TOKEN_ADDRESS=0x...
  /// ```
  static final AppConfig fromEnvironment = AppConfig(
    backendBaseUrl: _normalised(const String.fromEnvironment(
      'CATT_BACKEND_URL',
      defaultValue: 'http://10.0.2.2:3000',
    )),
    rpcUrl: _normalised(const String.fromEnvironment('CATT_RPC_URL')),
    cattTokenAddress: _normalised(const String.fromEnvironment('CATT_TOKEN_ADDRESS')),
    networkName: _normalised(const String.fromEnvironment(
      'CATT_NETWORK_NAME',
      defaultValue: 'Polygon',
    )),
  );

  /// Returns [value] without any trailing slashes so URL joining is total.
  static String _normalised(String value) {
    var out = value.trim();
    while (out.endsWith('/')) {
      out = out.substring(0, out.length - 1);
    }
    return out;
  }

  @override
  String toString() => 'AppConfig(backendBaseUrl: $backendBaseUrl, '
      'rpcConfigured: $isRpcConfigured, network: $networkName)';
}