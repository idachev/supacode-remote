package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.Caps
import com.idachev.supacoderemote.protocol.WatchRequest
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Решава дали списъкът идва с `watch` (Mac-ът го праща сам при промяна) или „Сесии“ и „Worktree“
 * го питат на 3 s, както преди (ДЗ3).
 *
 * `watch` е на връзката, не на екрана: включен е, докато има сесия с host-а, Mac-ът има `watch` в
 * `caps` на текущия сокет и приложението е пред очите. Във фон спира с `on:false` — известията
 * там питат на 15 s ([com.idachev.supacoderemote.alerts.AgentWatchService]), защото при работещ
 * агент Mac-ът праща списъка на ~2 s, а телефонът във фон не бива да се буди толкова често.
 * Push-овете са `list` с `id:null` и стигат до [SessionsRepository] като всеки отговор.
 */
class ListWatch(
  private val link: HostLink,
  foreground: StateFlow<Boolean>,
  private val refresh: () -> Unit,
  scope: CoroutineScope,
) {

  private val _watching = MutableStateFlow(false)

  /** Mac-ът праща списъка сам; тогава екраните не питат на 3 s. */
  val watching: StateFlow<Boolean> = _watching.asStateFlow()

  /** Сесията, за която е тръгнал `watch` с `on:true`. Пипа се само от събирача долу. */
  private var watchedSession: Int? = null

  init {
    scope.launch {
      combine(link.hostSession, link.hostCaps, foreground) { session, caps, visible ->
        Triple(session, caps, visible)
      }.collect { (session, caps, visible) -> update(session, caps, visible) }
    }
  }

  private fun update(session: Int?, caps: Set<String>?, visible: Boolean) {
    // Нова сесия (reconnect, смяна на пътя): Mac-ът е забравил watch-а заедно със старата връзка,
    // а `on:false` по стария сокет праща RelayClient.
    if (watchedSession != null && watchedSession != session) watchedSession = null
    val wanted = session != null && visible && caps?.contains(Caps.WATCH) == true
    if (wanted && watchedSession == null) {
      if (link.send(WatchRequest(link.nextId(), on = true))) {
        watchedSession = session
        // Първият push може да закъснее (или да не дойде, ако нищо не се мени) — списъкът веднага.
        refresh()
      }
    } else if (!wanted && watchedSession != null) {
      link.send(WatchRequest(link.nextId(), on = false))
      watchedSession = null
    }
    _watching.value = watchedSession != null
  }
}
