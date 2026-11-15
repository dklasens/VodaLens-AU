plugins { id("com.android.application"); id("org.jetbrains.kotlin.plugin.compose") }
android {
    namespace = "au.com.vodalens"
    compileSdk = 37
    defaultConfig {
        applicationId = "au.com.vodalens"
        minSdk = 36
        targetSdk = 37
        versionCode = 4
        versionName = "0.1.3"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { compose = true }
    signingConfigs {
        create("distribution") {
            System.getenv("VODALENS_SIGNING_STORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("VODALENS_SIGNING_PASSWORD")
            keyAlias = "vodalens"
            keyPassword = System.getenv("VODALENS_SIGNING_PASSWORD")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildTypes {
        release {
            isMinifyEnabled = true; isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("VODALENS_SIGNING_STORE") != null) signingConfig = signingConfigs.getByName("distribution")
        }
        create("personal") {
            initWith(getByName("release"))
            // Same local certificate preserves the installed app's encrypted vault.
            // Distribution signing is intentionally separate from this personal build.
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
            versionNameSuffix = "-personal"
        }
    }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
