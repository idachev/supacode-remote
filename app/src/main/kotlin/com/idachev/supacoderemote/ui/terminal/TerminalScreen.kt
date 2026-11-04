package com.idachev.supacoderemote.ui.terminal

import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.terminal.LiveKeys
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.idachev.supacoderemote.TerminalKey
import com.idachev.supacoderemote.protocol.TerminalKeys
import com.idachev.supacoderemote.terminal.AttachPhase
import com.idachev.supacoderemote.terminal.TerminalViewModel
import com.idachev.supacoderemote.terminal.TextDiff
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.LocalAppContainer

/** „Терминал“: живият таб от Mac-а, полето за писане, клавишите и „Предложи“. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(key: TerminalKey, onBack: () -> Unit) {
  val container = LocalAppContainer.current
  val vm: TerminalViewModel = viewModel(key = key.contentId) {
    TerminalViewModel(container.relay, container.notices, key.contentId)
  }
  val state by vm.state.collectAsStateWithLifecycle()
  var copyText by remember { mutableStateOf<String?>(null) }

  Scaffold(
    topBar = {
      Column {
        TopAppBar(
          title = {
            Column {
              Text(key.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
              (state.phase as? AttachPhase.Attached)?.let {
                Text("${it.cols} × ${it.rows}", style = MaterialTheme.typography.labelMedium)
              }
            }
          },
          navigationIcon = { TextButton(onClick = onBack) { Text("Назад") } },
          actions = {
            TextButton(
              onClick = vm::requestText,
              enabled = state.phase is AttachPhase.Attached,
              modifier = Modifier.testTag("terminal-copy"),
            ) { Text("Копирай") }
          },
        )
        ConnectionBanner()
      }
    },
    bottomBar = {
      InputBar(
        vm = vm,
        ctrlSticky = state.ctrlSticky,
        liveKeys = state.liveKeys,
        suggesting = state.suggesting,
        suggestions = state.suggestions,
        modifier = Modifier.windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding).background(androidx.compose.ui.graphics.Color(0xFF1E1E1E))) {
      TerminalWebView(
        commands = vm.commands,
        onReady = vm::onWebReady,
        onGone = vm::onWebGone,
        modifier = Modifier.fillMaxSize().testTag("terminal-web"),
        onText = { copyText = it },
      )
      PhaseOverlay(state.phase, onReattach = vm::reattach, modifier = Modifier.align(Alignment.Center))
    }
  }
  copyText?.let { text -> CopyTextDialog(text = text, onDismiss = { copyText = null }) }
}

@Composable
private fun PhaseOverlay(phase: AttachPhase, onReattach: () -> Unit, modifier: Modifier = Modifier) {
  when (phase) {
    is AttachPhase.Attached -> Unit
    AttachPhase.Waiting -> OverlayCard(modifier) { Text("Чакам връзка с Mac-а…") }
    AttachPhase.Attaching -> OverlayCard(modifier) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        Text("Свързване с таба…")
      }
    }
    is AttachPhase.Detached -> OverlayCard(modifier) {
      Text("Потокът спря: ${phase.reason}")
      Button(onClick = onReattach, modifier = Modifier.testTag("terminal-reattach")) { Text("Свържи отново") }
    }
  }
}

@Composable
private fun OverlayCard(modifier: Modifier, content: @Composable () -> Unit) {
  Card(modifier = modifier.padding(24.dp)) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { content() }
  }
}

@Composable
private fun InputBar(
  vm: TerminalViewModel,
  ctrlSticky: Boolean,
  liveKeys: Boolean,
  suggesting: Boolean,
  suggestions: List<String>,
  modifier: Modifier = Modifier,
) {
  var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
  val focusManager = LocalFocusManager.current
  // Паметта за думата в процес живее с екрана; самото View — само докато режимът е включен.
  val liveKeysInput = remember { LiveKeys(vm::sendLive) }
  var liveView by remember { mutableStateOf<LiveKeysView?>(null) }

  // Включени „Живи клавиши“: клавиатурата пише в невидимото поле, а не в полето за ред.
  LaunchedEffect(liveKeys, liveView) {
    val view = liveView ?: return@LaunchedEffect
    if (liveKeys) {
      focusManager.clearFocus()
      // След layout-а, иначе requestFocus на току-що добавено View понякога не хваща.
      view.post { view.showKeyboard() }
    }
  }

  Column(
    verticalArrangement = Arrangement.spacedBy(4.dp),
    modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(6.dp),
  ) {
    if (suggestions.isNotEmpty()) {
      Row(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).testTag("suggestions"),
      ) {
        suggestions.forEach { s ->
          // Предложението само пълни полето. Праща се едва със „Прати“.
          SuggestionChip(
            onClick = {
              // Предложението е за поправяне преди изпращане — значи в полето за ред.
              vm.setLiveKeys(false)
              field = TextFieldValue(s, selection = TextRange(s.length))
            },
            label = { Text(s, fontFamily = FontFamily.Monospace, maxLines = 1) },
          )
        }
        TextButton(onClick = vm::clearSuggestions) { Text("✕") }
      }
    }
    Row(
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).testTag("key-row"),
    ) {
      FilterChip(
        selected = liveKeys,
        onClick = { vm.setLiveKeys(!liveKeys) },
        label = { Text("Живи клавиши") },
        modifier = Modifier.height(36.dp).testTag("live-keys"),
      )
      KeyButton("Esc") { vm.sendKey(TerminalKeys.ESC) }
      KeyButton("Tab") { vm.sendKey(TerminalKeys.TAB) }
      KeyButton("Ctrl", highlighted = ctrlSticky) { vm.toggleCtrl() }
      KeyButton("^C") { vm.sendKey(TerminalKeys.CTRL_C) }
      KeyButton("^D") { vm.sendKey(TerminalKeys.CTRL_D) }
      KeyButton("↑") { vm.sendKey(TerminalKeys.UP) }
      KeyButton("↓") { vm.sendKey(TerminalKeys.DOWN) }
      KeyButton("←") { vm.sendKey(TerminalKeys.LEFT) }
      KeyButton("→") { vm.sendKey(TerminalKeys.RIGHT) }
      KeyButton("PgUp") { vm.sendKey(TerminalKeys.PAGE_UP) }
      KeyButton("PgDn") { vm.sendKey(TerminalKeys.PAGE_DOWN) }
      KeyButton("Home") { vm.sendKey(TerminalKeys.HOME) }
      KeyButton("End") { vm.sendKey(TerminalKeys.END) }
      // Историята на телефона (xterm.js), за shell; горните четири са за програмата.
      KeyButton("История ↑", tag = "history-up") { vm.scrollHistory(-1) }
      KeyButton("История ↓", tag = "history-down") { vm.scrollHistory(1) }
      KeyButton("Долу", tag = "history-bottom") { vm.scrollToBottom() }
      KeyButton("⏎") { vm.sendKey(TerminalKeys.ENTER) }
      KeyButton("!") { vm.sendKey("!") }
      KeyButton("/") { vm.sendKey("/") }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      if (liveKeys) {
        LiveKeysArea(
          keys = liveKeysInput,
          ctrlSticky = ctrlSticky,
          onView = { liveView = it },
          modifier = Modifier.weight(1f),
        )
      } else {
        OutlinedTextField(
        value = field,
        onValueChange = { next ->
          // При лепкав Ctrl следващата буква отива като control код, а не в полето.
          val ch = if (ctrlSticky) TextDiff.insertedChar(field.text, next.text) else null
          if (ch == null || !vm.consumeCtrl(ch)) field = next
        },
        placeholder = { Text(if (ctrlSticky) "Ctrl + буква…" else "Текст за терминала") },
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        maxLines = 4,
        modifier = Modifier.weight(1f).testTag("terminal-input"),
        )
      }
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!liveKeys) {
          Button(
            onClick = { if (vm.sendLine(field.text)) field = TextFieldValue("") },
            contentPadding = PaddingValues(horizontal = 12.dp),
            modifier = Modifier.height(40.dp).testTag("terminal-send"),
          ) { Text("Прати") }
        }
        OutlinedButton(
          onClick = vm::suggest,
          enabled = !suggesting,
          contentPadding = PaddingValues(horizontal = 8.dp),
          modifier = Modifier.height(36.dp).testTag("terminal-suggest"),
        ) {
          if (suggesting) {
            CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
            Text(" Мисля…")
          } else {
            Text("Предложи")
          }
        }
      }
    }
  }
}

/**
 * Мястото на полето за ред при „Живи клавиши“: невидимото [LiveKeysView] върху надпис.
 * Докосване показва клавиатурата отново, ако е била скрита.
 */
