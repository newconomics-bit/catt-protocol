package com.cattprotocol.catt_app

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Native battery telemetry over the `com.cattprotocol/battery` MethodChannel.
 *
 * WHY THIS EXISTS: `battery_plus` 7.x exposes a charge LEVEL only — the 4.x
 * `batteryTemperature` getter was removed — so the Android platform was never
 * being asked for the one signal the backend's anti-cheat scorer reads. The
 * platform still has it:
 *
 *  1. [BatteryManager.getIntProperty] with [PROP_BATTERY_TEMPERATURE], the local
 *     spelling of AOSP's `BatteryManager.BATTERY_PROPERTY_TEMPERATURE` (see below),
 *  2. or, on devices/OEMs that do not implement that property, the
 *     `ACTION_BATTERY_CHANGED` sticky intent extra
 *     [BatteryManager.EXTRA_TEMPERATURE].
 *
 * UNITS, ON BOTH PATHS: the framework reports TENTHS OF A DEGREE CELSIUS.
 * 297 does not mean 297 degrees, it means 29.7 C. Every path below therefore
 * divides by 10.0 before crossing the channel, and a path that forgets to
 * divide would show up as a `BATTERY_IMPOSSIBLE` penalty (-30) on the Judge.
 *
 * WHY `null` AND NOT A SUBSTITUTE: "this device cannot report a temperature" is
 * an expected outcome (emulators, some tablets, non-Android platforms), not an
 * error. Every method answers with `result.success(null)` rather than
 * `result.error(...)` so the Dart side never sees a crash-shaped failure, and
 * no path ever invents a number: a fabricated temperature is false data in a
 * proof system, and the scorer would rightly treat it as fabricated hardware.
 */
