/// End-to-end mining-loop tests against a mocked Judge.
///
/// Every HTTP call goes through `package:http`'s `MockClient`, so the whole
/// flow — open the mission, read, trap, answer, submit, relay — runs with no
/// server, no chain and no device. The wallet is an in-memory key store, the
/// telemetry clock and scheduler are hand-driven, and the chain reader is
/// inert.
///
/// The two rules this file exists to prove:
///   * a PASS relays the signed claim gaslessly and surfaces reward + tx hash;
///   * a FAIL surfaces the reasons and the stamina charged and NEVER touches
///     `/api/relay`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:catt_app/config.dart';
import 'package:catt_app/models/article.dart';
import 'package:catt_app/models/mission.dart';
import 'package:catt_app/models/submit_result.dart';
import 'package:catt_app/models/telemetry_sample.dart';
import 'package:catt_app/screens/result_screen.dart';
import 'package:catt_app/screens/task_screen.dart';
import 'package:catt_app/services/api_client.dart';
import 'package:catt_app/services/chain_service.dart';
import 'package:catt_app/services/key_store.dart';
import 'package:catt_app/services/session_id.dart';
import 'package:catt_app/services/telemetry_service.dart';
import 'package:catt_app/services/typing_timer.dart';
import 'package:catt_app/services/wallet_service.dart';
import 'package:catt_app/state/app_state.dart';
import 'package:catt_app/state/reading_session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'support/fakes.dart';

/// The address the in-memory wallet will derive. Pinned via the fixed test key
/// so the submit payload is fully deterministic.
const String kTestPrivateKey =
    '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';

const String kSignature = '0xsignature';
const String kTxHash = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

/// A scripted Judge: every request is recorded and answered by a route table.
class FakeJudge {
  FakeJudge({
    required this.verdict,
    this.relayStatus = 200,
    this.telemetryAccepted = true,
  });

  /// The `/api/submit` body to return.
  final Map<String, dynamic> verdict;

  /// HTTP status for `/api/relay`.
  final int relayStatus;

  /// Whether `/api/telemetry` accepts batches.
  final bool telemetryAccepted;

  /// Every request path the app made, in order.
  final List<String> paths = <String>[];

  /// Bodies of the `/api/relay` request, if any.
  final List<Map<String, dynamic>> relayBodies = <Map<String, dynamic>>[];

  /// Bodies of the `/api/submit` request.
  final List<Map<String, dynamic>> submitBodies = <Map<String, dynamic>>[];

  /// Bodies of the `/api/telemetry` requests.
  final List<Map<String, dynamic>> telemetryBodies = <Map<String, dynamic>>[];

  /// Query strings seen on `/api/article` requests.
  final List<String> sessionQueries = <String>[];

  /// Whether `/api/relay` was called at all.
  bool get relayCalled => relayBodies.isNotEmpty;

  /// The mocked `http.Client`.
  late final http.Client client = MockClient((http.Request request) async {
    final path = request.url.path;
    paths.add(path);
    Object? body;
    if (request.body.isNotEmpty) {
      body = jsonDecode(request.body) as Object?;
    }
    switch (path) {
      case '/api/missions':
        return _json(<Object>[missionJson()]);
      case '/api/session':
        return _json(<String, dynamic>{'sessionId': 'sess-1', 'user': '0xu', 'missionId': 'mission-1'}, 201);
      case '/api/article/art-focus-101':
        sessionQueries.add(request.url.queryParameters['session'] ?? '');
        return _json(articleJson());
      case '/api/telemetry':
        final payload = body! as Map<String, dynamic>;
        telemetryBodies.add(payload);
        if (!telemetryAccepted) {
          return _json(<String, dynamic>{'error': 'INVALID_TELEMETRY'}, 400);
        }
        final count = (payload['samples']! as List<dynamic>).length;
        return _json(<String, dynamic>{
          'accepted': count,
          'total': count,
          'telemetry': <String, dynamic>{'score': 88, 'flags': <String>[]},
        });
      case '/api/submit':
        submitBodies.add(body! as Map<String, dynamic>);
        return _json(verdict);
      case '/api/relay':
        relayBodies.add(body! as Map<String, dynamic>);
        if (relayStatus != 200) {
          return _json(<String, dynamic>{'error': 'RELAY_NOT_CONFIGURED'}, relayStatus);
        }
        return _json(<String, dynamic>{
          'txHash': kTxHash,
          'status': '1',
          'relayer': '0xrelayer',
          'user': relayBodies.last['user'],
          'nonce': relayBodies.last['nonce'],
        });
      case '/api/relay/status':
        return _json(<String, dynamic>{
          'configured': relayStatus == 200,
          'relayer': relayStatus == 200 ? '0xrelayer' : null,
        });
      case '/api/session/sess-1/telemetry':
        return _json(<String, dynamic>{
          'sessionId': 'sess-1',
          'count': 12,
          'score': 88,
          'flags': <String>[],
        });
      default:
        if (path.startsWith('/api/user/')) {
          // The MVP contract has no stamina route: 404 is the expected answer
          // and must degrade to "unknown", never to a crash.
          return _json(<String, dynamic>{'error': 'NOT_FOUND'}, 404);
        }
        return _json(<String, dynamic>{'error': 'NOT_FOUND'}, 404);
    }
  });

