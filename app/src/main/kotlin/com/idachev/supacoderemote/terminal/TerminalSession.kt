package com.idachev.supacoderemote.terminal

import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.Caps
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Страницата на таба (WebView-то с xterm.js). Пази се със сесията, за да е връщането към таба
 * със същия екран, история и скрол (ДЗ17); унищожава се, когато пулът пусне таба.
 */
interface TerminalPage {
  fun destroy()
}

/** Каквото описва терминала и оцелява при излизане от екрана: връзката, маркираното, „Пауза“. */
data class TerminalSessionState(
  val phase: AttachPhase = AttachPhase.Waiting,
  /** Маркираното с дълго натискане; докато го има, се вижда лентата за маркиране. */
  val selection: TerminalSelection? = null,
  /** „Пауза“: байтовете изход, задържани докато има маркирано; `null` — няма пауза. */
  val pausedBytes: Long? = null,
)

/**
 * Живият терминал на един таб (ДЗ17, ДЗ18): attach-ът му, потокът към страницата с xterm.js,
 * маркираното и „Пауза“. Живее в [TerminalPool], не в екрана, затова връщането към таба е без
 * мрежа: attach-ът стои (`keep`), а изходът, дошъл докато табът е скрит, чака в [HiddenOutput].
 *
 * Размерът винаги е на Mac-а: `attached` и `size` го казват, а телефонът никога не праща свой.
 * `attach` тръгва наново при нова сесия с host-а (само ако табът се вижда — скритите чакат, ДЗ8),
 * при ново зареждане на страницата (тогава екранът е празен) и при показване на таб с „нужен
 * attach“. Всичко тук върви на main нишката (scope-ът на пула), както екраните.
 */
