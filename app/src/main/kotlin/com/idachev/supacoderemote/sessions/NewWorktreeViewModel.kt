package com.idachev.supacoderemote.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.WorktreeNewReply
import com.idachev.supacoderemote.protocol.WorktreeNewRequest
import com.idachev.supacoderemote.relay.HostLink
import com.idachev.supacoderemote.terminal.GridSize
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Диалогът „Нов worktree“: за кое repository, написаното име, грешката от Mac-а и дали чака. */
data class NewWorktreeDialog(
  val repositoryId: String,
  val repositoryName: String,
  val name: String = "",
  val error: String? = null,
  val pending: Boolean = false,
)

/**
 * „Нов worktree“ (ЗД11): бутонът „+“ на repository-то, `worktree.new` към Mac-а и чакането.
 *
 * Живее с „Сесии“ — дъното на стека, затова отговорът стига тук, дори потребителят да е отишъл
 * в терминал. Затвори ли диалога, докато чака, Mac-ът пак създава: тогава успехът само
 * опреснява списъка, а отказът отива в snackbar-а. Грешките `worktree_*` [AppContainer] не
 * показва сам — те са тук, в диалога, с името, за да се поправи.
 */
class NewWorktreeViewModel(
  private val link: HostLink,
  private val notices: Notices,
  /** Новото worktree е в `list` веднага след отговора, затова се пита веднага. */
  private val refresh: () -> Unit,
  /** К3: Mac-ът отговаря до 310 s; чакаме малко повече, за да дойде първо неговият отговор. */
  private val timeoutMs: Long = TIMEOUT_MS,
  /** Размерът на първия таб — както при „Нов таб“ (АН1); Mac-ът после го сменя със своя. */
  private val startGrid: () -> GridSize? = { null },
) : ViewModel() {

  private val _dialog = MutableStateFlow<NewWorktreeDialog?>(null)
  val dialog: StateFlow<NewWorktreeDialog?> = _dialog.asStateFlow()

  private val _created = MutableStateFlow<WorktreeNewReply?>(null)

  /** Готовото worktree, което екранът да отвори и после да потвърди с [consumeCreated]. */
  val created: StateFlow<WorktreeNewReply?> = _created.asStateFlow()

  private var visible = false
  private var pendingId: Int? = null
  private var pendingSession: Int? = null
  private var timeout: Job? = null

  /** Заявки, чийто диалог е затворен: Mac-ът още ги прави. */
  private val quiet = mutableSetOf<Int>()

  init {
    viewModelScope.launch { link.messages.collect(::onMessage) }
    // К2: отговорът идва само по връзката, по която е тръгнала заявката. Нова сесия с host-а
    // (reconnect, LAN ↔ Relay) значи, че той няма да дойде, а Mac-ът продължава.
    viewModelScope.launch {
      link.hostSession.collect { session ->
        if (pendingId != null && session != pendingSession) fail(UNKNOWN_OUTCOME)
        quiet.clear()
      }
    }
  }

  /**
   * „Сесии“ се вижда ли. Напусне ли го потребителят, докато чака (напр. по известие), заявката
   * става тиха: иначе по-късен успех би го пренесъл в новия терминал, щом се върне.
   */
  fun setVisible(value: Boolean) {
    visible = value
    if (!value && pendingId != null) dismiss()
  }

  fun open(repository: Repository) {
    if (pendingId != null) return
    _dialog.value = NewWorktreeDialog(repository.id, repository.name)
  }

  fun setName(name: String) {
    val d = _dialog.value ?: return
    if (d.pending) return
    _dialog.value = d.copy(name = name, error = null)
  }

  /** [existing] — имената в repository-то от пълния списък; с подсказка заявката не тръгва. */
  fun create(existing: List<String>) {
    val d = _dialog.value ?: return
    if (d.pending || WorktreeName.hint(d.name, existing) != null) return
    val session = link.hostSession.value
    if (session == null) {
      _dialog.value = d.copy(error = "Няма връзка с Mac-а")
      return
    }
    val id = link.nextId()
    val grid = startGrid()
    if (!link.send(WorktreeNewRequest(id, d.repositoryId, d.name.trim(), grid?.cols, grid?.rows))) {
      _dialog.value = d.copy(error = "Няма връзка — не е изпратено")
      return
    }
    pendingId = id
    pendingSession = session
    _dialog.value = d.copy(pending = true, error = null)
    timeout = viewModelScope.launch {
      delay(timeoutMs)
      if (pendingId != id) return@launch
      fail(UNKNOWN_OUTCOME)
      // Връзката е същата: закъснял отговор пак може да дойде и тогава поне опреснява списъка.
      quiet += id
    }
  }

  /** Затваря диалога; ако чака, Mac-ът продължава, а отговорът става тих. */
  fun dismiss() {
    pendingId?.let { quiet += it }
    stopWaiting()
    _dialog.value = null
  }

  fun consumeCreated() {
    _created.value = null
  }

  private fun onMessage(message: ServerMessage) {
    val id = when (message) {
      is WorktreeNewReply -> message.id
      is ErrorReply -> message.id
      else -> null
    } ?: return
    if (quiet.remove(id)) {
      if (message is WorktreeNewReply) {
        refresh()
        notices.show("Worktree-то „${message.name}“ е създадено")
      } else if (message is ErrorReply) {
        notices.show(errorText(message))
      }
      return
    }
    if (id != pendingId) return
    when (message) {
      is WorktreeNewReply -> {
        stopWaiting()
        _dialog.value = null
        refresh()
        if (visible) _created.value = message
      }
      is ErrorReply -> fail(errorText(message))
      else -> Unit
    }
  }

  /** `worktree_timeout` носи английски текст от Mac-а; на потребителя се казва на български. */
  private fun errorText(error: ErrorReply): String =
    if (error.code == ErrorReply.WORKTREE_TIMEOUT) UNKNOWN_OUTCOME else error.message.ifBlank { "Грешка от Mac-а" }

  private fun fail(text: String) {
    stopWaiting()
    _dialog.value = _dialog.value?.copy(pending = false, error = text)
  }

  private fun stopWaiting() {
    pendingId = null
    pendingSession = null
    timeout?.cancel()
    timeout = null
  }

  companion object {
    const val TIMEOUT_MS = 320_000L

    /** Отговорът не дойде: таймаут или паднала връзка (К2, К3, К3a). Без нов опит сам. */
    const val UNKNOWN_OUTCOME =
      "Mac-ът още създава worktree-то или връзката падна. Ако стане, ще се появи в списъка; " +
        "ако не, Mac-ът показва защо. Можеш да опиташ пак със същото име."
  }
}
