/// Proof-of-Attention telemetry collection (PRD 3.1 "Telemetry Collection").
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
/// and penalises a battery temperature that never moves (`BATTERY_FLATLINE`,
/// -40) and the same touch coordinate landing twice (`PIXEL_PERFECT_TOUCH`,
/// -25), so a naive batcher fails a human for the wrong reason. Therefore:
///
///  * ONE SAMPLE PER FLUSH INTERVAL, carrying the aggregate for that interval:
///    `touch` is the last real touch of the interval (or `null` if there was
///    none) and `scrollDelta` is the signed total distance scrolled. A
///    coordinate is never reused or invented — repeating one is exactly the bot
///    signature the Judge looks for.
///  * `batteryTempC` is whatever the platform reports, or `null` when the
///    platform exposes no sensor. There is NO synthetic fallback and no jitter
///    anywhere in this app: fabricating plausible hardware telemetry would be
///    helping the reader defeat the protocol's own anti-cheat, and it would also
///    be false data in a proof system.
///  * `ts` comes from the injected [TelemetryClock]. There is no inline
///    `DateTime.now()` in this file, so tests drive the timeline exactly.
///
/// Everything external is injected — clock, scheduler, battery, sink — so the
/// batching logic is testable with no device, no platform channel and no real
/// five-second wait.
library;

import 'dart:async';

import 'package:battery_plus/battery_plus.dart';

import '../models/telemetry_sample.dart';

/// The flush cadence the backend contract expects (PRD 3.1: "sent to the
/// backend every 5 seconds"). Exported so tests assert the interval the service
/// actually schedules instead of hard-coding 5000 in two places.
const Duration kTelemetryFlushInterval = Duration(seconds: 5);

/// Milliseconds since epoch. Injectable so tests pin the timeline.
abstract class TelemetryClock {
  /// Current epoch milliseconds.
  int nowMs();
}

/// Wall-clock implementation.
class SystemTelemetryClock implements TelemetryClock {
  /// Creates the clock.
  const SystemTelemetryClock();

  @override
  int nowMs() => DateTime.now().millisecondsSinceEpoch;
}

/// A clock a test advances by hand.
class FakeTelemetryClock implements TelemetryClock {
  /// Creates a clock starting at [startMs].
  FakeTelemetryClock([this._nowMs = 1700000000000]);

  int _nowMs;

  @override
  int nowMs() => _nowMs;

  /// Moves the clock forward.
  void advance(Duration by) => _nowMs += by.inMilliseconds;

  /// Sets the clock to an absolute instant.
  void set(int epochMs) => _nowMs = epochMs;
}

/// Handle for a scheduled periodic callback.
abstract class TelemetryHandle {
  /// Cancels the schedule. Safe to call more than once.
  void cancel();
}

/// Schedules the flush tick. Injected so tests tick it manually instead of
/// waiting five real seconds.
abstract class TelemetryScheduler {
  /// Runs [tick] every [interval] until cancelled.
  TelemetryHandle schedulePeriodic(Duration interval, void Function() tick);
}

/// `Timer.periodic` implementation used in the app.
class TimerTelemetryScheduler implements TelemetryScheduler {
  /// Creates the scheduler.
  const TimerTelemetryScheduler();

  @override
  TelemetryHandle schedulePeriodic(Duration interval, void Function() tick) {
    final timer = Timer.periodic(interval, (_) => tick());
    return _TimerHandle(timer);
  }
}

class _TimerHandle implements TelemetryHandle {
  _TimerHandle(this._timer);

  final Timer _timer;

  @override
  void cancel() => _timer.cancel();
}

/// Reads battery signals for telemetry.
abstract class BatteryTelemetrySource {
  /// Battery temperature in degrees Celsius, or `null` when the platform
  /// exposes no such sensor.
  double? temperatureC();

  /// Whether this platform can report a temperature at all. When false the
  /// reader screen tells the user their device cannot supply the signal
  /// instead of leaving them to be silently failed by the Judge.
  bool get hasTemperatureSensor;

