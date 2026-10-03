/// Reader layout tests.
///
/// Two guarantees are proved here, and both are about the CLIENT not second-
/// guessing the server:
///
///  1. The trap is never at index 0 and never at the last index — for every
///     valid paragraph count and for every index the server could send,
///     including hostile ones.
///  2. Paragraph order is preserved exactly as received. The Judge grades the
///     submitted highlight against the layout it produced for this session, so
///     a client-side shuffle would guarantee a mismatch — this app does not
///     contain a shuffle.
library;

import 'package:catt_app/models/article.dart';
import 'package:catt_app/screens/focus_trap.dart';
import 'package:catt_app/screens/reader_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  group('the trap is never first and never last', () {
    test('a layout from the server is clamped into [1, length - 2]', () {
      for (var paragraphCount = 3; paragraphCount <= 12; paragraphCount++) {
        for (var rawIndex = -2; rawIndex <= paragraphCount + 2; rawIndex++) {
          final article = sampleArticle(
            paragraphCount: paragraphCount,
            trapIndex: rawIndex,
          );
          final trapIndex = article.trapIndex;
          expect(trapIndex, greaterThanOrEqualTo(1),
              reason: 'trap at 0 fires before the reader has read anything');
          expect(trapIndex, lessThanOrEqualTo(paragraphCount - 2),
              reason: 'a trap at the last index is unreachable in practice');
        }
      }
    });

    test('an in-range index from the server is used unchanged', () {
      for (final index in <int>[1, 2, 3, 4]) {
        expect(sampleArticle(paragraphCount: 6, trapIndex: index).trapIndex, index);
      }
    });

    test('the trap sits after at least one and at least two paragraphs remain', () {
      final article = sampleArticle(paragraphCount: 8, trapIndex: 4);
      expect(article.trapIndex, 4);
      expect(article.paragraphs.take(article.trapIndex).length, 4);
      expect(article.paragraphs.skip(article.trapIndex).length, 4);
      expect(article.isAfterTrap(article.trapIndex), isTrue);
      expect(article.isAfterTrap(article.trapIndex - 1), isFalse);
    });

    testWidgets('the rendered trap is never the first or last child',
        (WidgetTester tester) async {
      for (final rawIndex in <int>[0, 1, 3, 5, 6]) {
        await tester.pumpWidget(MaterialApp(
          home: Scaffold(
            body: ReaderView(
              article: sampleArticle(paragraphCount: 6, trapIndex: rawIndex),
              onTrapSatisfied: _noop,
              onTouch: (_, _) {},
              onScroll: (_) {},
            ),
          ),
        ));

        final children = buildReaderChildren(
          article: sampleArticle(paragraphCount: 6, trapIndex: rawIndex),
          trap: sampleArticle(paragraphCount: 6, trapIndex: rawIndex).focusTrap,
          onTrapSatisfied: _noop,
        );

        // Exactly one trap among paragraphs + trap.
        final trapPositions = <int>[
          for (var i = 0; i < children.length; i++)
            if (children[i] is FocusTrapView) i,
        ];
        expect(trapPositions.length, 1);
        expect(trapPositions.first, greaterThan(0));
        expect(trapPositions.first, lessThan(children.length - 1));

        // ...and the rendered order agrees with the pure function.
        final trapTop = tester.getTopLeft(find.byKey(FocusTrapKeys.trap)).dy;
        final firstParagraphTop = tester.getTopLeft(find.byKey(ReaderKeys.paragraph(0))).dy;
        final lastParagraphTop =
            tester.getTopLeft(find.byKey(ReaderKeys.paragraph(5))).dy;
        expect(trapTop, greaterThan(firstParagraphTop));
        expect(trapTop, lessThan(lastParagraphTop));
      }
    });
  });

  group('the client does not re-shuffle the server order', () {
    test('the rendered paragraph keys appear in the server order', () {
      final paragraphs = <String>[
        'Zulu paragraph.',
        'Alpha paragraph.',
        'Mike paragraph.',
        'Bravo paragraph.',
        'Charlie paragraph.',
        'Delta paragraph.',
      ];
      final article = ArticleLayout.fromJson(articleJson(paragraphCount: 6)
        ..['paragraphs'] = paragraphs);

      final children = buildReaderChildren(
        article: article,
        trap: article.focusTrap,
        onTrapSatisfied: _noop,
      );

      final rendered = <String>[
        for (final child in children)
          if (child.key is ValueKey<String>)
            (child.key! as ValueKey<String>).value.replaceFirst('paragraph-', ''),
      ];
      expect(rendered, <String>['0', '1', '2', '3', '4', '5'],
          reason: 'children are emitted in index order, and index order is '
              'server order');
      expect(article.paragraphs, paragraphs,
          reason: 'the model stores the server order verbatim');
    });

    testWidgets('a pumped reader renders the paragraphs top-down in that order',
        (WidgetTester tester) async {
      final article = ArticleLayout.fromJson(articleJson(paragraphCount: 6)
        ..['paragraphs'] = <String>[
          'Zulu.',
          'Alpha.',
          'Mike.',
          'Bravo.',
          'Charlie.',
          'Delta.',
        ]);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ReaderView(
            article: article,
            onTrapSatisfied: _noop,
            onTouch: (_, _) {},
            onScroll: (_) {},
          ),
        ),
      ));

      for (var i = 1; i < article.paragraphs.length; i++) {
        final previous = tester.getTopLeft(find.byKey(ReaderKeys.paragraph(i - 1))).dy;
        final current = tester.getTopLeft(find.byKey(ReaderKeys.paragraph(i))).dy;
        expect(current, greaterThan(previous),
            reason: 'paragraph $i must render below paragraph ${i - 1}');
      }
      expect(find.text('Zulu.'), findsOneWidget);
      expect(find.text('Delta.'), findsOneWidget);
    });
  });

  group('telemetry capture from the reader', () {
    testWidgets('a touch is reported in GLOBAL coordinates', (WidgetTester tester) async {
      final touches = <List<double>>[];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ReaderView(
            article: sampleArticle(paragraphCount: 6),
            onTrapSatisfied: _noop,
            onTouch: (double x, double y) => touches.add(<double>[x, y]),
            onScroll: (_) {},
          ),
        ),
      ));

      final centre = tester.getCenter(find.byKey(FocusTrapKeys.target));
      await tester.tapAt(centre);
      await tester.pump();

      expect(touches.length, 1);
      expect(touches.single[0], closeTo(centre.dx, 0.5));
      expect(touches.single[1], closeTo(centre.dy, 0.5));
    });

    testWidgets('scrolling is reported as a signed delta', (WidgetTester tester) async {
      final deltas = <double>[];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: ReaderView(
            article: sampleArticle(paragraphCount: 20),
            onTrapSatisfied: _noop,
            onTouch: (_, _) {},
            onScroll: deltas.add,
          ),
        ),
      ));

      // Dragging the content upwards moves the reader FORWARD through the
      // article, so `metrics.pixels` — and therefore scrollDelta — increases.
      await tester.drag(find.byType(ListView), const Offset(0, -300));
      await tester.pumpAndSettle();
      expect(deltas, isNotEmpty);
      expect(deltas.any((double d) => d > 0), isTrue);
      expect(deltas.fold<double>(0, (double a, double b) => a + b), greaterThan(0),
          reason: 'forward scrolling is a positive delta; its magnitude is '
              'what the Judge divides by elapsed time to get a velocity');

      // Dragging back down moves BACKWARD, and real readers do that.
      deltas.clear();
      await tester.drag(find.byType(ListView), const Offset(0, 200));
      await tester.pumpAndSettle();
      expect(deltas.any((double d) => d < 0), isTrue);
      expect(deltas.fold<double>(0, (double a, double b) => a + b), lessThan(0));
    });

    testWidgets('the battery notice appears only when the sensor is missing',
        (WidgetTester tester) async {
      Future<void> pump(bool available) => tester.pumpWidget(MaterialApp(
            home: Scaffold(
              body: ReaderView(
                article: sampleArticle(paragraphCount: 6),
                onTrapSatisfied: _noop,
                onTouch: (_, _) {},
                onScroll: (_) {},
                batteryTemperatureAvailable: available,
              ),
            ),
          ));

      await pump(false);
      expect(find.byKey(ReaderKeys.batteryNotice), findsOneWidget);
      await pump(true);
      expect(find.byKey(ReaderKeys.batteryNotice), findsNothing);
    });
  });
}

/// No-op callback for tests that do not care about the satisfaction signal.
void _noop() {}