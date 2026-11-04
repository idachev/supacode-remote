package com.idachev.supacoderemote.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.DetachRequest
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.InputRequest
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import com.idachev.supacoderemote.protocol.SuggestRequest
import com.idachev.supacoderemote.protocol.Suggestions
import com.idachev.supacoderemote.protocol.TerminalBytes
import com.idachev.supacoderemote.protocol.TerminalKeys
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Какво трябва да направи xterm.js. Изпълнява се в реда на пристигане. */
sealed interface TerminalCommand {
  /** Нов `attached`: терминалът се чисти и става точно [cols] × [rows]. */
  data class Init(val cols: Int, val rows: Int) : TerminalCommand

  data class Write(val b64: String) : TerminalCommand

  data class Resize(val cols: Int, val rows: Int) : TerminalCommand

  /** Превърта историята на самия xterm.js с [pages] страници (минус е нагоре). */
  data class ScrollPages(val pages: Int) : TerminalCommand

  /** Обратно до живия край на терминала. */
  data object ScrollToBottom : TerminalCommand

  /** Целият текст на терминала (историята и екрана) обратно към приложението, за копиране. */
  data object RequestText : TerminalCommand
}

sealed interface AttachPhase {
  /** Чакаме връзка и онлайн Mac. */
  data object Waiting : AttachPhase

  data object Attaching : AttachPhase

  data class Attached(val cols: Int, val rows: Int) : AttachPhase

  data class Detached(val reason: String) : AttachPhase
}

data class TerminalUiState(
  val phase: AttachPhase = AttachPhase.Waiting,
  val ctrlSticky: Boolean = false,
  /** „Живи клавиши“: всеки знак отива веднага, вместо ред със „Прати“. */
  val liveKeys: Boolean = false,
  val suggesting: Boolean = false,
  val suggestions: List<String> = emptyList(),
)

/**
 * Един таб на Mac-а, гледан от телефона.
 *
 * Размерът винаги е на Mac-а: `attached` и `size` го казват, а телефонът никога не праща
 * свой. `attach` се прави наново при всяка нова сесия с host-а (reconnect) и при всяко
 * ново зареждане на страницата с xterm.js, защото тогава екранът е празен.
 */
