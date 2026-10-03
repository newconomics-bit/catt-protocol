/// Lossless 18-decimal $CATT arithmetic.
///
/// THE ONE RULE: token amounts are never `double`. The backend returns
/// `reward` / `staminaCost` / `nonce` as decimal STRINGS of 18-decimal base
/// units ("12000000000000000000"), and 1e18 exceeds `Number.MAX_SAFE_INTEGER`
/// by more than two orders of magnitude. A `double` round-trip silently turns
/// 12 CATT into 11.999999999999998, which is a wrong amount in a financial
/// field — and on-chain it is a rejected signature. So amounts are [BigInt]
/// from the wire to the widget and back, and the only place a fractional
/// representation exists is inside [TokenAmount.format], which produces a
/// string by integer division and remainder only. `double` never appears.
library;

/// The $CATT token uses 18 decimals, matching the ERC-20 `uint256` on chain.
const int kCattDecimals = 18;

/// A non-negative amount of $CATT in base units.
class TokenAmount implements Comparable<TokenAmount> {
  const TokenAmount(this.baseUnits);

  /// Convenience for zero.
  static final TokenAmount zero = TokenAmount(BigInt.zero);

  /// Raw 18-decimal base units, e.g. 12 CATT is `12 * 10^18`.
  final BigInt baseUnits;

  /// Parses a decimal string of base units exactly.
  ///
  /// Accepts a bare decimal integer ("12000000000000000000"), a signed
  /// integer, or an [int]. Anything else — an empty string, a float literal, a
  /// `null` from a malformed response — yields [TokenAmount.zero] rather than
  /// throwing, because this is called on untrusted JSON off the wire and a
  /// malformed amount must not take the screen down.
  factory TokenAmount.parse(Object? raw) {
    if (raw is BigInt) return TokenAmount(raw < BigInt.zero ? BigInt.zero : raw);
    if (raw is int) return TokenAmount(raw < 0 ? BigInt.zero : BigInt.from(raw));
    if (raw is! String) return TokenAmount.zero;
    final text = raw.trim();
    if (text.isEmpty) return TokenAmount.zero;
    final value = BigInt.tryParse(text);
    if (value == null) return TokenAmount.zero;
    return TokenAmount(value < BigInt.zero ? BigInt.zero : value);
  }

  /// Formats as a human display string with [fractionDigits] decimals.
  ///
  /// Pure integer maths: the fraction is produced by dividing the base units by
  /// 10^decimals and keeping the remainder, then padding. No `toDoubleAsFixed`
  /// anywhere on this path, so 12 CATT formats as exactly "12.000000000000000000"
  /// and never as "11.999999999999998".
  String format({int fractionDigits = 4}) {
    final digits = fractionDigits < 0
        ? 0
        : (fractionDigits > kCattDecimals ? kCattDecimals : fractionDigits);
    final divisor = BigInt.from(10).pow(kCattDecimals);
    final whole = baseUnits ~/ divisor;
    final remainder = baseUnits.remainder(divisor);
    if (digits == 0) return whole.toString();

    // Scaled remainder, truncated to `digits` decimals.
    final scale = BigInt.from(10).pow(kCattDecimals - digits);
    final scaled = remainder ~/ scale;
    if (digits >= kCattDecimals) {
      // Full precision is a faithful rendering of the exact amount, so the
      // trailing zeros stay: "12.000000000000000000" IS the amount.
      return '${whole.toString()}.${scaled.toString().padLeft(digits, '0')}';
    }
    // Display precision: trailing zeros carry no information, so they go, but
    // at least one digit stays so the UI never renders "12.".
    var fraction = scaled.toString().padLeft(digits, '0').replaceFirst(RegExp(r'0+$'), '');
    if (fraction.isEmpty) fraction = '0';
    return '${whole.toString()}.$fraction';
  }

  /// Compact display used on list cards, e.g. "12.0".
  String formatShort() => format(fractionDigits: 1);

  @override
  int compareTo(TokenAmount other) => baseUnits.compareTo(other.baseUnits);

  @override
  bool operator ==(Object other) =>
      other is TokenAmount && other.baseUnits == baseUnits;

  @override
  int get hashCode => baseUnits.hashCode;

  @override
  String toString() => '${format(fractionDigits: 6)} CATT';
}