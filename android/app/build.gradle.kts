plugins {
    id("com.android.application")
}

if (file("google-services.json").isFile) {
    apply(plugin = "com.google.gms.google-services")
}

val configuredApiBase = providers.gradleProperty("GG_API_BASE_URL")
    .orElse("https://desktop-elb0fth.taildd904a.ts.net")
    .get()
    .trimEnd('/')

android {
    namespace = "com.goalgambit.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.goalgambit.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "API_BASE_URL", "\"$configuredApiBase\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:35.0.0"))
    implementation("com.google.firebase:firebase-messaging")
}