@Composable
private fun LiveKeysArea(
  keys: LiveKeys,
  ctrlSticky: Boolean,
  onView: (LiveKeysView?) -> Unit,
  modifier: Modifier = Modifier,
) {
  Box(
    contentAlignment = Alignment.CenterStart,
    modifier = modifier
      .height(56.dp)
      .border(1.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(4.dp))
      .padding(horizontal = 12.dp),
  ) {
    Text(
      if (ctrlSticky) "Ctrl + буква…" else "Живи клавиши: всеки знак отива веднага",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    AndroidView(
      factory = { context ->
        LiveKeysView(context, keys).apply {
          setOnClickListener { showKeyboard() }
          onView(this)
        }
      },
      // Режимът е изключен: клавиатурата се скрива с полето, за да не пише в нищото.
      onRelease = { view ->
        view.hideKeyboard()
        onView(null)
      },
      modifier = Modifier.matchParentSize().testTag("live-keys-input"),
    )
  }
}

@Composable
private fun KeyButton(label: String, highlighted: Boolean = false, tag: String = "key-$label", onClick: () -> Unit) {
  val colors = if (highlighted) {
    ButtonDefaults.filledTonalButtonColors(
      containerColor = MaterialTheme.colorScheme.primary,
      contentColor = MaterialTheme.colorScheme.onPrimary,
    )
  } else {
    ButtonDefaults.filledTonalButtonColors()
  }
  FilledTonalButton(
    onClick = onClick,
    colors = colors,
    contentPadding = PaddingValues(horizontal = 10.dp),
    modifier = Modifier.height(36.dp).testTag(tag),
  ) { Text(label, fontFamily = FontFamily.Monospace) }
}
