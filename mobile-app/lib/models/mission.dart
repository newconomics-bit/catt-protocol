/// Mission metadata as served by `GET /api/missions`.
///
/// The board response is a DELIBERATE projection (see the backend route): it
/// carries `id`, `articleId`, `difficulty`, `reward`, `staminaCost` and
/// nothing else. No quiz, no `correctIndex`, no prose. This model therefore
/// has no field that could hold an answer key, which is the point: there is
/// nowhere for one to be cached, logged or displayed.
library;

import 'package:flutter/foundation.dart';

import 'token_amount.dart';

/// Mission difficulty, ordered as the economy orders it.
enum Difficulty {
  easy('EASY'),
  medium('MEDIUM'),
  hard('HARD'),

  /// Anything the backend adds later. Kept as a value rather than a crash so
  /// a content update cannot brick the board.
  unknown('UNKNOWN');

  const Difficulty(this.wire);

  /// The exact string the backend uses.
  final String wire;

  /// Parses a difficulty string, falling back to [Difficulty.unknown].
  static Difficulty parse(Object? raw) {
    final text = raw?.toString().trim().toUpperCase() ?? '';
    for (final value in Difficulty.values) {
      if (value.wire == text) return value;
    }
    return Difficulty.unknown;
  }
}

/// One entry on the bounty board.
@immutable
class Mission {
  /// Creates a mission.
  const Mission({
    required this.id,
    required this.articleId,
    required this.difficulty,
    required this.reward,
    required this.staminaCost,
  });

  /// Parses one element of the `GET /api/missions` array.
  ///
  /// Throws [FormatException] only when the identifying fields are missing:
  /// a mission with no `id` cannot be opened at all, so there is nothing
  /// useful to display. Everything else degrades to a safe default.
  factory Mission.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final articleId = json['articleId'];
    if (id is! String || id.isEmpty || articleId is! String || articleId.isEmpty) {
      throw FormatException('mission is missing id/articleId: $json');
    }
    return Mission(
      id: id,
      articleId: articleId,
      difficulty: Difficulty.parse(json['difficulty']),
      reward: TokenAmount.parse(json['reward']),
      staminaCost: TokenAmount.parse(json['staminaCost']),
    );
  }

  /// Parses the whole board, skipping malformed rows instead of failing all.
  static List<Mission> listFromJson(Object? raw) {
    if (raw is! List) return const <Mission>[];
    final out = <Mission>[];
    for (final entry in raw) {
      if (entry is Map<String, dynamic>) {
        try {
          out.add(Mission.fromJson(entry));
        } on FormatException {
          // A single broken row must not hide the rest of the board.
          continue;
        }
      }
    }
    return out;
  }

  /// Mission id, e.g. `mission-1`. Attributed server-side at submit time.
  final String id;

  /// Article to read for this mission.
  final String articleId;

  /// Difficulty tier.
  final Difficulty difficulty;

  /// Reward in 18-decimal base units, parsed exactly.
  final TokenAmount reward;

  /// Stamina cost in 18-decimal base units, parsed exactly. Charged whether
  /// the attempt passes or fails.
  final TokenAmount staminaCost;

  /// Short label for cards, e.g. "MEDIUM".
  String get difficultyLabel => difficulty.wire;

  @override
  String toString() => 'Mission($id, ${difficulty.wire}, reward: $reward)';
}