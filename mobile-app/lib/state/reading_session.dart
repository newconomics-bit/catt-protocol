/// One reading attempt, from "mission opened" to "verdict received".
///
/// Deliberately a plain immutable-by-convention holder rather than a
/// `ChangeNotifier`: the app has exactly one session at a time and the reader,
/// task and result screens all read it through [AppState]. Keeping it free of
/// Flutter and of the network makes the whole mining loop testable with nothing
/// but an injected [ApiClient].
library;

import 'package:flutter/foundation.dart';

import '../models/article.dart';
import '../models/submit_result.dart';

/// The in-flight reading attempt.
@immutable
class ReadingSession {
  /// Creates a session.
  const ReadingSession({
    required this.sessionId,
    required this.missionId,
    required this.article,
    this.answers = const <String, int>{},
    this.highlightedSentences = const <String>{},
    this.freeText = '',
    this.typingMs = 0,
    this.trapSatisfied = false,
  });

  /// The seed for the server's layout. Stable for the whole session: the Judge
  /// grades the submitted highlight against the layout this id produced.
  final String sessionId;

  /// Mission being attempted.
  final String missionId;

  /// The reading layout as served for [sessionId].
  final ArticleLayout article;

  /// question id -> chosen option index.
  final Map<String, int> answers;

  /// Sentences the reader tapped to highlight, in tap order.
  final Set<String> highlightedSentences;

  /// The optional free-text answer.
  final String freeText;

  /// Measured typing time in milliseconds.
  final int typingMs;

  /// Whether the focus trap has been satisfied. The reader cannot continue
  /// past the trap until this is true.
  final bool trapSatisfied;

  /// True when every question has an answer.
  bool get isQuizComplete {
    if (article.quiz.isEmpty) return true;
    return answers.length == article.quiz.length;
  }

  /// The joined highlight text, which is what `POST /api/submit` grades. The
  /// server normalises it (case, punctuation, whitespace) before matching.
  String get highlightText => highlightedSentences.join(' ');

  /// Answers in the wire shape.
  List<QuizAnswer> get wireAnswers {
    final out = <QuizAnswer>[];
    for (final question in article.quiz) {
      final index = answers[question.id];
      if (index != null) out.add(QuizAnswer(questionId: question.id, answerIndex: index));
    }
    return out;
  }

  /// Returns a copy with the given fields replaced.
  ReadingSession copyWith({
    Map<String, int>? answers,
    Set<String>? highlightedSentences,
    String? freeText,
    int? typingMs,
    bool? trapSatisfied,
  }) =>
      ReadingSession(
        sessionId: sessionId,
        missionId: missionId,
        article: article,
        answers: answers ?? this.answers,
        highlightedSentences: highlightedSentences ?? this.highlightedSentences,
        freeText: freeText ?? this.freeText,
        typingMs: typingMs ?? this.typingMs,
        trapSatisfied: trapSatisfied ?? this.trapSatisfied,
      );

  /// Returns a copy with one question answered (or cleared with `null`).
  ReadingSession withAnswer(String questionId, int? answerIndex) {
    final next = Map<String, int>.from(answers);
    if (answerIndex == null) {
      next.remove(questionId);
    } else {
      next[questionId] = answerIndex;
    }
    return copyWith(answers: next);
  }

  /// Returns a copy with one sentence's highlight toggled.
  ReadingSession withHighlightToggled(String sentence) {
    final next = Set<String>.from(highlightedSentences);
    if (!next.remove(sentence)) next.add(sentence);
    return copyWith(highlightedSentences: next);
  }
}