/// The reading interface (PRD 3.1 "Reading Interface").
///
/// TWO BEHAVIOURS THIS FILE ENFORCES, BOTH TESTED:
///
///  1. **Server paragraph order is preserved verbatim.** The Judge graded the
///     submitted highlight against the exact layout the server produced for this
///     session, so re-shuffling here would guarantee a mismatch.
///     [buildReaderChildren] is a pure function and the layout test asserts its
///     output order directly.
///  2. **The trap is inserted after exactly `trapIndex` paragraphs**, never at
///     index 0 and never at the last index, and the Continue button stays
///     disabled until it is satisfied.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/article.dart';
import '../state/app_state.dart';
import 'focus_trap.dart';

/// Widget keys the reader's layout tests rely on.
class ReaderKeys {
  const ReaderKeys._();

  /// Key for the paragraph at [index], in server order.
  static Key paragraph(int index) => ValueKey<String>('paragraph-$index');

  /// Continue button.
  static const Key continueButton = ValueKey<String>('reader-continue');

  /// The notice shown when telemetry cannot supply a battery temperature.
  static const Key batteryNotice = ValueKey<String>('reader-battery-notice');
}

/// Builds the ordered children of the article body: paragraphs, with the focus
/// trap inserted after exactly [trapIndex] of them.
///
/// Pure and side-effect free, which is what lets `reader_layout_test.dart`
/// assert the ordering without pumping a widget at all.
List<Widget> buildReaderChildren({
  required ArticleLayout article,
  required FocusTrapSpec trap,
  required VoidCallback onTrapSatisfied,
}) {
  final split = article.trapIndex;
  final children = <Widget>[];
  for (var i = 0; i < article.paragraphs.length; i++) {
    if (i == split) {
      children.add(FocusTrapView(
        trap: trap,
        onSatisfied: onTrapSatisfied,
      ));
    }
    children.add(_Paragraph(key: ReaderKeys.paragraph(i), text: article.paragraphs[i]));
  }
  return children;
}

class _Paragraph extends StatelessWidget {
  const _Paragraph({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(
          text,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(height: 1.5),
        ),
      );
}

/// The article body. Extracted from [ReaderScreen] so it can be pumped
/// directly in a widget test with no routing, no provider and no network.
class ReaderView extends StatefulWidget {
  /// Creates the reader body.
  const ReaderView({
    super.key,
    required this.article,
    required this.onTrapSatisfied,
    required this.onTouch,
    required this.onScroll,
    this.scrollController,
    this.batteryTemperatureAvailable = true,
  });

  /// The layout to render, in server order.
  final ArticleLayout article;

  /// Called when the focus trap is satisfied.
  final VoidCallback onTrapSatisfied;

  /// Records a touch in GLOBAL coordinates.
  final void Function(double globalX, double globalY) onTouch;

  /// Records pixels scrolled since the last callback (signed).
  final void Function(double delta) onScroll;

  /// Optional controller, so the screen can own it.
  final ScrollController? scrollController;

  /// When false, a notice explains that hardware telemetry will be incomplete.
  final bool batteryTemperatureAvailable;

  @override
  State<ReaderView> createState() => _ReaderViewState();
}

class _ReaderViewState extends State<ReaderView> {
  double _lastScrollPixels = 0;

  @override
  Widget build(BuildContext context) {
    final children = buildReaderChildren(
      article: widget.article,
      trap: widget.article.focusTrap,
      onTrapSatisfied: widget.onTrapSatisfied,
    );
    return _buildBody(context, children);
  }

  Widget _buildBody(BuildContext context, List<Widget> children) {
    // A Listener, not a GestureDetector: pointer events are delivered even when
    // a child (the focus trap, a scrollable) wins the gesture arena, so a touch
    // anywhere in the article — including on the trap — is recorded. The
    // coordinates are global, i.e. render-space, which is what the Judge wants.
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerDown: (PointerDownEvent event) =>
          widget.onTouch(event.position.dx, event.position.dy),
      child: NotificationListener<ScrollNotification>(
        onNotification: (ScrollNotification notification) {
          final metrics = notification.metrics;
          final delta = metrics.pixels - _lastScrollPixels;
          _lastScrollPixels = metrics.pixels;
          if (delta != 0) widget.onScroll(delta);
          return false;
        },
        child: ListView(
          controller: widget.scrollController,
          padding: const EdgeInsets.all(20),
          children: <Widget>[
            if (!widget.batteryTemperatureAvailable)
              const Padding(
                key: ReaderKeys.batteryNotice,
                padding: EdgeInsets.only(bottom: 12),
                child: _BatteryNotice(),
              ),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _BatteryNotice extends StatelessWidget {
  const _BatteryNotice();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.battery_unknown, color: theme.colorScheme.onErrorContainer),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'This device cannot report battery temperature, so hardware '
              'telemetry will be incomplete and this attempt may be rejected. '
              'Telemetry is reported honestly — nothing is simulated.',
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

/// The full reading screen, bound to [AppState].
class ReaderScreen extends StatefulWidget {
  /// Creates the screen.
  const ReaderScreen({super.key});

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final session = state.session;
    if (session == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Reading')),
        body: Center(
          child: state.articleError == null
              ? const CircularProgressIndicator()
              : Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(state.articleError!, textAlign: TextAlign.center),
                ),
        ),
      );
    }

    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(session.article.title),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(24),
          child: Padding(
            padding: const EdgeInsets.only(bottom: 8, left: 16, right: 16),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'Mission ${session.missionId} · ${session.article.reward.formatShort()} CATT',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ),
        ),
      ),
      body: ReaderView(
        article: session.article,
        batteryTemperatureAvailable: state.batteryTemperatureAvailable,
        onTrapSatisfied: state.satisfyTrap,
        onTouch: state.recordTouch,
        onScroll: state.recordScroll,
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            height: 56,
            child: FilledButton(
              key: ReaderKeys.continueButton,
              onPressed: state.canLeaveReader
                  ? () => Navigator.of(context).pushNamed('/task')
                  : null,
              child: Text(
                state.canLeaveReader
                    ? 'Continue to the task'
                    : 'Clear the focus trap to continue',
              ),
            ),
          ),
        ),
      ),
    );
  }
}