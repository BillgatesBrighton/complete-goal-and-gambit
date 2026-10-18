import java.io.File
import java.io.FileInputStream
import java.util.Properties

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

val releaseSigningPropertiesFile = System.getenv("APPDATA")?.let {
    File(it, "GOAL" + '$' + "GAMBIT/release-signing.properties")
}
val releaseSigningProperties = Properties()
if (releaseSigningPropertiesFile != null && releaseSigningPropertiesFile.isFile) {
    FileInputStream(releaseSigningPropertiesFile).use(releaseSigningProperties::load)
}
val releaseSigningConfigured = releaseSigningPropertiesFile?.isFile == true &&
    listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all {
        !releaseSigningProperties.getProperty(it).isNullOrBlank()
    }

android {
    namespace = "com.goalgambit.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.goalgambit.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 7
        versionName = "1.0.6"
        buildConfigField("String", "API_BASE_URL", "\"$configuredApiBase\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(checkNotNull(releaseSigningProperties.getProperty("storeFile")))
                storePassword = checkNotNull(releaseSigningProperties.getProperty("storePassword"))
                keyAlias = checkNotNull(releaseSigningProperties.getProperty("keyAlias"))
                keyPassword = checkNotNull(releaseSigningProperties.getProperty("keyPassword"))
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

tasks.configureEach {
    if ((name.startsWith("assemble") || name.startsWith("bundle")) &&
        name.contains("Release", ignoreCase = true)) {
        doFirst {
            if (!releaseSigningConfigured) {
                throw GradleException("Release signing is not configured. See the Android release signing instructions.")
            }
        }
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:35.0.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.work:work-runtime:2.10.5")
}
