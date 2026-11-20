package com.idachev.supacoderemote.ui.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.protocol.TerminalKeys
import com.idachev.supacoderemote.terminal.LiveKeys
import com.idachev.supacoderemote.terminal.TerminalViewModel
import com.idachev.supacoderemote.terminal.TextDiff

/** Полето за писане под терминала: предложенията, редът с клавиши и полето за ред или „Живи клавиши“. */
@Composable
internal fun InputBar(
  vm: TerminalViewModel,
  /** Расте при всяко разпъване с бутона: полето (или „Живи клавиши“) взема фокуса. */
  focusRequest: Int,
  /** Прибира полето и клавиатурата; текстът в полето остава. */
  onCollapse: () -> Unit,
  /** Текстът в полето за ред; държи го екранът, за да оцелее прибирането. */
  fieldState: MutableState<TextFieldValue>,
  ctrlSticky: Boolean,
  liveKeys: Boolean,
  suggesting: Boolean,
  suggestions: List<String>,
  modifier: Modifier = Modifier,
) {
  var field by fieldState
  val focusManager = LocalFocusManager.current
  // Паметта за думата в процес живее с екрана; самото View — само докато режимът е включен.
  val liveKeysInput = remember { LiveKeys(vm::sendLive) }
  var liveView by remember { mutableStateOf<LiveKeysView?>(null) }
  val fieldFocus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current

  // Разпънато с бутона: курсорът в полето и клавиатурата отворена, без второ докосване.
  LaunchedEffect(focusRequest) {
    if (focusRequest == 0) return@LaunchedEffect
    // Полето е добавено в този кадър; фокусът хваща едва след layout-а.
    withFrameNanos { }
    if (liveKeys) {
      liveView?.let { view -> view.post { view.showKeyboard() } }
    } else {
      fieldFocus.requestFocus()
      keyboard?.show()
    }
  }

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
      SuggestionsRow(
        suggestions,
        onPick = { s ->
          // Предложението е за поправяне преди изпращане — значи в полето за ред.
          vm.setLiveKeys(false)
          field = TextFieldValue(s, selection = TextRange(s.length))
        },
        onClear = vm::clearSuggestions,
      )
    }
    KeyRow(vm, ctrlSticky = ctrlSticky, liveKeys = liveKeys, suggesting = suggesting, onCollapse = onCollapse)
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
        modifier = Modifier.weight(1f).focusRequester(fieldFocus).testTag("terminal-input"),
        )
      }
      if (!liveKeys) {
        Button(
          onClick = { if (vm.sendLine(field.text)) field = TextFieldValue("") },
          contentPadding = PaddingValues(horizontal = 12.dp),
          modifier = Modifier.height(40.dp).testTag("terminal-send"),
        ) { Text("Прати") }
      }
    }
  }
}

/** Предложенията от Mac-а над реда с клавиши; [onPick] само пълни полето. */
@Composable
private fun SuggestionsRow(suggestions: List<String>, onPick: (String) -> Unit, onClear: () -> Unit) {
  Row(
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalAlignment = Alignment.CenterVertically,
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).testTag("suggestions"),
  ) {
    suggestions.forEach { s ->
      // Предложението само пълни полето. Праща се едва със „Прати“.
      SuggestionChip(
        onClick = { onPick(s) },
        label = { Text(s, fontFamily = FontFamily.Monospace, maxLines = 1) },
      )
    }
    TextButton(onClick = onClear) { Text("✕") }
  }
}

