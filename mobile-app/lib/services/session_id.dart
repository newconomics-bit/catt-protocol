/// Session id generation.
///
/// The session id is the SEED for the server's paragraph shuffle and trap
/// position, so it must be:
///  * stable for the whole reading session (the client keeps it from opening
///    the article until submitting), and
///  * unpredictable, so a bot cannot pre-learn a layout.
///
/// It is generated locally from `Random.secure()` — it is not a secret and is
/// not an authentication token, but it IS a capability: the server will not let
/// a different wallet reuse one. It is generated from injected randomness so
/// tests can pin it.
library;

import 'dart:math';

/// Creates session ids.
abstract class SessionIdGenerator {
  /// Returns a fresh session id.
  String next();
}

/// Production generator: 128 bits from `Random.secure()`, hex encoded.
class SecureSessionIdGenerator implements SessionIdGenerator {
  /// Creates the generator.
  const SecureSessionIdGenerator();

  @override
  String next() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256), growable: false);
    return bytes.map((int b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}

/// Deterministic generator for tests: `sess-1`, `sess-2`, …
class CountingSessionIdGenerator implements SessionIdGenerator {
  /// Creates the generator, optionally seeded with a prefix.
  CountingSessionIdGenerator({this.prefix = 'sess-'});

  /// Prefix for generated ids.
  final String prefix;

  int _counter = 0;

  @override
  String next() {
    _counter += 1;
    return '$prefix$_counter';
  }
}