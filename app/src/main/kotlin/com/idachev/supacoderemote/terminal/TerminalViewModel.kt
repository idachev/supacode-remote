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

  /**
   * Скрол като от колелото / trackpad-а: страницата праща WheelEvent на xterm.js и той прави
   * каквото прави за истинско колело — mouse report, ако програмата следи мишката, стрелки
   * в alternate буфера, иначе превърта историята на телефона. Байтовете идват през `onInput`.
   */
  data class Wheel(val up: Boolean) : TerminalCommand

  /** Целият текст на терминала (историята и екрана) обратно към приложението, за копиране. */
  data object RequestText : TerminalCommand

  /** Показва точно този диапазон като маркирано (след ◀ ▶ в лентата за маркиране). */
  data class Select(val start: Cell, val end: Cell) : TerminalCommand

  /** Маркираното в clipboard-а — точно показаното; отговорът идва през `onCopy`. */
  data object CopySelection : TerminalCommand

  data object ClearSelection : TerminalCommand
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
  /** Маркираното с дълго натискане; докато го има, се вижда лентата за маркиране. */
  val selection: TerminalSelection? = null,
  /** „Пауза“: байтовете изход, задържани докато има маркирано; `null` — няма пауза. */
  val pausedBytes: Long? = null,
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
  /** „Скрол стига до агента“ от „Настройка“; чете се при всеки скрол. */
  private val overscrollToProgram: () -> Boolean = { true },
  /** Таванът на „Пауза“; над него паузата спира сама и маркираното се отменя. */
  pauseCapBytes: Long = OutputPause.CAP_BYTES,
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
  private val pause = OutputPause(pauseCapBytes)
  private var pauseTicker: Job? = null

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
    // Новата страница е празна и маркирано няма; задържаното ще дойде наново с attach.
    pause.end()
    stopPauseTicker()
    _state.update { it.copy(selection = null) }
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
        endPause(OutputPause.EndReason.Reattach)
        attachId = null
        // Init чисти терминала, а с него и маркираното.
        _state.update { it.copy(phase = AttachPhase.Attached(message.cols, message.rows), selection = null) }
        _commands.trySend(TerminalCommand.Init(message.cols, message.rows))
      }
      is Output -> if (message.contentId == contentId) {
        if (!pause.offer(message.b64)) {
          _commands.trySend(TerminalCommand.Write(message.b64))
        } else if (pause.overCap) {
          endPause(OutputPause.EndReason.Overflow)
          notices.show("Пауза спря: над ${OutputPause.formatSize(OutputPause.CAP_BYTES)} нов изход, маркирането е отменено")
        } else {
          schedulePauseChip()
        }
      }
      is SizeChanged -> if (message.contentId == contentId) {
        endPause(OutputPause.EndReason.Resize)
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

  /**
   * Страницата докладва маркираното (след дълго натискане и плъзгане). `null` — маркираното
   * е изчезнало там (докосване, нов attach) и лентата трябва да се скрие.
   */
  fun onSelection(selection: TerminalSelection?) {
    _state.update { it.copy(selection = selection) }
    if (selection != null && !pause.paused) startPause()
    if (selection == null) endPause(OutputPause.EndReason.SelectionGone)
  }

  /** Маркирането започна: изходът спира да се пише, за да не избута маркирания текст. */
  private fun startPause() {
    pause.start()
    _state.update { it.copy(pausedBytes = 0) }
  }

  /** Чипът се обновява най-много веднъж на [PAUSE_TICK_MS], не при всяко `out`. */
  private fun schedulePauseChip() {
    if (pauseTicker != null) return
    pauseTicker = viewModelScope.launch {
      delay(PAUSE_TICK_MS)
      pauseTicker = null
      if (pause.paused) _state.update { it.copy(pausedBytes = pause.queuedBytes) }
    }
  }

  /**
   * Край на паузата: задържаният изход се пише по ред, наведнъж. Без [OutputPause.EndReason.Copied]
   * и [OutputPause.EndReason.SelectionGone] маркираното се отменя първо — изходът го мести.
   */
  private fun endPause(reason: OutputPause.EndReason) {
    if (!pause.paused) return
    val cancel = reason != OutputPause.EndReason.Copied && reason != OutputPause.EndReason.SelectionGone
    if (cancel && _state.value.selection != null) {
      _state.update { it.copy(selection = null) }
      _commands.trySend(TerminalCommand.ClearSelection)
    }
    stopPauseTicker()
    pause.end().forEach { _commands.trySend(TerminalCommand.Write(it)) }
  }

  private fun stopPauseTicker() {
    pauseTicker?.cancel()
    pauseTicker = null
    _state.update { it.copy(pausedBytes = null) }
  }

  /** ◀ ▶ за началото: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionStart(delta: Int) = adjustSelection { it.moveStart(delta) }

  /** ◀ ▶ за края: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionEnd(delta: Int) = adjustSelection { it.moveEnd(delta) }

  private fun adjustSelection(change: (TerminalSelection) -> TerminalSelection) {
    val current = _state.value.selection ?: return
    val next = change(current)
    if (next == current) return
    _state.update { it.copy(selection = next) }
    _commands.trySend(TerminalCommand.Select(next.start, next.end))
  }

  /** „Копирай“ в лентата за маркиране: страницата връща показания текст и маха маркираното. */
  fun copySelection() {
    if (_state.value.selection == null) return
    _state.update { it.copy(selection = null) }
    _commands.trySend(TerminalCommand.CopySelection)
    endPause(OutputPause.EndReason.Copied)
  }

  fun clearSelection() {
    _state.update { it.copy(selection = null) }
    _commands.trySend(TerminalCommand.ClearSelection)
    endPause(OutputPause.EndReason.Cancelled)
  }

  /**
   * Скрол отвъд ръба на историята на телефона (или в TUI без история): същият скрол като
   * от trackpad-а и плаващите бутони ([scrollWheel]), не PgUp / PgDn. Тихо, без съобщение,
   * ако терминалът не е свързан — скролът е жест, не команда.
   */
  fun onOverscroll(up: Boolean) {
    if (!overscrollToProgram()) return
    scrollWheel(up)
  }

  /**
   * Плаващите бутони „Скрол нагоре / надолу“: скрол като от trackpad-а, не PgUp / PgDn —
   * в shell PgUp / PgDn вървят по историята на командите. Тихо без attach, както скролът.
   */
  fun scrollWheel(up: Boolean) {
    if (_state.value.phase !is AttachPhase.Attached) return
    _commands.trySend(TerminalCommand.Wheel(up))
  }

  /** Байтовете, които xterm.js е произвел за скрола от [scrollWheel] (mouse report, стрелки). */
  fun onWheelInput(bytes: String) {
    if (bytes.isEmpty() || _state.value.phase !is AttachPhase.Attached) return
    sendRaw(bytes)
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
    // Вход към програмата: първо се показва задържаният изход, иначе отговорът ѝ идва
    // след стария екран.
    endPause(OutputPause.EndReason.Input)
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

    /** Колко често чипът „Пауза“ показва нов размер. */
    const val PAUSE_TICK_MS = 250L
  }
}
