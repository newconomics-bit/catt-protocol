/// Focus-trap widget tests.
///
/// Covers the two things the trap exists for: it sits at the index the server
/// chose, and it cannot be cleared without performing the interaction its type
/// demands. A tap satisfies `tap-the-image`; a tap does NOT satisfy
/// `swipe-to-continue`, and a tap that does not outlast the hold window does NOT
/// satisfy `hold-to-reveal`.
library;

import 'package:catt_app/models/article.dart';
import 'package:catt_app/screens/focus_trap.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

/// Mounts a trap with no surrounding app chrome.
Future<Counter> pumpTrap(
  WidgetTester tester,
  FocusTrapType type, {
  Duration holdDuration = const Duration(milliseconds: 600),
}) async {
  final satisfied = Counter();
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: FocusTrapView(
        trap: FocusTrapSpec(index: 1, type: type),
        holdDuration: holdDuration,
        onSatisfied: satisfied.call,
      ),
    ),
  ));
  return satisfied;
}

void main() {
  group('placement', () {
    testWidgets('renders exactly one trap, keyed for layout assertions',
        (WidgetTester tester) async {
      await pumpTrap(tester, FocusTrapType.tapTheImage);
      expect(find.byKey(FocusTrapKeys.trap), findsOneWidget);
      expect(find.byKey(FocusTrapKeys.target), findsOneWidget);
      expect(find.byKey(FocusTrapKeys.cleared), findsNothing);
    });

    testWidgets('the trap occupies a large target, well past the 48dp minimum',
        (WidgetTester tester) async {
      await pumpTrap(tester, FocusTrapType.holdToReveal);
      final size = tester.getSize(find.byKey(FocusTrapKeys.target));
      expect(size.height, greaterThanOrEqualTo(48));
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(96));
    });
  });

  group('tap-the-image', () {
    testWidgets('is not satisfied until it is tapped', (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.tapTheImage);
      await tester.pump();
      expect(satisfied.value, 0);
      expect(find.byKey(FocusTrapKeys.cleared), findsNothing);

      await tester.tap(find.byKey(FocusTrapKeys.target));
      await tester.pump();
      expect(satisfied.value, 1);
      expect(find.byKey(FocusTrapKeys.cleared), findsOneWidget);
      expect(find.text('Focus trap cleared'), findsOneWidget);
    });

    testWidgets('is satisfied once and its target is then gone',
        (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.tapTheImage);
      await tester.tap(find.byKey(FocusTrapKeys.target));
      await tester.pump();
      expect(satisfied.value, 1);

      // The interactive surface is replaced by the cleared state, so a second
      // tap cannot re-report satisfaction and the reader cannot un-clear it.
      expect(find.byKey(FocusTrapKeys.target), findsNothing);
      expect(find.byKey(FocusTrapKeys.cleared), findsOneWidget);
      await tester.tap(find.byKey(FocusTrapKeys.cleared));
      await tester.pump();
      expect(satisfied.value, 1);
    });
  });

  group('swipe-to-continue', () {
    testWidgets('a TAP does not satisfy it — a swipe is required',
        (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.swipeToContinue);
      await tester.tap(find.byKey(FocusTrapKeys.target));
      await tester.pump(const Duration(milliseconds: 100));
      expect(satisfied.value, 0, reason: 'a bot that taps everything must not clear this');
      expect(find.byKey(FocusTrapKeys.cleared), findsNothing);
    });

    testWidgets('a slow drag does not satisfy it', (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.swipeToContinue);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(FocusTrapKeys.target)),
      );
      await gesture.moveBy(const Offset(-30, 0));
      await gesture.up();
      await tester.pump();
      expect(satisfied.value, 0);
    });

    testWidgets('a real horizontal fling satisfies it', (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.swipeToContinue);
      await tester.fling(find.byKey(FocusTrapKeys.target), const Offset(-220, 0), 1200);
      await tester.pump();
      expect(satisfied.value, 1);
      expect(find.byKey(FocusTrapKeys.cleared), findsOneWidget);
    });
  });

  group('hold-to-reveal', () {
    testWidgets('a quick tap does not satisfy it — the hold must be sustained',
        (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.holdToReveal);
      await tester.tap(find.byKey(FocusTrapKeys.target));
      await tester.pump(const Duration(milliseconds: 100));
      expect(satisfied.value, 0);
    });

    testWidgets('releasing early cancels the hold', (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.holdToReveal);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(FocusTrapKeys.target)),
      );
      await tester.pump(const Duration(milliseconds: 200));
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 600));
      expect(satisfied.value, 0);
    });

    testWidgets('sustained pressure satisfies it', (WidgetTester tester) async {
      final satisfied = await pumpTrap(tester, FocusTrapType.holdToReveal);
      final gesture = await tester.startGesture(
        tester.getCenter(find.byKey(FocusTrapKeys.target)),
      );
      await tester.pump(const Duration(milliseconds: 650));
      await gesture.up();
      await tester.pump();
      expect(satisfied.value, 1);
      expect(find.byKey(FocusTrapKeys.cleared), findsOneWidget);
    });
  });

  group('the trap inside a paragraph list', () {
    testWidgets('is positioned after exactly the paragraphs before its index',
        (WidgetTester tester) async {
      final article = sampleArticle(paragraphCount: 6, trapIndex: 3);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Column(
            children: <Widget>[
              for (final paragraph in article.paragraphs.take(article.trapIndex))
                Text(paragraph, key: ValueKey<String>('paragraph-${article.paragraphs.indexOf(paragraph)}')),
              const FocusTrapView(
                trap: FocusTrapSpec(index: 3, type: FocusTrapType.tapTheImage),
                onSatisfied: _noop,
              ),
              for (var i = article.trapIndex; i < article.paragraphs.length; i++)
                Text(article.paragraphs[i], key: ValueKey<String>('paragraph-$i')),
            ],
          ),
        ),
      ));

      final trapTop = tester.getTopLeft(find.byKey(FocusTrapKeys.trap)).dy;
      for (var i = 0; i < article.paragraphs.length; i++) {
        final paragraphTop = tester.getTopLeft(find.byKey(ValueKey<String>('paragraph-$i'))).dy;
        if (i < article.trapIndex) {
          expect(paragraphTop, lessThan(trapTop),
              reason: 'paragraph $i must render above the trap');
        } else {
          expect(paragraphTop, greaterThan(trapTop),
              reason: 'paragraph $i must render below the trap');
        }
      }
    });
  });

  group('reset between traps', () {
    testWidgets('a new trap starts unsatisfied', (WidgetTester tester) async {
      final satisfied = Counter();
      Widget build(FocusTrapType type) => MaterialApp(
            home: Scaffold(
              body: FocusTrapView(
                trap: FocusTrapSpec(index: 1, type: type),
                onSatisfied: satisfied.call,
              ),
            ),
          );

      await tester.pumpWidget(build(FocusTrapType.tapTheImage));
      await tester.tap(find.byKey(FocusTrapKeys.target));
      await tester.pump();
      expect(satisfied.value, 1);

      // The reader moved to a new layout: the cleared state must not carry over.
      await tester.pumpWidget(build(FocusTrapType.tapTheImage));
      await tester.pump();
      expect(find.byKey(FocusTrapKeys.cleared), findsNothing);
      expect(satisfied.value, 1);
    });
  });
}

/// No-op callback for tests that do not care about the satisfaction signal.
void _noop() {}