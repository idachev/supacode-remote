plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  alias(libs.plugins.kotlin.serialization)
}

// Стойностите идват от build-project.sh. Не се смятат тук: configuration cache
// иначе би показал час от предишен билд.
val buildTimeUtc = providers.gradleProperty("supacodeRemoteBuildTimeUtc").orElse("unknown")
val gitShortSha = providers.gradleProperty("supacodeRemoteGitShortSha").orElse("unknown")

android {
  namespace = "com.idachev.supacoderemote"
  // Template-ът иска 37, но platform 37 не е инсталирана; 36 е като в другите приложения.
  compileSdk = 36
  defaultConfig {
    applicationId = "com.idachev.supacoderemote"
    minSdk = 24
    targetSdk = 36
    versionCode = 1
    versionName = "1.0"
    buildConfigField("String", "BUILD_TIME_UTC", "\"${buildTimeUtc.get()}\"")
    buildConfigField("String", "GIT_SHORT_SHA", "\"${gitShortSha.get()}\"")
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  buildFeatures {
    compose = true
    aidl = false
    buildConfig = true
    shaders = false
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  val composeBom = platform(libs.androidx.compose.bom)
  implementation(composeBom)
  androidTestImplementation(composeBom)

  // Core Android dependencies
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)

  // Arch Components
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  // Връзката живее, докато приложението е на преден план. ProcessLifecycleOwner не
  // реагира на завъртане на екрана, за разлика от onStop на Activity.
  implementation(libs.androidx.lifecycle.process)

  // Compose
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.ui.tooling.preview)
  implementation(libs.androidx.compose.material3)
  // Tooling
  debugImplementation(libs.androidx.compose.ui.tooling)
  // Instrumented tests
  androidTestImplementation(libs.androidx.compose.ui.test.junit4)
  debugImplementation(libs.androidx.compose.ui.test.manifest)

  // Local tests: jUnit, coroutines, Android runner
  testImplementation(libs.junit)
  testImplementation(libs.kotlinx.coroutines.test)
  // Истински WebSocket сървър за теста на RelayClient (401, hello, ping).
  testImplementation(libs.okhttp.mockwebserver)

  // Instrumented tests: jUnit rules and runners
  androidTestImplementation(libs.androidx.test.core)
  androidTestImplementation(libs.androidx.test.ext.junit)
  androidTestImplementation(libs.androidx.test.runner)
  androidTestImplementation(libs.androidx.test.espresso.core)

  // Протоколът към relay-а е JSON по WebSocket.
  implementation(libs.kotlinx.serialization.json)
  implementation(libs.okhttp)

  // Navigation
  implementation(libs.androidx.navigation3.ui)
  implementation(libs.androidx.navigation3.runtime)
  implementation(libs.androidx.lifecycle.viewmodel.navigation3)
}

// Navigation 3 носи serialization-core 1.7.3, а JSON-ът е 1.8.1. Смесени версии дават
// AbstractMethodError още при първото четене, затова целият проект минава на 1.8.1.
configurations.configureEach {
  resolutionStrategy.force(
    "org.jetbrains.kotlinx:kotlinx-serialization-core:1.8.1",
    "org.jetbrains.kotlinx:kotlinx-serialization-core-jvm:1.8.1",
    "org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1",
    "org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.8.1",
  )
}
