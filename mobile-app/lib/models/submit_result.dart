/// Responses from `POST /api/submit`, `POST /api/relay` and the two read-only
/// telemetry/relay-status routes.
///
/// The important structural fact encoded here: a FAIL response has NO
/// `claim`, NO `signature`, NO `digest` and NO `signer`. [SubmitResponse] is
/// typed so that [claim] is only non-null when [isPass], so "we have nothing
/// to relay" is a type-level fact and not a runtime branch someone can forget.
library;

import 'package:flutter/foundation.dart';

import 'token_amount.dart';

/// Verdict constants shared with the backend's `anticheat.STATUS`.
class SubmitStatus {
  const SubmitStatus._();

  /// Every check passed; the response carries a signed claim.
  static const String pass = 'PASS';

  /// At least one check failed; there is nothing to relay.
  static const String fail = 'FAIL';
}

/// One `{ questionId, answerIndex }` pair in the submit payload.
@immutable
class QuizAnswer {
  /// Creates an answer.
  const QuizAnswer({required this.questionId, required this.answerIndex});

  /// Parses one element of the `answers` array.
  factory QuizAnswer.fromJson(Map<String, dynamic> json) => QuizAnswer(
        questionId: json['questionId']?.toString() ?? '',
        answerIndex: json['answerIndex'] is num
            ? (json['answerIndex']! as num).toInt()
            : (int.tryParse('${json['answerIndex'] ?? ''}') ?? -1),
      );

  /// Question this answer is for.
  final String questionId;

  /// Index into that question's `options`.
  final int answerIndex;

  /// Exact wire form.
  Map<String, dynamic> toJson() => <String, dynamic>{
        'questionId': questionId,
        'answerIndex': answerIndex,
      };

  @override
  bool operator ==(Object other) =>
      other is QuizAnswer &&
      other.questionId == questionId &&
      other.answerIndex == answerIndex;

  @override
  int get hashCode => Object.hash(questionId, answerIndex);

  @override
  String toString() => 'QuizAnswer($questionId -> $answerIndex)';
}

/// The EIP-712 struct the Judge signed. The app never sees the signing key and
/// never signs anything itself: it forwards these fields verbatim to
/// `POST /api/relay`, which broadcasts on the user's behalf so the user never
/// needs gas.
@immutable
class MiningClaim {
  /// Creates a claim.
  const MiningClaim({
    required this.user,
    required this.reward,
    required this.staminaCost,
    required this.nonce,
    required this.deadline,
  });

  /// Parses the `claim` object.
  factory MiningClaim.fromJson(Map<String, dynamic> json) => MiningClaim(
        user: json['user']?.toString() ?? '',
        reward: TokenAmount.parse(json['reward']),
        staminaCost: TokenAmount.parse(json['staminaCost']),
        nonce: json['nonce']?.toString() ?? '0',
        deadline: json['deadline']?.toString() ?? '0',
      );

  /// The address credited on chain.
  final String user;

  /// Reward in 18-decimal base units, kept as the exact wire string too.
  final TokenAmount reward;

  /// Stamina cost in 18-decimal base units.
  final TokenAmount staminaCost;

  /// Nonce, as the exact string the signature covers.
  final String nonce;

  /// Unix-seconds expiry, as the exact string the signature covers.
  final String deadline;

  /// The EXACT body `POST /api/relay` expects, with the amounts as the
  /// original decimal strings.
  ///
  /// Re-encoding the amounts from the parsed [BigInt] would be lossless here,
  /// but the deadline/nonce are signed as strings and must not be reformatted,
  /// so the claim is built from its own string fields verbatim.
  Map<String, String> toRelayPayload(String signature) => <String, String>{
        'user': user,
        'reward': reward.baseUnits.toString(),
        'staminaCost': staminaCost.baseUnits.toString(),
        'nonce': nonce,
        'deadline': deadline,
        'signature': signature,
      };

  @override
  String toString() => 'MiningClaim(user: $user, reward: $reward, nonce: $nonce)';
}

/// The Judge's verdict detail block.
@immutable
class ResultDetail {
  /// Creates a detail block.
  const ResultDetail({
    required this.status,
    required this.reward,
    required this.staminaCost,
    required this.flags,
    required this.correctAnswers,
    required this.totalQuestions,
    required this.highlightMatches,
    required this.minMatches,
  });

