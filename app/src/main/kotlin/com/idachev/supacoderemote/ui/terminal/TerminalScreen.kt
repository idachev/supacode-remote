package com.idachev.supacoderemote.ui.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.platform.LocalContext
import com.idachev.supacoderemote.Notices
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.terminal.LiveKeys
import com.idachev.supacoderemote.terminal.OutputPause
import androidx.compose.material3.Surface
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
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
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
import com.idachev.supacoderemote.ui.PathChip
import com.idachev.supacoderemote.ui.LocalAppContainer

/** „Терминал“: живият таб от Mac-а, полето за писане, клавишите и „Предложи“. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TerminalScreen(key: TerminalKey, onBack: () -> Unit) {
  val container = LocalAppContainer.current
  val vm: TerminalViewModel = viewModel(key = key.contentId) {
    TerminalViewModel(
      link = container.relay,
      notices = container.notices,
      contentId = key.contentId,
      overscrollToProgram = { container.settingsStore.overscrollToProgram.value },
    )
  }
  val state by vm.state.collectAsStateWithLifecycle()
  val textSize by container.settingsStore.textSize.collectAsStateWithLifecycle()
  val context = LocalContext.current
  var copyText by remember { mutableStateOf<String?>(null) }
  // Расте с всяко докосване на бутона с клавиатурата: само тогава полето взема фокуса и
  // клавиатурата излиза, а не при всяко показване (напр. след завъртане с разпънато поле).
  var focusInput by remember { mutableIntStateOf(0) }
  // Текстът в полето живее тук, а не в InputBar: прибраното поле не губи неизпратеното.
  val field = rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
  val focusManager = LocalFocusManager.current
  val keyboard = LocalSoftwareKeyboardController.current
  val collapseInput = {
    focusManager.clearFocus()
    keyboard?.hide()
    vm.setInputShown(false)
  }
  // Back първо прибира разпънатото поле (текстът остава), едва следващият напуска терминала.
  // Отворена клавиатура взема Back преди това, както винаги.
  BackHandler(enabled = state.bars.input) { collapseInput() }
  // Отворена клавиатура: терминалът скача най-долу, както с „Долу“. Пишеш към последния
  // ред, а местене с пръст или превъртяна история иначе оставят друго място пред очите.
  // Следи се самата клавиатура, за да важи за всеки път: бутона, полето, „Живи клавиши“.
  val imeVisible = WindowInsets.isImeVisible
  LaunchedEffect(imeVisible) { if (imeVisible) vm.scrollToBottom() }

  Scaffold(
    // Тъмен фон и под камерата (display cutout): на цял екран там иначе стои светла ивица.
    containerColor = TerminalBackground,
    topBar = {
      // Скрита горна лента: банерът за връзката остава, под status bar-а.
      val insets = if (state.bars.topBar) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars)
      Column(insets) {
        if (state.bars.topBar) TopAppBar(
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
            PathChip()
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
      if (state.bars.input) InputBar(
        vm = vm,
        focusRequest = focusInput,
        onCollapse = collapseInput,
        fieldState = field,
        ctrlSticky = state.ctrlSticky,
        liveKeys = state.liveKeys,
        suggesting = state.suggesting,
        suggestions = state.suggestions,
        modifier = Modifier.windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars)),
      )
    },
  ) { padding ->
    Box(Modifier.fillMaxSize().padding(padding).background(TerminalBackground)) {
      TerminalWebView(
        commands = vm.commands,
        onReady = vm::onWebReady,
        onGone = vm::onWebGone,
        // Долу в мястото: WebView-то е колкото терминала, празното над него е на Box-а.
        modifier = Modifier.fillMaxWidth().align(Alignment.BottomCenter).testTag("terminal-web"),
        onText = { copyText = it },
        onCopy = { text -> copyToClipboard(context, text, container.notices) },
        onOverscroll = vm::onOverscroll,
        onInput = vm::onWheelInput,
        fontSize = textSize,
        onSelection = vm::onSelection,
        // Цял екран (без горната лента и полето за писане): по един празен ред горе и долу.
        rowPadding = !state.bars.topBar && !state.bars.input,
      )
      // Плаващите бутони са в една колона вдясно, а не подравнени поотделно: в ниско място
      // (хоризонтално, с клавиатура) иначе се застъпват и горният прихваща докосванията.
      // Колоната се реже по мястото на терминала, вместо да излиза върху полето за писане.
      Column(
        horizontalAlignment = Alignment.End,
        modifier = Modifier.align(Alignment.CenterEnd).fillMaxHeight().clipToBounds().padding(8.dp),
      ) {
        // Горе: горната лента (заглавие, „Назад“, „Копирай“) се показва само при нужда.
        FloatingBarButton(
          icon = if (state.bars.topBar) TerminalIcons.ArrowUp else TerminalIcons.ArrowDown,
          description = if (state.bars.topBar) "Скрий горната лента" else "Покажи горната лента",
          tag = "float-top-bar",
          onClick = vm::toggleTopBar,
        )
        Spacer(Modifier.weight(1f).heightIn(min = 12.dp))
        // Скрол под палеца, като от trackpad-а (Claude Code го превърта така). PgUp / PgDn са в
        // реда с клавиши: в shell те вървят по историята на командите.
        RepeatKeyButton("▲", description = "Скрол нагоре", tag = "float-scroll-up") { vm.scrollWheel(up = true) }
        Spacer(Modifier.height(12.dp))
        RepeatKeyButton("▼", description = "Скрол надолу", tag = "float-scroll-down") { vm.scrollWheel(up = false) }
        Spacer(Modifier.height(12.dp))
        // Едно докосване до най-новото: историята на телефона и скролът на агента (Claude Code).
        FloatingBarButton(
          icon = TerminalIcons.ToBottom,
          description = "Най-долу",
          tag = "float-to-bottom",
          onClick = vm::jumpToBottom,
        )
        Spacer(Modifier.weight(1f).heightIn(min = 12.dp))
        // Долу: разпъва полето за писане. Разпънато се прибира от реда с клавиши (или с Back),
        // а докато има маркирано, бутонът не се показва, за да не покрива лентата за маркиране.
        // Празното място остава, за да не скачат ▲ ▼.
        if (!state.bars.input && state.selection == null) {
          FloatingBarButton(
            icon = TerminalIcons.Keyboard,
            description = "Покажи полето за писане",
            tag = "float-input",
            onClick = {
              vm.setInputShown(true)
              focusInput++
            },
          )
        } else {
          Spacer(Modifier.size(52.dp))
        }
      }
      // Скрита горна лента: „Назад“ остава горе вляво, защото е най-честото, за което тя се
      // разпъваше. Води направо до табовете, като „Назад“ в лентата.
      if (!state.bars.topBar) {
        FloatingBarButton(
          icon = TerminalIcons.ArrowBack,
          description = "Назад",
          tag = "float-back",
          modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
          onClick = onBack,
        )
      }
      // Маркираното с дълго натискане: лентата е тук, не в страницата, за да не расте с zoom-а.
      if (state.selection != null) {
        SelectionBar(
          onMoveStart = vm::moveSelectionStart,
          onMoveEnd = vm::moveSelectionEnd,
          onCopy = vm::copySelection,
          onCancel = vm::clearSelection,
          modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
        )
      }
      // „Пауза“: изходът се задържа, докато има маркирано; чипът казва колко е чакащото.
      state.pausedBytes?.let { bytes ->
        PauseChip(bytes, modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp))
      }
      PhaseOverlay(state.phase, onReattach = vm::reattach, modifier = Modifier.align(Alignment.Center))
    }
  }
  copyText?.let { text -> CopyTextDialog(text = text, onDismiss = { copyText = null }) }
}

/**
 * Прозрачност на целия плаващ бутон, с иконата: текстът на терминала под него се чете, а
 * бутонът пак се намира с поглед.
 */
