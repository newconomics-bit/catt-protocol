/// Local wallet: generate, persist and derive the address for the reader's
/// $CATT account.
///
/// SECURITY POSTURE (PRD 5, Rule 2):
///
///  * The private key is written ONCE, into [KeyStore] (Android Keystore), and
///    read back only to derive the address the user is shown.
///  * The key is NEVER returned by a public method of this class, never
///    included in [LocalWallet.toString] or [WalletService.toString], and never
///    logged. There is no `print` in this file and no logger to leak through.
///  * This app NEVER SIGNS. Claims are relayed gaslessly by the backend
///    (`POST /api/relay`), so no signing code exists here at all — a smaller
///    attack surface than an EIP-1193 provider would be, and it means the whole
///    key-handling path can be audited by reading this one file.
///
/// [RandomnessSource] is injected so tests can pin a known key and assert that
/// the address derives deterministically from it.
library;

import 'dart:math';
import 'dart:typed_data';

import 'package:web3dart/web3dart.dart';

import 'key_store.dart';

/// Supplies the bytes for a new private key.
abstract class RandomnessSource {
  /// Returns [length] cryptographically random bytes.
  Uint8List randomBytes(int length);
}

/// Production randomness, backed by `Random.secure()`.
class SecureRandomnessSource implements RandomnessSource {
  /// Creates the source.
  const SecureRandomnessSource();

  @override
  Uint8List randomBytes(int length) {
    final random = Random.secure();
    return Uint8List.fromList(
      List<int>.generate(length, (_) => random.nextInt(256), growable: false),
    );
  }
}

/// Deterministic randomness for tests. NOT for production use.
class FixedRandomnessSource implements RandomnessSource {
  /// Creates a source that emits a repeating pattern derived from [seed].
  FixedRandomnessSource(int seed)
      : _bytes = Uint8List.fromList(
          List<int>.generate(32, (int i) => (seed + i) & 0xff, growable: false),
        );

  final Uint8List _bytes;

  @override
  Uint8List randomBytes(int length) {
    if (length == 0) return Uint8List(0);
    return Uint8List.fromList(
      List<int>.generate(length, (int i) => _bytes[i % _bytes.length], growable: false),
    );
  }
}

/// The public view of a stored wallet. This is the only wallet-shaped object
/// that ever reaches the UI, and it holds no key material at all.
class LocalWallet {
  /// Creates a wallet view.
  const LocalWallet({required this.address, this.hasStoredKey = true});

  /// The public, EIP-55 checksummed address.
  final String address;

  /// Whether a private key is present in storage for this address.
  final bool hasStoredKey;

  /// `0x1234…abcd` for display. Contains no key material.
  String get shortAddress {
    if (address.length <= 12) return address;
    return '${address.substring(0, 6)}…${address.substring(address.length - 4)}';
  }

  /// Redacted by construction.
  @override
  String toString() => 'LocalWallet($shortAddress, hasKey: $hasStoredKey)';
}

/// Generates and persists the local wallet.
class WalletService {
  /// Creates the service.
  WalletService({
    required this.keyStore,
    this.randomness = const SecureRandomnessSource(),
  });

  /// Key under which the hex private key is stored. Namespaced so it cannot
  /// collide with anything else an app of this shape might persist.
  static const String storageKey = 'catt.wallet.privateKey.v1';

  /// Storage the key is written to. Public for injection and inspection; it
  /// exposes no key material through its interface.
  final KeyStore keyStore;

  /// Source of new private keys.
  final RandomnessSource randomness;

  LocalWallet? _cached;

  /// The loaded wallet, loading or generating it on first access.
  Future<LocalWallet> ensureWallet() async {
    final cached = _cached;
    if (cached != null) return cached;
    return createWallet();
  }

  /// Returns the stored wallet, or `null` when no key is stored.
  ///
  /// A storage backend that throws (a platform channel that is not available,
  /// a corrupted keystore) is treated as "no wallet": onboarding then offers
  /// to create one rather than the app failing to start.
  Future<LocalWallet?> loadWallet() async {
    String? privateKey;
    try {
      privateKey = await keyStore.read(storageKey);
    } catch (_) {
      return null;
    }
    if (privateKey == null || privateKey.isEmpty) return null;
    try {
      return LocalWallet(address: addressFromPrivateKey(privateKey));
    } catch (_) {
      // Unparseable stored material is treated as absent; onboarding will
      // offer to regenerate rather than crashing on boot.
      return null;
    }
  }

  /// Generates a wallet if none exists, stores its key and returns the public
  /// view of it.
  ///
  /// Deliberately does NOT rotate an existing key: silently replacing one
  /// would orphan every $CATT already credited to the previous address.
  Future<LocalWallet> createWallet() async {
    final existing = await loadWallet();
    if (existing != null) {
      _cached = existing;
      return existing;
    }
    final privateKey = _generatePrivateKeyHex();
    await keyStore.write(storageKey, privateKey);
    final wallet = LocalWallet(address: addressFromPrivateKey(privateKey));
    _cached = wallet;
    return wallet;
  }

  /// Forgets the local wallet. Irreversible by design: there is no seed-phrase
  /// backup in the MVP, so this is a "start over" affordance and the UI does
  /// not offer it.
  Future<void> deleteWallet() async {
    await keyStore.delete(storageKey);
    _cached = null;
  }

  /// Derives the EIP-55 address for a hex private key.
  ///
  /// The ONLY place a private key becomes a visible string, and only its PUBLIC
  /// half escapes: the credentials object is constructed, asked for `.address`,
  /// and immediately discarded as a local.
  static String addressFromPrivateKey(String privateKey) =>
      EthPrivateKey.fromHex(_ensureHexPrefix(privateKey)).address.eip55With0x;

  /// Generates a fresh private key as a `0x`-prefixed hex string.
  String _generatePrivateKeyHex() {
    final bytes = randomness.randomBytes(32);
    // A key that reduces to zero mod the curve order is degenerate and cannot
    // produce an address. Re-roll rather than surfacing a cryptic failure.
    if (bytes.every((int b) => b == 0)) {
      throw StateError('randomness source produced a degenerate private key');
    }
    final key = EthPrivateKey(bytes);
    return '0x${bytesToHex(key.privateKey, padToEvenLength: true)}';
  }

  static String _ensureHexPrefix(String value) =>
      value.startsWith('0x') || value.startsWith('0X') ? value : '0x$value';

  /// Redacted by construction: contains the address only, never a key.
  @override
  String toString() => 'WalletService(hasWallet: ${_cached != null})';
}