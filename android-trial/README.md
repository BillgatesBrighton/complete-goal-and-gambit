# GOAL$GAMBIT Player App Trial

Native Android player app for the GOAL$GAMBIT backend. It includes player accounts, chess, eFootball, tournaments, leagues, wallet, rankings, notifications, support, and direct player chat. The app contains no administrator desk or privileged administrator operations.

Online chess remains server-authoritative. The Player App also runs the native chess position verifier used by the Companion project and reports mismatches for server resynchronization. The web chessboard and server remain authoritative for legal moves and results.

The Player App source includes account-level notification preferences, Firebase background-alert handling, and notification-shade eFootball room-code reply/receipt actions. Firebase delivery is activated only when `app/google-services.json` contains a Firebase Android app registration for `com.goalgambit.trial`. The existing configuration in the separate Companion project is registered for `com.goalgambit.companion` and cannot be reused for this package. Until the matching configuration is added and a new APK is built, the published APK continues to use its existing in-app notification behavior.

Public How It Works, Terms, and Privacy pages are available from Player Services inside the app. Admin pages and administrator operations remain intentionally excluded.

## Download on an Android phone

[Download the GOAL$GAMBIT Player App](https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-player-v1.3.2.apk) on the phone, then open the downloaded file to install it.

## Build and install

Use Android Studio's bundled JDK 17 and an installed Android SDK. From this directory, build and run the focused unit checks with:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\gradlew.bat assembleDebug
.\gradlew.bat testDebugUnitTest
```

Install it on a connected Android device with:

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
```

Application ID: `com.goalgambit.trial`

Player App version: `1.3.2`
