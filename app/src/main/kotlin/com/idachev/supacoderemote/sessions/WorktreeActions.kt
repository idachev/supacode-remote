package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.WorktreeDeleteReply
import com.idachev.supacoderemote.protocol.WorktreeDeleteRequest
import com.idachev.supacoderemote.protocol.WorktreesRefreshRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Изтриване на worktree и „Опресни“ на Mac-а (ЗД13). Живее с приложението, а не с екран: изтриването
 * може да трае минути, а резултатът трябва да стигне до потребителя, където и да е. Всичко
 * към него минава през snackbar-а; грешките с тези кодове [AppContainer] не показва сам.
 */
class WorktreeActions(
  private val link: HostLink,
  private val notices: Notices,
  /** Изтритото изчезва от следващия `list`, затова се пита веднага. */
  private val refreshList: () -> Unit,
  private val scope: CoroutineScope,
  /** К8: Mac-ът отговаря до 300 s за изтриване и до 60 s за опресняване; чакаме малко повече. */
  private val deleteTimeoutMs: Long = DELETE_TIMEOUT_MS,
  private val refreshTimeoutMs: Long = REFRESH_TIMEOUT_MS,
) {

  private class Wait(val worktreeId: String?, val name: String, val session: Int?, val timer: Job)

  private val _deleting = MutableStateFlow<Set<String>>(emptySet())

  /** Worktree-тата, които Mac-ът изтрива сега: редът им показва „Изтривам…“. */
  val deleting: StateFlow<Set<String>> = _deleting.asStateFlow()

  private val _refreshing = MutableStateFlow(false)
  val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

  /**
   * С replay: изтриването може да свърши, докато навигацията не слуша (приложението е във фон);
   * повторно затваряне на вече затворен екран не прави нищо.
   */
  private val _deleted = MutableSharedFlow<String>(replay = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)

  /** Id-тата на изтритите worktree-та: навигацията затваря отворените им екрани. */
  val deleted: SharedFlow<String> = _deleted.asSharedFlow()

  /** Отговорите идват от [scope] (Dispatchers.Default), а натисканията — от главния поток. */
  private val lock = Any()

  /** id на заявка → какво чака. Само под [lock]. */
  private val deletes = mutableMapOf<Int, Wait>()
  private var refreshWait: Pair<Int, Wait>? = null

  init {
    scope.launch { link.messages.collect { synchronized(lock) { onMessage(it) } } }
    // К7: отговорът идва само по връзката на заявката; нова сесия значи, че той няма да дойде.
    scope.launch { link.hostSession.collect { synchronized(lock) { onSession(it) } } }
  }

  fun delete(worktreeId: String, name: String): Unit = synchronized(lock) {
    if (worktreeId in _deleting.value) return
    val session = link.hostSession.value
    if (session == null) {
      notices.show("Няма връзка с Mac-а")
      return
    }
    val id = link.nextId()
    if (!link.send(WorktreeDeleteRequest(id, worktreeId))) {
      notices.show("Няма връзка — не е изпратено")
      return
    }
    val timer = scope.launch {
      delay(deleteTimeoutMs)
      synchronized(lock) { deletes.remove(id)?.let { lostDelete(it) } }
    }
    deletes[id] = Wait(worktreeId, name, session, timer)
    _deleting.value = _deleting.value + worktreeId
  }

  /** `worktrees.refresh`; `false` — не е тръгнал (тогава екранът пита с обикновен `list`). */
  fun refresh(): Boolean = synchronized(lock) {
    if (refreshWait != null) return true
    val session = link.hostSession.value ?: return false
    val id = link.nextId()
    if (!link.send(WorktreesRefreshRequest(id))) return false
    val timer = scope.launch {
      delay(refreshTimeoutMs)
      synchronized(lock) { if (refreshWait?.first == id) finishRefresh(REFRESH_LATER) }
    }
    refreshWait = id to Wait(null, "", session, timer)
    _refreshing.value = true
    return true
  }

  private fun onMessage(message: ServerMessage) {
    when (message) {
      is WorktreeDeleteReply -> deletes.remove(message.id ?: return)?.let { deleted(it, message.worktreeId) }
      is ListReply -> if (message.id != null && refreshWait?.first == message.id) finishRefresh(null)
      is ErrorReply -> onError(message)
      else -> Unit
    }
  }

  private fun onError(error: ErrorReply) {
    val id = error.id ?: return
    if (refreshWait?.first == id) {
      finishRefresh(
        if (error.code == ErrorReply.REFRESH_TIMEOUT) REFRESH_LATER else "Не опресних: ${error.message.ifBlank { "грешка от Mac-а" }}",
      )
      return
    }
    val wait = deletes.remove(id) ?: return
    wait.timer.cancel()
    _deleting.value = _deleting.value - wait.worktreeId.orEmpty()
    if (error.code == ErrorReply.WORKTREE_TIMEOUT) {
      notices.show(DELETE_UNKNOWN)
    } else {
      // `worktree_dirty` изброява файловете; текстът е на Mac-а.
      notices.show("Не изтрих „${wait.name}“: ${error.message.ifBlank { "грешка от Mac-а" }}")
    }
  }

  private fun deleted(wait: Wait, worktreeId: String) {
    wait.timer.cancel()
    _deleting.value = _deleting.value - wait.worktreeId.orEmpty()
    notices.show("Изтрих „${wait.name}“")
    refreshList()
    _deleted.tryEmit(worktreeId)
  }

  private fun lostDelete(wait: Wait) {
    wait.timer.cancel()
    _deleting.value = _deleting.value - wait.worktreeId.orEmpty()
    notices.show(DELETE_UNKNOWN)
  }

  private fun finishRefresh(text: String?) {
    refreshWait?.second?.timer?.cancel()
    refreshWait = null
    _refreshing.value = false
    text?.let(notices::show)
  }

  private fun onSession(session: Int?) {
    deletes.entries.filter { it.value.session != session }.forEach { (id, wait) ->
      deletes.remove(id)
      lostDelete(wait)
    }
    if (refreshWait?.second?.session.let { it != null && it != session }) finishRefresh(null)
  }

  companion object {
    const val DELETE_TIMEOUT_MS = 310_000L
    const val REFRESH_TIMEOUT_MS = 70_000L

    /** К7, К8: таймаут или паднала връзка. Нов опит няма. */
    const val DELETE_UNKNOWN =
      "Mac-ът още изтрива worktree-то или връзката падна. Worktree-то може да изчезне от списъка по-късно."
    const val REFRESH_LATER = "Mac-ът още чете worktree-тата; опитай пак по-късно."
  }
}
