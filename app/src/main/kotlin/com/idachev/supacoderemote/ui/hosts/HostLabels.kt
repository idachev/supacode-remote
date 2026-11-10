package com.idachev.supacoderemote.ui.hosts

import com.idachev.supacoderemote.protocol.ErrorReply
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

  /**
   * Редът под името в „Mac-ове“. Версията на Supacode ([app] от `hello`) е само за свързания
   * Mac: за другите телефонът няма `hello`.
   */
  fun status(online: Boolean, app: String?): String {
    val version = app?.trim()?.takeIf { it.isNotEmpty() } ?: return status(online)
    return "${status(online)} · $version"
  }

  /**
   * Текстът на грешка от host-а в snackbar-а. `resize_failed` казва на български какво не е
   * станало и с коя версия на Supacode — причината от Mac-а е кратка, на английски. Непознат
   * код показва самото [ErrorReply.message], както иска протоколът.
   */
  fun error(reply: ErrorReply, app: String?): String {
    val message = reply.message.trim()
    if (reply.code != ErrorReply.RESIZE_FAILED) return message.ifEmpty { "Грешка от host-а" }
    val reason = message.ifEmpty { "Mac-ът не каза защо" }
    val version = app?.trim()?.takeIf { it.isNotEmpty() }
    return if (version == null) "Размерът не се смени: $reason" else "Размерът не се смени: $reason ($version)"
  }

  fun offlineBanner(name: String): String = "$name е извън линия"
}
