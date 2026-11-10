package com.idachev.supacoderemote

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

/** „Настройка“. [wrongKey] — relay-ът е върнал 401 и ключът трябва да се смени. */
@Serializable data class SetupKey(val wrongKey: Boolean = false) : NavKey

@Serializable data object SessionsKey : NavKey

/** [created] — току-що създаден от телефона (ЗД11): може още да го няма в последния `list`. */
@Serializable
data class WorktreeKey(
  val repositoryId: String,
  val worktreeId: String,
  val title: String,
  val created: Boolean = false,
) : NavKey

@Serializable data class TerminalKey(val contentId: String, val title: String) : NavKey

/** „Mac-ове“: Mac-овете на relay-а и изборът на един от тях. */
@Serializable data object HostsKey : NavKey