/** Редът с клавиши: прибиране, „Живи клавиши“, „Предложи“ и клавишите към програмата и историята. */
@Composable
private fun KeyRow(
  vm: TerminalViewModel,
  ctrlSticky: Boolean,
  liveKeys: Boolean,
  suggesting: Boolean,
  onCollapse: () -> Unit,
) {
  Row(
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).testTag("key-row"),
  ) {
    // Прибирането е тук, а не плаващо над терминала: в ниско място бутонът би покрил ▲ ▼.
    FilledTonalIconButton(
      onClick = onCollapse,
      modifier = Modifier.size(36.dp).testTag("input-collapse"),
    ) {
      Icon(TerminalIcons.KeyboardHide, contentDescription = "Скрий полето за писане")
    }
    FilterChip(
      selected = liveKeys,
      onClick = { vm.setLiveKeys(!liveKeys) },
      label = { Text("Живи клавиши") },
      modifier = Modifier.height(36.dp).testTag("live-keys"),
    )
    // В реда с клавиши, а не под „Прати“: там собственикът го натискаше вместо „Прати“.
    SuggestButton(suggesting, onClick = vm::suggest)
    ProgramKeys(vm, ctrlSticky)
    // Историята на телефона (xterm.js), за shell; PgUp, PgDn, Home и End преди нея са за програмата.
    // Повтарят, докато се държат, както ▲ ▼: историята се превърта с много страници.
    RepeatKeyChip("История ↑", tag = "history-up") { vm.scrollHistory(-1) }
    RepeatKeyChip("История ↓", tag = "history-down") { vm.scrollHistory(1) }
    KeyButton("Долу", tag = "history-bottom") { vm.scrollToBottom() }
    KeyButton("⏎") { vm.sendKey(TerminalKeys.ENTER) }
    KeyButton("!") { vm.sendKey("!") }
    KeyButton("/") { vm.sendKey("/") }
  }
}

/** Клавишите към програмата от Esc до End; всеки праща байтовете си веднага. */
@Composable
private fun ProgramKeys(vm: TerminalViewModel, ctrlSticky: Boolean) {
  KeyButton("Esc") { vm.sendKey(TerminalKeys.ESC) }
  KeyButton("Tab") { vm.sendKey(TerminalKeys.TAB) }
  KeyButton("Ctrl", highlighted = ctrlSticky) { vm.toggleCtrl() }
  KeyButton("^C") { vm.sendKey(TerminalKeys.CTRL_C) }
  KeyButton("^D") { vm.sendKey(TerminalKeys.CTRL_D) }
  KeyButton("^L") { vm.sendKey(TerminalKeys.CTRL_L) }
  KeyButton("↑") { vm.sendKey(TerminalKeys.UP) }
  KeyButton("↓") { vm.sendKey(TerminalKeys.DOWN) }
  KeyButton("←") { vm.sendKey(TerminalKeys.LEFT) }
  KeyButton("→") { vm.sendKey(TerminalKeys.RIGHT) }
  KeyButton("PgUp") { vm.sendKey(TerminalKeys.PAGE_UP) }
  KeyButton("PgDn") { vm.sendKey(TerminalKeys.PAGE_DOWN) }
  KeyButton("Home") { vm.sendKey(TerminalKeys.HOME) }
  KeyButton("End") { vm.sendKey(TerminalKeys.END) }
}

/** „Предложи“: предложенията само пълнят полето за ред, нищо не се праща само. */
@Composable
private fun SuggestButton(suggesting: Boolean, onClick: () -> Unit) {
  OutlinedButton(
    onClick = onClick,
    enabled = !suggesting,
    contentPadding = PaddingValues(horizontal = 10.dp),
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

/**
 * На вид като [KeyButton], но повтаря, докато се държи ([repeatPress]). Не е `Button`:
 * неговото докосване би дало второ действие освен това на [repeatPress]. Само за превъртане
 * на историята — клавиш, повторен към агента, би бил много клавиши наведнъж.
 */
@Composable
private fun RepeatKeyChip(label: String, tag: String, onFire: () -> Unit) {
  Surface(
    shape = ButtonDefaults.filledTonalShape,
    color = MaterialTheme.colorScheme.secondaryContainer,
    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
    modifier = Modifier
      .height(36.dp)
      .clip(ButtonDefaults.filledTonalShape)
      .testTag(tag)
      .repeatPress(description = label, onFire = onFire),
  ) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxHeight().padding(horizontal = 10.dp)) {
      Text(label, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelLarge)
    }
  }
}
