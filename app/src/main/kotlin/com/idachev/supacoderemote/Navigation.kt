package com.idachev.supacoderemote

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.idachev.supacoderemote.relay.ConnectionState
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.sessions.SessionsScreen
import com.idachev.supacoderemote.ui.setup.SetupScreen
import com.idachev.supacoderemote.ui.terminal.TerminalScreen
import com.idachev.supacoderemote.ui.worktree.WorktreeScreen

@Composable
fun MainNavigation() {
  val container = LocalAppContainer.current
  val start: NavKey = if (container.settingsStore.settings.value == null) SetupKey() else SessionsKey
  val backStack = rememberNavBackStack(start)
  val snackbar = remember { SnackbarHostState() }
  val connection by container.relay.state.collectAsStateWithLifecycle()

  fun resetTo(key: NavKey) {
    backStack.clear()
    backStack.add(key)
  }

  // 401 от relay-а: ключът е грешен, връщаме към „Настройка“ с обяснение.
  LaunchedEffect(connection) {
    if (connection == ConnectionState.Unauthorized && backStack.lastOrNull() !is SetupKey) {
      resetTo(SetupKey(wrongKey = true))
    }
  }

  LaunchedEffect(Unit) {
    container.notices.messages.collect { snackbar.showSnackbar(it) }
  }

  // Докоснато известие: Сесии → Worktree → Терминал, за да води „Назад“ натам, откъдето
  // потребителят би стигнал до таба и сам.
  val openRequest by container.openTerminalRequests.collectAsStateWithLifecycle()
  LaunchedEffect(openRequest) {
    val request = openRequest ?: return@LaunchedEffect
    container.openTerminalRequests.value = null
    if (container.settingsStore.settings.value == null) return@LaunchedEffect
    backStack.clear()
    backStack.add(SessionsKey)
    if (request.worktreeId.isNotEmpty()) {
      backStack.add(WorktreeKey(request.repositoryId, request.worktreeId, request.worktreeName))
    }
    backStack.add(TerminalKey(request.contentId, request.tabTitle))
  }

  Box(Modifier.fillMaxSize()) {
    NavDisplay(
      backStack = backStack,
      onBack = { if (backStack.size > 1) backStack.removeLastOrNull() },
      // Всеки екран в стека има свой ViewModel; при махане от стека ViewModel-ът се
      // чисти — така терминалът праща `detach`.
      entryDecorators = listOf(
        rememberSaveableStateHolderNavEntryDecorator(),
        rememberViewModelStoreNavEntryDecorator(),
      ),
      entryProvider = entryProvider {
        entry<SetupKey> { key ->
          SetupScreen(
            wrongKey = key.wrongKey,
            canGoBack = backStack.size > 1,
            onBack = { backStack.removeLastOrNull() },
            onSaved = { resetTo(SessionsKey) },
          )
        }
        entry<SessionsKey> {
          SessionsScreen(
            onOpenWorktree = { repoId, wt -> backStack.add(WorktreeKey(repoId, wt.id, wt.displayName)) },
            onOpenSettings = { backStack.add(SetupKey()) },
          )
        }
        entry<WorktreeKey> { key ->
          WorktreeScreen(
            key = key,
            onBack = { backStack.removeLastOrNull() },
            onOpenTab = { tab -> backStack.add(TerminalKey(tab.contentId, tab.title ?: "Таб")) },
          )
        }
        entry<TerminalKey> { key ->
          TerminalScreen(key = key, onBack = { backStack.removeLastOrNull() })
        }
      },
    )
    SnackbarHost(
      hostState = snackbar,
      // Горе, под лентата: долу е полето за писане на терминала.
      modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 56.dp),
    )
  }
}
