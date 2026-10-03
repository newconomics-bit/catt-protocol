/// The per-session reading layout served by `GET /api/article/:id?session=…`.
///
/// TWO INVARIANTS live in this file and are covered by tests:
///
///  1. **The client never re-shuffles.** `paragraphs` is stored exactly as it
///     arrived. The server's shuffle and trap position are deterministic
///     functions of the session id, and the Judge grades the submitted
///     highlight against THAT layout, so re-ordering on the client would
///     guarantee a mismatch. There is deliberately no shuffle call anywhere in
///     this file.
///  2. **The trap is never at index 0 or the last index.** The server already
///     clamps to `[1, len - 2]`; [ArticleLayout.trapIndex] re-clamps
///     defensively so a malformed layout cannot produce an unreachable or
///     immediate trap.
library;

import 'package:flutter/foundation.dart';

import 'mission.dart';
import 'token_amount.dart';

/// The three focus-trap kinds the reading client can render.
enum FocusTrapType {
  tapTheImage('tap-the-image'),
  swipeToContinue('swipe-to-continue'),
  holdToReveal('hold-to-reveal');

  const FocusTrapType(this.wire);

  /// The exact string the backend uses.
  final String wire;

  /// Parses a trap type, falling back to [FocusTrapType.tapTheImage] — the
  /// cheapest trap to satisfy — so an unknown type can never dead-end a
  /// reading session.
  static FocusTrapType parse(Object? raw) {
    final text = raw?.toString().trim() ?? '';
    for (final value in FocusTrapType.values) {
      if (value.wire == text) return value;
    }
    return FocusTrapType.tapTheImage;
  }
}

/// Where the trap sits and what kind it is.
@immutable
class FocusTrapSpec {
  /// Creates a trap spec.
  const FocusTrapSpec({required this.index, required this.type});

  /// Parses the `focusTrap` object. A missing/garbage index becomes 0; it is
  /// clamped later by [ArticleLayout.trapIndex], which knows the paragraph
  /// count.
  factory FocusTrapSpec.fromJson(Map<String, dynamic> json) {
    final rawIndex = json['index'];
    final index = rawIndex is int ? rawIndex : int.tryParse('${rawIndex ?? ''}') ?? 0;
    return FocusTrapSpec(index: index, type: FocusTrapType.parse(json['type']));
  }

  /// Number of paragraphs that appear BEFORE the trap.
  final int index;

  /// Which interaction the trap requires.
  final FocusTrapType type;

  @override
  String toString() => 'FocusTrapSpec(index: $index, type: ${type.wire})';
}

/// One comprehension question. NOTE: `correctIndex` is deliberately absent —
/// the backend strips it from this endpoint, so this class cannot hold it even
/// by accident.
@immutable
class QuizQuestion {
  /// Creates a question.
  const QuizQuestion({
    required this.id,
    required this.question,
    required this.options,
  });

  /// Parses one element of the `quiz` array.
  factory QuizQuestion.fromJson(Map<String, dynamic> json) {
    final id = json['id']?.toString() ?? '';
    final options = json['options'];
    return QuizQuestion(
      id: id,
      question: json['question']?.toString() ?? '',
      options: options is List
          ? List<String>.unmodifiable(options.map((Object? o) => o.toString()))
          : const <String>[],
    );
  }

  /// Question id, echoed back in the submit payload.
  final String id;

  /// Question text.
  final String question;

  /// Answer options, in display order.
  final List<String> options;

  @override
  String toString() => 'QuizQuestion($id, ${options.length} options)';
}

/// The post-reading highlight task.
@immutable
class HighlightTask {
  /// Creates a highlight task.
  const HighlightTask({
    required this.instructions,
    required this.minMatches,
    required this.keySentences,
  });

  /// Parses the `highlightTask` object.
  ///
  /// `keySentences` is STRIPPED by the server and therefore normally absent;
  /// it is modelled (and left empty) so this client can never hold the answer
  /// key. If a hostile server ever did send it, the client does not use it:
  /// `keySentences` is parsed for shape only and nothing in the UI or the
  /// submit path reads it.
  factory HighlightTask.fromJson(Map<String, dynamic> json) {
    final rawMin = json['minMatches'];
    final minMatches = rawMin is int ? rawMin : (int.tryParse('${rawMin ?? ''}') ?? 0);
    return HighlightTask(
      instructions: json['instructions']?.toString() ?? '',
      minMatches: minMatches < 0 ? 0 : minMatches,
      keySentences: const <String>[],
    );
  }

  /// What the reader is asked to highlight.
  final String instructions;

  /// How many key sentences must appear in the submitted highlight.
  final int minMatches;

  /// Always empty on the client. See the factory.
  final List<String> keySentences;