class TerminalViewModel(
  private val link: HostLink,
  private val notices: Notices,
  val contentId: String,
  private val suggestTimeoutMs: Long = SUGGEST_TIMEOUT_MS,
) : ViewModel() {

  private val _state = MutableStateFlow(TerminalUiState())
  val state: StateFlow<TerminalUiState> = _state.asStateFlow()

  private val _commands = Channel<TerminalCommand>(Channel.UNLIMITED)

  /** Командите към xterm.js. Чете ги само един — WebView-то на екрана. */
  val commands: Flow<TerminalCommand> = _commands.receiveAsFlow()

  private var webReady = false
  private var attachId: Int? = null
  private var suggestId: Int? = null
  private var suggestTimeout: Job? = null

  init {
    viewModelScope.launch { link.messages.collect(::onMessage) }
    viewModelScope.launch {
      link.hostSession.collect { session ->
        if (session == null) {
          attachId = null
          _state.update { it.copy(phase = AttachPhase.Waiting) }
        } else if (webReady) {
          attach()
        }
      }
    }
  }

  /**
   * Страницата с xterm.js е заредена (първия път или след ново WebView). Старите команди
   * са за предишната страница, затова се изхвърлят и екранът се иска наново.
   */
  fun onWebReady() {
    webReady = true
    while (_commands.tryReceive().isSuccess) Unit
    if (link.hostSession.value != null) attach()
  }

  fun onWebGone() {
    webReady = false
  }

  /** Бутонът „Свържи отново“ след `detached`. */
  fun reattach() {
    if (link.hostSession.value == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    attach()
  }

  private fun attach() {
    val id = link.nextId()
    attachId = id
    _state.update { it.copy(phase = AttachPhase.Attaching) }
    if (!link.send(AttachRequest(id = id, contentId = contentId))) {
      attachId = null
      _state.update { it.copy(phase = AttachPhase.Waiting) }
    }
  }

  private fun onMessage(message: ServerMessage) {
    when (message) {
      is Attached -> if (message.contentId == contentId) {
        attachId = null
        _state.update { it.copy(phase = AttachPhase.Attached(message.cols, message.rows)) }
        _commands.trySend(TerminalCommand.Init(message.cols, message.rows))
      }
      is Output -> if (message.contentId == contentId) {
        _commands.trySend(TerminalCommand.Write(message.b64))
      }
      is SizeChanged -> if (message.contentId == contentId) {
        _state.update { it.copy(phase = AttachPhase.Attached(message.cols, message.rows)) }
        _commands.trySend(TerminalCommand.Resize(message.cols, message.rows))
      }
      is Detached -> if (message.contentId == contentId) {
        attachId = null
        _state.update { it.copy(phase = AttachPhase.Detached(message.reason?.ifBlank { null } ?: "сесията е спряла")) }
      }
      is Suggestions -> if (message.id != null && message.id == suggestId) {
        finishSuggest()
        _state.update { it.copy(suggestions = message.suggestions) }
        if (message.suggestions.isEmpty()) notices.show("Няма предложения")
      }
      is ErrorReply -> {
        // Самото съобщение вече е в snackbar-а (AppContainer); тук само спираме чакането.
        if (message.id != null && message.id == suggestId) finishSuggest()
        if (message.id != null && message.id == attachId) {
          attachId = null
          _state.update { it.copy(phase = AttachPhase.Detached(message.message)) }
        }
      }
      else -> Unit
    }
  }

  /** Текстът от полето и после Enter. */
  fun sendLine(text: String): Boolean = sendRaw(text + TerminalKeys.ENTER)

  /** Бутон от реда с клавиши. */
  fun sendKey(bytes: String): Boolean {
    _state.update { it.copy(ctrlSticky = false) }
    return sendRaw(bytes)
  }

  /**
   * Историята на телефона, не на програмата: за shell, чийто изход е излязъл над екрана.
   * PgUp/PgDn от реда с клавиши отиват към програмата (напр. Claude Code).
   */
  fun scrollHistory(pages: Int) {
    _commands.trySend(TerminalCommand.ScrollPages(pages))
  }

  fun scrollToBottom() {
    _commands.trySend(TerminalCommand.ScrollToBottom)
  }

  /** Иска текста на терминала; идва обратно през `onText` на WebView-то. */
  fun requestText() {
    _commands.trySend(TerminalCommand.RequestText)
  }

  fun toggleCtrl() = _state.update { it.copy(ctrlSticky = !it.ctrlSticky) }

  fun setLiveKeys(on: Boolean) = _state.update { it.copy(liveKeys = on) }

  /**
   * Текст от „Живи клавиши“, вече преведен в байтове (DEL, `\r`). Един знак при включен
   * Ctrl отива като control код, както в полето за ред.
   */
  fun sendLive(text: String) {
    if (text.isEmpty()) return
    if (text.length == 1 && consumeCtrl(text[0])) return
    sendRaw(text)
  }

  /**
   * Знак, написан в полето при включен Ctrl. Връща `true`, ако е изпратен като control
   * код — тогава полето не го показва. Ctrl се изключва след първия знак.
   */
  fun consumeCtrl(ch: Char): Boolean {
    if (!_state.value.ctrlSticky) return false
    val code = TerminalKeys.control(ch) ?: return false
    _state.update { it.copy(ctrlSticky = false) }
    sendRaw(code)
    return true
  }

  private fun sendRaw(text: String): Boolean {
    if (_state.value.phase !is AttachPhase.Attached) {
      notices.show("Терминалът не е свързан")
      return false
    }
    val sent = link.send(InputRequest(contentId = contentId, b64 = TerminalBytes.encodeText(text)))
    if (!sent) notices.show("Няма връзка — не е изпратено")
    return sent
  }

  /** Предложенията само пълнят полето; тук никога не се праща нищо към PTY-то. */
  fun suggest() {
    if (_state.value.suggesting) return
    if (link.hostSession.value == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    val id = link.nextId()
    if (!link.send(SuggestRequest(id = id, contentId = contentId))) {
      notices.show("Няма връзка — не е изпратено")
      return
    }
    suggestId = id
    _state.update { it.copy(suggesting = true, suggestions = emptyList()) }
    suggestTimeout = viewModelScope.launch {
      delay(suggestTimeoutMs)
      if (suggestId == id) {
        finishSuggest()
        notices.show("Mac-ът не върна предложения навреме")
      }
    }
  }

  fun clearSuggestions() = _state.update { it.copy(suggestions = emptyList()) }

  private fun finishSuggest() {
    suggestId = null
    suggestTimeout?.cancel()
    suggestTimeout = null
    _state.update { it.copy(suggesting = false) }
  }

  /** Екранът е затворен (entry-то е махнато от стека): host-ът спира потока. */
  override fun onCleared() {
    link.send(DetachRequest(contentId))
  }

  companion object {
    /** Моделът на Mac-а има до 90 s; малко отгоре за relay-а. */
    const val SUGGEST_TIMEOUT_MS = 100_000L
  }
}