  /// Battery charge 0..100, or `null` when unavailable. Informational only —
  /// it is not part of the telemetry payload.
  Future<int?> levelPercent();
}

/// A source that reports no signals at all: no battery sensor, no level.
/// Used by tests and as the safe fallback when the platform channel is
/// unavailable.
class NullBatteryTelemetrySource implements BatteryTelemetrySource {
  /// Creates the source.
  const NullBatteryTelemetrySource();

  @override
  double? temperatureC() => null;

  @override
  bool get hasTemperatureSensor => false;

  @override
  Future<int?> levelPercent() async => null;
}

/// `battery_plus`-backed source.
///
/// HONEST DEGRADATION, DOCUMENTED: `battery_plus 7.x` exposes battery LEVEL
/// only — there is no temperature getter in the package (the 4.x
/// `batteryTemperature` API was removed). So [temperatureC] is `null` by
/// construction and [hasTemperatureSensor] is `false`, and the app says so in
/// the reader rather than substituting an ambient guess. Nothing is faked: the
/// sample carries `batteryTempC: null`, which the Judge scores as
/// `BATTERY_IMPOSSIBLE`, and the reader is warned that hardware telemetry will
/// cost them the claim on this device.
///
/// If a future plugin version exposes a real temperature, this is the single
/// place to wire it: the sampling, batching and payload paths above are
/// unchanged and already testable.
class PlatformBatteryTelemetrySource implements BatteryTelemetrySource {
  /// Creates the source over [battery].
  PlatformBatteryTelemetrySource({Future<int> Function()? levelReader})
      : _levelReader = levelReader ?? _platformLevel;

  final Future<int> Function() _levelReader;

  static Future<int> _platformLevel() => Battery().batteryLevel;

  @override
  double? temperatureC() => null;

  @override
  bool get hasTemperatureSensor => false;

  @override
  Future<int?> levelPercent() async {
    try {
      return await _levelReader();
    } catch (_) {
      // Unsupported platform, permission denial, channel error: all degrade
      // to "unknown" rather than throwing into the reading session.
      return null;
    }
  }
}

/// Uploads one batch. Injected so tests capture payloads without HTTP.
typedef TelemetrySink = Future<void> Function(
  String sessionId,
  List<TelemetrySample> samples,
);

/// Outcome of a flush.
enum TelemetryUploadStatus {
  /// The batch was accepted, or there was nothing to send.
  ok,

  /// The upload failed. Samples are DISCARDED, not retried forever: replaying
  /// an old window after a reconnect would land stale timestamps next to fresh
  /// ones and corrupt the server's scroll-velocity computation, which divides
  /// `scrollDelta` by the interval between consecutive `ts` values.
  failed,
}

/// Accumulates telemetry and flushes it in batches.
class TelemetryService {
  /// Creates the service.
  TelemetryService({
    required this.sink,
    this.clock = const SystemTelemetryClock(),
    this.scheduler = const TimerTelemetryScheduler(),
    this.battery = const NullBatteryTelemetrySource(),
    this.flushInterval = kTelemetryFlushInterval,
  });

  /// Where batches go. Injected so tests capture payloads with no HTTP.
  final TelemetrySink sink;

  /// Source of the `ts` field. Never `DateTime.now()` inline.
  final TelemetryClock clock;

  /// Drives the periodic flush.
  final TelemetryScheduler scheduler;

  /// Battery signals, degrading to "no sensor" when unavailable.
  final BatteryTelemetrySource battery;

  /// How often a batch is closed and uploaded.
  final Duration flushInterval;

  TelemetryHandle? _handle;
  String? _sessionId;
  TouchPoint? _pendingTouch;
  double _pendingScrollDelta = 0;
  bool _disposed = false;

  /// Samples successfully uploaded since [start]. Diagnostic only.
  int uploadedCount = 0;

  /// Outcome of the most recent upload; `null` before the first one.
  TelemetryUploadStatus? lastUploadStatus;

  /// Whether the service is currently sampling.
  bool get isRunning => _handle != null;

