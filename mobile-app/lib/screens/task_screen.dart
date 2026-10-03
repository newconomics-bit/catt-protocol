/// The validation step (PRD 3.1 "Validation", PRD 6.2 "Mining Loop").
///
/// Three tasks in one screen, because they are graded together by a single
/// `POST /api/submit`:
///
///  * **Quiz** — single-select, one 56dp button per option. Big targets.
///  * **Highlight** — tap sentences to toggle them; the joined text is what the
///    server matches against its private key sentences.
///  * **Free text** — measured typing time via [TypingTimer], started when the
///    field gains focus and stopped on submit. The measured value is sent as-is:
///    the backend's typing-speed floor exists to catch replayed answers, so
///    inflating it here would be helping the reader beat the anti-cheat.
///
/// [TaskView] is a pure widget over [ReadingSession], so the whole task screen
/// is testable with no provider, no network and no device.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/article.dart';
import '../models/submit_result.dart';
import '../services/typing_timer.dart';
import '../state/app_state.dart';
import '../state/reading_session.dart';

/// Widget keys the task screen's tests rely on.
class TaskKeys {
  const TaskKeys._();

  /// Option button for [questionId] at [optionIndex].
  static Key option(String questionId, int optionIndex) =>
      ValueKey<String>('option-$questionId-$optionIndex');

  /// Tappable sentence at [index] in highlight mode.
  static Key sentence(int index) => ValueKey<String>('sentence-$index');

  /// Free-text field.
  static const Key freeText = ValueKey<String>('task-free-text');

  /// Submit button.
  static const Key submit = ValueKey<String>('task-submit');
}

/// The task screen body.
class TaskView extends StatefulWidget {
  /// Creates the task body.
  const TaskView({
    super.key,
    required this.session,
    required this.onAnswer,
    required this.onToggleHighlight,
    required this.onFreeTextChanged,
    required this.onSubmit,
    required this.typingTimer,
    this.isSubmitting = false,
    this.submitError,
  });

  /// The attempt being answered.
  final ReadingSession session;

  /// Answers (or clears) a question: `null` clears it.
  final void Function(String questionId, int? optionIndex) onAnswer;

  /// Toggles a sentence in the highlight set.
  final void Function(String sentence) onToggleHighlight;

  /// Updates the free-text answer.
  final void Function(String text) onFreeTextChanged;

  /// Submits the attempt.
  final VoidCallback onSubmit;

  /// Timer measuring real typing time.
  final TypingTimer typingTimer;

  /// Whether a submission is in flight.
  final bool isSubmitting;

  /// Last submission failure, safe to display.
  final String? submitError;

  @override
  State<TaskView> createState() => _TaskViewState();
}

