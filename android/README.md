# GOAL$GAMBIT Android Companion

The companion is a native Android app for Firebase match notifications and
room-code replies from the notification shade. Gameplay stays on the website.

## Build

From this directory, run `gradlew.bat assembleDebug` for a local test APK or
`gradlew.bat assembleRelease` for the signed release APK.

The release signing key and its local properties file are stored under
`%APPDATA%\GOAL$GAMBIT\` and are intentionally excluded from Git. Keep both
`android-release.jks` and `release-signing.properties` backed up securely. The
same key is required to publish updates that install over this release.

The website's current companion download is
`../frontend/downloads/goal-gambit-companion.apk`.
