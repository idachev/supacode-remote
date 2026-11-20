package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.DetachRequest
import com.idachev.supacoderemote.protocol.ServerMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** По кой път вървят заявките към host-а в момента. */
enum class LinkPath { NONE, RELAY, LAN }

/** Състоянието на WebSocket-а към relay-а. Дали Mac-ът е там, е отделно: [RelayClient.hostOnline]. */
sealed interface ConnectionState {
  /** Няма настройки или приложението е във фон — не се свързваме. */
  data object Idle : ConnectionState

  data object Connecting : ConnectionState

  data object Connected : ConnectionState

  /** Връзката падна; следващият опит е след [retryInMs]. */
  data class Waiting(val retryInMs: Long, val reason: String?) : ConnectionState

  /** Relay-ът върна 401. Не опитваме пак, докато ключът не се смени. */
  data object Unauthorized : ConnectionState
}

/**
 * Каналът към host-а, както го виждат екраните. Интерфейс, за да се тестват без WebSocket.
 */
interface HostLink {
  /** Всички съобщения от relay-а и host-а в реда на пристигане. */
  val messages: SharedFlow<ServerMessage>

  /** Расте при всяка нова връзка с онлайн host; `null`, докато няма такава. */
  val hostSession: StateFlow<Int?>

  /** `false`, ако връзката не е горе: тогава съобщението не е тръгнало. */
  fun send(message: ClientMessage): Boolean

  /**
   * `detach` от екрана, чийто последен `attach` е [lastAttachId] (`null` — не е правил).
   * Не тръгва, ако след него друг екран е закачил същия терминал.
   */
  fun detach(contentId: String, lastAttachId: Int?): Boolean = send(DetachRequest(contentId))

  /**
   * ДЗ8a: скрит таб след нова сесия — `detach` по пътищата, по които Mac-ът още го държи, освен
   * текущия (relay сокетът при преминаване на LAN). Видимият не минава оттук: неговият стар поток
   * тече до `attached` по новия път ([TerminalStreamGate], АЦ2). По подразбиране нищо — за
   * fake-овете в тестовете, които имат един път.
   */
  fun detachOtherPaths(contentId: String) {}

  /** Id за заявка, която чака отговор със същото `id`. */
  fun nextId(): Int

  /**
   * `caps` от `hello` на сокета, по който вървят заявките сега (relay или LAN). `null` — няма път
   * или `hello` по този сокет още не е дошъл; тогава `watch` и `keep` не се ползват. По
   * подразбиране `null`, за да не се пипат fake-овете в тестовете.
   */
  val hostCaps: StateFlow<Set<String>?> get() = NO_CAPS

  companion object {
    /** Връзка, която не знае `caps` — значи стар Mac. */
    val NO_CAPS: StateFlow<Set<String>?> = MutableStateFlow<Set<String>?>(null).asStateFlow()
  }
}
