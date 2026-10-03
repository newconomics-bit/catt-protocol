/// The verdict screen (PRD 6.2 "Mining Loop", step 5).
///
/// PASS: reward, the relayed transaction hash, and the stamina charged.
/// FAIL: every reason the Judge gave, in plain language, plus the stamina that
/// was charged — because stamina is charged on BOTH outcomes, and hiding that
/// on a failure is the kind of thing that makes a protocol feel dishonest.
///
/// [ResultView] takes plain values rather than [AppState] so both branches are
/// testable with no provider and no network.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../models/flag_labels.dart';
import '../models/submit_result.dart';
import '../models/token_amount.dart';
import '../state/app_state.dart';

/// Widget keys the result screen's tests rely on.
class ResultKeys {
  const ResultKeys._();

  /// Headline ("Reward claimed" / "Attempt failed").
  static const Key verdict = ValueKey<String>('result-verdict');

  /// The reward amount.
  static const Key reward = ValueKey<String>('result-reward');

  /// The relayed transaction hash, when there is one.
  static const Key txHash = ValueKey<String>('result-tx-hash');

  /// The stamina charged.
  static const Key stamina = ValueKey<String>('result-stamina');

  /// The failure reasons list, when there is one.
  static const Key reasons = ValueKey<String>('result-reasons');
}

/// Renders one verdict.
class ResultView extends StatelessWidget {
  /// Creates the view.
  const ResultView({
    super.key,
    required this.response,
    this.relay,
    this.relayNotice,
    this.onDone,
  });

  /// The verdict. `null` means the request never reached the Judge.
  final SubmitResponse? response;

  /// The relayed claim, when the reward was broadcast.
  final RelayResponse? relay;

  /// A non-fatal note about the relay.
  final String? relayNotice;

  /// Called when the reader is done.
  final VoidCallback? onDone;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final verdict = response;
    if (verdict == null) {
      return _Shell(
        verdictKey: ResultKeys.verdict,
        headline: 'No verdict yet',
        icon: Icons.cloud_off,
        color: theme.colorScheme.error,
        children: <Widget>[
          Text(
            relayNotice ?? 'The Judge could not be reached, so this attempt '
                'was not judged and no stamina was charged.',
            style: theme.textTheme.bodyLarge,
          ),
          const SizedBox(height: 16),
          _DoneButton(onDone: onDone, label: 'Back to the board'),
        ],
      );
    }

    if (verdict.isPass) return _buildPass(context, theme, verdict);
    return _buildFail(context, theme, verdict);
  }

  Widget _buildPass(BuildContext context, ThemeData theme, SubmitResponse verdict) {
    final claim = verdict.claim!;
    final txHash = relay?.txHash;
    return _Shell(
      verdictKey: ResultKeys.verdict,
      headline: 'Reward claimed',
      icon: Icons.verified,
      color: theme.colorScheme.primary,
      children: <Widget>[
        Text(
          'You earned',
          style: theme.textTheme.bodyMedium,
        ),
        const SizedBox(height: 4),
        Text(
          // Exact BigInt arithmetic all the way to the string.
          '${claim.reward.format(fractionDigits: 4)} CATT',
          key: ResultKeys.reward,
          style: theme.textTheme.headlineMedium,
        ),
        const SizedBox(height: 16),
        if (txHash != null && txHash.isNotEmpty) ...<Widget>[
          Text('Transaction', style: theme.textTheme.bodyMedium),
          const SizedBox(height: 4),
          InkWell(
            key: ResultKeys.txHash,
            onTap: () => Clipboard.setData(ClipboardData(text: txHash)),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                txHash,
                style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
              ),
            ),
          ),
          Text('Tap to copy', style: theme.textTheme.bodySmall),
        ] else
          Text(
            relayNotice ??
                'Reward signed. It is not on chain yet — no relayer answered.',
            style: theme.textTheme.bodyMedium,
          ),
        const SizedBox(height: 16),
        _StaminaLine(charged: claim.staminaCost),
        const SizedBox(height: 24),
        _DoneButton(onDone: onDone, label: 'Back to the board'),
      ],
    );
  }

  Widget _buildFail(BuildContext context, ThemeData theme, SubmitResponse verdict) {
    final reasons = verdict.failureReasons;
    return _Shell(
      verdictKey: ResultKeys.verdict,
      headline: 'Attempt failed',
      icon: Icons.gpp_bad,
      color: theme.colorScheme.error,
      children: <Widget>[
        Container(
          key: ResultKeys.reasons,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: theme.colorScheme.errorContainer,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              for (final flag in reasons)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    '• ${describeFlag(flag)}',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Text(
          'Telemetry score: ${verdict.telemetry.score.round()}/100'
          '${verdict.telemetry.flags.isEmpty ? '' : ' · ${verdict.telemetry.flags.join(', ')}'}',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 12),
        _StaminaLine(charged: verdict.result.staminaCost),
        const SizedBox(height: 24),
        _DoneButton(onDone: onDone, label: 'Back to the board'),
      ],
    );
  }
}

class _StaminaLine extends StatelessWidget {
  const _StaminaLine({required this.charged});

  final TokenAmount charged;

  @override
  Widget build(BuildContext context) => Row(
        children: <Widget>[
          const Icon(Icons.bolt),
          const SizedBox(width: 8),
          Text(
            // `charged` is a TokenAmount; formatting happens on it, never via double.
            'Stamina charged: ${charged.format(fractionDigits: 4)}',
            key: ResultKeys.stamina,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      );
}

class _DoneButton extends StatelessWidget {
  const _DoneButton({required this.onDone, required this.label});

  final VoidCallback? onDone;
  final String label;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 56,
        width: double.infinity,
        child: FilledButton(onPressed: onDone, child: Text(label)),
      );
}

class _Shell extends StatelessWidget {
  const _Shell({
    required this.headline,
    required this.icon,
    required this.color,
    required this.children,
    required this.verdictKey,
  });

  final String headline;
  final IconData icon;
  final Color color;
  final List<Widget> children;
  final Key verdictKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Result')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(icon, color: color, size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  headline,
                  key: verdictKey,
                  style: theme.textTheme.headlineSmall,
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          ...children,
        ],
      ),
    );
  }
}

/// The full result screen, bound to [AppState].
class ResultScreen extends StatelessWidget {
  /// Creates the screen.
  const ResultScreen({super.key, this.response});

  /// Verdict passed by the route; falls back to the state's last verdict.
  final SubmitResponse? response;

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return ResultView(
      response: response ?? state.submitResponse,
      relay: state.relayResponse,
      relayNotice: state.relayNotice,
      onDone: () => Navigator.of(context).pushNamedAndRemoveUntil('/board', (_) => false),
    );
  }
}