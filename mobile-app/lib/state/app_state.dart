/// Application state: the single [ChangeNotifier] wiring the whole mining loop.
///
/// WHY ONE NOTIFIER. The loop is strictly sequential — onboard, pick a mission,
/// read, trap, answer, submit, relay, claim — and the screens all render from
/// the same attempt. `provider` + one `ChangeNotifier` is the smallest thing
/// that supports that, and it keeps every piece of logic testable by injecting
/// fakes: no widget is required to assert "a PASS relays and surfaces a tx
/// hash", and no real chain is required to assert "a FAIL relays nothing".
///
/// EVERY EXTERNAL DEPENDENCY IS INJECTED: [ApiClient] (which itself takes an
/// `http.Client`), [WalletService] (which takes a [KeyStore]), [ChainReader] and
/// [TelemetryService] (which takes its clock, scheduler and battery source).
/// Nothing here reaches for a plugin, a socket or a global.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/mission.dart';
import '../models/submit_result.dart';
import '../models/token_amount.dart';
import '../services/api_client.dart';
import '../services/chain_service.dart';
import '../services/session_id.dart';
import '../services/telemetry_service.dart';
import '../services/typing_timer.dart';
import '../services/wallet_service.dart';
import 'reading_session.dart';

/// Topics offered at onboarding. Multi-select chips; purely a UX preference
/// for now, stored on device.
class InterestTopics {
  const InterestTopics._();

  /// The selectable topics.
  static const List<String> all = <String>[
    'Focus science',
    'Memory & learning',
    'Deep work',
    'Behavioural econ',
    'Cryptography',
    'Sustainability',
  ];
}

/// Wires the app together.
class AppState extends ChangeNotifier {
  /// Creates the state.
  AppState({
    required this.api,
    required this.wallet,
    required this.chain,
    required this.telemetry,
    this.battery = const NullBatteryTelemetrySource(),
    SessionIdGenerator? sessionIds,
    TypingTimer? typingTimer,
  })  : sessionIds = sessionIds ?? const SecureSessionIdGenerator(),
        typingTimer = typingTimer ?? TypingTimer();

  /// The Judge HTTP client.
  final ApiClient api;

  /// Local wallet generation and storage.
  final WalletService wallet;

  /// Read-only chain access for the balance.
  final ChainReader chain;

  /// Proof-of-Attention collector. The reader feeds it touches and scrolls.
  final TelemetryService telemetry;

  /// Battery signals for the reader notice and the wallet screen. Degrades to
  /// "no sensor" on platforms that expose none.
  final BatteryTelemetrySource battery;

  /// Source of the per-attempt session id.
  final SessionIdGenerator sessionIds;

  /// Measures real typing time for the free-text answer.
  final TypingTimer typingTimer;

  /* ----------------------------- onboarding ------------------------------ */

  bool _onboarded = false;
  final Set<String> _interests = <String>{};
  String? _address;
  String? _onboardingError;

  /// Whether a wallet exists and onboarding is complete.
  bool get isOnboarded => _onboarded && _address != null;

  /// The reader's public address.
  String? get address => _address;

  /// Short form of the address for display.
  String get shortAddress {
    final value = _address;
    if (value == null || value.length <= 12) return value ?? '—';
    return '${value.substring(0, 6)}…${value.substring(value.length - 4)}';
  }

  /// Selected interest topics.
  Set<String> get interests => Set<String>.unmodifiable(_interests);

  /// Last onboarding failure, already safe to display.
  String? get onboardingError => _onboardingError;

  /// Generates (or loads) the local wallet and completes onboarding.
  Future<void> completeOnboarding() async {
    _onboardingError = null;
    try {
      final local = await wallet.ensureWallet();
      _address = local.address;
      _onboarded = true;
      notifyListeners();
    } catch (_) {
      _onboardingError = 'Could not create a local wallet on this device.';
      notifyListeners();
    }
  }

  /// Toggles an interest topic.
  void toggleInterest(String topic) {
    if (!_interests.remove(topic)) _interests.add(topic);
    notifyListeners();
  }

  /* --------------------------- bounty board ------------------------------ */

  List<Mission> _missions = const <Mission>[];
  bool _loadingMissions = false;
  String? _boardError;

  /// Missions currently on the board.
  List<Mission> get missions => _missions;

  /// Whether the board is loading.
  bool get isLoadingMissions => _loadingMissions;

  /// Last board failure, safe to display.
  String? get boardError => _boardError;

