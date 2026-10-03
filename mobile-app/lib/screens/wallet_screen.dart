/// The wallet screen (PRD 6.1 "Onboarding", 6.3 "Staking Loop" entry point).
///
/// Shows the reader's address, their $CATT balance, and their stamina.
///
/// EVERY FIELD DEGRADES TO `—` RATHER THAN CRASHING, and that is a design
/// requirement, not laziness:
///  * no RPC configured (the default for a dev build) → balance `—`;
///  * RPC unreachable, rate-limited or wrong network → balance `—`;
///  * the MVP backend exposes no stamina route → stamina `—`;
///  * battery plugin unavailable → battery `—`.
/// A learn-to-earn app that white-screens because a public RPC is down has
/// already lost the user, and the balance is informational — it is never a
/// precondition for reading or claiming.
///
/// [WalletView] takes plain values so every degraded state is testable.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../models/token_amount.dart';
import '../state/app_state.dart';

/// Widget keys the wallet screen's tests rely on.
class WalletKeys {
  const WalletKeys._();

  /// The address field.
  static const Key address = ValueKey<String>('wallet-address');

  /// The balance field.
  static const Key balance = ValueKey<String>('wallet-balance');

  /// The stamina field.
  static const Key stamina = ValueKey<String>('wallet-stamina');

  /// The battery field.
  static const Key battery = ValueKey<String>('wallet-battery');

  /// Refresh action.
  static const Key refresh = ValueKey<String>('wallet-refresh');
}

/// Placeholder for any value that could not be read.
const String kUnavailable = '—';

/// Renders the wallet.
class WalletView extends StatelessWidget {
  /// Creates the view.
  const WalletView({
    super.key,
    required this.address,
    this.balance,
    this.stamina,
    this.batteryPercent,
    this.isLoading = false,
    this.error,
    this.onRefresh,
    this.networkName = 'Polygon',
    this.relayConfigured,
  });

  /// The reader's public address, or `null` when there is no wallet yet.
  final String? address;

  /// $CATT balance, or `null` when unavailable.
  final TokenAmount? balance;

  /// Stamina, or `null` when the backend does not expose it.
  final TokenAmount? stamina;

  /// Battery charge 0..100, or `null`.
  final int? batteryPercent;

  /// Whether a refresh is in flight.
  final bool isLoading;

  /// Last refresh failure, safe to display.
  final String? error;

  /// Called to refresh.
  final VoidCallback? onRefresh;

  /// Chain name for display.
  final String networkName;

  /// Whether the gasless relayer is deployed; `null` when unknown.
  final bool? relayConfigured;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final walletAddress = address;
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          if (walletAddress == null)
            const Text('No wallet yet. Finish onboarding to create one.')
          else ...<Widget>[
            Text('Your address', style: theme.textTheme.bodyMedium),
            const SizedBox(height: 4),
            InkWell(
              key: WalletKeys.address,
              onTap: () => Clipboard.setData(ClipboardData(text: walletAddress)),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  walletAddress,
                  style: theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace'),
                ),
              ),
            ),
            Text('Tap to copy', style: theme.textTheme.bodySmall),
          ],
          const SizedBox(height: 24),
          _Field(
            label: '\$networkName \$CATT balance',
            value: balance?.format(fractionDigits: 4),
            fieldKey: WalletKeys.balance,
          ),
          const SizedBox(height: 16),
          _Field(
            label: 'Stamina',
            value: stamina?.format(fractionDigits: 4),
            fieldKey: WalletKeys.stamina,
          ),
          const SizedBox(height: 16),
          _Field(
            label: 'Battery',
            value: batteryPercent == null ? null : '$batteryPercent%',
            fieldKey: WalletKeys.battery,
          ),
          if (relayConfigured != null) ...<Widget>[
            const SizedBox(height: 16),
            _Field(
              label: 'Gasless claims',
              value: relayConfigured! ? 'Available' : 'No relayer deployed',
            ),
          ],
          const SizedBox(height: 24),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(error!, style: TextStyle(color: theme.colorScheme.error)),
            ),
          SizedBox(
            height: 56,
            child: FilledButton.tonal(
              key: WalletKeys.refresh,
              onPressed: isLoading ? null : onRefresh,
              child: isLoading
                  ? const SizedBox(
                      height: 24,
                      width: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Refresh'),
            ),
          ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value, this.fieldKey});

  final String label;
  final String? value;
  final Key? fieldKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(label, style: theme.textTheme.bodyMedium),
        const SizedBox(height: 4),
        Text(
          // The graceful-degradation placeholder, in one place.
          value ?? kUnavailable,
          key: fieldKey,
          style: theme.textTheme.headlineSmall,
        ),
      ],
    );
  }
}

/// The full wallet screen, bound to [AppState].
class WalletScreen extends StatefulWidget {
  /// Creates the screen.
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  bool? _relayConfigured;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final state = context.read<AppState>();
    await state.refreshWallet();
    await state.refreshBatteryPercent();
    if (!mounted) return;
    // `configured: false` is a supported deployment mode, so this is a
    // display value rather than an error path.
    final status = await state.fetchRelayStatus();
    if (!mounted) return;
    setState(() => _relayConfigured = status.configured);
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return WalletView(
      address: state.address,
      balance: state.balance,
      stamina: state.stamina,
      batteryPercent: state.batteryPercent,
      isLoading: state.isLoadingWallet,
      error: state.walletError,
      relayConfigured: _relayConfigured,
      onRefresh: _load,
    );
  }
}