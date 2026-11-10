package com.idachev.supacoderemote.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.TabNewReply
import com.idachev.supacoderemote.protocol.TabNewRequest
import com.idachev.supacoderemote.relay.HostLink
import com.idachev.supacoderemote.terminal.GridSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * „Нов таб“: `tab.new` към Mac-а и чакането на отговора. Пътят (LAN или relay) не е грижа
 * тук — [HostLink.send] избира сам, а отговорът идва в общия поток и по двата пътя.
 *
 * Терминалът се отваря само докато екранът „Worktree“ се вижда ([setVisible]): иначе
 * закъснял отговор би отворил таб, след като потребителят е отишъл другаде. Напуснат ли
 * екрана, чакането спира, а заявката остава „тиха“ — Mac-ът пак прави таба, затова при
 * отговор списъкът се опреснява, но нищо не се отваря.
 */
class NewTabViewModel(
  private val link: HostLink,
  private val notices: Notices,
  /** Новият таб се появява в `list` чак след нова заявка, затова се пита веднага. */
  private val refresh: () -> Unit,
  /** За тихите заявки след [onCleared]: тогава [viewModelScope] вече е спрян. */
  private val appScope: CoroutineScope,
  /** Малко над 10-те секунди на Mac-а, за да дойде неговата грешка преди нашата. */
  private val timeoutMs: Long = TIMEOUT_MS,
  /**
   * Началният размер на новия таб — по правилото на „Размер по този екран“ (АН1), от последната
   * мярка на терминала. `null` — няма мярка, host-ът решава сам.
   */
  private val startGrid: () -> GridSize? = { null },
) : ViewModel() {

  private val _pendingWorktreeId = MutableStateFlow<String?>(null)

  /** Worktree-то, за което чакаме таб; `null` — не чакаме. Показва се като прогрес. */
  val pendingWorktreeId: StateFlow<String?> = _pendingWorktreeId.asStateFlow()

  private val _opened = MutableStateFlow<TabNewReply?>(null)

  /** Създаденият таб, който екранът да отвори и после да потвърди с [consumeOpened]. */
  val opened: StateFlow<TabNewReply?> = _opened.asStateFlow()

  private var visible = false
  private var pendingId: Int? = null
  private var timeout: Job? = null

  /** Заявки, чийто екран е напуснат: отговорът само опреснява списъка. Id → край на чакането. */
  private val quiet = mutableMapOf<Int, Job>()

  init {
    viewModelScope.launch { link.messages.collect(::onMessage) }
  }

  fun setVisible(value: Boolean) {
    visible = value
    if (value) return
    _opened.value = null
    val id = pendingId ?: return
    finish()
    quiet[id] = viewModelScope.launch {
      delay(timeoutMs)
      quiet.remove(id)
    }
  }

  fun create(worktreeId: String) {
    if (pendingId != null || !visible) return
    if (link.hostSession.value == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    val id = link.nextId()
    val grid = startGrid()
    if (!link.send(TabNewRequest(id = id, worktreeId = worktreeId, cols = grid?.cols, rows = grid?.rows))) {
      notices.show("Няма връзка — не е изпратено")
      return
    }
    pendingId = id
    _pendingWorktreeId.value = worktreeId
    timeout = viewModelScope.launch {
      delay(timeoutMs)
      if (pendingId == id) {
        finish()
        notices.show("Mac-ът не отвори таб навреме")
      }
    }
  }

  fun consumeOpened() {
    _opened.value = null
  }

  private fun onMessage(message: ServerMessage) {
    val id = when (message) {
      is TabNewReply -> message.id
      // Самото съобщение вече е в snackbar-а (AppContainer); тук само спираме чакането.
      is ErrorReply -> message.id
      else -> null
    } ?: return
    quiet.remove(id)?.let { job ->
      job.cancel()
      if (message is TabNewReply) refresh()
      return
    }
    if (id != pendingId) return
    finish()
    if (message is TabNewReply) {
      refresh()
      if (visible) _opened.value = message
    }
  }

  private fun finish() {
    pendingId = null
    timeout?.cancel()
    timeout = null
    _pendingWorktreeId.value = null
  }

  /** Екранът е махнат от стека: тихите заявки още опресняват списъка, докато им е времето. */
  override fun onCleared() {
    val ids = quiet.keys.toSet() + listOfNotNull(pendingId)
    if (ids.isEmpty()) return
    appScope.launch {
      val reply = withTimeoutOrNull(timeoutMs) {
        link.messages.first { (it is TabNewReply && it.id in ids) || (it is ErrorReply && it.id in ids) }
      }
      if (reply is TabNewReply) refresh()
    }
  }

  companion object {
    const val TIMEOUT_MS = 12_000L
  }
}
