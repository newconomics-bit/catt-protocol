/// Read-only on-chain access: the $CATT `balanceOf` of the reader's address.
///
/// SCOPE, DELIBERATELY NARROW. This app NEVER SIGNS AND NEVER SENDS A
/// TRANSACTION. Claims are relayed gaslessly by the backend
/// (`POST /api/relay`), so there is no signing key on this path, no gas
/// management, and no transaction builder to get wrong. The only chain call is
/// a `view` function returning a `uint256`.
///
/// GRACEFUL DEGRADATION IS A FEATURE HERE. With no RPC configured (the default
/// for a dev build) or no token address, the reader shows `—` rather than a
/// crash: an unreachable RPC must never be able to block onboarding or the
/// wallet screen.
library;

import 'dart:async';

import 'package:http/http.dart' as http;
import 'package:wallet/wallet.dart' show EthereumAddress;
import 'package:web3dart/web3dart.dart';

import '../config.dart';
import '../models/token_amount.dart';

/// Minimal ABI slice for ERC-20 `balanceOf`.
const String _balanceOfAbi = '[{"constant":true,"inputs":[{"name":"owner",'
    '"type":"address"}],"name":"balanceOf","outputs":[{"name":"",'
    '"type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"}]';

/// Reads a token balance for an address.
abstract class ChainReader {
  /// Balance in 18-decimal base units, or `null` when it could not be read.
  Future<TokenAmount?> balanceOf(String address);
}

/// Always reports "unknown". Used when no RPC is configured, and by tests.
class UnconfiguredChainReader implements ChainReader {
  /// Creates the reader.
  const UnconfiguredChainReader();

  @override
  Future<TokenAmount?> balanceOf(String address) async => null;
}

/// `web3dart`-backed reader. Read-only; see the file header for why.
class Web3ChainReader implements ChainReader {
  /// Creates the reader. Returns null-safe behaviour for every failure path.
  Web3ChainReader({required this.config, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  /// Configuration snapshot; supplies the RPC URL and token address.
  final AppConfig config;

  final http.Client _http;

  bool get isConfigured => config.isRpcConfigured;

  @override
  Future<TokenAmount?> balanceOf(String address) async {
    if (!isConfigured) return null;
    Web3Client? client;
    try {
      client = Web3Client(config.rpcUrl, _http);
      final deployed = DeployedContract(
        ContractAbi.fromJson(_balanceOfAbi, 'CATT'),
        EthereumAddress.fromHex(config.cattTokenAddress),
      );
      final decoded = await client.call(
        contract: deployed,
        function: deployed.function('balanceOf'),
        params: <dynamic>[address],
      ).timeout(const Duration(seconds: 12));
      if (decoded.isEmpty) return null;
      final raw = decoded.first;
      if (raw is BigInt) return TokenAmount(raw);
      if (raw is int) return TokenAmount(BigInt.from(raw));
      return null;
    } catch (_) {
      // Wrong network, wrong address, rate limit, unreachable node, a
      // decode error: all of them mean "we cannot show a balance", and the
      // wallet screen is built to render that state.
      return null;
    } finally {
      // `dispose` tears down the JSON-RPC plumbing; awaited so the reader's
      // socket is released before the screen is dismissed.
      await client?.dispose();
    }
  }
}