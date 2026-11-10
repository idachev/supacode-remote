package com.idachev.supacoderemote.ui.hosts

import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.idachev.supacoderemote.protocol.HostInfo
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.LocalAppContainer

/**
 * „Mac-ове“: всички Mac-ове, които relay-ят познава, с „на линия“ / „извън линия“. Свързаният е
 * „избран“. Изборът е нова връзка ([com.idachev.supacoderemote.relay.RelayClient.selectHost]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(canGoBack: Boolean, onBack: () -> Unit, onPick: (String) -> Unit) {
  val relay = LocalAppContainer.current.relay
  val hosts by relay.hosts.collectAsStateWithLifecycle()
  val bound by relay.boundHostId.collectAsStateWithLifecycle()

  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = { Text("Mac-ове") },
          navigationIcon = { if (canGoBack) TextButton(onClick = onBack) { Text("Назад") } },
        )
        ConnectionBanner()
      }
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding)) { HostList(hosts, bound, onPick) }
  }
}

@Composable
private fun HostList(hosts: List<HostInfo>, bound: String?, onPick: (String) -> Unit) {
  if (hosts.isEmpty()) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
      Text("Relay-ят още не познава друг Mac.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    return
  }
  LazyColumn(Modifier.fillMaxSize().testTag("hosts-list")) {
    items(hosts, key = { it.id }) { host -> HostRow(host, selected = host.id == bound) { onPick(host.id) } }
  }
}

@Composable
private fun HostRow(host: HostInfo, selected: Boolean, onClick: () -> Unit) {
  val colors = MaterialTheme.colorScheme
  Surface(
    onClick = onClick,
    shape = RoundedCornerShape(12.dp),
    color = if (selected) colors.secondaryContainer else colors.surfaceContainerHigh,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("host-${host.id}"),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(16.dp)) {
      OnlineDot(host.online)
      Spacer(Modifier.width(12.dp))
      HostText(host, selected, Modifier.weight(1f))
      if (selected) {
        Text("избран", style = MaterialTheme.typography.labelLarge, color = colors.primary)
      }
    }
  }
}

@Composable
private fun HostText(host: HostInfo, selected: Boolean, modifier: Modifier) {
  Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = modifier) {
    Text(
      HostLabels.displayName(host.name),
      style = MaterialTheme.typography.bodyLarge,
      fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    Text(HostLabels.status(host.online), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

/** Основният цвят — на линия, сиво — извън линия. Ползва се и в заглавието на „Сесии“. */
@Composable
fun OnlineDot(online: Boolean, modifier: Modifier = Modifier) {
  val color = if (online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
  Box(modifier.size(10.dp).background(color, CircleShape))
}
