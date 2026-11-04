package com.idachev.supacoderemote.ui.worktree

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.idachev.supacoderemote.WorktreeKey
import com.idachev.supacoderemote.protocol.Tab
import com.idachev.supacoderemote.sessions.SessionGroups
import com.idachev.supacoderemote.ui.AgentBadges
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.PathChip
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.PollSessionsWhileVisible
import com.idachev.supacoderemote.ui.WorkingIndicator

/** „Worktree“: табовете на един worktree. Данните са от същия `list`, който пита „Сесии“. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorktreeScreen(key: WorktreeKey, onBack: () -> Unit, onOpenTab: (Tab) -> Unit) {
  val container = LocalAppContainer.current
  val repos by container.sessions.repos.collectAsStateWithLifecycle()
  val refreshing by container.sessions.refreshing.collectAsStateWithLifecycle()
  PollSessionsWhileVisible()
  val worktree = repos?.let { SessionGroups.findWorktree(it, key.repositoryId, key.worktreeId) }

  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = {
            Column {
              Text(worktree?.displayName ?: key.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
              worktree?.branch?.let { Text(it, style = MaterialTheme.typography.labelMedium, maxLines = 1) }
            }
          },
          navigationIcon = { TextButton(onClick = onBack) { Text("Назад") } },
          actions = { PathChip(Modifier.padding(end = 12.dp)) },
        )
        ConnectionBanner()
      }
    },
  ) { padding ->
    PullToRefreshBox(
      isRefreshing = refreshing,
      onRefresh = { container.sessions.refresh(userAction = true) },
      modifier = Modifier.fillMaxSize().padding(padding),
    ) {
      when {
        repos == null -> Centered("Чакам списъка от Mac-а…")
        worktree == null -> Centered("Този worktree вече го няма в Supacode")
        worktree.tabs.isEmpty() -> Centered("Няма табове")
        else -> LazyColumn(Modifier.fillMaxSize()) {
          items(worktree.tabs, key = { it.id }) { tab ->
            TabItem(tab) { onOpenTab(tab) }
            HorizontalDivider()
          }
        }
      }
    }
  }
}

@Composable
private fun Centered(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(text) }
}

@Composable
private fun TabItem(tab: Tab, onClick: () -> Unit) {
  Column(
    verticalArrangement = Arrangement.spacedBy(4.dp),
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 12.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      if (tab.focused) {
        // Табът, който е избран в Supacode на Mac-а.
        Text("●", color = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(6.dp))
      }
      Text(
        tab.title?.ifBlank { null } ?: "Таб",
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = if (tab.focused) FontWeight.SemiBold else FontWeight.Normal,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f, fill = false),
      )
      Spacer(Modifier.width(8.dp))
      WorkingIndicator(tab.working)
      if (tab.readOnly) {
        Spacer(Modifier.width(8.dp))
        Text("само четене", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    AgentBadges(tab.agents)
  }
}
