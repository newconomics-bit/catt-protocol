/// Tests for the native battery channel and the fallback paths.
///
/// Every test here mocks the `com.cattprotocol/battery` MethodChannel, so the
/// suite runs with no device and no platform side. The mocked handler emulates
/// the Kotlin in `MainActivity.kt`: it receives the framework's TENTHS OF A
/// DEGREE and divides by 10 before answering, which is exactly what the real
/// native side does. Asserting both the emulated conversion and the fact that
/// Dart does NOT divide a second time is what pins the unit conversion end to
/// end — a missing `/10` in Kotlin or a second `/10` in Dart both fail here.
library;

import 'package:catt_app/models/telemetry_sample.dart';
import 'package:catt_app/services/battery_source.dart';
import 'package:catt_app/services/telemetry_service.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// Answers [kBatteryChannelName] with [handler] for every call, which is what
/// `MainActivity` registers natively.
void _mockBatteryChannel(Future<Object?> Function(MethodCall call) handler) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
    const MethodChannel(kBatteryChannelName),
    handler,
  );
}

/// Simulates the Kotlin side: raw tenths of a degree in, degrees Celsius out.
/// Returns `null` (not an error) for the "unsupported" answer, which is what
/// `MainActivity` does for a sentinel outside 0..1000 raw tenths.
Future<Object?> _nativeTemperature(int? rawTenths) async {
  if (rawTenths == null || rawTenths < 0 || rawTenths > 1000) return null;
  return rawTenths / 10.0;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    // Handlers are global to the binary messenger: leaving one installed would
    // leak into the next test file and hide a real regression.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
      const MethodChannel(kBatteryChannelName),
      null,
    );
  });

  group('channel contract', () {
    test('the channel name is the one the Kotlin side registers', () {
      expect(kBatteryChannelName, 'com.cattprotocol/battery');
      expect(kBatteryMethodGetTemperatureC, 'getTemperatureC');
      expect(kBatteryMethodGetLevelPercent, 'getLevelPercent');
      expect(kBatteryMethodIsTemperatureSupported, 'isTemperatureSupported');
    });

    test('every method the Dart side calls reaches the native side', () async {
      final calls = <String>[];
      _mockBatteryChannel((MethodCall call) async {
        calls.add(call.method);
        if (call.method == kBatteryMethodIsTemperatureSupported) return true;
        if (call.method == kBatteryMethodGetLevelPercent) return 64;
        return 29.7;
      });

      final source = MethodChannelBatterySource();
      // Probed first: once a reading has proved the capability, the probe is
      // answered from the cache instead of crossing the channel again.
      await source.probeTemperatureSupport();
      await source.temperatureC();
      await source.levelPercent();

      expect(
        calls,
        containsAll(<String>[
          kBatteryMethodGetTemperatureC,
          kBatteryMethodGetLevelPercent,
          kBatteryMethodIsTemperatureSupported,
        ]),
      );
    });
  });

  group('temperature: the tenths-of-a-degree conversion', () {
    test('raw 297 reaches the app as exactly 29.7 C', () async {
      _mockBatteryChannel((MethodCall call) async {
        expect(call.method, kBatteryMethodGetTemperatureC);
        // What Android reports for a 29.7 C battery.
        return _nativeTemperature(297);
      });

      expect(await MethodChannelBatterySource().temperatureC(), 29.7);
    });

    test('the Dart layer does not divide a second time', () async {
      // The native side already converted; 31.5 must survive as 31.5, not
      // become 3.15.
      _mockBatteryChannel((MethodCall call) async => 31.5);

      expect(await MethodChannelBatterySource().temperatureC(), 31.5);
    });

    test('boundary readings convert exactly', () async {
      _mockBatteryChannel((MethodCall call) async => _nativeTemperature(0));
      expect(await MethodChannelBatterySource().temperatureC(), 0.0);

      _mockBatteryChannel((MethodCall call) async => _nativeTemperature(315));
      expect(await MethodChannelBatterySource().temperatureC(), 31.5);
    });

    test('a raw 0 is a real reading, not a stand-in for "unavailable"', () async {
      _mockBatteryChannel((MethodCall call) async => _nativeTemperature(0));

      final temperature = await MethodChannelBatterySource().temperatureC();
      // 0.0 is what the hardware said, so it is reported as 0.0 — but the
      // source still knows the device IS capable, which is what stops the app
      // from mistaking a real cold battery for a missing sensor.
      expect(temperature, 0.0);
      expect(temperature, isNotNull);
      expect(temperature!.isNaN, isFalse);
    });

    test('a raw sentinel or an absent reading is null, never 0.0', () async {
      // -1 and -100 are the "no sensor" sentinels some kernels return.
      _mockBatteryChannel((MethodCall call) async => _nativeTemperature(-1));
      expect(await MethodChannelBatterySource().temperatureC(), isNull);

      _mockBatteryChannel((MethodCall call) async => _nativeTemperature(-100));
      expect(await MethodChannelBatterySource().temperatureC(), isNull);

      // And an explicit null, which is what MainActivity answers with.
      _mockBatteryChannel((MethodCall call) async => null);
      final unsupported = await MethodChannelBatterySource().temperatureC();
      expect(unsupported, isNull);
      expect(unsupported, isNot(0.0));
      expect(unsupported, isNot(double.nan));
    });
  });

  group('battery level', () {
    test('returns the integer percentage', () async {
      _mockBatteryChannel((MethodCall call) async => 64);

      expect(await MethodChannelBatterySource().levelPercent(), 64);
    });

    test('returns null when the platform has no level', () async {
      _mockBatteryChannel((MethodCall call) async => null);

      expect(await MethodChannelBatterySource().levelPercent(), isNull);
    });
  });

  group('isTemperatureSupported', () {
    test('maps a true answer through', () async {
      _mockBatteryChannel((MethodCall call) async => true);

      final source = MethodChannelBatterySource();
      expect(await source.probeTemperatureSupport(), isTrue);
      expect(source.isTemperatureSupported, isTrue);
    });

    test('maps a false answer through', () async {
      _mockBatteryChannel((MethodCall call) async => false);

      final source = MethodChannelBatterySource();
      expect(await source.probeTemperatureSupport(), isFalse);
      expect(source.isTemperatureSupported, isFalse);
    });

    test('is false before any probe, rather than optimistic', () {
      expect(MethodChannelBatterySource().isTemperatureSupported, isFalse);
    });

    test('a real reading marks the device capable', () async {
      _mockBatteryChannel((MethodCall call) async {
        if (call.method == kBatteryMethodIsTemperatureSupported) return true;
        return _nativeTemperature(297);
      });

      final source = MethodChannelBatterySource();
      expect(source.isTemperatureSupported, isFalse);
      await source.temperatureC();
      expect(source.isTemperatureSupported, isTrue);
    });
  });

  group('graceful fallback (the iOS / unsupported-platform path)', () {
    test('a MissingPluginException degrades every method and never throws',
        () async {
      _mockBatteryChannel((MethodCall call) async {
        throw MissingPluginException(
          'No implementation found for method ${call.method} '
          'on channel $kBatteryChannelName',
        );
      });

      final source = MethodChannelBatterySource();
      expect(await source.temperatureC(), isNull);
      expect(await source.levelPercent(), isNull);
      expect(await source.probeTemperatureSupport(), isFalse);
      expect(source.isTemperatureSupported, isFalse);
    });

    test('with no handler registered at all the calls still fail soft',
        () async {
      // Exactly what iOS looks like: the channel simply does not exist.
      final source = MethodChannelBatterySource();

      expect(await source.temperatureC(), isNull);
      expect(await source.levelPercent(), isNull);
      expect(await source.probeTemperatureSupport(), isFalse);
    });

    test('a PlatformException from the device degrades the same way', () async {
      _mockBatteryChannel((MethodCall call) async {
        throw PlatformException(
          code: 'UNSUPPORTED',
          message: 'battery sensor unavailable',
        );
      });

      final source = MethodChannelBatterySource();
      expect(await source.temperatureC(), isNull);
      expect(await source.levelPercent(), isNull);
      expect(source.isTemperatureSupported, isFalse);
    });

    test('a malformed reply is ignored, not coerced', () async {
      for (final Object? reply in <Object?>['29.7', true, <String, int>{'c': 29}]) {
        _mockBatteryChannel((MethodCall call) async => reply);

        final source = MethodChannelBatterySource();
        // No number came back, so no reading is reported. Coercing a string to
        // a double here would put a fabricated number into the payload.
        expect(await source.temperatureC(), isNull, reason: 'reply $reply');
        expect(await source.levelPercent(), isNull, reason: 'reply $reply');
      }
    });

    test('an int reply is still a number, not malformed', () async {
      _mockBatteryChannel((MethodCall call) async => 30);

      final source = MethodChannelBatterySource();
      expect(await source.temperatureC(), 30.0);
      expect(await source.levelPercent(), 30);
    });

    test('FallbackBatterySource always reports no capability', () async {
      const source = FallbackBatterySource();

      expect(source.isTemperatureSupported, isFalse);
      expect(await source.temperatureC(), isNull);
      expect(await source.levelPercent(), isNull);
    });
  });

  group('PlatformBatteryTelemetrySource: the cached adapter', () {
    test('caches the channel reading and exposes the capability', () async {
      _mockBatteryChannel((MethodCall call) async {
        if (call.method == kBatteryMethodIsTemperatureSupported) return true;
        return _nativeTemperature(297);
      });

      final source = PlatformBatteryTelemetrySource();
      // Nothing has been read yet: an honest null, never a guess.
      expect(source.temperatureC(), isNull);
      expect(source.hasTemperatureSensor, isFalse);

      await source.refresh();

      expect(source.temperatureC(), 29.7);
      expect(source.hasTemperatureSensor, isTrue);
    });

    test('a missing channel leaves the cache at null and unsupported',
        () async {
      final source = PlatformBatteryTelemetrySource();
      await source.refresh();

      expect(source.temperatureC(), isNull);
      expect(source.hasTemperatureSensor, isFalse);
      expect(await source.levelPercent(), isNull);
    });

    test('level falls back to battery_plus when the channel has no answer',
        () async {
      _mockBatteryChannel((MethodCall call) async => null);

      final source = PlatformBatteryTelemetrySource(levelReader: () async => 64);
      expect(await source.levelPercent(), 64);
    });

    test('a throwing level reader degrades to null, not an exception', () async {
      _mockBatteryChannel((MethodCall call) async => null);

      final source = PlatformBatteryTelemetrySource(
        levelReader: () async => throw MissingPluginException(),
      );
      expect(await source.levelPercent(), isNull);
    });
  });

  group('TelemetryService integration', () {
    late RecordingTelemetryScheduler scheduler;
    late FakeTelemetryClock clock;
    late RecordingTelemetrySink sink;

    setUp(() {
      scheduler = RecordingTelemetryScheduler();
      clock = FakeTelemetryClock();
      sink = RecordingTelemetrySink();
    });

    test('a mocked 297 reading is flushed as batteryTempC == 29.7', () async {
      _mockBatteryChannel((MethodCall call) async {
        if (call.method == kBatteryMethodIsTemperatureSupported) return true;
        return _nativeTemperature(297);
      });

      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: PlatformBatteryTelemetrySource(),
      );

      await service.start('sess-1');
      await pumpEventQueue();
      expect(service.hasBatteryTemperature, isTrue,
          reason: 'the channel says this device has a sensor');

      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      final sample = sink.batchAt(0).single;
      expect(sample.batteryTempC, 29.7);
      expect(sample.toJson()['batteryTempC'], 29.7);
      service.dispose();
    });

    test('with no channel the key is STILL present, carrying an explicit null',
        () async {
      // The iOS path. The scorer reads case (ii) — "no sensor" — which is
      // neutral, and it can only recognise that case if the key is there.
      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: PlatformBatteryTelemetrySource(),
      );

      await service.start('sess-1');
      await pumpEventQueue();
      expect(service.hasBatteryTemperature, isFalse);

      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      final json = sink.batchAt(0).single.toJson();
      // THE CONTRACT WITH THE SCORER: present, and null. Never omitted, never
      // an empty string, never a fabricated 0.0.
      expect(json.keys, contains('batteryTempC'));
      expect(json.containsKey('batteryTempC'), isTrue);
      expect(json['batteryTempC'], isNull);
      expect(json.keys, containsAll(<String>['ts', 'batteryTempC', 'touch', 'scrollDelta']));
      service.dispose();
    });

    test('the MissingPluginException path never breaks a flush', () async {
      _mockBatteryChannel((MethodCall call) async {
        throw MissingPluginException('no implementation for ${call.method}');
      });

      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: PlatformBatteryTelemetrySource(),
      );

      await service.start('sess-1');
      await pumpEventQueue();
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      expect(sink.sampleCount, 1);
      expect(service.lastUploadStatus, TelemetryUploadStatus.ok);
      expect(sink.batchAt(0).single.batteryTempC, isNull);
      expect(sink.batchAt(0).single.toJson()['batteryTempC'], isNull);
      service.dispose();
    });

    test('a sample is never built from a stale reading after the sensor goes',
        () async {
      int? rawTenths = 297;
      _mockBatteryChannel((MethodCall call) async {
        if (call.method == kBatteryMethodIsTemperatureSupported) return true;
        return _nativeTemperature(rawTenths);
      });

      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: PlatformBatteryTelemetrySource(),
      );

      await service.start('sess-1');
      await pumpEventQueue();
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();
      expect(sink.batchAt(0).single.batteryTempC, 29.7);

      // The sensor stops answering. The read for the NEXT interval is taken as
      // the current one closes, so the change is visible one interval later:
      // the second sample still carries the last genuinely-read value, and the
      // third carries null rather than freezing on 29.7 forever — a frozen
      // battery temperature is the BATTERY_FLATLINE signature.
      rawTenths = null;
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();
      expect(sink.batchAt(1).single.batteryTempC, 29.7,
          reason: 'the reading for this window was taken while the sensor worked');

      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();
      expect(sink.batchAt(2).single.batteryTempC, isNull);
      expect(sink.batchAt(2).single.toJson().keys, contains('batteryTempC'));
      service.dispose();
    });

    test('a FallbackBatterySource produces a well-formed null-temp sample',
        () async {
      final service = TelemetryService(
        sink: sink.call,
        clock: clock,
        scheduler: scheduler,
        battery: NullBatteryTelemetrySource(),
      );

      await service.start('sess-1');
      clock.advance(const Duration(seconds: 5));
      scheduler.tick();
      await pumpEventQueue();

      final sample = sink.batchAt(0).single;
      expect(sample, isA<TelemetrySample>());
      expect(sample.toJson()['batteryTempC'], isNull);
      service.dispose();
    });
  });
}