  /// Loads the board from `GET /api/missions`.
  Future<void> loadMissions() async {
    _loadingMissions = true;
    _boardError = null;
    notifyListeners();
    try {
      _missions = await api.fetchMissions();
    } on ApiException catch (error) {
      _boardError = error.message;
    } finally {
      _loadingMissions = false;
      notifyListeners();
    }
  }

  /* -------------------------- reading session --------------------------- */

  ReadingSession? _session;
  bool _loadingArticle = false;
  String? _articleError;

  /// The in-flight attempt, or `null`.
  ReadingSession? get session => _session;

  /// Whether the article is being fetched.
  bool get isLoadingArticle => _loadingArticle;

  /// Last article failure, safe to display.
  String? get articleError => _articleError;

  /// Opens [mission]: generates the session id, registers it, fetches the
  /// per-session layout and starts telemetry.
  ///
  /// The session id is created ONCE here and reused for every subsequent call
  /// (article fetch, telemetry, submit), because the server's shuffle and trap
  /// position are deterministic per session and the Judge grades against that
  /// exact layout.
  Future<bool> startMission(Mission mission) async {
    _loadingArticle = true;
    _articleError = null;
    notifyListeners();
    try {
      final local = await wallet.ensureWallet();
      _address = local.address;
      final sessionId = sessionIds.next();
      // Best-effort: `/api/telemetry` auto-creates the session, so a failure
      // here must not block reading. The attempt is still judged correctly.
      await api.registerSession(
        sessionId: sessionId,
        user: local.address,
        missionId: mission.id,
      );
      final article = await api.fetchArticle(mission.articleId, sessionId);
      _session = ReadingSession(sessionId: sessionId, missionId: mission.id, article: article);
      typingTimer.reset();
      await telemetry.start(sessionId);
      return true;
    } on ApiException catch (error) {
      _articleError = error.message;
      return false;
    } finally {
      _loadingArticle = false;
      notifyListeners();
    }
  }

  /// Records a touch in global coordinates for telemetry.
  void recordTouch(double globalX, double globalY) =>
      telemetry.recordTouch(globalX, globalY);

  /// Records scrolled pixels for telemetry.
  void recordScroll(double delta) => telemetry.recordScroll(delta);

  /// Marks the focus trap as satisfied. The reader's continue button is
  /// disabled until this happens.
  void satisfyTrap() {
    final current = _session;
    if (current == null || current.trapSatisfied) return;
    _session = current.copyWith(trapSatisfied: true);
    notifyListeners();
  }

  /// Answers (or clears) a quiz question.
  void answerQuestion(String questionId, int? optionIndex) {
    final current = _session;
    if (current == null) return;
    _session = current.withAnswer(questionId, optionIndex);
    notifyListeners();
  }

  /// Toggles a sentence in the highlight set.
  void toggleHighlight(String sentence) {
    final current = _session;
    if (current == null) return;
    _session = current.withHighlightToggled(sentence);
    notifyListeners();
  }

  /// Sets the free-text answer.
  void setFreeText(String text) {
    final current = _session;
    if (current == null) return;
    _session = current.copyWith(freeText: text);
    notifyListeners();
  }

  /// Banks the measured typing time into the session.
  void bankTypingTime() {
    final current = _session;
    if (current == null) return;
    _session = current.copyWith(typingMs: typingTimer.elapsedMs);
    notifyListeners();
  }

  /// Whether the trap must be satisfied before the task screen opens.
  bool get canLeaveReader => _session?.trapSatisfied ?? false;

  /// Stops telemetry for the current session, flushing the last window.
  Future<void> endSession() async {
    await telemetry.stop();
  }

  /* --------------------------- submit & relay --------------------------- */

  SubmitResponse? _submitResponse;
  RelayResponse? _relayResponse;
  bool _submitting = false;
  String? _submitError;
  String? _relayNotice;

  /// The Judge's verdict for the last submission.
  SubmitResponse? get submitResponse => _submitResponse;

  /// The relayer's response, when a claim was broadcast.
  RelayResponse? get relayResponse => _relayResponse;

  /// Whether a submission is in flight.
  bool get isSubmitting => _submitting;

  /// Last submission failure, safe to display.
  String? get submitError => _submitError;

  /// A non-fatal note about the relay, e.g. "no relayer deployed".
  String? get relayNotice => _relayNotice;