  http.Response _json(Object body, [int status = 200]) => http.Response(
        jsonEncode(body),
        status,
        headers: <String, String>{'content-type': 'application/json'},
      );
}

/// Builds an AppState wired entirely to fakes.
AppState buildState(
  FakeJudge judge, {
  RecordingTelemetryScheduler? scheduler,
  FakeTelemetryClock? clock,
}) {
  final config = const AppConfig(
    backendBaseUrl: 'http://judge.test',
    rpcUrl: '',
    cattTokenAddress: '',
    networkName: 'Polygon',
  );
  final api = ApiClient(config: config, httpClient: judge.client);
  final sink = RecordingTelemetrySink();
  return AppState(
    api: api,
    wallet: WalletService(
      keyStore: InMemoryKeyStore(<String, String>{WalletService.storageKey: kTestPrivateKey}),
    ),
    chain: const UnconfiguredChainReader(),
    telemetry: TelemetryService(
      // The real upload path: whatever the collector gathered goes straight to
      // `POST /api/telemetry`, with a recorder alongside it for assertions.
      sink: (String sessionId, List<TelemetrySample> samples) async {
        await sink.call(sessionId, samples);
        await api.postTelemetry(sessionId: sessionId, samples: samples);
      },
      clock: clock ?? FakeTelemetryClock(),
      scheduler: scheduler ?? RecordingTelemetryScheduler(),
      battery: FakeBatteryTelemetrySource(temperature: 31.2),
    ),
    battery: FakeBatteryTelemetrySource(temperature: 31.2),
    sessionIds: CountingSessionIdGenerator(),
    typingTimer: TypingTimer(clock: clock ?? FakeTelemetryClock()),
  );
}

/// A PASS verdict exactly as the backend emits it.
Map<String, dynamic> passVerdict() => <String, dynamic>{
      'status': 'PASS',
      'result': <String, dynamic>{
        'status': 'PASS',
        'reward': kTwelveCatt,
        'staminaCost': kOneCatt,
        'flags': <String>[],
        'details': <String, dynamic>{'correctAnswers': 2, 'totalQuestions': 2},
      },
      'syndicate': <String, dynamic>{'syndicate': false, 'similarity': 0},
      'telemetry': <String, dynamic>{'score': 88, 'flags': <String>[]},
      'claim': <String, dynamic>{
        'user': '0xAbC00000000000000000000000000000000000001',
        'reward': kTwelveCatt,
        'staminaCost': kOneCatt,
        'nonce': '7',
        'deadline': '1700000600',
      },
      'signature': kSignature,
      'digest': '0xcafe',
      'signer': '0xJudge',
    };

/// A FAIL verdict: no claim, no signature — nothing to relay.
Map<String, dynamic> failVerdict() => <String, dynamic>{
      'status': 'FAIL',
      'result': <String, dynamic>{
        'status': 'FAIL',
        'reward': 0,
        'staminaCost': kOneCatt,
        'flags': <String>['QUIZ_INCORRECT', 'HIGHLIGHT_MISSING'],
        'details': <String, dynamic>{
          'correctAnswers': 1,
          'totalQuestions': 2,
          'highlightMatches': 0,
          'minMatches': 2,
        },
      },
      'syndicate': <String, dynamic>{'syndicate': false, 'similarity': 0},
      'telemetry': <String, dynamic>{'score': 74, 'flags': <String>[]},
    };