  @override
  String toString() => 'HighlightTask(minMatches: $minMatches)';
}

/// A complete reading session layout.
@immutable
class ArticleLayout {
  /// Creates a layout.
  const ArticleLayout({
    required this.id,
    required this.missionId,
    required this.title,
    required this.difficulty,
    required this.reward,
    required this.staminaCost,
    required this.paragraphs,
    required this.focusTrap,
    required this.quiz,
    required this.highlightTask,
  });

  /// Parses `GET /api/article/:id?session=…`.
  ///
  /// Paragraph order is preserved verbatim (invariant 1 above).
  factory ArticleLayout.fromJson(Map<String, dynamic> json) {
    final rawParagraphs = json['paragraphs'];
    final paragraphs = rawParagraphs is List
        ? List<String>.unmodifiable(rawParagraphs.map((Object? p) => p.toString()))
        : const <String>[];
    final rawQuiz = json['quiz'];
    return ArticleLayout(
      id: json['id']?.toString() ?? '',
      missionId: json['missionId']?.toString() ?? '',
      title: json['title']?.toString() ?? 'Untitled',
      difficulty: Difficulty.parse(json['difficulty']),
      reward: TokenAmount.parse(json['reward']),
      staminaCost: TokenAmount.parse(json['staminaCost']),
      paragraphs: paragraphs,
      focusTrap: json['focusTrap'] is Map<String, dynamic>
          ? FocusTrapSpec.fromJson(json['focusTrap']! as Map<String, dynamic>)
          : const FocusTrapSpec(index: 0, type: FocusTrapType.tapTheImage),
      quiz: rawQuiz is List
          ? List<QuizQuestion>.unmodifiable(
              rawQuiz.whereType<Map<String, dynamic>>().map(QuizQuestion.fromJson),
            )
          : const <QuizQuestion>[],
      highlightTask: json['highlightTask'] is Map<String, dynamic>
          ? HighlightTask.fromJson(json['highlightTask']! as Map<String, dynamic>)
          : const HighlightTask(instructions: '', minMatches: 0, keySentences: <String>[]),
    );
  }

  /// Article id.
  final String id;

  /// Mission this article belongs to.
  final String missionId;

  /// Article title.
  final String title;

  /// Difficulty tier.
  final Difficulty difficulty;

  /// Reward in base units.
  final TokenAmount reward;

  /// Stamina cost in base units.
  final TokenAmount staminaCost;

  /// Paragraphs in SERVER ORDER. Never re-ordered by the client.
  final List<String> paragraphs;

  /// Requested trap placement.
  final FocusTrapSpec focusTrap;

  /// Comprehension questions, with no answer key.
  final List<QuizQuestion> quiz;

  /// Highlight task, with no key sentences.
  final HighlightTask highlightTask;

  /// Number of paragraphs that must appear before the trap.
  ///
  /// Clamped to `[1, len - 2]`, and further to `[0, len]` for layouts too
  /// short to hold a trap at all (invariant 2 above).
  int get trapIndex {
    final len = paragraphs.length;
    if (len < 3) return 0;
    final minIndex = 1;
    final maxIndex = len - 2;
    if (focusTrap.index < minIndex) return minIndex;
    if (focusTrap.index > maxIndex) return maxIndex;
    return focusTrap.index;
  }

  /// True when [paragraphIndex] (0-based) renders after the trap.
  bool isAfterTrap(int paragraphIndex) => paragraphIndex >= trapIndex;

  @override
  String toString() =>
      'ArticleLayout($id, ${paragraphs.length} paragraphs, trap at $trapIndex)';
}

/// Splits prose into tappable sentences for the highlight task.
///
/// Deliberately simple and dependency-free: a sentence ends at `.`, `!` or
/// `?` followed by whitespace, or at the end of the string. Abbreviations are
/// not special-cased because the submitted highlight is a single joined string
/// that the backend re-normalises with its own `normalizeText`, so a slightly
/// coarse split can only change which chip the reader taps, never the verdict.
List<String> splitSentences(String text) {
  if (text.trim().isEmpty) return const <String>[];
  final out = <String>[];
  final buffer = StringBuffer();
  for (var i = 0; i < text.length; i++) {
    final char = text[i];
    buffer.write(char);
    final isTerminator = char == '.' || char == '!' || char == '?';
    final isLast = i == text.length - 1;
    if ((isTerminator && i + 1 < text.length && _isSpace(text[i + 1])) || isLast) {
      final sentence = buffer.toString().trim();
      if (sentence.isNotEmpty) out.add(sentence);
      buffer.clear();
    }
  }
  return List<String>.unmodifiable(out);
}

bool _isSpace(String char) =>
    char == ' ' || char == '\n' || char == '\t' || char == '\r';