package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.ListRequest
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.relay.RelayClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch

/**
 * Последният `list` от host-а. „Сесии“ и „Worktree“ четат оттук и питат на 3 s, докато
 * се виждат, затова отговорът се пази на едно място, а не във всеки екран.
 */
class SessionsRepository(private val relay: RelayClient, scope: CoroutineScope) {

  private val _list = MutableStateFlow<ListReply?>(null)

  /** Целият последен `list` (repository-та и секциите на sidebar-а); `null` преди първия. */
  val list: StateFlow<ListReply?> = _list.asStateFlow()

  private val _repos = MutableStateFlow<List<Repository>?>(null)

  /** `null`, докато не е дошъл първият отговор. */
  val repos: StateFlow<List<Repository>?> = _repos.asStateFlow()

  private val _refreshing = MutableStateFlow(false)
  val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

  init {
    scope.launch {
      relay.messages.filterIsInstance<ListReply>().collect {
        // Без id, за да не будят екраните отговори, които не носят нищо ново.
        _list.value = it.copy(id = null)
        _repos.value = it.repos
        _refreshing.value = false
      }
    }
  }

  /**
   * Пита host-а за списъка. Без онлайн host не праща нищо: relay-ът би отговорил с
   * грешка „host offline“ на всеки 3 s.
   */
  fun refresh(userAction: Boolean = false): Boolean {
    if (relay.hostSession.value == null) {
      if (userAction) _refreshing.value = false
      return false
    }
    if (userAction) _refreshing.value = true
    return relay.send(ListRequest(relay.nextId())).also { if (!it) _refreshing.value = false }
  }
}
