# Jyotish Trader Android

Open this folder in Android Studio. The native WebView activity and packaged interface live in the `app` module.

## Live price behavior

The app subscribes to Binance's public per-symbol ticker WebSocket streams for one-second market updates. It shows a live/reconnecting badge and reconnects automatically. A native Android REST proxy provides the public ticker snapshot fallback to avoid WebView `file://` CORS restrictions. No account key is needed for public prices. The included paper-trading flows remain simulated; no real orders are sent.

## Build

The Gradle wrapper is pinned to Gradle 8.13 for Android Gradle Plugin 8.11.1 compatibility. In Android Studio, sync the project and run `assembleDebug`; or run `gradlew.bat assembleDebug` from this folder. The APK is written to `app/build/outputs/apk/debug/app-debug.apk`. `build-android.ps1` remains available as a manual Android SDK build path and produces `JyotishTrader-debug.apk`.

## Preview

Open `AndroidPreview.html` for a phone-sized preview. The Android emulator on this PC cannot run this x86_64 AVD because hardware virtualization acceleration is unavailable, so the app has not been launched in an emulator here.
