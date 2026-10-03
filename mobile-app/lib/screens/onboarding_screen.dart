/// Onboarding (PRD 6.1 "User connects wallet, selects interest topics").
///
/// The wallet is generated LOCALLY on first run and its key stored in the
/// Android Keystore. No seed phrase, no cloud backup, no third-party wallet
/// connection: for a learn-to-earn app that only ever needs to RECEIVE gasless
/// $CATT, a locally generated key is the whole requirement, and it keeps the
/// key material on the device.
///
/// [OnboardingView] takes plain values so the whole flow is testable without a
/// plugin or a provider.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// Widget keys the onboarding tests rely on.
class OnboardingKeys {
  const OnboardingKeys._();

  /// The "create wallet and continue" button.
  static const Key continueButton = ValueKey<String>('onboarding-continue');

  /// Chip for [topic].
  static Key chip(String topic) => ValueKey<String>('topic-$topic');

  /// Error text, when onboarding failed.
  static const Key error = ValueKey<String>('onboarding-error');
}

/// The onboarding body.
class OnboardingView extends StatelessWidget {
  /// Creates the view.
  const OnboardingView({
    super.key,
    required this.topics,
    required this.selected,
    required this.onTopicToggled,
    required this.onContinue,
    this.isBusy = false,
    this.error,
  });

  /// The selectable topics.
  final List<String> topics;

  /// Currently selected topics.
  final Set<String> selected;

  /// Toggles a topic.
  final void Function(String topic) onTopicToggled;

  /// Generates the wallet and finishes onboarding.
  final Future<void> Function() onContinue;

  /// Whether the wallet is being created.
  final bool isBusy;

  /// Last failure, safe to display.
  final String? error;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Welcome to CATT')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Text('Yield your attention, harvest your cognition.',
              style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          Text(
            'A wallet is created on this device and kept in your phone’s secure '
            'storage. Your key never leaves it, and this app never asks you to '
            'pay gas.',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: 28),
          Text('What do you want to read about?', style: theme.textTheme.titleSmall),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final topic in topics)
                FilterChip(
                  key: OnboardingKeys.chip(topic),
                  label: Text(topic),
                  selected: selected.contains(topic),
                  onSelected: (_) => onTopicToggled(topic),
                ),
            ],
          ),
          const SizedBox(height: 28),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                error!,
                key: OnboardingKeys.error,
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),
          SizedBox(
            height: 56,
            child: FilledButton(
              key: OnboardingKeys.continueButton,
              onPressed: isBusy ? null : onContinue,
              child: isBusy
                  ? const SizedBox(
                      height: 24,
                      width: 24,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Create wallet and continue'),
            ),
          ),
        ],
      ),
    );
  }
}

/// The full onboarding screen, bound to [AppState].
class OnboardingScreen extends StatelessWidget {
  /// Creates the screen.
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return OnboardingView(
      topics: InterestTopics.all,
      selected: state.interests,
      onTopicToggled: state.toggleInterest,
      error: state.onboardingError,
      onContinue: () async {
        await state.completeOnboarding();
        if (!context.mounted) return;
        Navigator.of(context).pushReplacementNamed('/board');
      },
    );
  }
}