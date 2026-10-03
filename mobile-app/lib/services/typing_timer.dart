/// Typing-time measurement for the free-text answer.
///
/// The backend scores `typingMs` against a floor of 60 ms per implied character
/// (`anticheat.MIN_TYPING_MS_PER_CHAR`), so a replayed answer is detectable by
/// being too fast. This class therefore measures REAL elapsed wall time from the
/// moment the free-text field gains focus until submit — it never estimates,
/// never pads, and never has a "minimum" that would inflate a fast typist into
/// passing.
///
/// The clock is injected so the measurement is testable with no real waiting.
library;

import '../services/telemetry_service.dart';

/// Accumulates elapsed typing time across focus/stop cycles.
class TypingTimer {
  /// Creates a timer over [clock].
  TypingTimer({this.clock = const SystemTelemetryClock()});

  /// Source of elapsed time. Injected so the measurement needs no real waiting.
  final TelemetryClock clock;

  int _accumulatedMs = 0;
  int? _startedAtMs;

  /// Whether the timer is currently counting.
  bool get isRunning => _startedAtMs != null;

  /// Total measured milliseconds, including any completed focus period.
  int get elapsedMs {
    final startedAt = _startedAtMs;
    if (startedAt == null) return _accumulatedMs;
    final now = clock.nowMs();
    return _accumulatedMs + (now > startedAt ? now - startedAt : 0);
  }

  /// Starts (or restarts) counting. Starting twice keeps the earliest start so
  /// time cannot be lost by a focus event firing twice.
  void start() {
    _startedAtMs ??= clock.nowMs();
  }

  /// Stops counting and banks the elapsed time.
  void stop() {
    final startedAt = _startedAtMs;
    if (startedAt == null) return;
    final now = clock.nowMs();
    if (now > startedAt) _accumulatedMs += now - startedAt;
    _startedAtMs = null;
  }

  /// Clears everything, for a fresh attempt.
  void reset() {
    _accumulatedMs = 0;
    _startedAtMs = null;
  }
}