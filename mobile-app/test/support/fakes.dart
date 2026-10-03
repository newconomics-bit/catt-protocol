/// Shared fakes and fixtures for the test suite.
///
/// Everything here replaces a real external dependency — a socket, a platform
/// channel, a timer — so the whole app is testable with no device, no network
/// and no real five-second wait. No test in this suite sleeps.
library;

import 'package:catt_app/models/article.dart';
import 'package:catt_app/models/mission.dart';
import 'package:catt_app/models/telemetry_sample.dart';
import 'package:catt_app/services/telemetry_service.dart';

/// A scheduler the test ticks by hand.
class RecordingTelemetryScheduler implements TelemetryScheduler {
  Duration? scheduledInterval;
  void Function()? _tick;
  int scheduleCount = 0;
  int cancelCount = 0;

  bool get isCancelled => cancelCount > 0;

  @override
  TelemetryHandle schedulePeriodic(Duration interval, void Function() tick) {
    scheduledInterval = interval;
    _tick = tick;
    scheduleCount++;
    return _RecordingHandle(this);
  }

  /// Fires the scheduled callback once.
  void tick() => _tick?.call();
}

class _RecordingHandle implements TelemetryHandle {
  _RecordingHandle(this._scheduler);

  final RecordingTelemetryScheduler _scheduler;

  @override
  void cancel() => _scheduler.cancelCount++;
}

/// A battery source a test controls, including "no sensor".
class FakeBatteryTelemetrySource implements BatteryTelemetrySource {
  FakeBatteryTelemetrySource({this.temperature, this.level = 77});

  /// Reading to report; `null` means "no sensor", which is the degraded mode.
  double? temperature;

  /// Charge percentage to report.
  int level;

  @override
  double? temperatureC() => temperature;

  @override
  bool get hasTemperatureSensor => temperature != null;

  @override
  Future<int?> levelPercent() async => level;
}

/// A telemetry sink that records every batch it was handed.
class RecordingTelemetrySink {
  /// Session id of every batch, in order.
  final List<String> sessionIds = <String>[];

  /// The samples of every batch, in order.
  final List<List<TelemetrySample>> batches = <List<TelemetrySample>>[];

  /// When true, every upload throws, simulating a dropped connection.
  bool failUploads = false;

  /// Total samples uploaded across all batches.
  int get sampleCount =>
      batches.fold<int>(0, (int sum, List<TelemetrySample> b) => sum + b.length);

  /// The samples of the batch at [index].
  List<TelemetrySample> batchAt(int index) => batches.elementAt(index);

  Future<void> call(String sessionId, List<TelemetrySample> samples) async {
    sessionIds.add(sessionId);
    batches.add(List<TelemetrySample>.from(samples));
    if (failUploads) throw StateError('network down');
  }
}

/// A mutable counter that can be passed as a `VoidCallback` and inspected
/// afterwards, which a bare `int` cannot do inside a closure.
class Counter {
  /// How many times the callback ran.
  int value = 0;

  /// Increments [value]. Usable directly as a `VoidCallback`.
  void call() => value++;
}

/// The twelve-CATT string the backend uses for mission 1.
const String kTwelveCatt = '12000000000000000000';

/// The one-CATT stamina string.
const String kOneCatt = '1000000000000000000';

/// Builds a mission as `GET /api/missions` would return it.
Map<String, dynamic> missionJson({
  String id = 'mission-1',
  String articleId = 'art-focus-101',
  String difficulty = 'EASY',
  String reward = kTwelveCatt,
  String staminaCost = kOneCatt,
}) =>
    <String, dynamic>{
      'id': id,
      'articleId': articleId,
      'difficulty': difficulty,
      'reward': reward,
      'staminaCost': staminaCost,
    };

/// Builds an article layout as `GET /api/article/:id?session=…` returns it,
/// with the answer key ALREADY STRIPPED exactly as the server strips it.
Map<String, dynamic> articleJson({
  String id = 'art-focus-101',
  String missionId = 'mission-1',
  String title = 'Why Your Attention Slips',
  int paragraphCount = 6,
  int trapIndex = 3,
  String trapType = 'tap-the-image',
  int questionCount = 2,
  int minMatches = 2,
}) {
  return <String, dynamic>{
    'id': id,
    'missionId': missionId,
    'title': title,
    'difficulty': 'EASY',
    'reward': kTwelveCatt,
    'staminaCost': kOneCatt,
    'paragraphs': <String>[
      for (var i = 0; i < paragraphCount; i++) 'Paragraph $i. It has a second sentence here.',
    ],
    'focusTrap': <String, dynamic>{'index': trapIndex, 'type': trapType},
    'quiz': <Map<String, dynamic>>[
      for (var i = 0; i < questionCount; i++)
        <String, dynamic>{
          'id': 'q$i',
          'question': 'Question $i?',
          // `correctIndex` is absent: the server strips it.
          'options': <String>['Option A$i', 'Option B$i', 'Option C$i'],
        },
    ],
    'highlightTask': <String, dynamic>{
      'instructions': 'Highlight the key sentences.',
      'minMatches': minMatches,
      // `keySentences` is absent: the server strips it.
    },
  };
}

/// Builds a parsed [ArticleLayout] from [articleJson].
ArticleLayout sampleArticle({
  int paragraphCount = 6,
  int trapIndex = 3,
  String trapType = 'tap-the-image',
}) =>
    ArticleLayout.fromJson(
      articleJson(paragraphCount: paragraphCount, trapIndex: trapIndex, trapType: trapType),
    );

/// Builds a parsed [Mission] from [missionJson].
Mission sampleMission({String id = 'mission-1'}) =>
    Mission.fromJson(missionJson(id: id));