class _TaskViewState extends State<TaskView> {
  bool _highlightMode = false;
  late final TextEditingController _freeTextController =
      TextEditingController(text: widget.session.freeText);
  late final FocusNode _freeTextFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    // Start counting the moment the field takes focus, which is the honest
    // definition of "typing time": it includes thinking about the answer.
    _freeTextFocus.addListener(_onFocusChanged);
  }

  void _onFocusChanged() {
    if (_freeTextFocus.hasFocus) {
      widget.typingTimer.start();
    } else {
      widget.typingTimer.stop();
    }
  }

  @override
  void dispose() {
    widget.typingTimer.stop();
    _freeTextFocus
      ..removeListener(_onFocusChanged)
      ..dispose();
    _freeTextController.dispose();
    super.dispose();
  }

  void _submit() {
    widget.typingTimer.stop();
    widget.onSubmit();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final session = widget.session;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: <Widget>[
        _SectionHeader(title: '1. Comprehension', subtitle: 'Pick one answer each.'),
        for (final question in session.article.quiz) ...<Widget>[
          _QuizQuestion(
            question: question,
            selectedIndex: session.answers[question.id],
            onSelected: (int index) => widget.onAnswer(question.id, index),
          ),
          const SizedBox(height: 16),
        ],
        _SectionHeader(
          title: '2. Highlight',
          subtitle: session.article.highlightTask.instructions.isEmpty
              ? 'Tap the sentences you would highlight.'
              : session.article.highlightTask.instructions,
        ),
        SegmentedButton<bool>(
          segments: const <ButtonSegment<bool>>[
            ButtonSegment<bool>(value: false, label: Text('Read'), icon: Icon(Icons.article)),
            ButtonSegment<bool>(value: true, label: Text('Highlight'), icon: Icon(Icons.brush)),
          ],
          selected: <bool>{_highlightMode},
          onSelectionChanged: (Set<bool> selection) =>
              setState(() => _highlightMode = selection.first),
        ),
        const SizedBox(height: 12),
        ..._buildHighlightBody(theme),
        _SectionHeader(
          title: '3. In your own words',
          subtitle: 'Your answer is compared against other readers to detect copying.',
        ),
        TextField(
          key: TaskKeys.freeText,
          controller: _freeTextController,
          focusNode: _freeTextFocus,
          minLines: 4,
          maxLines: 8,
          onChanged: widget.onFreeTextChanged,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: 'What was the main idea?',
          ),
        ),
        const SizedBox(height: 24),
        if (widget.submitError != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Text(
              widget.submitError!,
              style: TextStyle(color: theme.colorScheme.error),
            ),
          ),
        SizedBox(
          height: 56,
          child: FilledButton(
            key: TaskKeys.submit,
            onPressed: widget.isSubmitting ? null : _submit,
            child: widget.isSubmitting
                ? const SizedBox(
                    height: 24,
                    width: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Submit for judgement'),
          ),
        ),
      ],
    );
  }

  List<Widget> _buildHighlightBody(ThemeData theme) {
    final sentences = <String>[];
    for (final paragraph in widget.session.article.paragraphs) {
      sentences.addAll(splitSentences(paragraph));
    }
    if (sentences.isEmpty) {
      return <Widget>[const Text('No text to highlight.')];
    }
    return <Widget>[
      Text(
        '${widget.session.highlightedSentences.length} sentence(s) selected',
        style: theme.textTheme.bodySmall,
      ),
      const SizedBox(height: 8),
      for (var i = 0; i < sentences.length; i++)
        _SelectableSentence(
          key: TaskKeys.sentence(i),
          text: sentences[i],
          selected: widget.session.highlightedSentences.contains(sentences[i]),
          enabled: _highlightMode,
          onTap: () => widget.onToggleHighlight(sentences[i]),
        ),
    ];
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      );
}

class _QuizQuestion extends StatelessWidget {
  const _QuizQuestion({
    required this.question,
    required this.selectedIndex,
    required this.onSelected,
  });

  final QuizQuestion question;
  final int? selectedIndex;
  final void Function(int index) onSelected;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(question.question, style: Theme.of(context).textTheme.bodyLarge),
          const SizedBox(height: 8),
          for (var i = 0; i < question.options.length; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: SizedBox(
                height: 56,
                width: double.infinity,
                child: OutlinedButton(
                  key: TaskKeys.option(question.id, i),
                  onPressed: () => onSelected(i),
                  style: OutlinedButton.styleFrom(
                    alignment: Alignment.centerLeft,
                    backgroundColor: selectedIndex == i
                        ? Theme.of(context).colorScheme.primaryContainer
                        : null,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                  ),
                  child: Text(question.options[i], textAlign: TextAlign.left),
                ),
              ),
            ),
        ],
      );
}

class _SelectableSentence extends StatelessWidget {
  const _SelectableSentence({
    super.key,
    required this.text,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final String text;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Semantics(
        button: enabled,
        selected: selected,
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: selected ? theme.colorScheme.tertiaryContainer : null,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: selected ? theme.colorScheme.tertiary : theme.colorScheme.outlineVariant,
              ),
            ),
            child: Text(text, style: theme.textTheme.bodyMedium),
          ),
        ),
      ),
    );
  }
}

/// The full task screen, bound to [AppState].
class TaskScreen extends StatelessWidget {
  /// Creates the screen.
  const TaskScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final session = state.session;
    if (session == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Task')),
        body: const Center(child: Text('No active attempt.')),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Validate your attention')),
      body: TaskView(
        session: session,
        typingTimer: state.typingTimer,
        isSubmitting: state.isSubmitting,
        submitError: state.submitError,
        onAnswer: state.answerQuestion,
        onToggleHighlight: state.toggleHighlight,
        onFreeTextChanged: state.setFreeText,
        onSubmit: () async {
          final response = await state.submitAttempt();
          if (!context.mounted) return;
          Navigator.of(context).pushReplacementNamed(
            '/result',
            arguments: response,
          );
        },
      ),
    );
  }
}

/// Argument type for the `/result` route.
///
/// [response] is the Judge's verdict, or `null` when the request never reached
/// the Judge (a network failure), which the result screen renders as its own
/// state rather than pretending the attempt failed on its merits.
class ResultRouteArguments {
  /// Creates the arguments.
  const ResultRouteArguments(this.response);

  /// The verdict, when there is one.
  final SubmitResponse? response;
}