  /// Submits the attempt and, ONLY on a PASS, relays the signed claim.
  ///
  /// The relay call is made here rather than in the UI so the rule "never relay
  /// a failure" is enforced in one place: a FAIL response has no `claim` and no
  /// `signature`, and this method returns before touching `/api/relay`.
  Future<SubmitResponse?> submitAttempt() async {
    final current = _session;
    final user = _address;
    if (current == null || user == null) {
      _submitError = 'There is no attempt to submit.';
      notifyListeners();
      return null;
    }
    if (!current.trapSatisfied) {
      _submitError = 'Finish the focus trap before submitting.';
      notifyListeners();
      return null;
    }

    _submitting = true;
    _submitError = null;
    _relayNotice = null;
    _relayResponse = null;
    typingTimer.stop();
    final attempt = current.copyWith(typingMs: typingTimer.elapsedMs);
    _session = attempt;
    notifyListeners();

    // Flush the final telemetry window BEFORE the Judge grades, so the
    // session's last samples are part of the verdict rather than arriving
    // after it.
    await telemetry.stop();

    try {
      final response = await api.submit(
        sessionId: attempt.sessionId,
        user: user,
        answers: attempt.wireAnswers,
        highlight: attempt.highlightText,
        typingMs: attempt.typingMs,
        freeText: attempt.freeText,
      );
      _submitResponse = response;
      if (response.isPass) {
        await _relayClaim(response);
      } else {
        _relayNotice = null;
      }
      return response;
    } on ApiException catch (error) {
      _submitError = error.message;
      return null;
    } finally {
      _submitting = false;
      notifyListeners();
    }
  }

  /// Forwards a signed claim to the gasless relayer.
  ///
  /// Graceful degradation: a `RELAY_NOT_CONFIGURED` 503 is a supported
  /// deployment mode, not an error, so it becomes a notice and the PASS still
  /// stands. Anything else surfaces as an error message.
  Future<void> _relayClaim(SubmitResponse response) async {
    final claim = response.claim;
    final signature = response.signature;
    if (claim == null || signature == null) return;
    try {
      _relayResponse = await api.relay(claim, signature);
    } on ApiException catch (error) {
      if (error.code == 'RELAY_NOT_CONFIGURED') {
        _relayNotice = 'Reward signed, but no gasless relayer is available. '
            'The claim is valid for 10 minutes.';
      } else {
        _relayNotice = error.message;
      }
    }
  }

  /// Whether the gasless relayer is deployed, per `GET /api/relay/status`.
  Future<RelayStatusInfo> fetchRelayStatus() => api.fetchRelayStatus();

  /* ------------------------------- wallet ------------------------------- */

  TokenAmount? _balance;
  TokenAmount? _stamina;
  bool _loadingWallet = false;
  String? _walletError;
  int? _batteryPercent;

  /// $CATT balance, or `null` when it could not be read (no RPC, node
  /// unreachable, rate limit). The wallet screen renders `—`.
  TokenAmount? get balance => _balance;

  /// Stamina, or `null` when the backend does not expose it.
  TokenAmount? get stamina => _stamina;

  /// Whether a wallet refresh is in flight.
  bool get isLoadingWallet => _loadingWallet;

  /// Last wallet refresh failure, safe to display.
  String? get walletError => _walletError;

  /// Battery charge 0..100, or `null` when unavailable.
  int? get batteryPercent => _batteryPercent;

  /// Whether this device can supply a battery temperature for telemetry. When
  /// false, the reader says so instead of letting the user be silently failed.
  bool get batteryTemperatureAvailable => battery.hasTemperatureSensor;

  /// Refreshes balance, stamina and battery in one pass.
  Future<void> refreshWallet() async {
    _loadingWallet = true;
    _walletError = null;
    notifyListeners();
    try {
      final local = await wallet.ensureWallet();
      _address = local.address;
      _balance = await chain.balanceOf(local.address);
      _stamina = await api.fetchStamina(local.address);
    } catch (apiError) {
      // Never throw out of a refresh: the wallet screen is informational.
      _walletError = apiError is ApiException
          ? apiError.message
          : 'Could not refresh your wallet right now.';
    } finally {
      _loadingWallet = false;
      notifyListeners();
    }
  }

  /// Reads the battery charge for the wallet screen. Never throws: an
  /// unavailable battery is `null`, which renders as `—`.
  Future<void> refreshBatteryPercent() async {
    _batteryPercent = await battery.levelPercent();
    notifyListeners();
  }

  @override
  void dispose() {
    telemetry.dispose();
    super.dispose();
  }
}