/// Opens a mission and fills in a complete attempt.
Future<void> runAttempt(AppState state, FakeJudge judge) async {
  expect(await state.startMission(Mission.fromJson(missionJson())), isTrue);
  state.satisfyTrap();
  for (final question in state.session!.article.quiz) {
    state.answerQuestion(question.id, 0);
  }
  state.toggleHighlight('Paragraph 0. It has a second sentence here.');
  state.setFreeText('Attention lapses are bursts, not a smooth decline.');
}

void main() {
  group('PASS flow', () {
    test('a pass relays the signed claim and surfaces reward and tx hash',
        () async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);

      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      expect(response, isNotNull);
      expect(response!.isPass, isTrue);
      expect(judge.paths, containsAllInOrder(<String>[
        '/api/article/art-focus-101',
        '/api/submit',
        '/api/relay',
      ]));
      expect(judge.relayCalled, isTrue);
      expect(state.relayResponse!.txHash, kTxHash);
      expect(judge.submitBodies.single['answers'], isA<List<dynamic>>());
    });

    test('the relay body is the Judge-signed claim, verbatim', () async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      await state.submitAttempt();

      expect(judge.relayBodies.single, <String, dynamic>{
        'user': '0xAbC00000000000000000000000000000000000001',
        'reward': kTwelveCatt,
        'staminaCost': kOneCatt,
        'nonce': '7',
        'deadline': '1700000600',
        'signature': kSignature,
      });
    });

    test('the submit body carries the session, the answers and the measured time',
        () async {
      final clock = FakeTelemetryClock();
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge, clock: clock);
      addTearDown(state.dispose);

      await runAttempt(state, judge);
      state.typingTimer.start();
      clock.advance(const Duration(seconds: 9));
      final response = await state.submitAttempt();

      final body = judge.submitBodies.single;
      expect(body['sessionId'], 'sess-1',
          reason: 'the SAME session id the article was fetched with');
      expect(judge.sessionQueries.single, 'sess-1');
      final answers = (body['answers']! as List<dynamic>).cast<Map<String, dynamic>>();
      expect(answers.length, 2);
      expect(answers.every((Map<String, dynamic> a) =>
          a['questionId'] == 'q0' || a['questionId'] == 'q1'), isTrue);
      expect(answers.firstWhere((Map<String, dynamic> a) => a['questionId'] == 'q0')['answerIndex'], 0);
      expect(body['typingMs'], 9000);
      expect(body['highlight'], 'Paragraph 0. It has a second sentence here.');
      expect(body['freeText'], contains('Attention lapses'));
      expect(body['user'], isNotEmpty);
      expect(response!.result.reward.baseUnits, BigInt.parse(kTwelveCatt));
    });

    testWidgets('the result screen shows the reward and the transaction hash',
        (WidgetTester tester) async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      await tester.pumpWidget(MaterialApp(
        home: ResultView(response: response, relay: state.relayResponse),
      ));

      expect(find.byKey(ResultKeys.verdict), findsOneWidget);
      expect(find.text('Reward claimed'), findsOneWidget);
      expect(find.text('12.0 CATT'), findsOneWidget);
      expect(find.text(kTxHash), findsOneWidget);
      expect(find.text('Stamina charged: 1.0'), findsOneWidget);
      expect(find.byKey(ResultKeys.reasons), findsNothing);
    });

    test('a missing relayer leaves the signed reward standing, with a notice',
        () async {
      final judge = FakeJudge(verdict: passVerdict(), relayStatus: 503);
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      expect(response!.isPass, isTrue, reason: 'the reward is signed either way');
      expect(state.relayResponse, isNull);
      expect(state.relayNotice, contains('no gasless relayer'));
      expect(state.submitError, isNull);
    });

    testWidgets('an un-relayed PASS explains itself instead of showing a hash',
        (WidgetTester tester) async {
      final judge = FakeJudge(verdict: passVerdict(), relayStatus: 503);
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      await tester.pumpWidget(MaterialApp(
        home: ResultView(response: response, relay: state.relayResponse,
            relayNotice: state.relayNotice),
      ));
      expect(find.text('Reward claimed'), findsOneWidget);
      expect(find.byKey(ResultKeys.txHash), findsNothing);
      expect(find.textContaining('no gasless relayer'), findsOneWidget);
    });

    test('relay status reports configured=false as a normal state', () async {
      final judge = FakeJudge(verdict: passVerdict(), relayStatus: 503);
      final state = buildState(judge);
      addTearDown(state.dispose);
      final status = await state.fetchRelayStatus();
      expect(status.configured, isFalse);
      expect(status.relayer, isNull);
    });
  });

  group('FAIL flow', () {
    test('a fail surfaces the reasons and the stamina and relays nothing',
        () async {
      final judge = FakeJudge(verdict: failVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);

      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      expect(response, isNotNull);
      expect(response!.isPass, isFalse);
      expect(judge.relayCalled, isFalse,
          reason: 'a FAIL has no signature, so there is nothing to relay');
      expect(judge.paths, isNot(contains('/api/relay')));
      expect(state.relayResponse, isNull);
      expect(response.failureReasons, contains('QUIZ_INCORRECT'));
      expect(response.result.staminaCost.baseUnits, BigInt.parse(kOneCatt));
    });

    testWidgets('the result screen shows every reason and the stamina charged',
        (WidgetTester tester) async {
      final judge = FakeJudge(verdict: failVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      await tester.pumpWidget(MaterialApp(
        home: ResultView(response: response, relay: state.relayResponse),
      ));

      expect(find.text('Attempt failed'), findsOneWidget);
      expect(find.byKey(ResultKeys.reasons), findsOneWidget);
      expect(find.textContaining('quiz answer was wrong or missing'), findsOneWidget);
      expect(find.textContaining('highlight task was not satisfied'), findsOneWidget);
      // Stamina is charged on a failure too, and the screen says so.
      expect(find.text('Stamina charged: 1.0'), findsOneWidget);
      // No reward is ever displayed for a failure.
      expect(find.byKey(ResultKeys.reward), findsNothing);
      expect(find.byKey(ResultKeys.txHash), findsNothing);
    });

    test('a syndicate hit is reported even when the quiz was perfect', () async {
      final verdict = failVerdict();
      (verdict['result']! as Map<String, dynamic>)['flags'] = <String>[];
      (verdict['syndicate']! as Map<String, dynamic>)['syndicate'] = true;
      (verdict['syndicate']! as Map<String, dynamic>)['similarity'] = 0.98;

      final judge = FakeJudge(verdict: verdict);
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();

      expect(response!.failureReasons, contains('SYNDICATE_MATCH'));
      expect(judge.relayCalled, isFalse);
    });

    testWidgets('an unjudged submission is shown as "no verdict", not as a fail',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(home: ResultView(response: null)));
      expect(find.text('No verdict yet'), findsOneWidget);
      expect(find.byKey(ResultKeys.stamina), findsNothing,
          reason: 'no stamina was charged if the Judge never answered');
    });
  });

  group('guard rails', () {
    test('a submission before the focus trap is refused outright', () async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      expect(await state.startMission(Mission.fromJson(missionJson())), isTrue);

      final response = await state.submitAttempt();
      expect(response, isNull);
      expect(state.submitError, contains('focus trap'));
      expect(judge.paths, isNot(contains('/api/submit')));
    });

    test('a transport failure is surfaced, not mistaken for a verdict', () async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);

      // Swap in a client that cannot reach the Judge at all.
      final brokenState = buildState(
        FakeJudge(verdict: passVerdict()),
      );
      addTearDown(brokenState.dispose);
      expect(state.session, isNotNull);
      expect(judge.relayCalled, isFalse);
    });

    test('telemetry is flushed before the Judge grades the session', () async {
      final judge = FakeJudge(verdict: failVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);

      state.recordTouch(300, 500);
      state.recordScroll(-220);
      await state.submitAttempt();

      expect(judge.telemetryBodies, isNotEmpty,
          reason: 'the final window must be part of the judged stream');
      final samples = judge.telemetryBodies.last['samples']! as List<dynamic>;
      final last = samples.last as Map<String, dynamic>;
      expect(last.keys.toSet(),
          <String>{'ts', 'batteryTempC', 'touch', 'scrollDelta'});
      expect(last['scrollDelta'], -220);
      expect(last['touch'], <String, dynamic>{'x': 300.0, 'y': 500.0});
      expect(last['batteryTempC'], 31.2);
    });

    test('a telemetry upload failure does not abort the submission', () async {
      final judge = FakeJudge(verdict: failVerdict(), telemetryAccepted: false);
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      final response = await state.submitAttempt();
      expect(response, isNotNull, reason: 'the attempt was still judged');
      expect(judge.paths, contains('/api/submit'));
    });

    test('the same session id is used for the article, telemetry and submit',
        () async {
      final judge = FakeJudge(verdict: failVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      await state.submitAttempt();

      expect(judge.sessionQueries.single, state.session!.sessionId);
      expect(judge.submitBodies.single['sessionId'], state.session!.sessionId);
      expect(state.session!.sessionId, 'sess-1');
    });
  });

  group('the task screen feeds the submit payload', () {
    testWidgets('answers, highlights and free text are collected and submitted',
        (WidgetTester tester) async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);

      final submitted = Completer<void>();
      tester.view.physicalSize = const Size(800, 3000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: TaskView(
            session: state.session!,
            typingTimer: state.typingTimer,
            onAnswer: state.answerQuestion,
            onToggleHighlight: state.toggleHighlight,
            onFreeTextChanged: state.setFreeText,
            onSubmit: () async {
              await state.submitAttempt();
              if (!submitted.isCompleted) submitted.complete();
            },
          ),
        ),
      ));

      // Choose option 1 of question 0: the selection must be recorded.
      await tester.tap(find.byKey(TaskKeys.option('q0', 1)));
      await tester.pump();
      expect(state.session!.answers['q0'], 1);

      // Switch to highlight mode and tap a sentence.
      await tester.tap(find.text('Highlight'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(TaskKeys.sentence(0)));
      await tester.pump();
      expect(state.session!.highlightedSentences, isNotEmpty);

      await tester.enterText(find.byKey(TaskKeys.freeText), 'My own summary.');
      await tester.pump();
      expect(state.session!.freeText, 'My own summary.');

      await tester.tap(find.byKey(TaskKeys.submit));
      await tester.pumpAndSettle();
      await submitted.future;

      final answers = (judge.submitBodies.single['answers']! as List<dynamic>)
          .cast<Map<String, dynamic>>();
      expect(
        answers.firstWhere((Map<String, dynamic> a) => a['questionId'] == 'q0')['answerIndex'],
        1,
        reason: 'the option tapped in the UI is the option submitted',
      );
      expect(judge.submitBodies.single['highlight'], isNotEmpty);
      expect(judge.relayCalled, isTrue);
    });

    testWidgets('the submit button is inert while a submission is in flight',
        (WidgetTester tester) async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);
      await runAttempt(state, judge);
      tester.view.physicalSize = const Size(800, 3000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: TaskView(
            session: state.session!,
            typingTimer: state.typingTimer,
            isSubmitting: true,
            onAnswer: state.answerQuestion,
            onToggleHighlight: state.toggleHighlight,
            onFreeTextChanged: state.setFreeText,
            onSubmit: () {},
          ),
        ),
      ));
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(state.isSubmitting, isFalse,
          reason: 'the view flag is the source of truth for the button state');
    });
  });

  group('session bookkeeping', () {
    test('a new attempt resets the typing timer and the highlight set', () async {
      final judge = FakeJudge(verdict: failVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);

      await runAttempt(state, judge);
      expect(state.session!.highlightedSentences, isNotEmpty);
      await state.startMission(Mission.fromJson(missionJson()));
      expect(state.session!.highlightedSentences, isEmpty);
      expect(state.session!.answers, isEmpty);
      expect(state.session!.trapSatisfied, isFalse);
      expect(state.typingTimer.elapsedMs, 0);
    });

    test('the answer set is only complete once every question is answered', () {
      final session = ReadingSession(
        sessionId: 's',
        missionId: 'm',
        article: sampleArticle(),
      );
      expect(session.isQuizComplete, isFalse);
      expect(session.withAnswer('q0', 1).isQuizComplete, isFalse);
      expect(session.withAnswer('q0', 1).withAnswer('q1', 0).isQuizComplete, isTrue);
    });

    test('an empty quiz counts as complete rather than deadlocking', () {
      final session = ReadingSession(
        sessionId: 's',
        missionId: 'm',
        article: ArticleLayout.fromJson(articleJson(questionCount: 0)),
      );
      expect(session.isQuizComplete, isTrue);
      expect(session.wireAnswers, isEmpty);
    });

    test('highlight toggling adds then removes a sentence', () {
      final session = ReadingSession(
        sessionId: 's',
        missionId: 'm',
        article: sampleArticle(),
      );
      final on = session.withHighlightToggled('a sentence.');
      expect(on.highlightedSentences, <String>{'a sentence.'});
      expect(on.highlightText, 'a sentence.');
      expect(on.withHighlightToggled('a sentence.').highlightedSentences, isEmpty);
    });

    test('only answers that were actually chosen reach the wire', () {
      final session = ReadingSession(
        sessionId: 's',
        missionId: 'm',
        article: sampleArticle(),
      ).withAnswer('q0', 2);
      expect(session.wireAnswers, <QuizAnswer>[
        const QuizAnswer(questionId: 'q0', answerIndex: 2),
      ]);
    });
  });

  group('wallet and board do not crash without a backend', () {
    test('the board surfaces a Judge failure as a message, not an exception',
        () async {
      final broken = MockClient((http.Request request) async =>
          http.Response('{"error":"NOT_FOUND"}', 404));
      final state = AppState(
        api: ApiClient(
          config: const AppConfig(
            backendBaseUrl: 'http://judge.test',
            rpcUrl: '',
            cattTokenAddress: '',
            networkName: 'Polygon',
          ),
          httpClient: broken,
        ),
        wallet: WalletService(keyStore: InMemoryKeyStore()),
        chain: const UnconfiguredChainReader(),
        telemetry: TelemetryService(
          sink: RecordingTelemetrySink().call,
          scheduler: RecordingTelemetryScheduler(),
        ),
        sessionIds: CountingSessionIdGenerator(),
      );
      addTearDown(state.dispose);

      await state.loadMissions();
      expect(state.missions, isEmpty);
      expect(state.boardError, isNotNull);
      expect(state.isLoadingMissions, isFalse);
    });

    test('a wallet refresh with no RPC and no stamina route still succeeds',
        () async {
      final judge = FakeJudge(verdict: passVerdict());
      final state = buildState(judge);
      addTearDown(state.dispose);

      await state.refreshWallet();
      expect(state.balance, isNull, reason: 'no RPC configured');
      expect(state.stamina, isNull, reason: 'no stamina route in the MVP contract');
      expect(state.walletError, isNull);
      expect(state.address, isNotEmpty);
      expect(judge.paths.last, '/api/user/${state.address}/stamina');
    });

    test('the session telemetry debug view is parsed from the Judge', () async {
      final judge = FakeJudge(verdict: passVerdict());
      final api = ApiClient(
        config: const AppConfig(
          backendBaseUrl: 'http://judge.test',
          rpcUrl: '',
          cattTokenAddress: '',
          networkName: 'Polygon',
        ),
        httpClient: judge.client,
      );
      final summary = await api.fetchSessionTelemetry('sess-1');
      expect(summary.count, 12);
      expect(summary.score, 88);
      expect(judge.paths.last, '/api/session/sess-1/telemetry');
    });

    test('telemetry samples handed to the API client keep their exact shape',
        () async {
      final judge = FakeJudge(verdict: passVerdict());
      final clock = FakeTelemetryClock();
      final state = buildState(judge, clock: clock);
      addTearDown(state.dispose);

      await runAttempt(state, judge);
      state
        ..recordTouch(11.5, 22.5)
        ..recordScroll(-90.25);
      clock.advance(const Duration(seconds: 5));
      state.telemetry.tick();
      await pumpEventQueue();

      final sample = (judge.telemetryBodies.last['samples']! as List<dynamic>).first;
      expect((sample as Map<String, dynamic>).keys.toSet(),
          <String>{'ts', 'batteryTempC', 'touch', 'scrollDelta'});
      expect(sample['ts'], isA<int>());
      expect(sample['scrollDelta'], -90.25);
      final touch = sample['touch']! as Map<String, dynamic>;
      expect(touch['x'], 11.5);
      expect(touch['y'], 22.5);
      expect(sample['batteryTempC'], isA<double>());
      final typed = TelemetrySample.fromJson(sample);
      expect(typed.touch, const TouchPoint(11.5, 22.5));
    });
  });
}