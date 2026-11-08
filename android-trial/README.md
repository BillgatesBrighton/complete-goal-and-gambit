# GOAL$GAMBIT Player App Trial

Native Android player app trial for the GOAL$GAMBIT backend. It is separate from the older Companion app.

## Download on an Android phone

[Download the GOAL$GAMBIT Player App](https://billgatesbrighton.github.io/complete-goal-and-gambit/frontend/downloads/goal-gambit-player-v1.2.1.apk) on the phone, then open the downloaded file to install it.

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

Player App trial version: `1.2.1`

The app contains no administrator desk or privileged administrator operations. Wallet and eFootball sections are read-only in this prototype.
