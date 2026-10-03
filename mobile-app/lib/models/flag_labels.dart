/// Human-readable text for the Judge's stable failure codes.
///
/// Every code here comes from `backend-server/src/anticheat.js` (`FLAGS` and
/// `SUBMISSION_FLAGS`) or from the Judge's own `JUDGE_FLAGS`. The mapping is
/// exhaustive over those lists and falls back to the raw code for anything
/// added later, so an unknown flag is visible rather than silently dropped.
library;

/// Explains a failure code in one reader-facing sentence.
String describeFlag(String flag) {
  switch (flag) {
    /* --- telemetry (hardware truth) --- */
    case 'BATTERY_FLATLINE':
      return 'Battery temperature never moved. Real hardware drifts, so a '
          'perfectly steady reading does not look like a phone.';
    case 'BATTERY_IMPOSSIBLE':
      return 'Battery temperature was missing or outside a plausible range '
          '(10–60°C). This device cannot supply that reading.';
    case 'PIXEL_PERFECT_TOUCH':
      return 'The same screen coordinate was tapped more than once.';
    case 'INHUMAN_SCROLL_SPEED':
      return 'The page scrolled faster than a human can flick it.';
    case 'TOO_FEW_SAMPLES':
      return 'The session was too short to judge. Read for longer.';
    case 'TELEMETRY_UNACCEPTABLE':
      return 'Hardware telemetry did not clear the bar.';
    case 'TELEMETRY_UNUSABLE':
      return 'Telemetry could not be scored.';

    /* --- submission (comprehension) --- */
    case 'QUIZ_INCORRECT':
      return 'At least one quiz answer was wrong or missing.';
    case 'HIGHLIGHT_MISSING':
      return 'The highlight task was not satisfied.';
    case 'TYPING_TOO_FAST':
      return 'The free-text answer was typed faster than a person could.';
    case 'TELEMETRY_POOR':
      return 'The telemetry score was too low.';
    case 'SUBMISSION_MALFORMED':
      return 'The submission payload was incomplete.';

    /* --- judge (cross-user) --- */
    case 'SYNDICATE_MATCH':
      return 'This free-text answer closely matches another account’s.';
    default:
      return flag;
  }
}