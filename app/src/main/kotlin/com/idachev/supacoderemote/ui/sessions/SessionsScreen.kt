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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.protocol.WorktreeNewReply
import com.idachev.supacoderemote.protocol.WorktreeStatus
import com.idachev.supacoderemote.relay.LinkPath
import com.idachev.supacoderemote.sessions.NewWorktreeViewModel
import com.idachev.supacoderemote.sessions.SessionGroups
import com.idachev.supacoderemote.sessions.WorktreeName
import com.idachev.supacoderemote.ui.hosts.OnlineDot
import com.idachev.supacoderemote.sessions.SessionRow
import com.idachev.supacoderemote.ui.AgentBadges
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.PathChip
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.PollSessionsWhileVisible
import com.idachev.supacoderemote.ui.WorkingIndicator
import com.idachev.supacoderemote.ui.boundHostName

/** „Сесии“: repository-тата и техните worktree-та в групите на sidebar-а на Supacode. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
  onOpenWorktree: (repositoryId: String, Worktree) -> Unit,
  onOpenSettings: () -> Unit,
  onOpenHosts: () -> Unit,
  /** Mac-ът е създал worktree-то (ЗД11): навигацията го отваря, с първия таб, ако го има. */
  onWorktreeCreated: (WorktreeNewReply) -> Unit,
) {
  val container = LocalAppContainer.current
  val newWorktree: NewWorktreeViewModel = viewModel {
    NewWorktreeViewModel(
      link = container.relay,
      notices = container.notices,
      refresh = { container.sessions.refresh() },
      startGrid = { container.terminalGrid.gridFor(container.settingsStore.textSize.value) },
    )
  }
  val worktreeDialog by newWorktree.dialog.collectAsStateWithLifecycle()
  val createdWorktree by newWorktree.created.collectAsStateWithLifecycle()
  val hostSession by container.relay.hostSession.collectAsStateWithLifecycle()
  LifecycleStartEffect(newWorktree) {
    newWorktree.setVisible(true)
    onStopOrDispose { newWorktree.setVisible(false) }
  }
  LaunchedEffect(createdWorktree) {
    val reply = createdWorktree ?: return@LaunchedEffect
    newWorktree.consumeCreated()
    onWorktreeCreated(reply)
  }
  val listReply by container.sessions.list.collectAsStateWithLifecycle()
  // Сгънатите групи — изборът на телефона; без избор важи `collapsed` от Mac-а.
  var collapsed by rememberSaveable { mutableStateOf(mapOf<String, Boolean>()) }
  val refreshing by container.sessions.refreshing.collectAsStateWithLifecycle()
  // Търсенето е тук, а не в хранилището: важи само докато екранът е отворен (и при завъртане).
  var query by rememberSaveable { mutableStateOf("") }
  PollSessionsWhileVisible()

  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = { SessionsTitle(onOpenHosts) },
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
              is SessionRow.RepositoryHeader -> RepositoryHeader(
                row.repository,
                onNewWorktree = { newWorktree.open(row.repository) }.takeIf { row.repository.canCreateWorktree },
                enabled = hostSession != null && worktreeDialog?.pending != true,
              )
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
  worktreeDialog?.let { dialog ->
    NewWorktreeDialogView(
      dialog = dialog,
      // От пълния списък: при търсене repository-то в редовете носи само намерените worktree-та.
      existing = WorktreeName.existing(listReply?.repos, dialog.repositoryId),
      connected = hostSession != null,
      onName = newWorktree::setName,
      onCreate = { newWorktree.create(WorktreeName.existing(listReply?.repos, dialog.repositoryId)) },
      onDismiss = newWorktree::dismiss,
    )
  }
}

/** „Сесии“ и под него свързаният Mac. */
@Composable
private fun SessionsTitle(onOpenHosts: () -> Unit) {
  val relay = LocalAppContainer.current.relay
  val multiHost by relay.multiHost.collectAsStateWithLifecycle()
  val hostOnline by relay.hostOnline.collectAsStateWithLifecycle()
  val path by relay.path.collectAsStateWithLifecycle()
  Column {
    Text("Сесии")
    HostTitle(
      name = boundHostName(),
      // По LAN Mac-ът е там, каквото и да казва relay-ът.
      online = hostOnline || path == LinkPath.LAN,
      // При стар relay няма списък и няма към какво да се смени.
      onSwitch = if (multiHost) onOpenHosts else null,
    )
  }
}

/**
 * Името на свързания Mac с точка „на линия“. С няколко Mac-а е бутон „Смени Mac-а“ към
 * „Mac-ове“; без избран Mac пише „Избери Mac“.
 */
@Composable
private fun HostTitle(name: String?, online: Boolean, onSwitch: (() -> Unit)?) {
  val label = name ?: if (onSwitch != null) "Избери Mac" else return
  var modifier: Modifier = Modifier.testTag("host-title")
  if (onSwitch != null) {
    modifier = modifier
      .clickable(onClickLabel = "Смени Mac-а", onClick = onSwitch)
      .semantics { contentDescription = "Смени Mac-а" }
  }
  Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
    OnlineDot(online)
    Spacer(Modifier.width(6.dp))
    Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    if (onSwitch != null) Text(" ▾", style = MaterialTheme.typography.labelMedium)
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

/**
 * Repository: тих етикет с папка, без фон и без докосване — за разлика от картите на
 * worktree-тата под него, които се отварят. „+“ вдясно е нов worktree (ЗД11), само щом Mac-ът
 * каже, че може ([onNewWorktree] не е `null`).
 */
@Composable
private fun RepositoryHeader(repository: Repository, onNewWorktree: (() -> Unit)?, enabled: Boolean) {
  val name = repository.name
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    HorizontalDivider()
    // С бутона редът е колкото него (48 dp), затова отстъпите горе и долу са по-малки.
    val button = onNewWorktree != null
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.fillMaxWidth().padding(
        start = 16.dp,
        end = if (button) 4.dp else 16.dp,
        top = if (button) 0.dp else 10.dp,
        bottom = if (button) 0.dp else 4.dp,
      ),
    ) {
      Icon(
        SessionIcons.Repository,
        contentDescription = null,
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(18.dp),
      )
      Spacer(Modifier.width(8.dp))
      Text(
        name,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      if (onNewWorktree != null) {
        IconButton(
          onClick = onNewWorktree,
          enabled = enabled,
          modifier = Modifier.semantics { contentDescription = "Нов worktree в $name" },
        ) {
          Text("+", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
        }
      }
    }
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

/**
 * Worktree: карта с branch икона и › вдясно — ясно е, че се натиска и отваря табовете.
 */
@Composable
private fun WorktreeItem(worktree: Worktree, repositoryName: String?, onClick: () -> Unit) {
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(12.dp),
    color = MaterialTheme.colorScheme.surfaceContainerHigh,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 10.dp, bottom = 10.dp),
    ) {
      Icon(
        SessionIcons.Worktree,
        contentDescription = null,
        tint = MaterialTheme.colorScheme.primary,
        modifier = Modifier.size(20.dp),
      )
      Spacer(Modifier.width(12.dp))
      WorktreeText(worktree, repositoryName, Modifier.weight(1f))
      Icon(
        SessionIcons.Open,
        contentDescription = "Отвори",
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun WorktreeText(worktree: Worktree, repositoryName: String?, modifier: Modifier) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = modifier) {
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
