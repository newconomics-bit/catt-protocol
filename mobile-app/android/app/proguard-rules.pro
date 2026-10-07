# CATT Protocol ProGuard/R8 rules for release builds

# Keep Flutter/Dart native entry points
-keep class io.flutter.app.** { *; }
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.util.** { *; }
-keep class io.flutter.view.** { *; }
-keep class io.flutter.embedding.engine.** { *; }
-keep class io.flutter.embedding.android.** { *; }

# Keep web3dart and wallet libraries
-keep class com.hedera.hashgraph.sdk.** { *; }
-keep class io.github.novacrypto.** { *; }
-keep class org.bouncycastle.** { *; }

# Keep flutter_secure_storage platform channel
-keep class com.tekartik.sqflite.** { *; }
-keep class com.cattprotocol.catt_app.** { *; }

# Keep Kotlin serialization if used
-keep class kotlinx.serialization.** { *; }

# Keep network security config
-keep class android.security.net.config.** { *; }

# Prevent obfuscation of JNI method names
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep enum values for serialization
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}