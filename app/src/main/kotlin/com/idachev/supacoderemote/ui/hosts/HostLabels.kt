package com.idachev.supacoderemote.ui.hosts

import com.idachev.supacoderemote.protocol.HostInfo

/** Текстовете за Mac-овете (АН5 в дизайна). Отделно от Compose, за да се тестват. */
object HostLabels {

  const val UNNAMED = "Mac без име"

  fun displayName(name: String?): String = name?.trim()?.takeIf { it.isNotEmpty() } ?: UNNAMED

  /**
   * Името на свързания Mac: от списъка на relay-а, защото преименуване идва само там; от
   * `hello` при стар relay. `null`, докато няма нито едно.
   */
  fun boundName(hosts: List<HostInfo>, boundHostId: String?, helloName: String?): String? =
    hosts.firstOrNull { it.id == boundHostId }?.let { displayName(it.name) } ?: helloName

  fun status(online: Boolean): String = if (online) "на линия" else "извън линия"

  fun offlineBanner(name: String): String = "$name е извън линия"
}
