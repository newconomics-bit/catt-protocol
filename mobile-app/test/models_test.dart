/// Model and JSON-contract tests.
///
/// The emphasis is on the two places a token app is most likely to be quietly
/// wrong: 18-decimal amounts must never pass through a `double`, and a stripped
/// answer key must not be reachable from a parsed model.
library;

import 'package:catt_app/models/article.dart';
import 'package:catt_app/models/flag_labels.dart';
import 'package:catt_app/models/mission.dart';
import 'package:catt_app/models/submit_result.dart';
import 'package:catt_app/models/telemetry_sample.dart';
import 'package:catt_app/models/token_amount.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  group('TokenAmount parsing is exact', () {
    test('parses a 18-decimal decimal string into the exact BigInt', () {
      final amount = TokenAmount.parse('12000000000000000000');
      expect(amount.baseUnits, BigInt.parse('12000000000000000000'));
      expect(amount.baseUnits.toString(), kTwelveCatt);
    });

    test('a double loses precision on real CATT amounts, BigInt does not', () {
      // The whole reason this type exists, demonstrated rather than asserted.
      const awkward = '1234567890123456789';
      final viaDouble = BigInt.from(1234567890123456789.0);
      expect(viaDouble.toString(), isNot(awkward));
      expect(TokenAmount.parse(awkward).baseUnits.toString(), awkward);
    });

    test('parses an int, a BigInt and a zero-padded string identically', () {
      expect(TokenAmount.parse(1000000000000000000).baseUnits,
          TokenAmount.parse('1000000000000000000').baseUnits);
      expect(TokenAmount.parse(BigInt.from(7)).baseUnits, BigInt.from(7));
      expect(TokenAmount.parse('0000000000000000007').baseUnits, BigInt.from(7));
    });

    test('malformed input degrades to zero instead of throwing', () {
      expect(TokenAmount.parse(null).baseUnits, BigInt.zero);
      expect(TokenAmount.parse('').baseUnits, BigInt.zero);
      expect(TokenAmount.parse('12.5').baseUnits, BigInt.zero);
      expect(TokenAmount.parse('not a number').baseUnits, BigInt.zero);
      expect(TokenAmount.parse(<String, dynamic>{}).baseUnits, BigInt.zero);
    });

    test('a negative amount is clamped to zero', () {
      expect(TokenAmount.parse('-500').baseUnits, BigInt.zero);
      expect(TokenAmount.parse(-5).baseUnits, BigInt.zero);
    });
  });

  group('TokenAmount formatting never uses a double', () {
    test('formats 12 CATT as exactly 12.000000000000000000', () {
      expect(
        TokenAmount.parse(kTwelveCatt).format(fractionDigits: 18),
        '12.000000000000000000',
      );
    });

    test('formats a fractional amount without binary drift', () {
      expect(
        TokenAmount.parse('1500000000000000000').format(fractionDigits: 4),
        '1.5',
      );
      expect(
        TokenAmount.parse('1').format(fractionDigits: 18),
        '0.000000000000000001',
      );
    });

    test('short format is stable for whole and fractional amounts', () {
      expect(TokenAmount.parse(kTwelveCatt).formatShort(), '12.0');
      expect(TokenAmount.parse(kOneCatt).formatShort(), '1.0');
      expect(TokenAmount.parse('1500000000000000000').formatShort(), '1.5');
    });

    test('truncates rather than rounds, and clamps the digit count', () {
      expect(TokenAmount.parse('1999999999999999999').format(fractionDigits: 2), '1.99');
      expect(TokenAmount.parse(kTwelveCatt).format(fractionDigits: 99),
          TokenAmount.parse(kTwelveCatt).format(fractionDigits: 18));
      expect(TokenAmount.parse(kTwelveCatt).format(fractionDigits: -3), '12');
    });

    test('equality and comparison work on base units', () {
      expect(TokenAmount.parse('5'), TokenAmount.parse(5));
      expect(TokenAmount.parse('5').compareTo(TokenAmount.parse('6')), isNegative);
      expect(TokenAmount.zero, TokenAmount.parse('0'));
    });
  });

  group('Mission', () {
    test('parses the board projection exactly', () {
      final mission = Mission.fromJson(missionJson());
      expect(mission.id, 'mission-1');
      expect(mission.articleId, 'art-focus-101');
      expect(mission.difficulty, Difficulty.easy);
      expect(mission.reward.baseUnits, BigInt.parse(kTwelveCatt));
      expect(mission.staminaCost.baseUnits, BigInt.parse(kOneCatt));
    });

    test('a difficulty the backend adds later does not crash the board', () {
      expect(Mission.fromJson(missionJson(difficulty: 'SPONSORED')).difficulty,
          Difficulty.unknown);
      expect(Difficulty.parse(null), Difficulty.unknown);
      expect(Difficulty.parse('hard'), Difficulty.hard);
    });

    test('the board list skips a broken row and keeps the rest', () {
      final missions = Mission.listFromJson(<Object?>[
        missionJson(id: 'mission-1'),
        <String, dynamic>{'id': 'no-article-id'},
        'not an object',
        missionJson(id: 'mission-2'),
      ]);
      expect(missions.map((Mission m) => m.id), <String>['mission-1', 'mission-2']);
    });

    test('a non-list board body yields an empty board, not a crash', () {
      expect(Mission.listFromJson(null), isEmpty);
      expect(Mission.listFromJson(<String, dynamic>{'error': 'NOPE'}), isEmpty);
    });

    test('toString carries the reward but no secret', () {
      expect(Mission.fromJson(missionJson()).toString(), contains('12.0 CATT'));
    });
  });

  group('ArticleLayout', () {
    test('preserves the server paragraph order verbatim', () {
      final article = sampleArticle(paragraphCount: 7);
      expect(article.paragraphs.first, 'Paragraph 0. It has a second sentence here.');
      expect(article.paragraphs[4], 'Paragraph 4. It has a second sentence here.');
      expect(article.paragraphs.length, 7);
    });

    test('exposes no answer key: QuizQuestion has no correctIndex at all', () {
      final article = sampleArticle();
      // The server strips `correctIndex`, and the model has no field for it, so
      // there is nowhere for it to be cached even if a hostile server sent one.
      expect(() => (article.quiz.first as dynamic).correctIndex, throwsA(isA<NoSuchMethodError>()));
      expect(article.quiz.first.options.length, 3);
      expect(article.quiz.first.toString(), isNot(contains('correct')));
    });

    test('drops keySentences even if the server were to send them', () {
      final json = articleJson();
      (json['highlightTask']! as Map<String, dynamic>)['keySentences'] = <String>[
        'the difficulty has to be on the retrieval side',
      ];
      final article = ArticleLayout.fromJson(json);
      expect(article.highlightTask.keySentences, isEmpty);
      expect(article.highlightTask.instructions, 'Highlight the key sentences.');
      expect(article.highlightTask.minMatches, 2);
    });

    test('clamps the trap index into [1, length - 2]', () {
      expect(sampleArticle(paragraphCount: 6, trapIndex: 0).trapIndex, 1);
      expect(sampleArticle(paragraphCount: 6, trapIndex: 99).trapIndex, 4);
      expect(sampleArticle(paragraphCount: 6, trapIndex: -3).trapIndex, 1);
      expect(sampleArticle(paragraphCount: 6, trapIndex: 3).trapIndex, 3);
      expect(sampleArticle(paragraphCount: 6, trapIndex: 1).trapIndex, 1);
    });

    test('an unknown trap type falls back to the cheapest trap', () {
      expect(FocusTrapType.parse('swipe-to-continue'), FocusTrapType.swipeToContinue);
      expect(FocusTrapType.parse('hold-to-reveal'), FocusTrapType.holdToReveal);
      expect(FocusTrapType.parse('nonsense'), FocusTrapType.tapTheImage);
      expect(FocusTrapType.parse(null), FocusTrapType.tapTheImage);
    });

    test('a malformed layout body degrades rather than throwing', () {
      final article = ArticleLayout.fromJson(<String, dynamic>{'title': 'T'});
      expect(article.paragraphs, isEmpty);
      expect(article.quiz, isEmpty);
      expect(article.trapIndex, 0);
      expect(article.reward.baseUnits, BigInt.zero);
    });

    test('splits prose into tappable sentences', () {
      expect(splitSentences('One. Two! Three?'), <String>['One.', 'Two!', 'Three?']);
      expect(splitSentences('   '), isEmpty);
      expect(splitSentences('No terminator'), <String>['No terminator']);
    });
  });

  group('TelemetrySample wire shape', () {
    test('emits exactly the four keys the backend scores', () {
      final sample = TelemetrySample(
        ts: 1700000000000,
        batteryTempC: 31.4,
        touch: const TouchPoint(120.5, 840.25),
        scrollDelta: -318.0,
      );
      final json = sample.toJson();
      expect(json.keys.toSet(),
          <String>{'ts', 'batteryTempC', 'touch', 'scrollDelta'});
      expect(json['ts'], 1700000000000);
      expect(json['batteryTempC'], 31.4);
      expect(json['touch'], <String, double>{'x': 120.5, 'y': 840.25});
      expect(json['scrollDelta'], -318.0);
    });

    test('a missing sensor is reported as an explicit null, never a guess', () {
      final json = TelemetrySample(ts: 1, batteryTempC: null, touch: null, scrollDelta: 0).toJson();
      expect(json.containsKey('batteryTempC'), isTrue);
      expect(json['batteryTempC'], isNull);
      expect(json['touch'], isNull);
    });

    test('round-trips through fromJson', () {
      final original = TelemetrySample(
        ts: 7,
        batteryTempC: 22.5,
        touch: const TouchPoint(1, 2),
        scrollDelta: 9.5,
      );
      final parsed = TelemetrySample.fromJson(original.toJson());
      expect(parsed.ts, 7);
      expect(parsed.batteryTempC, 22.5);
      expect(parsed.touch, const TouchPoint(1, 2));
      expect(parsed.scrollDelta, 9.5);
    });

    test('touch equality is exact, so the pixel-perfect check is not blurred', () {
      expect(const TouchPoint(1.0, 2.0), const TouchPoint(1.0, 2.0));
      expect(const TouchPoint(1.0, 2.0), isNot(const TouchPoint(1.0, 2.0001)));
    });
  });

  group('SubmitResponse', () {
    test('a FAIL carries no claim, no signature and is not a pass', () {
      final response = SubmitResponse.fromJson(<String, dynamic>{
        'status': 'FAIL',
        'result': <String, dynamic>{
          'status': 'FAIL',
          'reward': 0,
          'staminaCost': kOneCatt,
          'flags': <String>['QUIZ_INCORRECT', 'QUIZ_INCORRECT', 'SYNDICATE_MATCH'],
          'details': <String, dynamic>{'correctAnswers': 1, 'totalQuestions': 3},
        },
        'syndicate': <String, dynamic>{'syndicate': true, 'similarity': 0.97},
        'telemetry': <String, dynamic>{'score': 41, 'flags': <String>['BATTERY_FLATLINE']},
      });
      expect(response.isPass, isFalse);
      expect(response.claim, isNull);
      expect(response.signature, isNull);
      expect(response.result.reward.baseUnits, BigInt.zero);
      expect(response.result.staminaCost.baseUnits, BigInt.parse(kOneCatt));
      // Reasons are deduplicated: a flag repeated by two engines is one reason.
      expect(response.failureReasons,
          <String>['QUIZ_INCORRECT', 'SYNDICATE_MATCH', 'TELEMETRY_UNACCEPTABLE']);
    });

    test('a PASS exposes the signed claim and an exact relay payload', () {
      final response = SubmitResponse.fromJson(<String, dynamic>{
        'status': 'PASS',
        'result': <String, dynamic>{
          'status': 'PASS',
          'reward': kTwelveCatt,
          'staminaCost': kOneCatt,
          'flags': <String>[],
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
        'signature': '0xdeadbeef',
        'digest': '0xcafe',
        'signer': '0xSigner',
      });
      expect(response.isPass, isTrue);
      expect(response.claim!.reward.baseUnits, BigInt.parse(kTwelveCatt));
      expect(response.claim!.toRelayPayload('0xdeadbeef'), <String, String>{
        'user': '0xAbC00000000000000000000000000000000000001',
        'reward': kTwelveCatt,
        'staminaCost': kOneCatt,
        'nonce': '7',
        'deadline': '1700000600',
        'signature': '0xdeadbeef',
      });
      expect(response.failureReasons, isEmpty);
    });

    test('a PASS without a signature is not treated as claimable', () {
      final response = SubmitResponse.fromJson(<String, dynamic>{'status': 'PASS'});
      expect(response.isPass, isFalse);
      expect(response.claim, isNull);
    });

    test('telemetry verdict marks a sub-60 score unacceptable', () {
      expect(TelemetryVerdict.fromJson(<String, dynamic>{'score': 59}).isUnacceptable, isTrue);
      expect(TelemetryVerdict.fromJson(<String, dynamic>{'score': 60}).isUnacceptable, isFalse);
      expect(TelemetryVerdict.fromJson(<String, dynamic>{}).isUnacceptable, isTrue);
    });

    test('relay and session-telemetry responses parse', () {
      final relay = RelayResponse.fromJson(<String, dynamic>{
        'txHash': '0xfeed',
        'status': '1',
        'relayer': '0xrelay',
        'user': '0xuser',
        'nonce': '3',
      });
      expect(relay.txHash, '0xfeed');
      expect(relay.nonce, '3');

      final summary = SessionTelemetrySummary.fromJson(<String, dynamic>{
        'sessionId': 's',
        'count': 12,
        'score': 90,
        'flags': <String>[],
      });
      expect(summary.count, 12);
      expect(summary.score, 90);
    });

    test('relay status distinguishes configured from not', () {
      expect(RelayStatusInfo.fromJson(<String, dynamic>{'configured': true}).configured, isTrue);
      expect(RelayStatusInfo.fromJson(<String, dynamic>{'configured': false}).configured, isFalse);
    });

    test('a QuizAnswer round-trips through its wire form', () {
      const answer = QuizAnswer(questionId: 'q1', answerIndex: 2);
      expect(QuizAnswer.fromJson(answer.toJson()), answer);
      expect(QuizAnswer.fromJson(<String, dynamic>{'questionId': 'q1'}).answerIndex, -1);
    });
  });

  group('flag labels', () {
    test('every backend flag has reader-facing text', () {
      for (final flag in <String>[
        'BATTERY_FLATLINE',
        'BATTERY_IMPOSSIBLE',
        'PIXEL_PERFECT_TOUCH',
        'INHUMAN_SCROLL_SPEED',
        'TOO_FEW_SAMPLES',
        'QUIZ_INCORRECT',
        'HIGHLIGHT_MISSING',
        'TYPING_TOO_FAST',
        'TELEMETRY_POOR',
        'SUBMISSION_MALFORMED',
        'SYNDICATE_MATCH',
        'TELEMETRY_UNACCEPTABLE',
      ]) {
        expect(describeFlag(flag), isNot(flag), reason: 'no explanation for $flag');
        expect(describeFlag(flag), isNotEmpty);
      }
    });

    test('an unknown flag is shown verbatim rather than hidden', () {
      expect(describeFlag('SOME_FUTURE_FLAG'), 'SOME_FUTURE_FLAG');
    });
  });
}