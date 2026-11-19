package com.idachev.supacoderemote.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.InputRequest
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.ResizeRequest
import com.idachev.supacoderemote.protocol.SuggestRequest
import com.idachev.supacoderemote.protocol.Suggestions
import com.idachev.supacoderemote.protocol.TerminalBytes
import com.idachev.supacoderemote.protocol.TerminalKeys
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Какво трябва да направи xterm.js. Изпълнява се в реда на пристигане. */
sealed interface TerminalCommand {
  /** Нов `attached`: терминалът се чисти и става точно [cols] × [rows]. */
  data class Init(val cols: Int, val rows: Int) : TerminalCommand

  data class Write(val b64: String) : TerminalCommand

  data class Resize(val cols: Int, val rows: Int) : TerminalCommand

  /**
   * Mac-ът не смени размера (`resize_failed`): поисканият размер вече не чака отговор, иначе
   * по-късен `size` със същия размер би задържал шрифта, мерен за отказа.
   */
  data object ResizeFailed : TerminalCommand

  /** Превърта историята на самия xterm.js с [pages] страници (минус е нагоре). */
  data class ScrollPages(val pages: Int) : TerminalCommand

  /** Обратно до живия край на терминала. */
  data object ScrollToBottom : TerminalCommand

  /**
   * Скрол като от колелото / trackpad-а: страницата праща WheelEvent на xterm.js и той прави
   * каквото прави за истинско колело — mouse report, ако програмата следи мишката, стрелки
   * в alternate буфера, иначе превърта историята на телефона. Байтовете идват през `onInput`.
   *
   * [lines] е броят събития (0 — колкото за един скрол на колелото в страницата). С
   * [programOnly] страницата скролира само ако програмата следи мишката; иначе не прави нищо,
   * за да не тръгнат стрелки към TUI без мишка и да не мърда историята на телефона.
   */
  data class Wheel(val up: Boolean, val lines: Int = 0, val programOnly: Boolean = false) : TerminalCommand

  /** Подпис на екрана обратно към приложението: „Най-долу“ гледа има ли нови редове. */
  data object ReportScreen : TerminalCommand

  /** Целият текст на терминала (историята и екрана) обратно към приложението, за копиране. */
  data object RequestText : TerminalCommand

  /** Колко колони и реда влизат в мястото на терминала при сегашния шрифт; идва през `onGrid`. */
  data object MeasureGrid : TerminalCommand

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
  /** Горната лента и полето за писане; по подразбиране скрити (терминалът на цял екран). */
  val bars: TerminalBars = TerminalBars(),
  /** „Най-долу“ още скролира програмата; второ докосване го спира. */
  val jumping: Boolean = false,
)

