# Companion Android release checklist

For project maintainers. This file is separate from the player welcome guide.

1. Keep the release keystore and `release-signing.properties` outside the Git repository. The Android Gradle build reads the signing configuration from `%APPDATA%\GOAL$GAMBIT\release-signing.properties`.
2. Before each release, increment `versionCode` and update `versionName` in `android/app/build.gradle.kts`.
3. Build a signed release from the `android` directory with `gradlew.bat assembleRelease` using Android Studio's bundled JDK and the installed Android SDK.
4. Verify the generated APK with Android SDK Build Tools: `apksigner verify --verbose --print-certs app-release.apk`. The current release certificate SHA-256 fingerprint is `46bb6c4cfced785c9ad3382ffc141a833ce67121ce3417a8a87707eb60f7283a`. Stop if the fingerprint changes unexpectedly; Android will not install an update signed by a different key over the existing app.
5. Copy the verified release to `frontend/downloads/goal-gambit-companion.apk`. The signed-in website setup screen reports the checksum calculated from this actual file.
6. Keep the same release keystore for every update. Back it up securely; losing it prevents future updates from replacing existing installations.

Never commit keystores, passwords, service-account keys, or signing property files.