  /// Whether this device can supply a battery temperature at all.
  bool get hasBatteryTemperature => battery.hasTemperatureSensor;

  /// Starts sampling for [sessionId].
  ///
  /// Starting for the same session twice is a no-op, so a widget rebuild does
  /// not double-sample. Starting for a DIFFERENT session flushes the previous
  /// one first so its accumulated samples are not lost.
  Future<void> start(String sessionId) async {
    if (_disposed) return;
    if (_handle != null && _sessionId == sessionId) return;
    if (_handle != null) await stop();
    _sessionId = sessionId;
    _handle = scheduler.schedulePeriodic(flushInterval, tick);
  }

  /// Records a touch in GLOBAL (render) space for the current interval.
  ///
  /// Called from the reader's `GestureDetector` with the event's global
  /// position, so the coordinates are device-independent of where the gesture
  /// happened inside the widget tree. Only the most recent touch of the
  /// interval is kept, because the sample shape has exactly one `touch` field.
  void recordTouch(double globalX, double globalY) {
    _pendingTouch = TouchPoint(globalX, globalY);
  }

  /// Adds [delta] logical pixels scrolled during the current interval.
  ///
  /// Signed, and signed the way the platform reports it: moving forward
  /// through the article increases `metrics.pixels` and therefore [delta],
  /// while scrolling back to re-read something decreases it. The Judge takes the
  /// magnitude, so only the velocity matters — but keeping the sign means the
  /// data reads honestly instead of being absolute-valued away.
  void recordScroll(double delta) {
    _pendingScrollDelta += delta;
  }

  /// Closes the current interval and returns the sample for it.
  ///
  /// Returns `null` when the service is not running for a session.
  TelemetrySample? takeIntervalSample() {
    final sessionId = _sessionId;
    if (sessionId == null || sessionId.isEmpty) return null;
    final sample = TelemetrySample(
      ts: clock.nowMs(),
      batteryTempC: battery.temperatureC(),
      touch: _pendingTouch,
      scrollDelta: _pendingScrollDelta,
    );
    _pendingTouch = null;
    _pendingScrollDelta = 0;
    return sample;
  }

  /// Closes the current interval and flushes it.
  ///
  /// This is what the periodic tick calls, and it is deliberately SYNCHRONOUS
  /// so a test can assert the payload immediately after a tick. The upload runs
  /// fire-and-forget: the tick must not stall the UI thread on a network round
  /// trip, and [lastUploadStatus] records the outcome for the UI to show.
  void tick() {
    final sessionId = _sessionId;
    final sample = takeIntervalSample();
    if (sessionId == null || sample == null) return;
    unawaited(_upload(sessionId, <TelemetrySample>[sample]));
  }

  /// Stops sampling and flushes whatever has accumulated, so the last partial
  /// window is not silently dropped when the reader leaves the article.
  ///
  /// Returns the outcome of the final upload, or `null` when there was nothing
  /// pending.
  Future<TelemetryUploadStatus?> stop() async {
    // The session id is captured before it is cleared, so the final window is
    // still attributed to the session it was gathered for.
    final sessionId = _sessionId;
    final sample = takeIntervalSample();
    _handle?.cancel();
    _handle = null;
    _sessionId = null;
    if (sessionId == null || sample == null) return null;
    return _upload(sessionId, <TelemetrySample>[sample]);
  }

  Future<TelemetryUploadStatus> _upload(
    String sessionId,
    List<TelemetrySample> samples,
  ) async {
    if (samples.isEmpty) return TelemetryUploadStatus.ok;
    try {
      await sink(sessionId, samples);
      uploadedCount += samples.length;
      lastUploadStatus = TelemetryUploadStatus.ok;
    } catch (_) {
      // Deliberately swallowed and reported as a status: a telemetry upload
      // failing must never take the reading session down with it.
      lastUploadStatus = TelemetryUploadStatus.failed;
    }
    return lastUploadStatus!;
  }

  /// Releases resources without flushing. Use [stop] when the accumulated
  /// window still matters.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _handle?.cancel();
    _handle = null;
    _sessionId = null;
  }
}