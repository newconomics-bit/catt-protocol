/// One Proof-of-Attention telemetry sample (PRD 3.1 / 3.2).
///
/// THE SHAPE IS A CONTRACT, NOT A STYLE CHOICE. The backend's
/// `anticheat.evaluateTelemetry(samples)` reads exactly:
///
/// ```json
/// { "ts": 1712345678901,
///   "batteryTempC": 31.4,
///   "touch": { "x": 120.5, "y": 840.25 },
///   "scrollDelta": -318.0 }
/// ```
///
/// and penalises, among other things, a battery temperature that never moves
/// (`BATTERY_FLATLINE`) and the same touch coordinate landing twice
/// (`PIXEL_PERFECT_TOUCH`). So this class:
///
///  * emits EXACTLY those four keys, in that order, with no extras — an extra
///    key is dead weight and a missing one is an unscored sample;
///  * carries the REAL sensor values and nothing else. There is no synthetic
///    fallback, no jitter and no "plausible" generator anywhere in this app:
///    fabricating plausible telemetry would be helping the user defeat the
///    protocol's own anti-cheat, and it would also be dishonest data in a
///    proof system. When a signal is genuinely unavailable the sample records
///    `null` and the Judge decides what that means;
///  * records `touch: null` for an interval in which the reader did not touch
///    the screen, rather than reusing the last coordinate. Repeating a
///    coordinate is precisely what `PIXEL_PERFECT_TOUCH` looks for, and
///    inventing one would manufacture the very flag we are trying to avoid.
library;

import 'package:flutter/foundation.dart';

/// A touch position in global (render) space.
@immutable
class TouchPoint {
  /// Creates a touch point.
  const TouchPoint(this.x, this.y);

  /// Parses a `{x, y}` object.
  factory TouchPoint.fromJson(Object? raw) {
    if (raw is! Map) return const TouchPoint(0, 0);
    final x = raw['x'];
    final y = raw['y'];
    return TouchPoint(
      x is num ? x.toDouble() : 0,
      y is num ? y.toDouble() : 0,
    );
  }

  /// Horizontal position in logical pixels.
  final double x;

  /// Vertical position in logical pixels.
  final double y;

  /// Exact wire form.
  Map<String, double> toJson() => <String, double>{'x': x, 'y': y};

  /// Equality is exact: the Judge's pixel-perfect check keys on the exact
  /// pair, so rounding here would corrupt the comparison either way.
  @override
  bool operator ==(Object other) =>
      other is TouchPoint && other.x == x && other.y == y;

  @override
  int get hashCode => Object.hash(x, y);

  @override
  String toString() => 'TouchPoint($x, $y)';
}

/// One telemetry sample.
@immutable
class TelemetrySample {
  /// Creates a sample.
  const TelemetrySample({
    required this.ts,
    required this.batteryTempC,
    required this.touch,
    required this.scrollDelta,
  });

  /// Parses a sample off the wire (used by tests and by debug tooling).
  factory TelemetrySample.fromJson(Map<String, dynamic> json) => TelemetrySample(
        ts: json['ts'] is num
            ? (json['ts']! as num).toInt()
            : (int.tryParse('${json['ts'] ?? ''}') ?? 0),
        batteryTempC: json['batteryTempC'] is num
            ? (json['batteryTempC']! as num).toDouble()
            : null,
        touch: json['touch'] == null
            ? null
            : TouchPoint.fromJson(json['touch']),
        scrollDelta: json['scrollDelta'] is num
            ? (json['scrollDelta']! as num).toDouble()
            : 0,
      );

  /// Epoch milliseconds. Read from the injected clock, never `DateTime.now()`
  /// inline, so tests can drive the timeline deterministically.
  final int ts;

  /// Battery temperature in Celsius, or `null` when the platform exposes no
  /// battery sensor (emulator, desktop, some tablets). `null` is reported
  /// honestly; it is never replaced by a guess.
  final double? batteryTempC;

  /// The last touch in this interval, or `null` if there was none.
  final TouchPoint? touch;

  /// Signed pixels scrolled during this interval. 0 when the reader did not
  /// scroll. Negative is scrolling up.
  final double scrollDelta;

  /// The EXACT wire shape the backend scores.
  ///
  /// `batteryTempC` and `touch` are emitted as explicit `null`s rather than
  /// being omitted, so every sample has the same four keys and a client-side
  /// shape check cannot pass on a partially-populated batch.
  Map<String, dynamic> toJson() => <String, dynamic>{
        'ts': ts,
        'batteryTempC': batteryTempC,
        'touch': touch?.toJson(),
        'scrollDelta': scrollDelta,
      };

  /// Copy with selected fields replaced.
  TelemetrySample copyWith({
    int? ts,
    double? batteryTempC,
    TouchPoint? touch,
    double? scrollDelta,
  }) =>
      TelemetrySample(
        ts: ts ?? this.ts,
        batteryTempC: batteryTempC ?? this.batteryTempC,
        touch: touch ?? this.touch,
        scrollDelta: scrollDelta ?? this.scrollDelta,
      );

  @override
  String toString() =>
      'TelemetrySample(ts: $ts, batteryTempC: $batteryTempC, touch: $touch, '
      'scrollDelta: $scrollDelta)';
}