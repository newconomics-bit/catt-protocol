/// Native battery telemetry, read over the `com.cattprotocol/battery`
/// MethodChannel instead of `battery_plus`.
///
/// WHY THIS FILE EXISTS. `battery_plus` 7.x dropped the 4.x
/// `batteryTemperature` getter, so the app could never read the one signal the
/// backend's anti-cheat scorer actually reads
/// (`anticheat.evaluateTelemetry`). The Android platform still has it —
/// `BatteryManager.BATTERY_PROPERTY_TEMPERATURE`, with the
/// `ACTION_BATTERY_CHANGED` sticky `EXTRA_TEMPERATURE` as a fallback — so the
/// app asks the platform directly through [MethodChannelBatterySource].
///
/// THE CONTRACT WITH THE SCORER. A sample always carries the `batteryTempC`
/// key, either with a finite Celsius number or with an explicit `null`. `null`
/// means "this device cannot measure temperature" and is scored NEUTRALLY
/// (`BATTERY_NOT_REPORTED`, penalty 0); a flat constant is scored as
/// `BATTERY_FLATLINE` (-40) and an out-of-range or wrong-typed value as
/// `BATTERY_IMPOSSIBLE` (-30). So this layer has exactly one rule:
///
///  * report what the platform returned, or `null`;
///  * never substitute 0.0, an ambient guess, or any other fabricated number,
///    because a fake battery reading is fabricated evidence in a proof system;
///  * never throw. Every platform failure degrades to `null`/`false`.
///
/// The channel name and method names are exported as constants so the Kotlin
/// side, the Dart side and the tests cannot drift apart.
library;

import 'package:flutter/services.dart';

/// Channel name shared with the Android `MainActivity` (`BATTERY_CHANNEL`).
const String kBatteryChannelName = 'com.cattprotocol/battery';

/// Method returning degrees Celsius as a double, or `null` when unsupported.
const String kBatteryMethodGetTemperatureC = 'getTemperatureC';

/// Method returning charge 0..100, or `null` when unsupported.
const String kBatteryMethodGetLevelPercent = 'getLevelPercent';

/// Method returning whether a temperature reading exists at all.
const String kBatteryMethodIsTemperatureSupported = 'isTemperatureSupported';

/// The injectable seam for battery signals.
///
/// Same shape as the other seams in this codebase (`KeyStore`, `Randomness
/// Source`, the telemetry clock): production wires a platform implementation,
/// tests wire a fake, and nothing downstream of the interface knows which it
/// got.
abstract class BatterySource {
  /// Battery temperature in DEGREES CELSIUS, or `null` when the platform
  /// exposes no such sensor. The platform channel already converts the
  /// framework's tenths-of-a-degree integer (297 -> 29.7); this layer must not
  /// divide again.
  Future<double?> temperatureC();

  /// Battery charge 0..100, or `null` when unavailable. Informational only —
  /// it is not part of the telemetry payload.
  Future<int?> levelPercent();

  /// Whether this platform can report a temperature at all.
  ///
  /// Synchronous by design, so a widget can decide what to tell the reader
  /// without an `await` in `build`. It reflects the LATEST probe: call
  /// [probeTemperatureSupport] (or [temperatureC], which probes implicitly)
  /// before reading it, and it is `false` until then — an unprobed platform is
  /// treated as incapable rather than as capable-with-an-unknown-value.
  bool get isTemperatureSupported;

  /// Re-probes the platform and updates [isTemperatureSupported].
  ///
  /// Separate from [isTemperatureSupported] because that getter is synchronous
  /// (a widget reads it from `build`) while probing needs a channel round trip.
  /// [FallbackBatterySource] answers `false` without asking anything.
  Future<bool> probeTemperatureSupport();
}

/// A [BatterySource] that can re-read the platform on demand.
///
/// Implemented by the sources that cache their reading, so the collector can
/// refresh the cache without knowing anything about platform channels.
abstract class RefreshableBatterySource {
  /// Re-reads the platform and updates the cached values. Never throws.
  Future<void> refresh();
}

/// Reads battery signals from the native Android MethodChannel.
///
/// GRACEFUL FALLBACK IS THE POINT OF THIS CLASS. On iOS, desktop, in tests and
/// on any platform where the channel is not registered, every call comes back
/// as [MissingPluginException] (or a [PlatformException] from a device-side
/// failure). That is an expected state, not a failure of the reading session,
/// so every method here swallows it and answers `null` / `false`. The caller
/// cannot tell "the hardware has no sensor" from "this platform cannot ask",
/// and that is correct: both mean the same thing to the scorer.
class MethodChannelBatterySource implements BatterySource {
  /// Creates the source over [channel], defaulting to [kBatteryChannelName].
  MethodChannelBatterySource({MethodChannel? channel})
      : _channel = channel ?? const MethodChannel(kBatteryChannelName);

  final MethodChannel _channel;

  bool? _supported;

  @override
  bool get isTemperatureSupported => _supported ?? false;

  /// Asks the platform whether a temperature reading exists, caching the
  /// answer for [isTemperatureSupported]. Any channel failure caches `false`.
  @override
  Future<bool> probeTemperatureSupport() async {
    final cached = _supported;
    if (cached != null) return cached;
    try {
      final raw = await _channel
          .invokeMethod<Object>(kBatteryMethodIsTemperatureSupported);
      _supported = raw is bool ? raw : false;
    } on MissingPluginException {
      // iOS and any platform without the native side: expected, not an error.
      _supported = false;
    } on PlatformException {
      _supported = false;
    } catch (_) {
      // There is not even a binary messenger to ask (an isolate with no
      // binding, a test that never initialised one). Still "not supported".
      _supported = false;
    }
    return _supported!;
  }

  @override
  Future<double?> temperatureC() async {
    try {
      final raw =
          await _channel.invokeMethod<Object>(kBatteryMethodGetTemperatureC);
      // The channel answers `null` when the device has no sensor. Anything
      // that is not a number (a string, a bool, a map) is a malformed reply
      // and is treated the same way: no reading, never a coerced number.
      if (raw is! num) return null;
      _supported = true;
      return raw.toDouble();
    } on MissingPluginException {
      // iOS and any platform without the native side: expected, not an error.
      return null;
    } on PlatformException {
      return null;
    } catch (_) {
      // No binary messenger at all. Same answer as an unsupported device.
      return null;
    }
  }

  @override
  Future<int?> levelPercent() async {
    try {
      final raw =
          await _channel.invokeMethod<Object>(kBatteryMethodGetLevelPercent);
      if (raw is! num) return null;
      return raw.toInt();
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    } catch (_) {
      return null;
    }
  }
}

/// The honest "we cannot measure" source: no channel at all, no sensor, no
/// numbers.
///
/// Used when there is no native side to talk to, and by tests. It deliberately
/// reports `null` for the temperature — the SAME value a real unsupported
/// device produces — so the deployed app can never be confused with a device
/// whose battery is genuinely pinned at 0 C. A flat reading is a fabrication;
/// this class refuses to make one.
class FallbackBatterySource implements BatterySource {
  /// Creates the source.
  const FallbackBatterySource();

  @override
  Future<double?> temperatureC() async => null;

  @override
  Future<int?> levelPercent() async => null;

  @override
  bool get isTemperatureSupported => false;

  @override
  Future<bool> probeTemperatureSupport() async => false;
}