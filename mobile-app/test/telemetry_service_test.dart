/// Batching and payload-shape tests for the telemetry collector.
///
/// NO TEST HERE WAITS FIVE REAL SECONDS. The flush cadence is driven by an
/// injected [TelemetryScheduler] that the test ticks by hand, and the `ts`
/// values come from an injected [FakeTelemetryClock]. The one test that does
/// exercise the real `Timer.periodic` scheduler uses `fakeAsync` and elapses
/// virtual time, so it is still instant and still deterministic.
library;

import 'package:catt_app/config.dart';
import 'package:catt_app/models/telemetry_sample.dart';
import 'package:catt_app/services/api_client.dart';
import 'package:catt_app/services/telemetry_service.dart';
import 'package:catt_app/services/typing_timer.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart' show MissingPluginException;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/fakes.dart';

/// The exact key set the backend's `evaluateTelemetry` reads.
const Set<String> kBackendSampleKeys = <String>{
  'ts',
  'batteryTempC',
  'touch',
  'scrollDelta',
};

void main() {
  group('flush cadence', () {
    test('schedules the flush at the 5-second cadence the contract expects', () async {
      final scheduler = RecordingTelemetryScheduler();
      final service = TelemetryService(
        sink: RecordingTelemetrySink().call,
        scheduler: scheduler,
      );
      expect(service.flushInterval, const Duration(seconds: 5));
      expect(kTelemetryFlushInterval, const Duration(seconds: 5));

      await service.start('sess-1');
      expect(scheduler.scheduledInterval, const Duration(seconds: 5));
      expect(scheduler.scheduleCount, 1);
      service.dispose();
    });

    test('the real Timer.periodic scheduler fires once per 5s of virtual time',
        () {
      fakeAsync((FakeAsync async) {
        var fired = 0;
        const scheduler = TimerTelemetryScheduler();
        final handle = scheduler.schedulePeriodic(
          kTelemetryFlushInterval,
          () => fired++,
        );
        expect(fired, 0);
        async.elapse(const Duration(milliseconds: 4999));
        expect(fired, 0, reason: 'must not fire early');
        async.elapse(const Duration(milliseconds: 1));
        expect(fired, 1);
        async.elapse(const Duration(seconds: 10));
        expect(fired, 3);
        handle.cancel();
        async.elapse(const Duration(seconds: 30));
        expect(fired, 3, reason: 'cancel() must stop the schedule');
      });
    });

    test('a sample exists only once a session is running, and closing it resets',
        () async {
      final scheduler = RecordingTelemetryScheduler();
      final clock = FakeTelemetryClock();
      final service = TelemetryService(
        sink: RecordingTelemetrySink().call,
        clock: clock,
        scheduler: scheduler,
      );

      expect(service.takeIntervalSample(), isNull, reason: 'not started yet');
      await service.start('sess-1');
      service
        ..recordTouch(5, 6)
        ..recordScroll(-20);
      clock.advance(const Duration(seconds: 5));
      final first = service.takeIntervalSample()!;
      expect(first.touch, const TouchPoint(5, 6));
      expect(first.scrollDelta, -20);
      // Closing the window clears the pending state, so the next sample cannot
      // inherit a stale touch or duplicate a scroll delta.
      final second = service.takeIntervalSample()!;
      expect(second.touch, isNull);
      expect(second.scrollDelta, 0);
      expect(second.ts, first.ts);
      service.dispose();
    });
  });

  group('batching', () {
    late RecordingTelemetryScheduler scheduler;
    late FakeTelemetryClock clock;
    late RecordingTelemetrySink sink;
    late TelemetryService service;

    setUp(() {
      scheduler = RecordingTelemetryScheduler();
      clock = FakeTelemetryClock();
      sink = RecordingTelemetrySink();
      service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: FakeBatteryTelemetrySource(temperature: 31.4),
      );
    });

    test('accumulates one sample per interval and uploads each batch', () async {
      await service.start('sess-1');

      service.recordTouch(120, 840);
      service.recordScroll(-120);
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      service.recordTouch(400, 900);
      service.recordScroll(60);
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      expect(sink.batches.length, 2);
      expect(sink.sampleCount, 2);
      expect(sink.sessionIds, <String>['sess-1', 'sess-1']);
      expect(service.uploadedCount, 2);
      service.dispose();
    });

    test('aggregates a whole interval into one sample, not one per event',
        () async {
      await service.start('sess-1');
      // Three touches and five scrolls inside a single 5s window.
      service
        ..recordTouch(10, 10)
        ..recordScroll(-50)
        ..recordTouch(11, 12)
        ..recordScroll(-20)
        ..recordTouch(13, 14)
        ..recordScroll(30);
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      expect(sink.sampleCount, 1);
      final sample = sink.batchAt(0).single;
      // Touch is a position, not a count: the last real one in the window.
      expect(sample.touch, const TouchPoint(13, 14));
      // Scroll accumulates across the window and keeps its sign.
      expect(sample.scrollDelta, -40);
      service.dispose();
    });

    test('an interval with no interaction reports null touch and zero scroll',
        () async {
      await service.start('sess-1');
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      final sample = sink.batchAt(0).single;
      expect(sample.touch, isNull,
          reason: 'never reuse a coordinate: that is PIXEL_PERFECT_TOUCH');
      expect(sample.scrollDelta, 0);
      service.dispose();
    });

    test('ts comes from the injected clock, one per interval', () async {
      await service.start('sess-1');
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      expect(sink.batchAt(0).single.ts, 1700000005000);
      expect(sink.batchAt(1).single.ts, 1700000010000);
      expect(sink.batchAt(1).single.ts - sink.batchAt(0).single.ts, 5000);
      service.dispose();
    });

    test('stop() flushes the partial final window instead of dropping it',
        () async {
      await service.start('sess-1');
      service.recordTouch(7, 7);
      service.recordScroll(-15);
      clock.advance(const Duration(milliseconds: 1200));

      final status = await service.stop();
      expect(status, TelemetryUploadStatus.ok);
      expect(sink.sampleCount, 1);
      expect(sink.batchAt(0).single.scrollDelta, -15);
      expect(sink.batchAt(0).single.ts, 1700000001200);
      expect(service.isRunning, isFalse);
    });

    test('a window is a window even when nothing happened in it', () async {
      await service.start('sess-1');
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      // The trailing window is still a real observation: the reader was on the
      // page, it simply did not scroll or tap. Dropping it would shorten the
      // judged stream, so it is reported honestly with null touch / zero delta.
      expect(await service.stop(), TelemetryUploadStatus.ok);
      expect(sink.sampleCount, 2);
      expect(sink.batchAt(1).single.touch, isNull);
      expect(sink.batchAt(1).single.scrollDelta, 0);
      expect(sink.batchAt(1).single.ts, 1700000005000);
    });

    test('starting twice for the same session does not double-sample', () async {
      await service.start('sess-1');
      await service.start('sess-1');
      expect(scheduler.scheduleCount, 1);
      scheduler.tick();
      await pumpEventQueue();
      expect(sink.sampleCount, 1);
      service.dispose();
    });

    test('starting a different session flushes the previous one first',
        () async {
      await service.start('sess-1');
      service.recordTouch(1, 1);
      await service.start('sess-2');
      expect(sink.sessionIds.first, 'sess-1',
          reason: 'the old window must not be lost');
      scheduler.tick();
      await pumpEventQueue();
      expect(sink.sessionIds.last, 'sess-2');
      service.dispose();
    });

    test('a failing upload is reported, not thrown, and never retried forever',
        () async {
      sink.failUploads = true;
      await service.start('sess-1');
      scheduler.tick();
      await pumpEventQueue();
      expect(service.lastUploadStatus, TelemetryUploadStatus.failed);
      expect(service.uploadedCount, 0);
      expect(await service.stop(), TelemetryUploadStatus.failed);
      service.dispose();
    });
  });

  group('the wire payload matches the backend contract exactly', () {
    test('toJson emits exactly the four keys and nothing else', () {
      final json = TelemetrySample(
        ts: 1700000000000,
        batteryTempC: 31.4,
        touch: const TouchPoint(120.5, 840.25),
        scrollDelta: -318.0,
      ).toJson();
      expect(json.keys.toSet(), kBackendSampleKeys);
      expect(json['touch'], isA<Map<String, dynamic>>());
      expect((json['touch']! as Map<String, dynamic>).keys.toSet(), <String>{'x', 'y'});
    });

    test('POST /api/telemetry sends {sessionId, samples:[...]} with that shape',
        () async {
      http.Request? captured;
      final client = MockClient((http.Request request) async {
        captured = request;
        return http.Response(
          '{"accepted":1,"total":1,"telemetry":{"score":100,"flags":[]}}',
          200,
          headers: <String, String>{'content-type': 'application/json'},
        );
      });
      final api = ApiClient(
        config: const AppConfig(
          backendBaseUrl: 'http://judge.test',
          rpcUrl: '',
          cattTokenAddress: '',
          networkName: 'Polygon',
        ),
        httpClient: client,
      );

      final sink = RecordingTelemetrySink();
      final clock = FakeTelemetryClock();
      final scheduler = RecordingTelemetryScheduler();
      final telemetry = TelemetryService(
        sink: (String sessionId, List<TelemetrySample> samples) async {
          await api.postTelemetry(sessionId: sessionId, samples: samples);
          await sink.call(sessionId, samples);
        },
        clock: clock,
        scheduler: scheduler,
        battery: FakeBatteryTelemetrySource(temperature: 29.75),
      );

      await telemetry.start('sess-1');
      telemetry
        ..recordTouch(120.5, 840.25)
        ..recordScroll(-318.0);
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      expect(captured, isNotNull);
      expect(captured!.method, 'POST');
      expect(captured!.url.path, '/api/telemetry');
      final body = captured!.body;
      expect(body, contains('"sessionId":"sess-1"'));
      expect(body, contains('"batteryTempC":29.75'));
      expect(body, contains('"touch":{"x":120.5,"y":840.25}'));
      expect(body, contains('"scrollDelta":-318.0'));
      expect(body, contains('"ts":1700000005000'));
      // No extra keys anywhere in the payload.
      expect(body, isNot(contains('batteryLevel')));
      expect(body, isNot(contains('correctIndex')));
      expect(sink.sampleCount, 1);
      telemetry.dispose();
    });

    test('an empty batch is not uploaded at all', () async {
      var calls = 0;
      final api = ApiClient(
        config: const AppConfig(
          backendBaseUrl: 'http://judge.test',
          rpcUrl: '',
          cattTokenAddress: '',
          networkName: 'Polygon',
        ),
        httpClient: MockClient((http.Request request) async {
          calls++;
          return http.Response('{}', 200);
        }),
      );
      final accepted = await api.postTelemetry(sessionId: 'sess-1', samples: <TelemetrySample>[]);
      expect(calls, 0);
      expect(accepted, 0);
    });
  });

  group('graceful degradation', () {
    test('a platform with no battery sensor reports null rather than a guess',
        () async {
      final scheduler = RecordingTelemetryScheduler();
      final clock = FakeTelemetryClock();
      final sink = RecordingTelemetrySink();
      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: const NullBatteryTelemetrySource(),
      );
      expect(service.hasBatteryTemperature, isFalse);

      await service.start('sess-1');
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      final json = sink.batchAt(0).single.toJson();
      expect(json['batteryTempC'], isNull);
      expect(json.keys.toSet(), kBackendSampleKeys,
          reason: 'the shape is unchanged even when the signal is missing');
      service.dispose();
    });

    test('a battery source that reports a sensor flips the capability flag',
        () async {
      final service = TelemetryService(
        sink: RecordingTelemetrySink().call,
        battery: FakeBatteryTelemetrySource(temperature: 30),
      );
      expect(service.hasBatteryTemperature, isTrue);
      service.dispose();
    });

    test('the real battery source degrades to "no sensor" instead of throwing',
        () async {
      // battery_plus 7.x exposes no temperature getter at all, so this is the
      // honest answer on every device: null, never an ambient guess.
      final source = PlatformBatteryTelemetrySource(
        levelReader: () async => throw MissingPluginException(),
      );
      expect(source.hasTemperatureSensor, isFalse);
      expect(source.temperatureC(), isNull);
      expect(await source.levelPercent(), isNull);
    });

    test('battery level is read when the platform answers', () async {
      final source = PlatformBatteryTelemetrySource(levelReader: () async => 64);
      expect(await source.levelPercent(), 64);
    });
  });

  group('typing time is measured, never invented', () {
    test('accumulates only while running, and never goes negative', () {
      final clock = FakeTelemetryClock();
      final timer = TypingTimer(clock: clock);

      expect(timer.elapsedMs, 0);
      timer.start();
      clock.advance(const Duration(seconds: 3));
      expect(timer.elapsedMs, 3000);

      timer.stop();
      expect(timer.isRunning, isFalse);
      expect(timer.elapsedMs, 3000);
      clock.advance(const Duration(seconds: 10));
      expect(timer.elapsedMs, 3000, reason: 'stopped time is not counted');

      timer.start();
      clock.advance(const Duration(milliseconds: 700));
      expect(timer.elapsedMs, 3700, reason: 'focus periods accumulate');
    });

    test('a double start does not lose the earliest start time', () {
      final clock = FakeTelemetryClock();
      final timer = TypingTimer(clock: clock)
        ..start()
        ..start();
      clock.advance(const Duration(seconds: 2));
      expect(timer.elapsedMs, 2000);
    });

    test('reset clears a finished attempt', () {
      final clock = FakeTelemetryClock();
      final timer = TypingTimer(clock: clock)..start();
      clock.advance(const Duration(seconds: 5));
      timer.reset();
      expect(timer.elapsedMs, 0);
      expect(timer.isRunning, isFalse);
    });
  });
}