/**
 * Екранът на един таб на Mac-а (ДЗ18): лентите, полето за писане, „Живи клавиши“, Ctrl,
 * предложенията и „Най-долу“. Самият терминал — attach-ът, потокът, маркираното и „Пауза“ — е
 * [TerminalSession] от [TerminalPool] и остава жив след излизане от екрана.
 *
 * Входът, `resize`, „Предложи“ и скролът към програмата вървят само за [contentId] — таба на
 * този екран, т.е. видимия (АЦ1).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TerminalViewModel(
  private val link: HostLink,
  private val notices: Notices,
  val contentId: String,
  private val pool: TerminalPool,
  private val suggestTimeoutMs: Long = SUGGEST_TIMEOUT_MS,
  /** „Скрол стига до агента“ от „Настройка“; чете се при всеки скрол. */
  private val overscrollToProgram: () -> Boolean = { true },
  /** Паузата между текста от полето и неговия Enter (виж [sendLine]). */
  private val enterDelayMs: Long = ENTER_DELAY_MS,
  /** Часовникът, с който „Най-долу“ мери колко бързо отговаря програмата. */
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) : ViewModel() {

  private val _state = MutableStateFlow(TerminalUiState())
  val state: StateFlow<TerminalUiState> = _state.asStateFlow()

  /** Пазен от пула; сменя се само ако пулът го е пуснал, докато екранът още е отворен. */
  private val _session = MutableStateFlow(pool.open(contentId, this))
  private val session: TerminalSession get() = _session.value

  /** Живият терминал на екрана; с него идва и страницата му ([TerminalSession.page]). */
  val terminal: StateFlow<TerminalSession> = _session.asStateFlow()

  /** Синхронното огледало на сесията в [state] (виж [TerminalSession.observer]). */
  private val mirror: (TerminalSessionState) -> Unit = { s ->
    _state.update { it.copy(phase = s.phase, selection = s.selection, pausedBytes = s.pausedBytes) }
    // Нов attach, `detached` или паднала връзка: „Най-долу“ скролираше стария екран.
    if (s.phase !is AttachPhase.Attached) cancelJump()
  }

  /** Командите към xterm.js. Чете ги само един — WebView-то на екрана. */
  val commands: Flow<TerminalCommand> = _session.flatMapLatest { it.commands }

  private var suggestId: Int? = null
  private var suggestTimeout: Job? = null
  private var pendingEnter: Job? = null
  private var jumpJob: Job? = null

  /** Байтовете от страницата за скрола на „Най-долу“; има го само докато той тече. */
  private var jumpReplies: Channel<String>? = null

  /** Подписите на екрана от страницата; има го само докато „Най-долу“ тече. */
  private var jumpSignatures: Channel<Int>? = null

  init {
    bind(session)
    viewModelScope.launch { link.messages.collect(::onMessage) }
  }

  private fun bind(next: TerminalSession) {
    _session.value = next
    next.observer = mirror
    mirror(next.state.value)
  }

  /**
   * Страницата с xterm.js е заредена (първия път или след ново WebView). Сесията изхвърля
   * старите команди и иска екрана наново. Ако пулът междувременно е пуснал таба (друг Mac,
   * недостиг на памет), екранът взима нов.
   */
  fun onWebReady() {
    cancelJump()
    if (session.released) bind(pool.open(contentId, this))
    session.onWebReady()
  }

  /**
   * Екранът е пред очите (и след завъртане или връщане от „Настройка“): табът става видим —
   * чакащият изход се пише наведнъж, а ако Mac-ът е забравил attach-а — нов (ДЗ7, ДЗ19).
   */
  fun onShown() {
    bind(pool.open(contentId, this))
  }

  /**
   * Екранът вече не се вижда: табът остава жив в пула скрит (без `attach.keep` — `detach`,
   * както преди). Скритият таб не рисува, изходът му чака в [HiddenOutput].
   */
  fun onHidden() {
    // С keep фазата остава Attached, а скролът към програмата е само за видимия таб (АЦ1).
    cancelJump()
    pool.leave(contentId, this)
  }

  /** Бутонът „Свържи отново“ след `detached`. */
  fun reattach() {
    if (link.hostSession.value == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    session.attach()
  }

  /** Само каквото е на екрана; потокът на терминала е в [TerminalSession]. */
  private fun onMessage(message: ServerMessage) {
    when (message) {
      is Suggestions -> if (message.id != null && message.id == suggestId) {
        finishSuggest()
        _state.update { it.copy(suggestions = message.suggestions) }
        if (message.suggestions.isEmpty()) notices.show("Няма предложения")
      }
      is ErrorReply -> {
        // Самото съобщение вече е в snackbar-а (AppContainer); тук само спираме чакането.
        if (message.id != null && message.id == suggestId) finishSuggest()
      }
      else -> Unit
    }
  }

  /**
   * Текстът от полето и после Enter — в два отделни `input`, с [enterDelayMs] между тях.
   * Claude Code приема бързо дошло парче с няколко знака като поставен текст и `\r` в него
   * става нов ред в полето му, а не „изпрати“; shell-ът няма тази разлика. Затова Enter-ът
   * идва сам и малко по-късно.
   */
  fun sendLine(text: String): Boolean {
    cancelJump()
    if (text.isEmpty()) return sendRaw(TerminalKeys.ENTER)
    if (!sendRaw(text)) return false
    pendingEnter = viewModelScope.launch {
      delay(enterDelayMs)
      pendingEnter = null
      sendRaw(TerminalKeys.ENTER)
    }
    return true
  }

  /** Чакащ Enter от [sendLine] тръгва веднага, за да не го изпревари следващият вход. */
  private fun flushPendingEnter() {
    val job = pendingEnter ?: return
    pendingEnter = null
    job.cancel()
    sendRaw(TerminalKeys.ENTER)
  }

  /** Бутон от реда с клавиши. */
  fun sendKey(bytes: String): Boolean {
    cancelJump()
    _state.update { it.copy(ctrlSticky = false) }
    return sendRaw(bytes)
  }

  /**
   * Историята на телефона, не на програмата: за shell, чийто изход е излязъл над екрана.
   * PgUp/PgDn от реда с клавиши отиват към програмата (напр. Claude Code).
   */
  fun scrollHistory(pages: Int) {
    cancelJump()
    session.command(TerminalCommand.ScrollPages(pages))
  }

  fun scrollToBottom() {
    session.command(TerminalCommand.ScrollToBottom)
  }

  /**
   * „Най-долу“: историята на телефона до живия край, после скрол надолу към програмата на
   * пакети от [JUMP_LINES] реда, докато идват нови редове — за да покаже Claude Code и другите
   * агенти най-новото. Второ докосване, докато тече, го спира.
   *
   * Дъното се познава по екрана ([TerminalCommand.ReportScreen]), не по `out`: `less` праща
   * байтове и на дъното, а агентът върти spinner. Времето без промяна е според връзката —
   * до [JUMP_FIRST_CHANGE_MS], докато екранът мръдне за първи път, после три пъти колкото е
   * отнело това, между [JUMP_QUIET_MIN_MS] и [JUMP_QUIET_MAX_MS]. Агент, който пише нови
   * редове, не свършва; затова има и таван [JUMP_MAX_MS].
   *
   * Скролът тръгва само ако програмата следи мишката (`programOnly`): иначе страницата не дава
   * байтове, пакетът остава без отговор за [JUMP_REPLY_MS] и скролът спира, без стрелки.
   */
  fun jumpToBottom() {
    if (jumpJob?.isActive == true) {
      cancelJump()
      return
    }
    cancelJump()
    session.command(TerminalCommand.ScrollToBottom)
    if (_state.value.phase !is AttachPhase.Attached) return
    val replies = Channel<String>(Channel.UNLIMITED)
    val signatures = Channel<Int>(Channel.UNLIMITED)
    jumpReplies = replies
    jumpSignatures = signatures
    _state.update { it.copy(jumping = true) }
    jumpJob = viewModelScope.launch {
      try {
        withTimeoutOrNull(JUMP_MAX_MS) { scrollProgramDown(replies, signatures) }
      } finally {
        // Нов „Най-долу“ може вече да тече; неговото състояние не се пипа.
        if (jumpReplies === replies) {
          jumpReplies = null
          jumpSignatures = null
          _state.update { it.copy(jumping = false) }
        }
      }
    }
  }

  private suspend fun scrollProgramDown(replies: Channel<String>, signatures: Channel<Int>) {
    val startedAt = nowMs()
    var lastChangeAt = startedAt
    var quietMs = JUMP_FIRST_CHANGE_MS
    var moved = false
    var last: Int? = null
    while (true) {
      // Отговорите от предишния пакет не бива да минат за отговор на новия.
      while (replies.tryReceive().isSuccess) Unit
      session.command(TerminalCommand.Wheel(up = false, lines = JUMP_LINES, programOnly = true))
      withTimeoutOrNull(JUMP_REPLY_MS) { replies.receive() } ?: return
      delay(JUMP_EVERY_MS)
      while (signatures.tryReceive().isSuccess) Unit
      session.command(TerminalCommand.ReportScreen)
      val signature = withTimeoutOrNull(JUMP_REPLY_MS) { signatures.receive() } ?: return
      val now = nowMs()
      if (last != null && signature != last) {
        if (!moved) {
          moved = true
          quietMs = ((now - startedAt) * 3).coerceIn(JUMP_QUIET_MIN_MS, JUMP_QUIET_MAX_MS)
        }
        lastChangeAt = now
      } else if (now - lastChangeAt >= quietMs) {
        return
      }
      last = signature
    }
  }

  /** Подписът на екрана от страницата, за „Най-долу“. */
  fun onScreenSignature(hash: Int) {
    jumpSignatures?.trySend(hash)
  }

  private fun cancelJump() {
    jumpJob?.cancel()
    jumpJob = null
    jumpReplies = null
    jumpSignatures = null
    _state.update { it.copy(jumping = false) }
  }

  /** Плаващият бутон горе: показва или скрива горната лента. */
  fun toggleTopBar() {
    setBars { it.copy(topBar = !it.topBar) }
  }

  /** Бутонът с клавиатурата: разпъва или прибира полето за писане с реда с клавиши. */
  fun setInputShown(shown: Boolean) {
    setBars { it.copy(input = shown) }
  }

  private fun setBars(change: (TerminalBars) -> TerminalBars) {
    _state.update { it.copy(bars = change(it.bars)) }
  }

  /** „Размер по този екран“: първо страницата мери колко влиза, после [onGrid] праща `resize`. */
  fun fitToScreen() {
    session.command(TerminalCommand.MeasureGrid)
  }

  /**
   * Размерът, който влиза в екрана. Само за закачен таб: host-ът приема `resize` само за свой
   * attach. Отговорът е обикновеният `size` (и при същия размер), а при отказ — `error` с
   * `resize_failed`; стар host не отговаря нищо.
   */
  fun onGrid(cols: Int, rows: Int) {
    if (_state.value.phase !is AttachPhase.Attached) return
    link.send(ResizeRequest(contentId = contentId, cols = cols, rows = rows))
  }

  /** Иска текста на терминала; идва обратно през `onText` на WebView-то. */
  fun requestText() {
    session.command(TerminalCommand.RequestText)
  }

  /**
   * Страницата докладва маркираното (след дълго натискане и плъзгане). `null` — маркираното
   * е изчезнало там (докосване, нов attach) и лентата трябва да се скрие.
   */
  fun onSelection(selection: TerminalSelection?) = session.onSelection(selection)

  /** ◀ ▶ за началото: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionStart(delta: Int) = session.moveSelectionStart(delta)

  /** ◀ ▶ за края: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionEnd(delta: Int) = session.moveSelectionEnd(delta)

  /** „Копирай“ в лентата за маркиране: страницата връща показания текст и маха маркираното. */
  fun copySelection() = session.copySelection()

  fun clearSelection() = session.clearSelection()

  /**
   * Скрол отвъд ръба на историята на телефона (или в TUI без история): същият скрол като
   * от trackpad-а и плаващите бутони ([scrollWheel]), не PgUp / PgDn. Тихо, без съобщение,
   * ако терминалът не е свързан — скролът е жест, не команда.
   */
  fun onOverscroll(up: Boolean) {
    cancelJump()
    if (!overscrollToProgram()) return
    scrollWheel(up)
  }

  /**
   * Плаващите бутони „Скрол нагоре / надолу“: скрол като от trackpad-а, не PgUp / PgDn —
   * в shell PgUp / PgDn вървят по историята на командите. Тихо без attach, както скролът.
   */
  fun scrollWheel(up: Boolean) {
    cancelJump()
    if (_state.value.phase !is AttachPhase.Attached) return
    session.command(TerminalCommand.Wheel(up))
  }

  /** Байтовете, които xterm.js е произвел за скрола от [scrollWheel] (mouse report, стрелки). */
  fun onWheelInput(bytes: String) {
    if (bytes.isEmpty() || _state.value.phase !is AttachPhase.Attached) return
    jumpReplies?.trySend(bytes)
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
    cancelJump()
    if (text.length == 1 && consumeCtrl(text[0])) return
    sendRaw(text)
  }

  /**
   * Знак, написан в полето при включен Ctrl. Връща `true`, ако е изпратен като control
   * код — тогава полето не го показва. Ctrl се изключва след първия знак.
   */
  fun consumeCtrl(ch: Char): Boolean {
    if (!_state.value.ctrlSticky) return false
    cancelJump()
    val code = TerminalKeys.control(ch) ?: return false
    _state.update { it.copy(ctrlSticky = false) }
    sendRaw(code)
    return true
  }

  private fun sendRaw(text: String): Boolean {
    flushPendingEnter()
    // Вход към програмата: първо се показва задържаният изход, иначе отговорът ѝ идва
    // след стария екран.
    session.endPause(OutputPause.EndReason.Input)
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

  /**
   * Екранът е затворен (entry-то е махнато от стека). Терминалът остава жив в пула; дали
   * Mac-ът спира потока, решава пулът (`detach` само без `attach.keep`).
   */
  override fun onCleared() {
    // Излизане веднага след „Прати“: Enter-ът не бива да остане неизпратен в полето на агента.
    flushPendingEnter()
    if (session.observer === mirror) session.observer = null
    pool.leave(contentId, this)
  }

  companion object {
    /** Моделът на Mac-а има до 90 s; малко отгоре за relay-а. */
    const val SUGGEST_TIMEOUT_MS = 100_000L

    /** Над прозореца, в който Claude Code слива бързо дошли парчета в един paste. */
    const val ENTER_DELAY_MS = 150L

    /** Колко често чипът „Пауза“ показва нов размер. */
    const val PAUSE_TICK_MS = TerminalSession.PAUSE_TICK_MS

    /**
     * „Най-долу“: редове скрол в един пакет; mouse report-ът е ~13 байта, 100 са ~1,3 KB.
     * С паузата между пакетите това е ~700 реда в секунда (в emulator-а, с mock-а).
     */
    const val JUMP_LINES = 100

    /** „Най-долу“: пауза между пакетите, за да не се трупа вход в relay-а. */
    const val JUMP_EVERY_MS = 100L

    /** „Най-долу“: таванът за агент, който работи и прерисува постоянно (над 10 000 реда). */
    const val JUMP_MAX_MS = 20_000L

    /**
     * „Най-долу“: толкова се чакат байтовете и подписът от страницата. Те идват от WebView-то
     * на телефона, не от мрежата, затова времето не зависи от връзката.
     */
    const val JUMP_REPLY_MS = 500L

    /** „Най-долу“: първата промяна минава през relay-а и Mac-а; бавна връзка има време. */
    const val JUMP_FIRST_CHANGE_MS = 3_000L

    /** „Най-долу“: границите на времето без нови редове, след което програмата е на дъното. */
    const val JUMP_QUIET_MIN_MS = 400L
    const val JUMP_QUIET_MAX_MS = 2_000L
  }
}