  /// Parses `result` from the submit response.
  factory ResultDetail.fromJson(Map<String, dynamic> json) => ResultDetail(
        status: json['status']?.toString() ?? SubmitStatus.fail,
        reward: TokenAmount.parse(json['reward']),
        staminaCost: TokenAmount.parse(json['staminaCost']),
        flags: json['flags'] is List
            ? List<String>.unmodifiable(
                (json['flags']! as List).map((Object? f) => f.toString()))
            : const <String>[],
        correctAnswers: _int(json['details'] is Map ? (json['details']! as Map)['correctAnswers'] : null),
        totalQuestions: _int(json['details'] is Map ? (json['details']! as Map)['totalQuestions'] : null),
        highlightMatches:
            _int(json['details'] is Map ? (json['details']! as Map)['highlightMatches'] : null),
        minMatches:
            _int(json['details'] is Map ? (json['details']! as Map)['minMatches'] : null),
      );

  static int _int(Object? raw) {
    if (raw is int) return raw;
    if (raw is num) return raw.toInt();
    return int.tryParse('${raw ?? ''}') ?? 0;
  }

  /// PASS or FAIL.
  final String status;

  /// Reward: the mission reward on PASS, exactly 0 on FAIL.
  final TokenAmount reward;

  /// Stamina charged. Charged on BOTH outcomes — stamina is the cost of
  /// attempting, otherwise a failed quiz would be a free oracle.
  final TokenAmount staminaCost;

  /// Machine-readable failure reasons.
  final List<String> flags;

  /// Questions answered correctly.
  final int correctAnswers;

  /// Questions in the quiz.
  final int totalQuestions;

  /// Key sentences found in the submitted highlight.
  final int highlightMatches;

  /// Key sentences required.
  final int minMatches;

  /// True when this detail block reports a pass.
  bool get isPass => status == SubmitStatus.pass;
}

/// The anti-cheat engine's live verdict for the session so far.
@immutable
class TelemetryVerdict {
  /// Creates a verdict.
  const TelemetryVerdict({required this.score, required this.flags});

  /// Parses a `telemetry` block.
  factory TelemetryVerdict.fromJson(Map<String, dynamic> json) => TelemetryVerdict(
        score: json['score'] is num ? (json['score']! as num).toDouble() : 0,
        flags: json['flags'] is List
            ? List<String>.unmodifiable(
                (json['flags']! as List).map((Object? f) => f.toString()))
            : const <String>[],
      );

  /// 0..100, 100 being pristine.
  final double score;

  /// Flags raised so far.
  final List<String> flags;

  /// A telemetry verdict below the backend's 60-point bar.
  bool get isUnacceptable => score < 60;

  @override
  String toString() => 'TelemetryVerdict(score: $score, flags: $flags)';
}

/// Cross-user answer-copying check.
@immutable
class SyndicateVerdict {
  /// Creates a verdict.
  const SyndicateVerdict({required this.syndicate, required this.similarity});

  /// Parses a `syndicate` block.
  factory SyndicateVerdict.fromJson(Map<String, dynamic> json) => SyndicateVerdict(
        syndicate: json['syndicate'] == true,
        similarity: json['similarity'] is num
            ? (json['similarity']! as num).toDouble()
            : 0,
      );

  /// True when the free text closely matches another account's.
  final bool syndicate;

  /// Best similarity found, 0 when there is no history.
  final double similarity;

  @override
  String toString() => 'SyndicateVerdict(syndicate: $syndicate, similarity: $similarity)';
}

/// The full `POST /api/submit` response.
@immutable
class SubmitResponse {
  /// Creates a response.
  const SubmitResponse({
    required this.status,
    required this.result,
    required this.syndicate,
    required this.telemetry,
    required this.claim,
    required this.signature,
    required this.digest,
    required this.signer,
  });

  /// Parses the response body.
  factory SubmitResponse.fromJson(Map<String, dynamic> json) {
    final status = json['status']?.toString() == SubmitStatus.pass
        ? SubmitStatus.pass
        : SubmitStatus.fail;
    return SubmitResponse(
      status: status,
      result: json['result'] is Map<String, dynamic>
          ? ResultDetail.fromJson(json['result']! as Map<String, dynamic>)
          : ResultDetail.fromJson(<String, dynamic>{'status': status}),
      syndicate: json['syndicate'] is Map<String, dynamic>
          ? SyndicateVerdict.fromJson(json['syndicate']! as Map<String, dynamic>)
          : const SyndicateVerdict(syndicate: false, similarity: 0),
      telemetry: json['telemetry'] is Map<String, dynamic>
          ? TelemetryVerdict.fromJson(json['telemetry']! as Map<String, dynamic>)
          : const TelemetryVerdict(score: 0, flags: <String>[]),
      claim: json['claim'] is Map<String, dynamic>
          ? MiningClaim.fromJson(json['claim']! as Map<String, dynamic>)
          : null,
      signature: json['signature']?.toString(),
      digest: json['digest']?.toString(),
      signer: json['signer']?.toString(),
    );
  }

