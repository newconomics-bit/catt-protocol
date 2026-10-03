/// The focus trap: the one interaction an auto-scroller cannot fake.
///
/// PRD 3.1 — "randomized 'Focus Traps' (e.g. swipe to continue, tap an image)
/// to defeat auto-scrollers". The server picks the type and the position; this
/// widget renders the type and enforces that it is satisfied before the reader
/// may continue.
///
/// DESIGN CONSTRAINTS, all deliberate:
///  * **A tap is not always enough.** `tap-the-image` accepts a tap;
///    `swipe-to-continue` requires a real horizontal fling (a tap must NOT
///    satisfy it); `hold-to-reveal` requires a sustained press. A bot that taps
///    everything therefore clears one trap in three.
///  * **Big targets.** The tap target is 96dp and the swipe/hold surfaces are at
///    least 120dp tall, well past the 48dp minimum, because this app targets
///    mid-range Android hardware and one-handed use.
///  * **Works under test.** No platform channels, no timers that need real time
///    to elapse ([holdDuration] is injectable), and a stable [ValueKey] on the
///    trap root so a layout test can assert exactly how many paragraphs render
///    before it.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../models/article.dart';

/// Widget keys the reader and its tests rely on.
class FocusTrapKeys {
  const FocusTrapKeys._();

  /// Root of the trap, wherever it is placed among the paragraphs.
  static const Key trap = ValueKey<String>('focus-trap');

  /// The interactive surface for the current trap type.
  static const Key target = ValueKey<String>('focus-trap-target');

  /// Shown once the trap has been satisfied.
  static const Key cleared = ValueKey<String>('focus-trap-cleared');
}

/// Renders one focus trap and reports when it is satisfied.
class FocusTrapView extends StatefulWidget {
  /// Creates the trap.
  const FocusTrapView({
    super.key,
    required this.trap,
    required this.onSatisfied,
    this.holdDuration = const Duration(milliseconds: 600),
    this.minSwipeVelocity = 120,
  });

  /// Which trap to render and how it must be cleared.
  final FocusTrapSpec trap;

  /// Called exactly once, the first time the trap is satisfied.
  final VoidCallback onSatisfied;

  /// How long a press must be held for `hold-to-reveal`.
  final Duration holdDuration;

  /// Minimum horizontal fling velocity (logical px/s) for `swipe-to-continue`.
  final double minSwipeVelocity;

  @override
  State<FocusTrapView> createState() => _FocusTrapViewState();
}

class _FocusTrapViewState extends State<FocusTrapView> {
  bool _satisfied = false;
  Timer? _holdTimer;
  double _swipeProgress = 0;

  @override
  void didUpdateWidget(FocusTrapView oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A new layout means a new trap: reset so a satisfied state from the
    // previous article cannot leak into this one.
    if (oldWidget.trap != widget.trap) {
      _holdTimer?.cancel();
      _holdTimer = null;
      _satisfied = false;
      _swipeProgress = 0;
    }
  }

  @override
  void dispose() {
    _holdTimer?.cancel();
    super.dispose();
  }

  void _satisfy() {
    if (_satisfied) return;
    setState(() => _satisfied = true);
    widget.onSatisfied();
  }

  void _onHoldStart() {
    _holdTimer?.cancel();
    _holdTimer = Timer(widget.holdDuration, _satisfy);
  }

  void _onHoldEnd() {
    _holdTimer?.cancel();
    _holdTimer = null;
  }

  void _onSwipeEnd(DragEndDetails details) {
    final velocity = details.primaryVelocity ?? 0;
    final magnitude = velocity.abs();
    if (magnitude >= widget.minSwipeVelocity) {
      setState(() => _swipeProgress = 1);
      _satisfy();
    } else {
      // Too slow: spring back. A slow drag is a human fumbling, not a swipe.
      setState(() => _swipeProgress = 0);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Semantics(
      container: true,
      label: 'Focus trap. ${_instruction()}',
      child: Container(
        key: FocusTrapKeys.trap,
        margin: const EdgeInsets.symmetric(vertical: 20),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: theme.colorScheme.secondaryContainer,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: theme.colorScheme.secondary,
            width: 2,
          ),
        ),
        child: _satisfied ? _buildCleared(theme) : _buildTrap(theme),
      ),
    );
  }

  Widget _buildCleared(ThemeData theme) => Row(
        key: FocusTrapKeys.cleared,
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(Icons.check_circle, color: theme.colorScheme.primary, size: 28),
          const SizedBox(width: 12),
          Text(
            'Focus trap cleared',
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
        ],
      );

  Widget _buildTrap(ThemeData theme) {
    switch (widget.trap.type) {
      case FocusTrapType.tapTheImage:
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('Focus trap — tap the illustration to continue',
                style: theme.textTheme.titleSmall, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            Semantics(
              button: true,
              label: 'Tap the illustration to continue',
              child: GestureDetector(
                key: FocusTrapKeys.target,
                onTap: _satisfy,
                child: Container(
                  width: 96,
                  height: 96,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: const Icon(Icons.image, color: Colors.white, size: 48),
                ),
              ),
            ),
          ],
        );
      case FocusTrapType.swipeToContinue:
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('Focus trap — swipe left to continue',
                style: theme.textTheme.titleSmall, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            GestureDetector(
              key: FocusTrapKeys.target,
              onHorizontalDragUpdate: (DragUpdateDetails details) {
                setState(() => _swipeProgress =
                    (_swipeProgress - details.delta.dx / 160).clamp(0.0, 1.0));
              },
              onHorizontalDragEnd: _onSwipeEnd,
              child: Container(
                height: 120,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: theme.colorScheme.primary, width: 2),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.arrow_back),
                    const SizedBox(width: 8),
                    Text(
                      _swipeProgress >= 1 ? 'Released' : 'Swipe →',
                      style: theme.textTheme.titleMedium,
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      case FocusTrapType.holdToReveal:
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('Focus trap — press and hold to reveal the next section',
                style: theme.textTheme.titleSmall, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            GestureDetector(
              key: FocusTrapKeys.target,
              onTapDown: (_) => _onHoldStart(),
              onTapUp: (_) => _onHoldEnd(),
              onTapCancel: _onHoldEnd,
              child: Container(
                height: 120,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: theme.colorScheme.primary, width: 2),
                ),
                child: const Icon(Icons.touch_app, size: 48),
              ),
            ),
          ],
        );
    }
  }

  String _instruction() {
    switch (widget.trap.type) {
      case FocusTrapType.tapTheImage:
        return 'Tap the illustration to continue.';
      case FocusTrapType.swipeToContinue:
        return 'Swipe left to continue.';
      case FocusTrapType.holdToReveal:
        return 'Press and hold to reveal.';
    }
  }
}