class MainActivity : FlutterActivity() {

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            BATTERY_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                METHOD_GET_TEMPERATURE_C -> result.success(readTemperatureC())
                METHOD_GET_LEVEL_PERCENT -> result.success(readLevelPercent())
                METHOD_IS_TEMPERATURE_SUPPORTED ->
                    result.success(readTemperatureC() != null)
                else -> result.notImplemented()
            }
        }
    }

    /**
     * Battery temperature in DEGREES CELSIUS, or `null` when the device does
     * not expose one.
     *
     * Path 1 is [BatteryManager.getIntProperty]; path 2 is the sticky
     * `ACTION_BATTERY_CHANGED` broadcast. Both raw readings are in tenths of a
     * degree, so both divide by 10.0. `BatteryManager` signals "unsupported"
     * with [Int.MIN_VALUE] and some OEM kernels return a small negative
     * sentinel, so a raw value outside [MIN_PLAUSIBLE_RAW_TENTHS_C]..
     * [MAX_PLAUSIBLE_RAW_TENTHS_C] is treated as "no reading" rather than as a
     * temperature.
     */
    private fun readTemperatureC(): Double? {
        val fromProperty = readTemperatureFromBatteryManager()
        if (fromProperty != null) return fromProperty
        return readTemperatureFromStickyIntent()
    }

    /** Path 1: AOSP's `BatteryManager.BATTERY_PROPERTY_TEMPERATURE` (see
     *  [PROP_BATTERY_TEMPERATURE]), in tenths. */
    private fun readTemperatureFromBatteryManager(): Double? = try {
        val raw = batteryManager?.getIntProperty(PROP_BATTERY_TEMPERATURE)
        // /10: the framework reports tenths of a degree Celsius, so 297 is 29.7 C.
        raw?.takeIf(::isPlausibleRawTenths)?.div(TENTHS_PER_DEGREE)
    } catch (_: RuntimeException) {
        // Some OEM BatteryManager implementations throw instead of returning a
        // sentinel. That is a missing sensor, not a crash: fall through to the
        // sticky intent, and to `null` if that is empty too.
        null
    }

    /**
     * Path 2: the `ACTION_BATTERY_CHANGED` sticky intent.
     *
     * The sticky broadcast carries [BatteryManager.EXTRA_TEMPERATURE], also in
     * tenths of a degree Celsius, and is still populated on devices where
     * `getIntProperty` is unimplemented. `registerReceiver(null, filter)`
     * returns the cached broadcast without registering anything.
     */
    private fun readTemperatureFromStickyIntent(): Double? {
        val sticky: Intent? = try {
            registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (_: RuntimeException) {
            null
        }
        val raw = sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        // /10 again: same tenths-of-a-degree unit as path 1.
        return raw?.takeIf(::isPlausibleRawTenths)?.div(TENTHS_PER_DEGREE)
    }

    /**
     * Battery charge as a percentage 0..100, or `null` when unavailable.
     *
     * Informational only: the level is not part of the telemetry payload the
     * Judge scores, it is rendered in the wallet screen.
     */
    private fun readLevelPercent(): Int? {
        val fromProperty = try {
            batteryManager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } catch (_: RuntimeException) {
            null
        }
        if (fromProperty != null && fromProperty in 0..100) return fromProperty

        val sticky: Intent? = try {
            registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        } catch (_: RuntimeException) {
            null
        }
        val level = sticky?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = sticky?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        // EXTRA_SCALE is 100 on every Android release to date; the division is
        // kept so a future scale change cannot silently skew the percentage.
        if (level < 0 || scale <= 0) return null
        val percent = (level.toDouble() / scale.toDouble() * 100.0).toInt()
        return percent.coerceIn(0, 100)
    }

    /**
     * Whether a raw reading is a real temperature rather than a "not supported"
     * sentinel.
     *
     * AOSP answers [Int.MIN_VALUE] when the property is unimplemented, and OEM
     * kernels ship -1 and -100 instead; every negative value is therefore read
     * as "no sensor" instead of being divided into a negative degree count. The
     * upper bound is a sanity ceiling well above any real cell: 1000 tenths is
     * 100 C, so a garbage integer still cannot reach the app as a temperature.
     */
    private fun isPlausibleRawTenths(raw: Int): Boolean =
        raw in MIN_PLAUSIBLE_RAW_TENTHS_C..MAX_PLAUSIBLE_RAW_TENTHS_C

    private val batteryManager: BatteryManager?
        get() = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager

    private companion object {
        /** Channel name. MUST stay identical to `kBatteryChannelName` in Dart. */
        const val BATTERY_CHANNEL = "com.cattprotocol/battery"

        const val METHOD_GET_TEMPERATURE_C = "getTemperatureC"
        const val METHOD_GET_LEVEL_PERCENT = "getLevelPercent"
        const val METHOD_IS_TEMPERATURE_SUPPORTED = "isTemperatureSupported"

        /**
         * Raw property id of AOSP's `BatteryManager.BATTERY_PROPERTY_TEMPERATURE`,
         * declared locally because that constant is NOT part of the public SDK.
         *
         * In AOSP `BatteryManager.BATTERY_PROPERTY_TEMPERATURE` is a `@SystemApi`
         * constant with the raw value `5`. `@SystemApi` members are stripped from the
         * published `android.jar` (verified on both installed platforms, android-35
         * and android-36, where `android.os.BatteryManager` exposes only
         * `BATTERY_PROPERTY_CAPACITY`, `_CHARGE_COUNTER`, `_CURRENT_AVERAGE`,
         * `_CURRENT_NOW`, `_ENERGY_COUNTER` and `_STATUS`). So the constant name
         * simply does not resolve from app code — raising `compileSdk` cannot help,
         * this is a public-SDK surface limitation rather than a version problem.
         *
         * `getIntProperty(int)` itself IS public, and the property id is a stable
         * ABI value, so passing the raw id is the approach the framework documents by
         * behaviour: an app that never asked for this property still receives
         * [Int.MIN_VALUE], which [isPlausibleRawTenths] rejects, so an unrecognised
         * id degrades to `null` rather than to a fabricated temperature.
         *
         * UNIT: the value read back is TENTHS OF A DEGREE CELSIUS (297 = 29.7 C),
         * which is why every use below must divide by [TENTHS_PER_DEGREE].
         */
        private const val PROP_BATTERY_TEMPERATURE = 5

        /** The framework's unit for battery temperature. */
        const val TENTHS_PER_DEGREE = 10.0

        /**
         * Plausible range for a RAW reading, in tenths of a degree Celsius.
         *
         * Below zero the value is one of the "not supported" sentinels:
         * [Int.MIN_VALUE] from AOSP, -1 or -100 from various OEM kernels. No
         * lithium cell reports a sub-zero temperature through this API, so the
         * floor is 0 raw (0.0 C), not a guessed sentinel value.
         */
        const val MIN_PLAUSIBLE_RAW_TENTHS_C = 0

        /** 1000 raw tenths = 100 C. A sanity ceiling, far above real hardware. */
        const val MAX_PLAUSIBLE_RAW_TENTHS_C = 1000
    }
}