  /// PASS or FAIL.
  final String status;

  /// Comprehension verdict detail.
  final ResultDetail result;

  /// Syndicate check.
  final SyndicateVerdict syndicate;

  /// Session telemetry verdict.
  final TelemetryVerdict telemetry;

  /// The signed claim. NON-NULL ONLY WHEN [isPass]; the backend omits the key
  /// entirely on FAIL, so there is nothing to relay in that case.
  final MiningClaim? claim;

  /// EIP-712 signature over [digest].
  final String? signature;

  /// The signed struct hash.
  final String? digest;

  /// The Judge's PUBLIC address. Never key material.
  final String? signer;

  /// True when the submission passed and a claim is available.
  bool get isPass => status == SubmitStatus.pass && claim != null && signature != null;

  /// Every reason this failed, flags plus the syndicate hit, deduplicated.
  List<String> get failureReasons {
    final out = <String>[...result.flags];
    if (syndicate.syndicate) out.add('SYNDICATE_MATCH');
    if (telemetry.isUnacceptable) out.add('TELEMETRY_UNACCEPTABLE');
    return out.toSet().toList(growable: false);
  }

  @override
  String toString() => 'SubmitResponse($status, reasons: $failureReasons)';
}

/// The `POST /api/relay` response.
@immutable
class RelayResponse {
  /// Creates a response.
  const RelayResponse({
    required this.txHash,
    required this.status,
    required this.relayer,
    required this.user,
    required this.nonce,
  });

  /// Parses the response body.
  factory RelayResponse.fromJson(Map<String, dynamic> json) => RelayResponse(
        txHash: json['txHash']?.toString(),
        status: json['status']?.toString(),
        relayer: json['relayer']?.toString(),
        user: json['user']?.toString() ?? '',
        nonce: json['nonce']?.toString() ?? '',
      );

  /// Broadcast transaction hash, when the backend reported one.
  final String? txHash;

  /// On-chain status reported by the relayer, when reported.
  final String? status;

  /// The relayer's PUBLIC address.
  final String? relayer;

  /// Address credited.
  final String user;

  /// Nonce that was spent.
  final String nonce;

  @override
  String toString() => 'RelayResponse(txHash: $txHash, status: $status)';
}

/// `GET /api/relay/status`.
@immutable
class RelayStatusInfo {
  /// Creates a status object.
  const RelayStatusInfo({required this.configured, required this.relayer});

  /// Parses the response body.
  factory RelayStatusInfo.fromJson(Map<String, dynamic> json) => RelayStatusInfo(
        configured: json['configured'] == true,
        relayer: json['relayer']?.toString(),
      );

  /// False is a SUPPORTED deployment mode, not an error: the app then tells
  /// the user a sponsor is unavailable instead of failing the claim outright.
  final bool configured;

  /// The relayer's public address when configured.
  final String? relayer;

  @override
  String toString() => 'RelayStatusInfo(configured: $configured)';
}

/// `GET /api/session/:id/telemetry`.
@immutable
class SessionTelemetrySummary {
  /// Creates a summary.
  const SessionTelemetrySummary({
    required this.sessionId,
    required this.count,
    required this.score,
    required this.flags,
  });

  /// Parses the response body.
  factory SessionTelemetrySummary.fromJson(Map<String, dynamic> json) =>
      SessionTelemetrySummary(
        sessionId: json['sessionId']?.toString() ?? '',
        count: _toInt(json['count']),
        score: json['score'] is num ? (json['score']! as num).toDouble() : 0,
        flags: json['flags'] is List
            ? List<String>.unmodifiable(
                (json['flags']! as List).map((Object? f) => f.toString()))
            : const <String>[],
      );

  /// Session id.
  final String sessionId;

  /// Samples the server holds for this session.
  final int count;

  /// Live score.
  final double score;

  /// Live flags.
  final List<String> flags;

  static int _toInt(Object? raw) {
    if (raw is int) return raw;
    if (raw is num) return raw.toInt();
    return int.tryParse('${raw ?? ''}') ?? 0;
  }

  @override
  String toString() => 'SessionTelemetrySummary(count: $count, score: $score)';
}