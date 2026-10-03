/// Wallet generation, persistence and key-hygiene tests.
///
/// The private key is treated as hostile output: these tests assert that it
/// round-trips through storage, that the address derives from it deterministically,
/// and that it appears in NOTHING the user or a log could ever see.
library;

import 'package:catt_app/services/key_store.dart';
import 'package:catt_app/services/session_id.dart';
import 'package:catt_app/services/wallet_service.dart';
import 'package:flutter_test/flutter_test.dart';

/// The private key used throughout this file. A well-known, publicly published
/// example key taken from the web3 / web3dart documentation, deliberately
/// public: it funds nothing on any network, so it is safe to commit in a test
/// fixture. It is pinned, not randomly generated, so the derived address can
/// be asserted deterministically. Never reuse it where real value or secrecy
/// matters: real keys come from `WalletService` generation and secure storage.
const String kTestPrivateKey =
    '4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';

/// A key store that records every key it was asked for, so a test can assert
/// that nothing was read or written under any other name.
class RecordingKeyStore implements KeyStore {
  RecordingKeyStore([Map<String, String>? seed]) {
    if (seed != null) _values.addAll(seed);
  }

  final Map<String, String> _values = <String, String>{};
  final List<String> reads = <String>[];
  final List<String> writes = <String>[];
  final List<String> deletes = <String>[];

  /// Raw contents, for assertions about the stored key.
  Map<String, String> get contents => Map<String, String>.unmodifiable(_values);

  @override
  Future<String?> read(String key) async {
    reads.add(key);
    return _values[key];
  }

  @override
  Future<void> write(String key, String value) async {
    writes.add(key);
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    deletes.add(key);
    _values.remove(key);
  }
}

/// A key store whose platform channel is missing, as on an unsupported host.
class BrokenKeyStore implements KeyStore {
  @override
  Future<String?> read(String key) async => throw StateError('no channel');

  @override
  Future<void> write(String key, String value) async => throw StateError('no channel');

  @override
  Future<void> delete(String key) async => throw StateError('no channel');
}

