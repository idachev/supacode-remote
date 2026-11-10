package com.idachev.supacoderemote

import android.content.Context
import com.idachev.supacoderemote.alerts.AgentAlerts
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.relay.RelayClient
import com.idachev.supacoderemote.sessions.SessionsRepository
import com.idachev.supacoderemote.settings.KeystoreSettingsStore
import com.idachev.supacoderemote.settings.SettingsStore
import com.idachev.supacoderemote.terminal.TerminalGridMemory
import com.idachev.supacoderemote.ui.hosts.HostLabels
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.time.Duration

/**
 * Ръчно свързване на зависимостите. Няма Hilt.
 *
 * Една връзка към relay-а за целия процес: всички екрани говорят през нея, а
 * [SessionsRepository] пази последния списък, за да не го пита всеки екран отначало.
 */
class AppContainer(context: Context) {

  /** `SupervisorJob`, за да не спре един провал (напр. в цикъла на връзката) останалото. */
  val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  val settingsStore: SettingsStore = KeystoreSettingsStore(context)

  /** Таймаутите са само за handshake-а; веднъж отворен, WebSocket-ът се пази с `ping`. */
  private val http: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(Duration.ofSeconds(15))
    .build()

  val relay: RelayClient = RelayClient(http, appScope, selection = settingsStore)

  val sessions: SessionsRepository = SessionsRepository(relay, appScope)

  val notices: Notices = Notices()

  /** Последният размер, премерен от терминала; с него тръгва нов таб (АН1). */
  val terminalGrid: TerminalGridMemory = TerminalGridMemory()

  /** Дали приложението се вижда. Пише го [SupacodeRemoteApp] от ProcessLifecycleOwner. */
  val appInForeground: MutableStateFlow<Boolean> = MutableStateFlow(false)

  /** Известията „агент чака“; включват се от „Настройка“. */
  val agentAlerts: AgentAlerts = AgentAlerts(context, sessions.repos, relay.boundHostId, appInForeground, appScope)

  /**
   * Терминал, поискан от докоснато известие. Навигацията го отваря и връща `null`.
   * StateFlow, а не събитие: известието може да дойде преди навигацията да е готова.
   */
  val openTerminalRequests: MutableStateFlow<OpenTerminalRequest?> = MutableStateFlow(null)

  /**
   * До коя стойност на [RelayClient.hostPickRequests] навигацията вече е отворила „Mac-ове“.
   * Тук, а не в `rememberSaveable`: броячът живее колкото процеса и започва от 0 с него.
   */
  var handledHostPicks: Int = 0

  init {
    appScope.launch { settingsStore.notifyAwaiting.collect { agentAlerts.setEnabled(it) } }
    appScope.launch { settingsStore.settings.collect { relay.configure(it) } }
    appScope.launch {
      // Отказите на `worktree.new` са в диалога „Нов worktree“ (или в snackbar-а от него, ако е затворен).
      relay.messages.filterIsInstance<ErrorReply>()
        .filter { it.code?.startsWith(ErrorReply.WORKTREE_PREFIX) != true }
        .collect { notices.show(HostLabels.error(it, relay.hostApp.value)) }
    }
  }
}

/**
 * Кой терминал да се отвори от известие: Mac-ът му ([hostId], празно — който и да е свързан),
 * worktree-то му за стека „Назад“ и самият таб.
 */
data class OpenTerminalRequest(
  val hostId: String,
  val repositoryId: String,
  val worktreeId: String,
  val worktreeName: String,
  val contentId: String,
  val tabTitle: String,
)

/** Кратките съобщения към потребителя (snackbar). Грешките на host-а и тези на екраните идват тук. */
class Notices {
  private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
  val messages: SharedFlow<String> = _messages.asSharedFlow()

  fun show(message: String) {
    _messages.tryEmit(message)
  }
}
