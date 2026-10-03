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
///    be false data in a proof system. The `batteryTempC` KEY is always
///    present — as a number or as an explicit `null` — because the scorer
///    distinguishes "no sensor" (neutral) from a malformed record, and a
///    missing key is not a shape it scores.
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
import 'battery_source.dart';

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
///
/// The SYNCHRONOUS half of the battery seam, and the type the collector and
/// the app state hold, because closing an interval must stay synchronous: the
/// flush tick cannot await a platform round trip on the UI thread. The
/// asynchronous, channel-facing half is [BatterySource] in `battery_source.dart`,
/// and [PlatformBatteryTelemetrySource] is the adapter that caches it. Tests
/// substitute their own implementation here exactly as they always have.
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

/// Battery telemetry read from the native platform channel, with `battery_plus`
/// kept only as a LEVEL fallback.
///
/// WHY THE CHANNEL: `battery_plus` 7.x exposes a charge level and no
/// temperature at all (the 4.x `batteryTemperature` getter was removed), so it
/// can never satisfy `batteryTempC`. The Android platform can — see
/// `MainActivity.kt`, which reads `BatteryManager.BATTERY_PROPERTY_TEMPERATURE`
/// and falls back to the `ACTION_BATTERY_CHANGED` sticky intent, dividing the
/// raw tenths of a degree by 10 on both paths. [BatterySource] isolates that
/// conversation and degrades to `null` wherever the channel is missing (iOS,
/// desktop, tests).
///
/// WHY THE CACHE: a platform channel call is asynchronous but closing an
/// interval is not, so the last reading is cached and refreshed by the collector
/// ([TelemetryService.start] and every closed interval). A sample therefore
/// carries the most recent real reading — at most one flush interval old — and
/// `null` until the first read comes back. `null` is never replaced by a
/// guess, and a reading that stops being available goes back to `null` rather
/// than freezing on the last value, because a frozen battery temperature is
/// exactly the `BATTERY_FLATLINE` signature the scorer punishes.
///
/// `battery_plus` is still used for [levelPercent] when the channel has no
/// answer, which is what keeps iOS showing a charge percentage in the wallet
/// screen. The level is informational and is never part of the payload.
class PlatformBatteryTelemetrySource
    implements BatteryTelemetrySource, RefreshableBatterySource {
  /// Creates the source over [source], defaulting to the platform channel.
  PlatformBatteryTelemetrySource({
    BatterySource? source,
    Future<int> Function()? levelReader,
  })  : _source = source ?? MethodChannelBatterySource(),
        _levelReader = levelReader ?? _platformLevel;

  final BatterySource _source;
  final Future<int> Function() _levelReader;

  static Future<int> _platformLevel() => Battery().batteryLevel;

  double? _temperatureC;
  bool _temperatureSupported = false;

  @override
  double? temperatureC() => _temperatureC;

  @override
  bool get hasTemperatureSensor => _temperatureSupported;

  /// Re-reads the channel and updates the cached temperature.
  ///
  /// Fire-and-forget safe: any failure leaves the cache exactly as it was and
  /// never propagates, so a telemetry tick cannot be taken down by a missing
  /// platform channel.
  @override
  Future<void> refresh() async {
    try {
      final temperature = await _source.temperatureC();
      _temperatureC = temperature;
      // Capability is sticky once proven: a single failed read is a missing
      // SAMPLE, not proof that the hardware lost the sensor, and flipping the
      // flag back would make the reader screen claim a device is incapable
      // between two good readings.
      _temperatureSupported = temperature != null ||
          _temperatureSupported ||
          await _source.probeTemperatureSupport();
    } catch (_) {
      // Defence in depth: BatterySource implementations already fail soft, so
      // this only guards against a misbehaving injected source.
    }
  }

  @override
  Future<int?> levelPercent() async {
    final fromChannel = await _source.levelPercent();
    if (fromChannel != null) return fromChannel;
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

  /// Battery signals, degrading to "no sensor" when unavailable. Injected so
  /// the collector never touches a platform channel itself; production passes
  /// [PlatformBatteryTelemetrySource], which reads the native channel through
  /// [BatterySource].
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

  /// Re-reads the battery source when it caches its reading, so the NEXT
  /// closed interval carries a fresh temperature.
  ///
  /// The refresh is a fire-and-forget round trip: closing an interval stays
  /// synchronous (the flush tick must not block the UI thread on a platform
  /// channel), so a sample carries the reading taken at most one interval
  /// earlier. Sources that do not cache — every test fake, and the null source
  /// — are skipped entirely.
  void _scheduleBatteryRefresh() {
    final source = battery;
    if (source is! RefreshableBatterySource) return;
    unawaited((source as RefreshableBatterySource).refresh());
  }

  /// Awaits the first battery read so the very first sample of a session is not
  /// forced to report `null` merely because the channel had not answered yet.
  Future<void> _primeBattery() async {
    final source = battery;
    if (source is! RefreshableBatterySource) return;
    await (source as RefreshableBatterySource).refresh();
  }

  /// Starts sampling for [sessionId].
  ///
  /// Starting for the same session twice is a no-op, so a widget rebuild does
  /// not double-sample. Starting for a DIFFERENT session flushes the previous
  /// one first so its accumulated samples are not lost.
  Future<void> start(String sessionId) async {
    if (_disposed) return;
    if (_handle != null && _sessionId == sessionId) return;
    if (_handle != null) await stop();
    await _primeBattery();
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
    // Read the temperature this interval closes on, then kick off the read for
    // the next one. `null` here means "no reading yet / no sensor" and is
    // carried into the sample as an explicit null — never a substitute value.
    final temperature = battery.temperatureC();
    _scheduleBatteryRefresh();
    final sample = TelemetrySample(
      ts: clock.nowMs(),
      batteryTempC: temperature,
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