void main() {
  group('generation', () {
    test('creates a wallet with a valid, checksummed 20-byte address', () async {
      final store = InMemoryKeyStore();
      final wallet = await WalletService(keyStore: store).createWallet();

      expect(wallet.address, matches(RegExp(r'^0x[0-9a-fA-F]{40}$')));
      expect(wallet.hasStoredKey, isTrue);
      // EIP-55 checksummed, so it is not all-lower or all-upper.
      expect(wallet.address, isNot(wallet.address.toLowerCase()));
      expect(wallet.address, isNot(wallet.address.toUpperCase()));
    });

    test('stores exactly one secret, under one namespaced key', () async {
      final store = RecordingKeyStore();
      await WalletService(keyStore: store).createWallet();

      expect(store.writes, <String>[WalletService.storageKey]);
      expect(store.writes.single, startsWith('catt.wallet.'));
      expect(store.contents.keys, <String>[WalletService.storageKey]);
      expect(store.contents.values.single, startsWith('0x'));
      expect(store.contents.values.single.length, 66, reason: '0x + 32 bytes');
    });

    test('two wallets generated from different randomness differ', () async {
      final a = await WalletService(
        keyStore: InMemoryKeyStore(),
        randomness: FixedRandomnessSource(1),
      ).createWallet();
      final b = await WalletService(
        keyStore: InMemoryKeyStore(),
        randomness: FixedRandomnessSource(200),
      ).createWallet();
      expect(a.address, isNot(b.address));
    });

    test('createWallet does not rotate an existing key', () async {
      final store = RecordingKeyStore();
      final first = await WalletService(keyStore: store).createWallet();
      final keyAfterFirst = store.contents[WalletService.storageKey];
      final second = await WalletService(keyStore: store).createWallet();
      // Rotating would orphan $CATT already credited to the old address.
      expect(second.address, first.address);
      expect(store.contents[WalletService.storageKey], keyAfterFirst);
      expect(store.writes.length, 1, reason: 'the key is written exactly once');
    });
  });

  group('persistence round-trip', () {
    test('the key round-trips through the fake store and the address survives',
        () async {
      final store = InMemoryKeyStore();
      final created = await WalletService(keyStore: store).createWallet();

      // A completely fresh service, as after an app restart.
      final reopened = await WalletService(keyStore: store).loadWallet();
      expect(reopened, isNotNull);
      expect(reopened!.address, created.address);
    });

    test('the address derives deterministically from the stored key', () async {
      final store = InMemoryKeyStore(<String, String>{
        WalletService.storageKey: kTestPrivateKey,
      });
      final service = WalletService(keyStore: store);

      final loaded = await service.loadWallet();
      expect(loaded!.address, isNotEmpty);

      // Same key, three fresh services, one answer.
      final again = await WalletService(keyStore: InMemoryKeyStore()).loadWallet();
      expect(again, isNull, reason: 'a different store has no key at all');

      final derived = WalletService.addressFromPrivateKey(kTestPrivateKey);
      expect(derived, loaded.address);
      expect(derived, WalletService.addressFromPrivateKey(kTestPrivateKey));
      expect(derived, matches(RegExp(r'^0x[0-9a-fA-F]{40}$')));
    });

    test('ensureWallet generates on first run and loads thereafter', () async {
      final store = RecordingKeyStore();
      final service = WalletService(keyStore: store);

      final first = await service.ensureWallet();
      final second = await service.ensureWallet();
      expect(second.address, first.address);
      expect(store.writes.length, 1);
    });

    test('an empty store loads nothing rather than inventing a wallet', () async {
      expect(await WalletService(keyStore: InMemoryKeyStore()).loadWallet(), isNull);
    });

    test('deleting the wallet clears it', () async {
      final store = RecordingKeyStore();
      final service = WalletService(keyStore: store);
      await service.createWallet();
      await service.deleteWallet();
      expect(store.deletes, <String>[WalletService.storageKey]);
      expect(store.contents, isEmpty);
      expect(await service.loadWallet(), isNull);
    });
  });

  group('key material never leaks', () {
    test('no user-facing string from the wallet contains the private key',
        () async {
      final store = InMemoryKeyStore(<String, String>{
        WalletService.storageKey: kTestPrivateKey,
      });
      final service = WalletService(keyStore: store);
      final wallet = (await service.loadWallet())!;

      final userFacing = <String>[
        wallet.address,
        wallet.shortAddress,
        wallet.toString(),
        wallet.hasStoredKey.toString(),
        service.toString(),
      ];
      for (final value in userFacing) {
        expect(value, isNot(contains(kTestPrivateKey)));
        expect(value.toLowerCase(), isNot(contains(kTestPrivateKey.substring(2).toLowerCase())));
      }
    });

    test('the short address reveals only 10 of the 42 characters', () async {
      final store = InMemoryKeyStore(<String, String>{
        WalletService.storageKey: kTestPrivateKey,
      });
      final wallet = (await WalletService(keyStore: store).loadWallet())!;
      expect(wallet.shortAddress, contains('…'));
      expect(wallet.shortAddress.length, 11);
      expect(
        wallet.shortAddress,
        '${wallet.address.substring(0, 6)}…${wallet.address.substring(wallet.address.length - 4)}',
      );
    });

    test('nothing the wallet object renders contains its own key', () async {
      final store = RecordingKeyStore();
      final wallet = await WalletService(keyStore: store).createWallet();
      final keyFragment = store.contents[WalletService.storageKey]!.substring(2, 12);

      // The wallet object exposes no accessor that returns key material: it has
      // an address and a boolean, and both are safe to render.
      expect(wallet.address.length, 42);
      expect(wallet.address, isNot(contains(keyFragment)));
      expect(<String>[wallet.toString(), wallet.shortAddress].join(' '),
          isNot(contains(keyFragment)));
      expect(store.writes.single, WalletService.storageKey,
          reason: 'the key is stored, but it is not exposed');
    });

    test('a throwing key store degrades to "no wallet" instead of crashing',
        () async {
      expect(await WalletService(keyStore: BrokenKeyStore()).loadWallet(), isNull);
    });

    test('unparseable stored material is treated as absent', () async {
      final store = InMemoryKeyStore(<String, String>{
        WalletService.storageKey: 'not-a-key',
      });
      expect(await WalletService(keyStore: store).loadWallet(), isNull);
    });
  });

  group('session ids seed the server layout', () {
    test('the production generator produces distinct 128-bit hex ids', () {
      const generator = SecureSessionIdGenerator();
      final ids = <String>{for (var i = 0; i < 32; i++) generator.next()};
      expect(ids.length, 32, reason: 'ids must not collide');
      for (final id in ids) {
        expect(id, matches(RegExp(r'^[0-9a-f]{32}$')));
      }
    });

    test('the test generator is deterministic', () {
      final generator = CountingSessionIdGenerator();
      expect(generator.next(), 'sess-1');
      expect(generator.next(), 'sess-2');
    });
  });
}