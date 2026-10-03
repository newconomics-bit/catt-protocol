/// The bounty board (PRD 3.1 "Bounty Board", PRD 6.2 step 1).
///
/// Lists missions from `GET /api/missions`. Three constraints shape this
/// screen:
///
///  * **BIG TARGETS.** Cards are 72dp+ tall with a 56dp action row, because the
///    app targets mid-range Android hardware and a long thumb. The Material
///    minimum of 48dp is treated as a floor, not a goal.
///  * **NO ANSWERS ON THE BOARD.** The board response carries no quiz, no
///    `correctIndex` and no prose (see the backend's explicit projection), so
///    there is nothing here to pre-game.
///  * **HONEST AMOUNTS.** Reward and stamina cost come from `BigInt`, formatted
///    by integer arithmetic, so a card can never read 11.999999999999998 CATT.
///
/// [BountyBoardView] takes plain values so it is testable with no provider.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/mission.dart';
import '../state/app_state.dart';

/// Widget keys the board's tests rely on.
class BountyBoardKeys {
  const BountyBoardKeys._();

  /// Card for [missionId].
  static Key card(String missionId) => ValueKey<String>('mission-$missionId');

  /// Start button for [missionId].
  static Key start(String missionId) => ValueKey<String>('start-$missionId');

  /// Wallet button.
  static const Key wallet = ValueKey<String>('board-wallet');

  /// Error text.
  static const Key error = ValueKey<String>('board-error');

  /// Empty-state text.
  static const Key empty = ValueKey<String>('board-empty');
}

/// The board body.
class BountyBoardView extends StatelessWidget {
  /// Creates the board.
  const BountyBoardView({
    super.key,
    required this.missions,
    required this.onStart,
    required this.onRefresh,
    this.isLoading = false,
    this.error,
    this.onOpenWallet,
  });

  /// Missions to show.
  final List<Mission> missions;

  /// Opens [mission].
  final void Function(Mission mission) onStart;

  /// Reloads the board.
  final VoidCallback onRefresh;

  /// Whether the board is loading.
  final bool isLoading;

  /// Last load failure, safe to display.
  final String? error;

  /// Opens the wallet.
  final VoidCallback? onOpenWallet;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bounty board'),
        actions: <Widget>[
          IconButton(
            key: BountyBoardKeys.wallet,
            icon: const Icon(Icons.account_balance_wallet),
            tooltip: 'Wallet',
            onPressed: onOpenWallet,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => onRefresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: <Widget>[
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  error!,
                  key: BountyBoardKeys.error,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
            if (isLoading && missions.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (missions.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 48),
                child: Column(
                  children: <Widget>[
                    const Icon(Icons.inbox_outlined, size: 48),
                    const SizedBox(height: 12),
                    Text(
                      'No missions available right now.',
                      key: BountyBoardKeys.empty,
                      style: theme.textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      height: 56,
                      child: FilledButton.tonal(
                        onPressed: onRefresh,
                        child: const Text('Try again'),
                      ),
                    ),
                  ],
                ),
              )
            else
              for (final mission in missions)
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: _MissionCard(mission: mission, onStart: onStart),
                ),
          ],
        ),
      ),
    );
  }
}

class _MissionCard extends StatelessWidget {
  const _MissionCard({required this.mission, required this.onStart});

  final Mission mission;
  final void Function(Mission mission) onStart;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: BountyBoardKeys.card(mission.id),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                _DifficultyChip(difficulty: mission.difficulty),
                const Spacer(),
                Text(
                  '${mission.reward.formatShort()} CATT',
                  style: theme.textTheme.titleMedium,
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text('Mission ${mission.id}', style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(
              'Costs ${mission.staminaCost.formatShort()} stamina',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 56,
              width: double.infinity,
              child: FilledButton(
                key: BountyBoardKeys.start(mission.id),
                onPressed: () => onStart(mission),
                child: const Text('Start reading'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DifficultyChip extends StatelessWidget {
  const _DifficultyChip({required this.difficulty});

  final Difficulty difficulty;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final Color color = switch (difficulty) {
      Difficulty.easy => theme.colorScheme.primary,
      Difficulty.medium => theme.colorScheme.tertiary,
      Difficulty.hard => theme.colorScheme.error,
      Difficulty.unknown => theme.colorScheme.outline,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        difficulty.wire,
        style: theme.textTheme.labelLarge?.copyWith(color: color),
      ),
    );
  }
}

/// The full board screen, bound to [AppState].
class BountyBoardScreen extends StatefulWidget {
  /// Creates the screen.
  const BountyBoardScreen({super.key});

  @override
  State<BountyBoardScreen> createState() => _BountyBoardScreenState();
}

class _BountyBoardScreenState extends State<BountyBoardScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<AppState>().loadMissions();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    return BountyBoardView(
      missions: state.missions,
      isLoading: state.isLoadingMissions,
      error: state.boardError,
      onRefresh: state.loadMissions,
      onOpenWallet: () => Navigator.of(context).pushNamed('/wallet'),
      onStart: (Mission mission) async {
        final started = await state.startMission(mission);
        if (!context.mounted) return;
        if (started) {
          await Navigator.of(context).pushNamed('/reader');
        } else {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(state.articleError ?? 'Could not open that mission.')),
          );
        }
      },
    );
  }
}