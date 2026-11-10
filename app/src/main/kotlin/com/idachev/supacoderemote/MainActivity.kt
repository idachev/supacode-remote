package com.idachev.supacoderemote

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import com.idachev.supacoderemote.alerts.AgentAlerts
import com.idachev.supacoderemote.alerts.AgentWatchService
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.theme.SupacodeRemoteTheme

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val container = (application as SupacodeRemoteApp).container
    // Само при истинско пускане: след завъртане или от „Скорошни“ intent-ът е същият стар.
    if (savedInstanceState == null) handleIntent(intent)

    enableEdgeToEdge()
    hideSystemBars()
    setContent {
      CompositionLocalProvider(LocalAppContainer provides container) {
        SupacodeRemoteTheme {
          // testTag-овете стават resource-id, за да ги вижда uiautomator при пробата с adb.
          Surface(modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }, color = MaterialTheme.colorScheme.background) { MainNavigation() }
        }
      }
    }
  }

  override fun onStart() {
    super.onStart()
    // Service-ът за известия се пуска оттук: от преден план Android го позволява винаги.
    val container = (application as SupacodeRemoteApp).container
    AgentWatchService.sync(this, container.settingsStore.notifyAwaiting.value)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Диалог или известие връщат системните ленти; при връщане на фокуса пак се скриват.
    if (hasFocus) hideSystemBars()
  }

  /**
   * Цял екран: status bar-ът и navigation bar-ът са скрити, за да вземе терминалът всеки
   * ред. Плъзгане от ръба ги показва за малко, без да мести съдържанието (immersive).
   */
  private fun hideSystemBars() {
    WindowCompat.getInsetsController(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  /** Докоснато известие „агент чака“: отваря терминала на този таб. */
  private fun handleIntent(intent: Intent?) {
    if (intent?.action != AgentAlerts.ACTION_OPEN_TERMINAL) return
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
    val contentId = intent.getStringExtra(AgentAlerts.EXTRA_CONTENT_ID) ?: return
    (application as SupacodeRemoteApp).container.openTerminalRequests.value = OpenTerminalRequest(
      hostId = intent.getStringExtra(AgentAlerts.EXTRA_HOST_ID).orEmpty(),
      repositoryId = intent.getStringExtra(AgentAlerts.EXTRA_REPOSITORY_ID).orEmpty(),
      worktreeId = intent.getStringExtra(AgentAlerts.EXTRA_WORKTREE_ID).orEmpty(),
      worktreeName = intent.getStringExtra(AgentAlerts.EXTRA_WORKTREE_NAME).orEmpty(),
      contentId = contentId,
      tabTitle = intent.getStringExtra(AgentAlerts.EXTRA_TAB_TITLE) ?: "Таб",
    )
  }
}