private const val FloatingButtonAlpha = 0.6f

/**
 * Полупрозрачен кръгъл бутон за клавиш, който се повтаря, докато се държи: първо веднъж,
 * после след кратка пауза на всеки 150 ms ([repeatPress]).
 */
@Composable
private fun RepeatKeyButton(label: String, description: String, tag: String, onFire: () -> Unit) {
  Box(
    contentAlignment = Alignment.Center,
    modifier = Modifier
      .size(52.dp)
      .alpha(FloatingButtonAlpha)
      .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), CircleShape)
      .testTag(tag)
      .repeatPress(description = description, onFire = onFire),
  ) {
    Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

/** Полупрозрачен кръгъл бутон с икона, със същия размер и вид като ▲ ▼ за скрола. */
@Composable
private fun FloatingBarButton(
  icon: ImageVector,
  description: String,
  tag: String,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  Box(
    contentAlignment = Alignment.Center,
    modifier = modifier
      .size(52.dp)
      .alpha(FloatingButtonAlpha)
      .clip(CircleShape)
      .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
      .clickable(onClickLabel = description, role = Role.Button, onClick = onClick)
      .testTag(tag),
  ) {
    Icon(icon, contentDescription = description, tint = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

/** Малкият чип „Пауза · 12 KB“ горе върху терминала; в Compose, за да не расте с zoom-а. */
@Composable
private fun PauseChip(bytes: Long, modifier: Modifier = Modifier) {
  Surface(
    shape = RoundedCornerShape(12.dp),
    color = MaterialTheme.colorScheme.tertiaryContainer,
    shadowElevation = 4.dp,
    modifier = modifier.testTag("pause-chip"),
  ) {
    Text(
      "Пауза · ${OutputPause.formatSize(bytes)}",
      style = MaterialTheme.typography.labelLarge,
      color = MaterialTheme.colorScheme.onTertiaryContainer,
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
    )
  }
}

/** В системния clipboard. От Android 13 системата сама показва, че е копирано. */
private fun copyToClipboard(context: Context, text: String, notices: Notices) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("terminal", text))
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) notices.show("Копирано")
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
      // Повтарят, докато се държат, както ▲ ▼: историята се превърта с много страници.
      RepeatKeyChip("История ↑", tag = "history-up") { vm.scrollHistory(-1) }
      RepeatKeyChip("История ↓", tag = "history-down") { vm.scrollHistory(1) }
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
        modifier = Modifier.weight(1f).focusRequester(fieldFocus).testTag("terminal-input"),
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

/** Фонът на терминала (като в xterm.js); и празното около него е в този цвят. */
private val TerminalBackground = androidx.compose.ui.graphics.Color(0xFF1E1E1E)
