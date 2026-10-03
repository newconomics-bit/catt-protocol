/// Private-key storage abstraction.
///
/// `flutter_secure_storage` needs a platform channel (Keystore on Android),
/// which does not exist in a unit test. Everything in this app that touches a
/// key therefore goes through [KeyStore], and tests inject
/// [InMemoryKeyStore] instead. The production implementation is
/// [SecureStorageKeyStore], the only place the plugin is referenced.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Read/write/delete a single opaque secret.
abstract class KeyStore {
  /// Returns the stored value for [key], or `null` when absent.
  Future<String?> read(String key);

  /// Stores [value] under [key].
  Future<void> write(String key, String value);

  /// Removes the value for [key]. Missing keys are not an error.
  Future<void> delete(String key);
}

/// In-memory implementation used by tests and as a safe fallback when the
/// platform channel is unavailable (the app will still work for the session,
/// the key just does not survive a restart).
class InMemoryKeyStore implements KeyStore {
  /// Creates a store, optionally pre-seeded.
  InMemoryKeyStore([Map<String, String>? seed]) {
    if (seed != null) _values.addAll(seed);
  }

  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    _values.remove(key);
  }
}

/// `flutter_secure_storage`-backed implementation.
///
/// Android options are chosen for the mid-range/low-end devices this app
/// targets: `encryptedSharedPreferences` off (the legacy keystore path is
/// lighter) and no biometric gate, because a wallet that needs a fingerprint
/// to open a 3-line article reader loses more users than it protects.
class SecureStorageKeyStore implements KeyStore {
  /// Creates a store over the plugin.
  SecureStorageKeyStore(this._storage);

  /// Builds the production store with sane Android defaults.
  factory SecureStorageKeyStore.createDefault() => SecureStorageKeyStore(
        const FlutterSecureStorage(),
      );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}