package com.idachev.supacoderemote

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

/** „Настройка“. [wrongKey] — relay-ът е върнал 401 и ключът трябва да се смени. */
@Serializable data class SetupKey(val wrongKey: Boolean = false) : NavKey

@Serializable data object SessionsKey : NavKey

@Serializable data class WorktreeKey(val repositoryId: String, val worktreeId: String, val title: String) : NavKey

@Serializable data class TerminalKey(val contentId: String, val title: String) : NavKey
