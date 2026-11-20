package com.idachev.supacoderemote.ui.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.TerminalKey
import com.idachev.supacoderemote.terminal.AttachPhase
import com.idachev.supacoderemote.terminal.OutputPause
import com.idachev.supacoderemote.terminal.TerminalUiState
import com.idachev.supacoderemote.terminal.TerminalViewModel
import com.idachev.supacoderemote.ui.ConnectionBanner
import com.idachev.supacoderemote.ui.LocalAppContainer
import com.idachev.supacoderemote.ui.PathChip

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
      pool = container.terminalPool,
      overscrollToProgram = { container.settingsStore.overscrollToProgram.value },
    )
  }
  val state by vm.state.collectAsStateWithLifecycle()
  // Табът е видим, докато екранът е в композицията (и след завъртане); иначе е скрит в пула.
  DisposableEffect(vm) {
    vm.onShown()
    onDispose { vm.onHidden() }
  }
  val terminal by vm.terminal.collectAsStateWithLifecycle()
  val appContext = LocalContext.current.applicationContext
  // Страницата живее с терминала (ДЗ17): при връщане към таба е същата, със същия скрол.
  val page = remember(terminal) {
    (terminal.page as? TerminalPageView)
      ?: TerminalPageView(appContext, readyWithoutScreen = terminal::onWebReady).also { terminal.page = it }
  }
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
    topBar = { TerminalTopBar(key.title, state, vm, onBack) },
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
        page = page,
        commands = terminal.commands,
        onReady = vm::onWebReady,
        // Долу в мястото: WebView-то е колкото терминала, празното над него е на Box-а.
        modifier = Modifier.fillMaxWidth().align(Alignment.BottomCenter).testTag("terminal-web"),
        onText = { copyText = it },
        onCopy = { text -> copyToClipboard(context, text, container.notices) },
        onOverscroll = vm::onOverscroll,
        onInput = vm::onWheelInput,
        onScreenSignature = vm::onScreenSignature,
        onGrid = vm::onGrid,
        onGridEstimate = { cols, rows ->
          // С отворено поле за писане (и клавиатура) мястото е много по-ниско, отколкото в новия
          // таб, който се отваря на цял екран; такава мярка не се пази.
          if (!state.bars.input) container.terminalGrid.remember(textSize, cols, rows)
        },
        fontSize = textSize,
        onSelection = vm::onSelection,
        // Цял екран (без горната лента и полето за писане): по един празен ред горе и долу.
        rowPadding = !state.bars.topBar && !state.bars.input,
      )
      FloatingButtons(
        state,
        vm,
        onShowInput = {
          vm.setInputShown(true)
          focusInput++
        },
      )
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

/** Горната лента (заглавие, размер, „Назад“, „Копирай“) и банерът за връзката. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalTopBar(title: String, state: TerminalUiState, vm: TerminalViewModel, onBack: () -> Unit) {
  // Скрита горна лента: банерът за връзката остава, под status bar-а.
  val insets = if (state.bars.topBar) Modifier else Modifier.windowInsetsPadding(WindowInsets.statusBars)
  Column(insets) {
    if (state.bars.topBar) TopAppBar(
      title = { TerminalTitle(title, state.phase as? AttachPhase.Attached, onFitToScreen = vm::fitToScreen) },
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
}

/** Заглавието на таба, размерът на Mac-а и „Размер по този екран“ — последните само при attach. */
@Composable
private fun TerminalTitle(title: String, attached: AttachPhase.Attached?, onFitToScreen: () -> Unit) {
  Column {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
      attached?.let { Text("  ${it.cols} × ${it.rows}", style = MaterialTheme.typography.labelMedium, maxLines = 1) }
    }
    // Само по натискане: телефонът иначе никога не сменя размера на таба на Mac-а.
    if (attached != null) Text(
      "Размер по този екран",
      style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.primary,
      maxLines = 1,
      modifier = Modifier.clickable(onClick = onFitToScreen).testTag("terminal-fit-screen"),
    )
  }
}

/**
 * Плаващите бутони вдясно: горната лента, ▲ ▼, „Най-долу“ и полето за писане. В една колона, а не
 * подравнени поотделно: в ниско място (хоризонтално, с клавиатура) иначе се застъпват и горният
 * прихваща докосванията. Колоната се реже по мястото на терминала, вместо да излиза върху полето
 * за писане.
 */
@Composable
private fun BoxScope.FloatingButtons(state: TerminalUiState, vm: TerminalViewModel, onShowInput: () -> Unit) {
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
    // Докато скролира, свети; второ докосване го спира.
    FloatingBarButton(
      icon = TerminalIcons.ToBottom,
      description = if (state.jumping) "Спри скрола до най-долу" else "Най-долу",
      tag = "float-to-bottom",
      active = state.jumping,
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
        onClick = onShowInput,
      )
    } else {
      Spacer(Modifier.size(52.dp))
    }
  }
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
  /** Нещо, пуснато с бутона, още тече: бутонът е плътен, в основния цвят. */
  active: Boolean = false,
  onClick: () -> Unit,
) {
  val colors = MaterialTheme.colorScheme
  Box(
    contentAlignment = Alignment.Center,
    modifier = modifier
      .size(52.dp)
      .alpha(if (active) 1f else FloatingButtonAlpha)
      .clip(CircleShape)
      .background(if (active) colors.primary else colors.surfaceVariant.copy(alpha = 0.55f))
      .clickable(onClickLabel = description, role = Role.Button, onClick = onClick)
      .testTag(tag),
  ) {
    Icon(icon, contentDescription = description, tint = if (active) colors.onPrimary else colors.onSurfaceVariant)
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

/** Фонът на терминала (като в xterm.js); и празното около него е в този цвят. */
private val TerminalBackground = androidx.compose.ui.graphics.Color(0xFF1E1E1E)