class TerminalSession internal constructor(
  private val link: HostLink,
  val contentId: String,
  private val notices: Notices,
  parentScope: CoroutineScope,
  pauseCapBytes: Long,
  hiddenCapBytes: Long,
  private val events: Events,
) {

  /** Какво пулът трябва да знае, за да пази набора верен. */
  internal interface Events {
    /** `attach` е тръгнал; без [keep] Mac-ът е откачил всички други терминали на връзката. */
    fun attachSent(session: TerminalSession, keep: Boolean)

    /** Mac-ът отказа с `attach_limit` (ДЗ10): пулът се свива, преди attach-ът да тръгне пак. */
    fun attachLimit(session: TerminalSession)

    /** `detached` за скрит таб (ДЗ9): той излиза от набора. */
    fun detachedWhileHidden(session: TerminalSession)
  }

  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val scope = CoroutineScope(parentScope.coroutineContext + job)

  private val _state = MutableStateFlow(TerminalSessionState())
  val state: StateFlow<TerminalSessionState> = _state.asStateFlow()

  /**
   * Екранът, който гледа таба, иска състоянието синхронно — в същото извикване, в което се
   * сменя, иначе проверките му (напр. „свързан ли е“) закъсняват с един кадър.
   */
  internal var observer: ((TerminalSessionState) -> Unit)? = null

  private val _commands = Channel<TerminalCommand>(Channel.UNLIMITED)

  /** Командите към xterm.js. Чете ги само един — страницата на таба. */
  val commands: Flow<TerminalCommand> = _commands.receiveAsFlow()

  /** Екран гледа таба; скрит таб не рисува (ДЗ19). */
  var visible: Boolean = false
    private set

  /** Екранът, който последно е отворил таба; закъсняло излизане на стар екран не се брои. */
  internal var owner: Any? = null

  /** Табът е пуснат от пула; екран, който още го държи, взима нов. */
  var released: Boolean = false
    private set

  /** Страницата на таба; екранът я създава при първото показване. Пуснат таб я унищожава веднага. */
  var page: TerminalPage? = null
    set(value) {
      if (released) {
        value?.destroy()
        return
      }
      field = value
    }

  private var webReady = false
  private var attachId: Int? = null

  /** Последният изпратен `attach`; `detach`-ът при пускане е за него. */
  var lastAttachId: Int? = null
    private set

  /** Mac-ът не държи attach за таба (нова сесия, фон, attach без keep на друг таб). */
  internal var needsAttach: Boolean = true
    private set

  /** Сесията с host-а, която табът вече е видял; attach-ът за нея тръгва от [onWebReady]/[show]. */
  private var seenHostSession: Int? = link.hostSession.value

  /** `attach_limit` се опитва наново само веднъж на attach. */
  private var limitRetried = false
  private val pause = OutputPause(pauseCapBytes)
  private val hidden = HiddenOutput(hiddenCapBytes)
  private var pauseTicker: Job? = null

  init {
    scope.launch { link.messages.collect(::onMessage) }
  }

  /** Команда към страницата от екрана (скрол, мярка, текст). */
  fun command(command: TerminalCommand) {
    _commands.trySend(command)
  }

  /**
   * Страницата с xterm.js е заредена. Тя се пази със сесията, затова това е първото зареждане
   * (или ново, ако страницата е създадена наново). Старите команди са за предишната страница,
   * затова се изхвърлят и екранът се иска наново.
   */
  fun onWebReady() {
    webReady = true
    while (_commands.tryReceive().isSuccess) Unit
    // Новата страница е празна и маркирано няма; задържаното ще дойде наново с attach.
    pause.end()
    stopPauseTicker()
    update { it.copy(selection = null) }
    // Скрит таб (страницата се е заредила след излизане от екрана): attach-ът тръгва при
    // показване — оттук при неизвестни caps или стар Mac би бил без keep и би спрял видимия.
    if (visible && link.hostSession.value != null) attach() else markNeedsAttach()
  }

  /** Табът е пред очите: чакащото се пише наведнъж, или attach, ако Mac-ът го е забравил. */
  internal fun show() {
    visible = true
    if (!webReady) return
    if (needsAttach || hidden.overflowed) {
      // Без сесия с host-а attach-ът тръгва с нея ([onHostSession]).
      if (link.hostSession.value != null) attach()
      return
    }
    hidden.drain().forEach {
      when (it) {
        is TerminalCommand.Resize -> showSize(it.cols, it.rows)
        is TerminalCommand.Write -> showOutput(it.b64)
        else -> Unit
      }
    }
  }

  internal fun hide() {
    visible = false
  }

  fun attach() {
    needsAttach = false
    hidden.clear()
    // Без известни caps (нов сокет преди hello) — без keep (ДЗ8b).
    val keep = link.hostCaps.value?.contains(Caps.ATTACH_KEEP) == true
    val id = link.nextId()
    attachId = id
    lastAttachId = id
    update { it.copy(phase = AttachPhase.Attaching) }
    if (!link.send(AttachRequest(id = id, contentId = contentId, keep = if (keep) true else null))) {
      attachId = null
      needsAttach = true
      update { it.copy(phase = AttachPhase.Waiting) }
      return
    }
    events.attachSent(this, keep)
  }

  /** Mac-ът вече не държи attach-а: при показване тръгва нов, а дотогава изход няма. */
  internal fun markNeedsAttach() {
    needsAttach = true
    attachId = null
    hidden.clear()
    update { it.copy(phase = AttachPhase.Waiting) }
  }

  /** Пулът го пуска: `detach` (ако Mac-ът още го държи) и край на събирачите. */
  internal fun release(detach: Boolean) {
    if (released) return
    released = true
    visible = false
    owner = null
    if (detach) link.detach(contentId, lastAttachId)
    job.cancel()
    page?.destroy()
    page = null
  }

  /** Пулът подава сесията с host-а — първо на видимите табове, после на скритите (ПБ1). */
  internal fun onHostSession(session: Int?) {
    // Сесията, в която табът е отворен, не е нова.
    if (session == seenHostSession) return
    seenHostSession = session
    if (session == null) {
      markNeedsAttach()
      return
    }
    // Нова сесия: Mac-ът е забравил attach-овете. Видимият таб ги иска веднага, скритите — чак
    // при показване, за да не дойдат до 4 екрана наведнъж при всеки reconnect (ДЗ8).
    if (visible && webReady) attach() else markNeedsAttach()
  }

  private fun onMessage(message: ServerMessage) {
    when (message) {
      is Attached -> if (message.contentId == contentId) {
        endPause(OutputPause.EndReason.Reattach)
        attachId = null
        limitRetried = false
        // Init чисти терминала, а с него и маркираното.
        update { it.copy(phase = AttachPhase.Attached(message.cols, message.rows), selection = null) }
        command(TerminalCommand.Init(message.cols, message.rows))
      }
      is Output -> if (message.contentId == contentId) {
        if (visible) {
          showOutput(message.b64)
        } else if (!needsAttach) {
          // Над тавана буферът е изхвърлен; при показване екранът идва с нов attach.
          hidden.offer(message.b64)
        }
      }
      is SizeChanged -> if (message.contentId == contentId) {
        if (visible) {
          showSize(message.cols, message.rows)
        } else {
          // Заглавието знае размера веднага; страницата — при показване.
          update { it.copy(phase = AttachPhase.Attached(message.cols, message.rows)) }
          if (!needsAttach) hidden.size(message.cols, message.rows)
        }
      }
      is Detached -> if (message.contentId == contentId) {
        attachId = null
        update { it.copy(phase = AttachPhase.Detached(message.reason?.ifBlank { null } ?: "сесията е спряла")) }
        if (!visible) events.detachedWhileHidden(this)
      }
      is ErrorReply -> onError(message)
      else -> Unit
    }
  }

  private fun onError(message: ErrorReply) {
    // Самото съобщение вече е в snackbar-а (AppContainer); тук само спираме чакането.
    if (message.code == ErrorReply.RESIZE_FAILED && message.contentId == contentId) {
      command(TerminalCommand.ResizeFailed)
    }
    if (message.id == null || message.id != attachId) return
    if (message.code == ErrorReply.ATTACH_LIMIT && !limitRetried) {
      limitRetried = true
      events.attachLimit(this)
      attach()
      return
    }
    attachId = null
    update { it.copy(phase = AttachPhase.Detached(message.message)) }
  }

  private fun showOutput(b64: String) {
    if (!pause.offer(b64)) {
      command(TerminalCommand.Write(b64))
    } else if (pause.overCap) {
      endPause(OutputPause.EndReason.Overflow)
      notices.show("Пауза спря: над ${OutputPause.formatSize(OutputPause.CAP_BYTES)} нов изход, маркирането е отменено")
    } else {
      schedulePauseChip()
    }
  }

  private fun showSize(cols: Int, rows: Int) {
    endPause(OutputPause.EndReason.Resize)
    update { it.copy(phase = AttachPhase.Attached(cols, rows)) }
    command(TerminalCommand.Resize(cols, rows))
  }

  /**
   * Страницата докладва маркираното (след дълго натискане и плъзгане). `null` — маркираното
   * е изчезнало там (докосване, нов attach) и лентата трябва да се скрие.
   */
  fun onSelection(selection: TerminalSelection?) {
    update { it.copy(selection = selection) }
    if (selection != null && !pause.paused) startPause()
    if (selection == null) endPause(OutputPause.EndReason.SelectionGone)
  }

  /** Маркирането започна: изходът спира да се пише, за да не избута маркирания текст. */
  private fun startPause() {
    pause.start()
    update { it.copy(pausedBytes = 0) }
  }

  /** Чипът се обновява най-много веднъж на [PAUSE_TICK_MS], не при всяко `out`. */
  private fun schedulePauseChip() {
    if (pauseTicker != null) return
    pauseTicker = scope.launch {
      delay(PAUSE_TICK_MS)
      pauseTicker = null
      if (pause.paused) update { it.copy(pausedBytes = pause.queuedBytes) }
    }
  }

  /**
   * Край на паузата: задържаният изход се пише по ред, наведнъж. Без [OutputPause.EndReason.Copied]
   * и [OutputPause.EndReason.SelectionGone] маркираното се отменя първо — изходът го мести.
   */
  fun endPause(reason: OutputPause.EndReason) {
    if (!pause.paused) return
    val cancel = reason != OutputPause.EndReason.Copied && reason != OutputPause.EndReason.SelectionGone
    if (cancel && _state.value.selection != null) {
      update { it.copy(selection = null) }
      command(TerminalCommand.ClearSelection)
    }
    stopPauseTicker()
    pause.end().forEach { command(TerminalCommand.Write(it)) }
  }

  private fun stopPauseTicker() {
    pauseTicker?.cancel()
    pauseTicker = null
    update { it.copy(pausedBytes = null) }
  }

  /** ◀ ▶ за началото: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionStart(delta: Int) = adjustSelection { it.moveStart(delta) }

  /** ◀ ▶ за края: една клетка назад (минус) или напред, през края на реда. */
  fun moveSelectionEnd(delta: Int) = adjustSelection { it.moveEnd(delta) }

  private fun adjustSelection(change: (TerminalSelection) -> TerminalSelection) {
    val current = _state.value.selection ?: return
    val next = change(current)
    if (next == current) return
    update { it.copy(selection = next) }
    command(TerminalCommand.Select(next.start, next.end))
  }

  /** „Копирай“ в лентата за маркиране: страницата връща показания текст и маха маркираното. */
  fun copySelection() {
    if (_state.value.selection == null) return
    update { it.copy(selection = null) }
    command(TerminalCommand.CopySelection)
    endPause(OutputPause.EndReason.Copied)
  }

  fun clearSelection() {
    update { it.copy(selection = null) }
    command(TerminalCommand.ClearSelection)
    endPause(OutputPause.EndReason.Cancelled)
  }

  private fun update(change: (TerminalSessionState) -> TerminalSessionState) {
    _state.update(change)
    observer?.invoke(_state.value)
  }

  companion object {
    /** Колко често чипът „Пауза“ показва нов размер. */
    const val PAUSE_TICK_MS = 250L
  }
}
