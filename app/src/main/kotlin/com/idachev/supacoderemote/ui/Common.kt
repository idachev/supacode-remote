package com.idachev.supacoderemote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.idachev.supacoderemote.AppContainer
import com.idachev.supacoderemote.protocol.AgentActivity
import com.idachev.supacoderemote.protocol.AgentBadge
import com.idachev.supacoderemote.relay.ConnectionState
import com.idachev.supacoderemote.relay.LinkPath
import com.idachev.supacoderemote.ui.hosts.HostLabels
import androidx.compose.ui.platform.testTag
import kotlinx.coroutines.delay

val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("AppContainer не е подаден") }

/** Колко често „Сесии“ и „Worktree“ питат за списъка, докато се виждат. */
const val LIST_POLL_MS = 3_000L

/**
 * Пита host-а за списъка веднага и после на всеки [LIST_POLL_MS], само докато екранът
 * се вижда и host-ът е онлайн. Нова сесия с host-а започва цикъла отначало.
 */
@Composable
fun PollSessionsWhileVisible() {
  val container = LocalAppContainer.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val hostSession by container.relay.hostSession.collectAsStateWithLifecycle()
  LaunchedEffect(lifecycle, hostSession) {
    if (hostSession == null) return@LaunchedEffect
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      while (true) {
        container.sessions.refresh()
        delay(LIST_POLL_MS)
      }
    }
  }
}

/** Името на свързания Mac за заглавието и банера — едно правило ([HostLabels.boundName]) за двете. */
@Composable
fun boundHostName(): String? {
  val relay = LocalAppContainer.current.relay
  val hosts by relay.hosts.collectAsStateWithLifecycle()
  val boundHostId by relay.boundHostId.collectAsStateWithLifecycle()
  val hostName by relay.hostName.collectAsStateWithLifecycle()
  return HostLabels.boundName(hosts, boundHostId, hostName)
}

/** Лентата под заглавието: няма връзка, Mac-ът е офлайн, грешен ключ. При добра връзка я няма. */
@Composable
fun ConnectionBanner(modifier: Modifier = Modifier) {
  val relay = LocalAppContainer.current.relay
  val state by relay.state.collectAsStateWithLifecycle()
  val hostOnline by relay.hostOnline.collectAsStateWithLifecycle()
  val path by relay.path.collectAsStateWithLifecycle()
  val boundHostId by relay.boundHostId.collectAsStateWithLifecycle()
  val multiHost by relay.multiHost.collectAsStateWithLifecycle()
  val boundName = boundHostName()
  // По LAN Mac-ът е там, каквото и да казва relay-ът.
  if (path == LinkPath.LAN) return
  val offlineText = when {
    multiHost && boundHostId == null -> "Няма избран Mac"
    else -> boundName?.let { HostLabels.offlineBanner(it) } ?: "Mac-ът е офлайн"
  }
  val text: String = when (val s = state) {
    ConnectionState.Idle -> return
    ConnectionState.Connecting -> "Свързване с relay-а…"
    ConnectionState.Connected -> if (hostOnline) return else offlineText
    is ConnectionState.Waiting -> buildString {
      append("Няма връзка")
      s.reason?.let { append(": ").append(it) }
      if (s.retryInMs > 0) append(". Нов опит след ${(s.retryInMs + 999) / 1000} s")
    }
    ConnectionState.Unauthorized -> "Грешен ключ"
  }
  val offline = state == ConnectionState.Connected
  Surface(
    color = if (offline) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.errorContainer,
    modifier = modifier.fillMaxWidth(),
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
      Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
      if (state is ConnectionState.Waiting) {
        TextButton(onClick = { relay.reconnectNow() }) { Text("Опитай сега") }
      }
    }
  }
}

/** По кой път вървят заявките: „LAN“ (пряко до Mac-а) или „Relay“. Без връзка го няма. */
@Composable
fun PathChip(modifier: Modifier = Modifier) {
  val path by LocalAppContainer.current.relay.path.collectAsStateWithLifecycle()
  val colors = MaterialTheme.colorScheme
  val (label, bg, fg) = when (path) {
    LinkPath.NONE -> return
    LinkPath.LAN -> Triple("LAN", colors.primary, colors.onPrimary)
    LinkPath.RELAY -> Triple("Relay", colors.surfaceVariant, colors.onSurfaceVariant)
  }
  Text(
    label,
    style = MaterialTheme.typography.labelMedium,
    color = fg,
    modifier = modifier
      .background(bg, RoundedCornerShape(8.dp))
      .padding(horizontal = 8.dp, vertical = 2.dp)
      .testTag("path-chip"),
  )
}

/** Малкото въртящо се кръгче за „работи“. */
@Composable
fun WorkingIndicator(working: Boolean, modifier: Modifier = Modifier) {
  if (working) CircularProgressIndicator(strokeWidth = 2.dp, modifier = modifier.size(14.dp))
}

@Composable
fun AgentBadges(agents: List<AgentBadge>, modifier: Modifier = Modifier) {
  if (agents.isEmpty()) return
  FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = modifier) {
    agents.forEach { AgentBadgeChip(it) }
  }
}

/** Агент и какво прави. „Чака вход“ е най-ярката — заради нея се отваря телефонът. */
@Composable
fun AgentBadgeChip(badge: AgentBadge) {
  val activity = AgentActivity.of(badge.activity)
  val colors = MaterialTheme.colorScheme
  val (bg: Color, fg: Color) = when (activity) {
    AgentActivity.AWAITING_INPUT -> colors.tertiary to colors.onTertiary
    // primaryContainer на темата е тъмен, а onPrimaryContainer не е зададен — нечетимо.
    AgentActivity.BUSY -> colors.secondaryContainer to colors.onSecondaryContainer
    AgentActivity.ERROR -> colors.errorContainer to colors.onErrorContainer
    AgentActivity.COMPACTING -> colors.tertiaryContainer to colors.onTertiaryContainer
    AgentActivity.IDLE, AgentActivity.UNKNOWN -> colors.surfaceVariant to colors.onSurfaceVariant
  }
  val label = when (activity) {
    AgentActivity.AWAITING_INPUT -> "чака вход"
    AgentActivity.BUSY -> "работи"
    AgentActivity.ERROR -> "грешка"
    AgentActivity.COMPACTING -> "компактира"
    AgentActivity.IDLE -> "свободен"
    AgentActivity.UNKNOWN -> badge.activity
  }
  Text(
    text = "${badge.agent} · $label",
    style = MaterialTheme.typography.labelMedium,
    color = fg,
    modifier = Modifier
      .background(bg, RoundedCornerShape(8.dp))
      .padding(horizontal = 8.dp, vertical = 2.dp),
  )
}
