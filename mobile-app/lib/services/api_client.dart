/// HTTP client for the backend Judge.
///
/// EVERY external interaction in the app goes through this class, and it takes
/// an injected [http.Client] — so the entire network surface is testable with
/// `package:http/testing.dart`'s `MockClient` and no sockets, no server and no
/// device.
///
/// Error handling is uniform: a non-2xx response (or a transport failure) is
/// raised as [ApiException] carrying the backend's stable error code, never as
/// a raw exception, so every screen has one thing to catch and one message to
/// show. The backend only ever emits `{ "error": "<CODE>" }` and never echoes
/// internals, so nothing sensitive can leak through here either.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import '../models/article.dart';
import '../models/mission.dart';
import '../models/submit_result.dart';
import '../models/telemetry_sample.dart';
import '../models/token_amount.dart';

/// A failed call to the Judge.
class ApiException implements Exception {
  /// Creates an exception.
  const ApiException(this.message, {this.statusCode, this.code});

  /// Human-readable, already-safe message for display.
  final String message;

  /// HTTP status, when the failure was an HTTP response.
  final int? statusCode;

  /// The backend's stable error code, e.g. `ARTICLE_NOT_FOUND`.
  final String? code;

  /// True when retrying might succeed (network drop, timeout, 5xx).
  bool get isRetryable =>
      statusCode == null || (statusCode != null && statusCode! >= 500);

  @override
  String toString() => 'ApiException($code, status: $statusCode): $message';
}

