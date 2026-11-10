package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.HostInfo
import com.idachev.supacoderemote.protocol.RelayStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Mac-овете на relay-а, както ги вижда телефонът: списъкът, дали relay-ят е нов (има списък) и
 * дали потребителят трябва да избере Mac. Не е thread-safe: [RelayClient] го пази със своя lock.
 */
internal class HostRoster {

  private val _hosts = MutableStateFlow<List<HostInfo>>(emptyList())
  val hosts: StateFlow<List<HostInfo>> = _hosts.asStateFlow()

  private val _multiHost = MutableStateFlow(false)
  val multiHost: StateFlow<Boolean> = _multiHost.asStateFlow()

  private val _pickRequests = MutableStateFlow(0)
  val pickRequests: StateFlow<Int> = _pickRequests.asStateFlow()

  private val _pickPending = MutableStateFlow(false)
  val pickPending: StateFlow<Boolean> = _pickPending.asStateFlow()

  /** Ново `relay`: обновява списъка и решава по [HostChoice]. Питането е веднъж на преход. */
  fun update(saved: String?, status: RelayStatus): HostChoice.Decision {
    _multiHost.value = status.hosts != null
    status.hosts?.let { _hosts.value = it }
    val decision = HostChoice.decide(saved, status)
    when (decision) {
      HostChoice.Decision.AskUser -> askOnce()
      HostChoice.Decision.None -> pickResolved()
      is HostChoice.Decision.Select -> Unit
    }
    return decision
  }

  /** Изборът е направен (от потребителя или сам) — поисканото вече не чака. */
  fun pickResolved() {
    _pickPending.value = false
  }

  /** Друг relay: списъкът на стария не важи, а изборът се пита наново. */
  fun clear() {
    _hosts.value = emptyList()
    _multiHost.value = false
    pickResolved()
  }

  private fun askOnce() {
    if (_pickPending.value) return
    _pickPending.value = true
    _pickRequests.value += 1
  }
}
