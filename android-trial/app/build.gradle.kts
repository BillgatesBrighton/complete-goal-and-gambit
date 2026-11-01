plugins {
    id("com.android.application")
}

val configuredApiBase = providers.gradleProperty("GG_TRIAL_API_BASE_URL")
    .orElse("https://desktop-elb0fth.taildd904a.ts.net")
    .get()
    .trimEnd('/')

android {
    namespace = "com.goalgambit.trial"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.goalgambit.trial"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.0.1"
        buildConfigField("String", "API_BASE_URL", "\"" + configuredApiBase + "\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("io.socket:socket.io-client:2.1.2") {
        exclude(group = "org.json", module = "json")
    }
    implementation("com.caverock:androidsvg-aar:1.4")
    testImplementation("junit:junit:4.13.2")
}