/// Talks to the backend Judge.
class ApiClient {
  /// Creates a client over [httpClient].
  ApiClient({
    required this.config,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 15),
  })  : _http = httpClient ?? http.Client(),
        _ownsClient = httpClient == null;

  /// Shorthand for the compiled-in configuration.
  factory ApiClient.withDefaults({http.Client? httpClient}) =>
      ApiClient(config: AppConfig.fromEnvironment, httpClient: httpClient);

  /// Configuration snapshot; the backend base URL comes from here.
  final AppConfig config;

  /// Request timeout.
  final Duration timeout;

  final http.Client _http;
  final bool _ownsClient;

  /// Base URL in use (public, from config).
  String get baseUrl => config.backendBaseUrl;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${config.backendBaseUrl}$path').replace(
        queryParameters: (query == null || query.isEmpty) ? null : query,
      );

  /// GET `/api/missions` — the bounty board.
  ///
  /// A non-list body yields an empty list rather than an exception: the board
  /// shows an empty state, which is a normal condition, not a crash.
  Future<List<Mission>> fetchMissions() async {
    final body = await _getJson('/api/missions');
    return Mission.listFromJson(body);
  }

  /// GET `/api/article/:id?session=…` — the randomized reading layout.
  ///
  /// [sessionId] is MANDATORY and must be stable for the whole reading
  /// session: the server derives both the paragraph shuffle and the trap
  /// position from it, and the Judge grades the submitted highlight against
  /// that exact layout.
  Future<ArticleLayout> fetchArticle(String articleId, String sessionId) async {
    if (sessionId.trim().isEmpty) {
      throw const ApiException('A session id is required to open an article.');
    }
    final body = await _getJson('/api/article/${Uri.encodeComponent(articleId)}',
        <String, String>{'session': sessionId});
    if (body is! Map<String, dynamic>) {
      throw const ApiException('The Judge returned a malformed article.');
    }
    return ArticleLayout.fromJson(body);
  }

  /// POST `/api/session` — attribute telemetry to this wallet + mission.
  ///
  /// Best-effort: `/api/telemetry` auto-creates the session, so a failure here
  /// is reported but does not block the reader. Returns `false` when the call
  /// failed for any reason.
  Future<bool> registerSession({
    required String sessionId,
    required String user,
    required String missionId,
  }) async {
    try {
      await _postJson('/api/session', <String, dynamic>{
        'sessionId': sessionId,
        'user': user,
        'missionId': missionId,
      });
      return true;
    } on ApiException {
      return false;
    }
  }

  /// POST `/api/telemetry` — one batch of Proof-of-Attention samples.
  ///
  /// Returns the number of samples the server accepted in THIS batch; the
  /// server also reports its running `total`, which is what a client compares
  /// against to detect a dropped batch.
  Future<int> postTelemetry({
    required String sessionId,
    required List<TelemetrySample> samples,
  }) async {
    if (samples.isEmpty) return 0;
    final body = await _postJson('/api/telemetry', <String, dynamic>{
      'sessionId': sessionId,
      'samples': samples.map((TelemetrySample s) => s.toJson()).toList(growable: false),
    });
    if (body is! Map<String, dynamic>) return 0;
    final accepted = body['accepted'];
    return accepted is num ? accepted.toInt() : 0;
  }

  /// GET `/api/session/:id/telemetry` — the server's live view of a session.
  Future<SessionTelemetrySummary> fetchSessionTelemetry(String sessionId) async {
    final body = await _getJson('/api/session/${Uri.encodeComponent(sessionId)}/telemetry');
    if (body is! Map<String, dynamic>) {
      throw const ApiException('The Judge returned malformed telemetry.');
    }
    return SessionTelemetrySummary.fromJson(body);
  }

  /// POST `/api/submit` — the Judge.
  ///
  /// [answers] maps question ids to option indices, [highlight] is the joined
  /// text the reader claims to have highlighted, [typingMs] is the measured
  /// typing time and [freeText] is the optional free-text answer.
  Future<SubmitResponse> submit({
    required String sessionId,
    required String user,
    required List<QuizAnswer> answers,
    required String highlight,
    required int typingMs,
    String? freeText,
  }) async {
    final body = await _postJson('/api/submit', <String, dynamic>{
      'sessionId': sessionId,
      'user': user,
      'answers': answers.map((QuizAnswer a) => a.toJson()).toList(growable: false),
      'highlight': highlight,
      'typingMs': typingMs,
      'freeText': freeText ?? '',
    });
    if (body is! Map<String, dynamic>) {
      throw const ApiException('The Judge returned a malformed verdict.');
    }
    return SubmitResponse.fromJson(body);
  }

  /// GET `/api/relay/status` — is a gasless relayer deployed?
  ///
  /// `configured: false` is a supported mode, not an error, so a failure here
  /// degrades to `configured: false` rather than throwing.
  Future<RelayStatusInfo> fetchRelayStatus() async {
    try {
      final body = await _getJson('/api/relay/status');
      if (body is! Map<String, dynamic>) {
        return const RelayStatusInfo(configured: false, relayer: null);
      }
      return RelayStatusInfo.fromJson(body);
    } on ApiException {
      return const RelayStatusInfo(configured: false, relayer: null);
    }
  }

  /// POST `/api/relay` — broadcast a signed claim gaslessly.
  ///
  /// Only ever called with a claim from a PASS response; a FAIL response has no
  /// claim to send. The app signs nothing and holds no gas.
  Future<RelayResponse> relay(MiningClaim claim, String signature) async {
    final body = await _postJson('/api/relay', claim.toRelayPayload(signature));
    if (body is! Map<String, dynamic>) {
      throw const ApiException('The relayer returned a malformed response.');
    }
    return RelayResponse.fromJson(body);
  }

  /// GET `/api/user/:address/stamina` — best effort, and OPTIONAL by design.
  ///
  /// The MVP backend contract has no stamina route (stamina is charged by the
  /// Judge and read from chain), so this is expected to 404. A 404/501 is
  /// mapped to `null` — the wallet screen shows `—` — and every other failure
  /// is mapped to `null` too. Stamina is never invented.
  Future<TokenAmount?> fetchStamina(String address) async {
    try {
      final body = await _getJson('/api/user/${Uri.encodeComponent(address)}/stamina');
      if (body is! Map<String, dynamic>) return null;
      final raw = body['stamina'] ?? body['value'];
      if (raw == null) return null;
      return TokenAmount.parse(raw);
    } on ApiException {
      return null;
    }
  }

  Future<Object?> _getJson(String path, [Map<String, String>? query]) async {
    final uri = _uri(path, query);
    http.Response response;
    try {
      response = await _http.get(uri).timeout(timeout);
    } on TimeoutException {
      throw const ApiException('The Judge did not respond in time.');
    } catch (_) {
      throw const ApiException('Could not reach the Judge. Check your connection.');
    }
    return _decode(response);
  }

  Future<Object?> _postJson(String path, Map<String, dynamic> body) async {
    final uri = _uri(path);
    http.Response response;
    try {
      response = await _http
          .post(
            uri,
            headers: const <String, String>{'content-type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(timeout);
    } on TimeoutException {
      throw const ApiException('The Judge did not respond in time.');
    } catch (_) {
      throw const ApiException('Could not reach the Judge. Check your connection.');
    }
    return _decode(response);
  }

  Object? _decode(http.Response response) {
    final status = response.statusCode;
    Object? decoded;
    try {
      decoded = response.body.trim().isEmpty ? null : jsonDecode(response.body);
    } catch (_) {
      decoded = null;
    }
    if (status >= 200 && status < 300) return decoded;

    final code = decoded is Map<String, dynamic> ? decoded['error']?.toString() : null;
    throw ApiException(
      _messageFor(code) ?? 'The Judge rejected the request ($status).',
      statusCode: status,
      code: code,
    );
  }

  /// Friendly text for the backend's stable error codes.
  ///
  /// Only codes this client can actually act on are mapped; anything else falls
  /// through to a generic message, so a new backend code cannot leak raw server
  /// text into the UI.
  static String? _messageFor(String? code) {
    switch (code) {
      case 'SESSION_REQUIRED':
        return 'This reading session expired. Reopen the mission to continue.';
      case 'ARTICLE_NOT_FOUND':
        return 'That article is no longer available.';
      case 'SESSION_NOT_FOUND':
      case 'SESSION_CONFLICT':
        return 'This reading session is no longer valid. Reopen the mission.';
      case 'MISSION_NOT_FOUND':
      case 'ARTICLE_MISSING':
        return 'This mission is not available right now.';
      case 'INVALID_TELEMETRY':
        return 'Telemetry could not be recorded for this session.';
      case 'INVALID_SUBMISSION':
        return 'The submission was incomplete.';
      case 'RELAY_NOT_CONFIGURED':
        return 'No gasless relayer is available for this claim.';
      case 'RELAY_CLAIM_EXPIRED':
        return 'This claim expired before it could be relayed. Re-mine the article.';
      case 'RELAY_ALREADY_RELAYED':
        return 'This claim was already relayed.';
      case 'RELAY_SIGNATURE_INVALID':
      case 'INVALID_CLAIM':
        return 'The claim could not be relayed.';
      default:
        return null;
    }
  }

  /// Releases the underlying socket pool when this client created it.
  ///
  /// Deliberately silent on failure: closing is best-effort cleanup.
  void close() {
    if (_ownsClient) _http.close();
  }
}