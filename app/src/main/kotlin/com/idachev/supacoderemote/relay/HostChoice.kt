package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.RelayStatus

/**
 * Какво прави телефонът с поредното `relay` съобщение за избора на Mac (АН2 в дизайна).
 *
 * Записан избор никога не се сменя сам (решение на собственика ОП20): ако Mac-ът липсва в
 * списъка, потребителят избира. Сам телефонът избира само когато няма записан Mac и онлайн е
 * точно един — иначе би трябвало да гадае.
 */
object HostChoice {

  sealed interface Decision {
    /** Нищо за правене: стар relay или записаният Mac е в списъка. */
    data object None : Decision

    /** Връзката да се върже към този Mac и той да се запише. */
    data class Select(val id: String) : Decision

    /** Да се отвори „Mac-ове“. */
    data object AskUser : Decision
  }

  fun decide(saved: String?, status: RelayStatus): Decision {
    // Стар relay: един Mac, без списък; записаният избор чака нов relay.
    val hosts = status.hosts ?: return Decision.None
    if (saved != null) {
      return if (hosts.any { it.id == saved }) Decision.None else Decision.AskUser
    }
    val online = hosts.filter { it.online }
    return if (online.size == 1) Decision.Select(online.single().id) else Decision.AskUser
  }
}
