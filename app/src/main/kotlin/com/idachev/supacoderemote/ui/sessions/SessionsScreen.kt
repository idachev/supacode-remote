package com.idachev.supacoderemote.ui.sessions

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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.protocol.WorktreeStatus
import com.idachev.supacoderemote.sessions.SessionGroups
import com.idachev.supacoderemote.sessions.SessionRow
import com.idachev.supacoderemote.ui.AgentBadges
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.PathChip
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.PollSessionsWhileVisible
import com.idachev.supacoderemote.ui.WorkingIndicator

/** „Сесии“: repository-тата и техните worktree-та в групите на sidebar-а на Supacode. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(onOpenWorktree: (repositoryId: String, Worktree) -> Unit, onOpenSettings: () -> Unit) {
  val container = LocalAppContainer.current
  val listReply by container.sessions.list.collectAsStateWithLifecycle()
  // Сгънатите групи — изборът на телефона; без избор важи `collapsed` от Mac-а.
  var collapsed by rememberSaveable { mutableStateOf(mapOf<String, Boolean>()) }
  val refreshing by container.sessions.refreshing.collectAsStateWithLifecycle()
  val hostName by container.relay.hostName.collectAsStateWithLifecycle()
  // Търсенето е тук, а не в хранилището: важи само докато екранът е отворен (и при завъртане).
  var query by rememberSaveable { mutableStateOf("") }
  PollSessionsWhileVisible()

  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = {
            Column {
              Text("Сесии")
              hostName?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
            }
          },
          actions = {
            PathChip()
            TextButton(onClick = onOpenSettings) { Text("Настройка") }
          },
        )
        ConnectionBanner()
        SearchField(query, onChange = { query = it })
      }
    },
  ) { padding ->
    PullToRefreshBox(
      isRefreshing = refreshing,
      onRefresh = { container.sessions.refresh(userAction = true) },
      modifier = Modifier.fillMaxSize().padding(padding),
    ) {
      val list = listReply
      if (list == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Чакам списъка от Mac-а…") }
      } else {
        val rows = SessionGroups.rows(list, collapsed, query)
        if (rows.isEmpty() && query.isNotBlank()) {
          Text(
            "Нищо не отговаря на „${query.trim()}“",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(16.dp),
          )
        }
        LazyColumn(Modifier.fillMaxSize().testTag("sessions-list")) {
          items(rows, key = { it.key }) { row ->
            when (row) {
              is SessionRow.SectionHeader -> SectionHeader(row.title)
              is SessionRow.SidebarGroupHeader -> SidebarGroupHeader(row.name, row.collapsed) {
                collapsed = collapsed + (row.id to !row.collapsed)
              }
              is SessionRow.RepositoryHeader -> RepositoryHeader(row.repository.name)
              is SessionRow.GroupHeader -> GroupHeader(row.group)
              is SessionRow.WorktreeRow -> WorktreeItem(row.worktree, row.repositoryName) {
                onOpenWorktree(row.repositoryId, row.worktree)
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Търсене по името на worktree-то и на repository-то. Стои над списъка, а не в него, за
 * да не се изгуби при скрол. „Търси“ на клавиатурата само я прибира: списъкът вече е филтриран.
 */
@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
  val keyboard = LocalSoftwareKeyboardController.current
  OutlinedTextField(
    value = query,
    onValueChange = onChange,
    placeholder = { Text("Търси сесия или repository") },
    singleLine = true,
    trailingIcon = if (query.isEmpty()) null else {
      { TextButton(onClick = { onChange("") }, modifier = Modifier.testTag("sessions-search-clear")) { Text("✕") } }
    },
    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
    modifier = Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp, vertical = 4.dp)
      .testTag("sessions-search"),
  )
}

/** „Active“ / „Pinned“ най-горе, както в sidebar-а на Supacode. */
@Composable
private fun SectionHeader(title: String) {
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    HorizontalDivider()
    Text(
      title.uppercase(),
      style = MaterialTheme.typography.labelLarge,
      fontWeight = FontWeight.Bold,
      color = MaterialTheme.colorScheme.primary,
      modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
    )
  }
}

@Composable
private fun SidebarGroupHeader(name: String, collapsed: Boolean, onToggle: () -> Unit) {
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    HorizontalDivider()
    Text(
      (if (collapsed) "▸ " else "▾ ") + name.uppercase(),
      style = MaterialTheme.typography.labelLarge,
      fontWeight = FontWeight.Bold,
      color = MaterialTheme.colorScheme.secondary,
      modifier = Modifier
        .fillMaxWidth()
        .clickable(onClick = onToggle)
        .padding(horizontal = 16.dp, vertical = 12.dp),
    )
  }
}

@Composable
private fun RepositoryHeader(name: String) {
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    HorizontalDivider()
    Text(
      name,
      style = MaterialTheme.typography.titleMedium,
      fontWeight = FontWeight.Bold,
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
  }
}

@Composable
private fun GroupHeader(group: WorktreeStatus) {
  Text(
    when (group) {
      WorktreeStatus.MAIN -> "Основен"
      WorktreeStatus.PINNED -> "Закачени"
      WorktreeStatus.UNPINNED -> "Активни"
    },
    style = MaterialTheme.typography.labelLarge,
    color = MaterialTheme.colorScheme.primary,
    modifier = Modifier.padding(start = 16.dp, top = 8.dp, bottom = 2.dp),
  )
}

@Composable
private fun WorktreeItem(worktree: Worktree, repositoryName: String?, onClick: () -> Unit) {
  Column(
    verticalArrangement = Arrangement.spacedBy(4.dp),
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 8.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(
        // В Active и Pinned редовете са от различни repository-та.
        repositoryName?.let { "$it · ${worktree.displayName}" } ?: worktree.displayName,
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = if (worktree.focused) FontWeight.SemiBold else FontWeight.Normal,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f, fill = false),
      )
      Spacer(Modifier.width(8.dp))
      WorkingIndicator(worktree.working)
    }
    worktree.branch?.takeIf { it != worktree.displayName }?.let {
      Text(
        it,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    AgentBadges(worktree.tabs.flatMap { it.agents })
  }
}
