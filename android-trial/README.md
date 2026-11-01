# GOAL$GAMBIT Trial App

Separate native Android prototype. It installs alongside GOAL$GAMBIT Companion and does not replace it.

## Download on an Android phone

[Download the GOAL$GAMBIT Trial APK](https://raw.githubusercontent.com/BillgatesBrighton/complete-goal-and-gambit/main/android-trial/download/goal-gambit-trial.apk) on the phone, then open the downloaded file to install it.

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

Trial version: `0.1.0-trial`

The app contains no administrator desk or privileged administrator operations. Wallet and eFootball sections are read-only in this prototype.
