package com.idachev.supacoderemote.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.TabNewReply
import com.idachev.supacoderemote.protocol.TabNewRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * „Нов таб“: `tab.new` към Mac-а и чакането на отговора. Пътят (LAN или relay) не е грижа
 * тук — [HostLink.send] избира сам, а отговорът идва в общия поток и по двата пътя.
 *
 * Чака се по един таб наведнъж: втори натиск, докато първият чака, би отворил два таба.
 */
class NewTabViewModel(
  private val link: HostLink,
  private val notices: Notices,
  /** Новият таб се появява в `list` чак след нова заявка, затова се пита веднага. */
  private val refresh: () -> Unit,
  /** Малко над 10-те секунди на Mac-а, за да дойде неговата грешка преди нашата. */
  private val timeoutMs: Long = TIMEOUT_MS,
) : ViewModel() {

  private val _pendingWorktreeId = MutableStateFlow<String?>(null)

  /** Worktree-то, за което чакаме таб; `null` — не чакаме. Показва се като прогрес. */
  val pendingWorktreeId: StateFlow<String?> = _pendingWorktreeId.asStateFlow()

  private val _opened = Channel<TabNewReply>(Channel.UNLIMITED)

  /** Създадените табове, за да ги отвори екранът. Чете ги само един — екранът. */
  val opened: Flow<TabNewReply> = _opened.receiveAsFlow()

  private var pendingId: Int? = null
  private var timeout: Job? = null

  init {
    viewModelScope.launch { link.messages.collect(::onMessage) }
  }

  fun create(worktreeId: String) {
    if (pendingId != null) return
    if (link.hostSession.value == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    val id = link.nextId()
    if (!link.send(TabNewRequest(id = id, worktreeId = worktreeId))) {
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

  private fun onMessage(message: ServerMessage) {
    val id = pendingId ?: return
    when (message) {
      is TabNewReply -> if (message.id == id) {
        finish()
        refresh()
        _opened.trySend(message)
      }
      // Самото съобщение вече е в snackbar-а (AppContainer); тук само спираме чакането.
      is ErrorReply -> if (message.id == id) finish()
      else -> Unit
    }
  }

  private fun finish() {
    pendingId = null
    timeout?.cancel()
    timeout = null
    _pendingWorktreeId.value = null
  }

  companion object {
    const val TIMEOUT_MS = 12_000L
  }
}
