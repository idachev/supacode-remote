package com.idachev.supacoderemote.ui.terminal

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.layout
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.protocol.ProtocolCodec
import com.idachev.supacoderemote.settings.TextSize
import com.idachev.supacoderemote.terminal.Cell
import com.idachev.supacoderemote.terminal.TerminalCommand
import com.idachev.supacoderemote.terminal.TerminalLinks
import com.idachev.supacoderemote.terminal.TerminalPage
import com.idachev.supacoderemote.terminal.TerminalSelection
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.builtins.serializer

/** Какво страницата казва на екрана, който я показва сега. Екранът се сменя, страницата остава. */
class PageCallbacks(
  val onReady: () -> Unit,
  val onText: (String) -> Unit,
  val onCopy: (String) -> Unit,
  val onOverscroll: (up: Boolean) -> Unit,
  val onInput: (String) -> Unit,
  val onScreenSignature: (Int) -> Unit,
  val onGrid: (cols: Int, rows: Int) -> Unit,
  val onGridEstimate: (cols: Int, rows: Int) -> Unit,
  val onSelection: (TerminalSelection?) -> Unit,
)

/**
 * WebView-то с xterm.js на един таб, пазено с терминала му в пула (ДЗ17). Екранът го закача,
 * докато се вижда, и го откача при излизане, без да го унищожава: връщането към таба е със
 * същия екран, история и скрол, без ново зареждане и без attach.
 *
 * Създава се с [MutableContextWrapper]: WebView, създадено с Activity, би държало старото
 * Activity след завъртане. Докато е закачено, базата е текущото Activity (за `startActivity` на
 * линковете), а откачено — Application-ът.
 *
 * [readyWithoutScreen] — страницата се е заредила, докато никой екран не я показва.
 */
@SuppressLint("SetJavaScriptEnabled")
class TerminalPageView(private val appContext: Context, private val readyWithoutScreen: () -> Unit) : TerminalPage {

  private val context = MutableContextWrapper(appContext)
  private val main = Handler(Looper.getMainLooper())

  /** Колбеците на екрана, който показва страницата; `null` — скрита. */
  var callbacks: PageCallbacks? = null

  /** Страницата е заредена (SupaBridge.ready). Пази се със страницата, не с екрана. */
  var ready by mutableStateOf(false)
    private set

  /** Височината на терминала в страницата (dp); до първия доклад WebView-то е цялото място. */
  var pageHeight by mutableStateOf<Int?>(null)
    private set

  /** Височината на един ред (dp), за отстъпа на цял екран; до първия доклад отстъп няма. */
  var rowHeight by mutableStateOf(0f)
    private set

  /**
   * Екранът, чийто AndroidView държи WebView-то. При бързо „назад и пак напред“ два екрана на
   * същия таб са в композицията наведнъж; командите чете само последният.
   */
  var holder by mutableStateOf<Any?>(null)
    private set

  val webView: WebView = WebView(context).apply {
    configureForTerminal()
    // Методите на моста идват от нишката на WebView-то, не от main.
    addJavascriptInterface(createBridge(), "SupaBridge")
    installSelectionGesture(this)
    loadUrl("file:///android_asset/terminal/index.html")
  }

  /**
   * SupaBridge: каквото страницата казва на приложението. Всеки метод минава към main и оттам
   * към екрана, който показва страницата сега ([callbacks]).
   */
  private fun createBridge(): Any = object {
    @JavascriptInterface
    fun ready() {
      main.post {
        ready = true
        callbacks?.onReady?.invoke() ?: readyWithoutScreen()
      }
    }

    /** Отговорът на `supa.copyText()`: текстът на терминала като обикновен текст. */
    @JavascriptInterface
    fun text(value: String) {
      main.post { callbacks?.onText?.invoke(value) }
    }

    /** „Копирай“ от лентата за маркиране: показаният текст. */
    @JavascriptInterface
    fun copy(value: String) {
      main.post { callbacks?.onCopy?.invoke(value) }
    }

    /**
     * Маркираното след дълго натискане: краищата (включително) и размерът на буфера
     * ([cols] × [rows] с историята), за да не излязат ◀ ▶ извън него.
     */
    @JavascriptInterface
    fun selection(startCol: Int, startRow: Int, endCol: Int, endRow: Int, cols: Int, rows: Int) {
      val value = TerminalSelection.of(Cell(startCol, startRow), Cell(endCol, endRow), cols, rows)
      main.post { callbacks?.onSelection?.invoke(value) }
    }

    /** Маркираното е изчезнало в страницата (тап, reset): лентата се скрива. */
    @JavascriptInterface
    fun selectionGone() {
      main.post { callbacks?.onSelection?.invoke(null) }
    }

    /** Скрол отвъд ръба на историята: "up" / "down" — скрол като от trackpad-а към програмата. */
    @JavascriptInterface
    fun overscroll(direction: String) {
      main.post { callbacks?.onOverscroll?.invoke(direction == "up") }
    }

    /**
     * Височината на терминала (CSS px = dp). WebView-то става точно толкова: така при
     * zoom видимата част не може да излезе в празното извън терминала.
     */
    @JavascriptInterface
    fun height(dp: Int) {
      main.post { pageHeight = dp }
    }

    /** Височината на един ред на терминала (CSS px = dp), за отстъпа на цял екран. */
    @JavascriptInterface
    fun rowHeight(dp: Double) {
      main.post { rowHeight = dp.toFloat() }
    }

    /** Подписът на екрана, поискан от `supa.reportScreen` („Най-долу“). */
    @JavascriptInterface
    fun screenSignature(hash: Int) {
      main.post { callbacks?.onScreenSignature?.invoke(hash) }
    }

    /** Отговорът на `supa.measureGrid`: размерът, който влиза в мястото на терминала. */
    @JavascriptInterface
    fun grid(cols: Int, rows: Int) {
      main.post { callbacks?.onGrid?.invoke(cols, rows) }
    }

    /** Отговорът на `supa.reportGrid`: мярката за нов таб. */
    @JavascriptInterface
    fun gridEstimate(cols: Int, rows: Int) {
      main.post { callbacks?.onGridEstimate?.invoke(cols, rows) }
    }

    /** Байтовете на xterm.js за скрола от `supa.wheel` (mouse report или стрелки). */
    @JavascriptInterface
    fun input(data: String) {
      main.post { callbacks?.onInput?.invoke(data) }
    }

    /**
     * Тап в терминала (`supa.tap`): редът с пренесените му части и индексът на тапнатия знак.
     * Адрес под пръста се отваря в браузъра; иначе тапът не прави нищо.
     */
    @JavascriptInterface
    fun tapText(text: String, index: Int) {
      val url = TerminalLinks.urlAt(text, index) ?: return
      main.post { openInBrowser(context, url) }
    }

    /** Тап по OSC 8 линк (`supa.tap`): адресът от последователността, не от текста. */
    @JavascriptInterface
    fun tapUrl(url: String) {
      main.post { openInBrowser(context, url) }
    }
  }

  /** Екранът [owner] показва страницата: линковете се отварят от неговото Activity. */
  fun attachTo(activity: Context, owner: Any, screen: PageCallbacks) {
    context.baseContext = activity
    holder = owner
    callbacks = screen
  }

  /** Екранът [owner] не я показва вече. Ако по-нов екран вече я е взел — нищо. */
  fun detachFrom(owner: Any) {
    if (holder !== owner) return
    holder = null
    callbacks = null
    (webView.parent as? ViewGroup)?.removeView(webView)
    context.baseContext = appContext
  }

  override fun destroy() {
    holder = null
    callbacks = null
    (webView.parent as? ViewGroup)?.removeView(webView)
    webView.removeJavascriptInterface("SupaBridge")
    webView.destroy()
  }
}

/**
 * Показва [page] — xterm.js от assets в WebView. Няма CDN: всичко е в `assets/terminal/`.
 *
 * [onReady] идва, когато страницата се зареди — тогава екранът е празен и трябва нов `attach`.
 * Страницата се пази с терминала, затова това е само първото показване на таба. Командите се
 * изпълняват едва след това, в реда, в който са дошли, и само докато този екран държи страницата.
 */
@Composable
fun TerminalWebView(
  page: TerminalPageView,
  commands: Flow<TerminalCommand>,
  onReady: () -> Unit,
  modifier: Modifier = Modifier,
  onText: (String) -> Unit = {},
  onCopy: (String) -> Unit = {},
  onOverscroll: (up: Boolean) -> Unit = {},
  onInput: (String) -> Unit = {},
  onScreenSignature: (Int) -> Unit = {},
  /** Колко колони и реда влизат в мястото на терминала (отговорът на `MeasureGrid`). */
  onGrid: (cols: Int, rows: Int) -> Unit = { _, _ -> },
  /**
   * Същата мярка като [onGrid], но сама — при зареждане, смяна на шрифта и на мястото. Само за
   * размера на нов таб: от нея не тръгва `resize`.
   */
  onGridEstimate: (cols: Int, rows: Int) -> Unit = { _, _ -> },
  fontSize: Int = TextSize.FIT,
  onSelection: (TerminalSelection?) -> Unit = {},
  /**
   * Празен ред горе и долу (височината на един ред от страницата): на цял екран заобленият
   * екран и камерата иначе режат буквите на крайните редове.
   */
  rowPadding: Boolean = false,
) {
  val context = LocalContext.current
  val currentOnReady by rememberUpdatedState(onReady)
  val currentOnText by rememberUpdatedState(onText)
  val currentOnCopy by rememberUpdatedState(onCopy)
  val currentOnOverscroll by rememberUpdatedState(onOverscroll)
  val currentOnInput by rememberUpdatedState(onInput)
  val currentOnScreenSignature by rememberUpdatedState(onScreenSignature)
  val currentOnSelection by rememberUpdatedState(onSelection)
  val currentOnGrid by rememberUpdatedState(onGrid)
  val currentOnGridEstimate by rememberUpdatedState(onGridEstimate)
  // Цялото място за терминала (dp), не височината на WebView-то: тя е колкото терминала на Mac-а.
  // Дробно: закръглено надолу до цяло dp, понякога губи ред, който влиза.
  var areaHeight by remember { mutableStateOf(0f) }
  // Този екран като собственик на страницата (виж [TerminalPageView.holder]).
  val owner = remember { Any() }
  val screen = remember {
    PageCallbacks(
      onReady = { currentOnReady() },
      onText = { currentOnText(it) },
      onCopy = { currentOnCopy(it) },
      onOverscroll = { currentOnOverscroll(it) },
      onInput = { currentOnInput(it) },
      onScreenSignature = { currentOnScreenSignature(it) },
      onGrid = { cols, rows -> currentOnGrid(cols, rows) },
      onGridEstimate = { cols, rows -> currentOnGridEstimate(cols, rows) },
      onSelection = { currentOnSelection(it) },
    )
  }
  val webView = page.webView
  val ready = page.ready
  val holding = page.holder === owner

  DisposableEffect(page, context) {
    page.attachTo(context, owner, screen)
    // Откачено, не унищожено: WebView-то живее с терминала в пула.
    onDispose { page.detachFrom(owner) }
  }

  // „Размер на текста“ — и при всяко ново зареждане на страницата (ready).
  LaunchedEffect(page, ready, fontSize, holding) {
    if (ready && holding) webView.evaluateJavascript("supa.fontSize($fontSize)", null)
  }

  // Мярката за нов таб. Пауза, защото мястото се мени на кадри (клавиатурата се отваря), а
  // мярката при „По ширина“ сменя шрифта за миг: мери се само щом мястото спре да се мени.
  LaunchedEffect(page, ready, fontSize, areaHeight, holding) {
    if (!ready || !holding || areaHeight <= 0f) return@LaunchedEffect
    delay(GRID_ESTIMATE_DELAY_MS)
    webView.evaluateJavascript("supa.reportGrid($areaHeight)", null)
  }

  // Каналът с командите има един читател: екранът, който държи страницата сега.
  LaunchedEffect(page, ready, holding) {
    if (!ready || !holding) return@LaunchedEffect
    commands.collect { cmd ->
      // Мястото знае само Compose, затова тази команда носи височината му.
      val js = if (cmd == TerminalCommand.MeasureGrid) "supa.measureGrid($areaHeight)" else cmd.toJs()
      webView.evaluateJavascript(js, null)
    }
  }

  // height е предпочитана височина: по-висок терминал взема цялото място, а страницата показва частта с курсора.
  val size = page.pageHeight?.let { Modifier.height(it.dp) } ?: Modifier.fillMaxHeight()
  // Отстъпът е отвън, височината отвътре: по-висок терминал се свива с двата реда, а
  // страницата вижда новата височина и показва частта с курсора в нея.
  val pad = Modifier.padding(vertical = if (rowPadding) page.rowHeight.dp else 0.dp)
  val density = LocalDensity.current
  // Ограничението отвън, преди височината на WebView-то: това е мястото, което терминалът може да вземе.
  val area = Modifier.layout { measurable, constraints ->
    if (constraints.hasBoundedHeight) areaHeight = with(density) { constraints.maxHeight.toDp().value }
    val placeable = measurable.measure(constraints)
    layout(placeable.width, placeable.height) { placeable.place(0, 0) }
  }
  // Същото WebView при всяко показване: първо се откача от предишния екран, ако още е там.
  AndroidView(
    factory = { webView.also { (it.parent as? ViewGroup)?.removeView(it) } },
    modifier = modifier.then(pad).then(area).then(size),
  )
}

private const val TAG = "TerminalWebView"

private const val GRID_ESTIMATE_DELAY_MS = 500L

/** Настройките на WebView-то за xterm.js: без zoom, без минимален шрифт, без glow на ръба. */
private fun WebView.configureForTerminal() {
  settings.javaScriptEnabled = true
  settings.allowFileAccess = false
  settings.allowContentAccess = false
  // Без zoom: размерът на текста е настройка („Размер на текста“).
  settings.setSupportZoom(false)
  settings.builtInZoomControls = false
  settings.displayZoomControls = false
  settings.useWideViewPort = true
  settings.loadWithOverviewMode = false
  // 120 колони на телефон дават шрифт около 5 px; без това WebView го вдига на 8 px
  // и колоните излизат извън екрана.
  settings.minimumFontSize = 1
  settings.minimumLogicalFontSize = 1
  settings.textZoom = 100
  setBackgroundColor(android.graphics.Color.rgb(0x1e, 0x1e, 0x1e))
  // Без glow / разтягане на WebView-то на ръба; скролът отвъд ръба стига до програмата.
  overScrollMode = android.view.View.OVER_SCROLL_NEVER
  webChromeClient = object : WebChromeClient() {
    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
      Log.d(TAG, "js: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
      return true
    }
  }
}

/**
 * Адресът от терминала в браузъра на телефона. Изходът на програмата не е доверен: проверката
 * за http/https е и тук, точно преди Intent-а. Без `resolveActivity`: без `<queries>` в
 * manifest-а той връща null и линкът никога не би се отворил.
 */
private fun openInBrowser(context: Context, url: String) {
  if (!TerminalLinks.isWebUrl(url)) return
  val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
  try {
    context.startActivity(intent)
  } catch (e: ActivityNotFoundException) {
    // Адресът не се логва: може да носи ключове или лични данни.
    Log.w(TAG, "няма app за линка", e)
  }
}

/**
 * Маркиране с дълго натискане. Хваща се тук, а не в страницата: щом Chromium сам познае
 * дълго натискане, той прекъсва докосването на страницата (touchcancel) и тя не вижда
 * плъзгането. След дългото натискане WebView-то получава CANCEL (страницата спира да
 * скролва), а пръстът движи маркирането в xterm.js. Без дълго натискане докосването е
 * изцяло на WebView-то — скролът и zoom-ът работят както преди.
 */
@SuppressLint("ClickableViewAccessibility")
private fun installSelectionGesture(webView: WebView) {
  var selecting = false
  val detector = GestureDetector(webView.context, object : GestureDetector.SimpleOnGestureListener() {
    override fun onLongPress(e: MotionEvent) {
      selecting = true
      webView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      val cancel = MotionEvent.obtain(e).apply { action = MotionEvent.ACTION_CANCEL }
      webView.onTouchEvent(cancel)
      cancel.recycle()
      webView.evaluateJavascript("supa.selectStart(${e.x},${e.y})", null)
    }

    // Тап без движение (скролът не е тап): ако е по адрес, страницата го дава на SupaBridge.tapText.
    // Събитието остава и за WebView-то.
    override fun onSingleTapUp(e: MotionEvent): Boolean {
      webView.evaluateJavascript("supa.tap(${e.x},${e.y})", null)
      return false
    }
  })
  webView.setOnTouchListener { _, event ->
    if (!selecting) {
      detector.onTouchEvent(event)
      // Дълго натискане тъкмо е започнало: това събитие вече не е за WebView-то.
      return@setOnTouchListener selecting
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> webView.evaluateJavascript("supa.selectMove(${event.x},${event.y})", null)
      // CANCEL също завършва маркирането: лентата трябва да знае докъде е стигнало плъзгането.
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        selecting = false
        webView.evaluateJavascript("supa.selectEnd(${event.x},${event.y})", null)
      }
    }
    true
  }
}

/** JS повикването за една команда. Низът се кодира като JSON, за да е винаги валиден литерал. */
private fun TerminalCommand.toJs(): String = when (this) {
  is TerminalCommand.Init -> "supa.init($cols,$rows)"
  is TerminalCommand.Resize -> "supa.resize($cols,$rows)"
  TerminalCommand.ResizeFailed -> "supa.resizeFailed()"
  is TerminalCommand.ScrollPages -> "supa.scrollPages($pages)"
  TerminalCommand.ScrollToBottom -> "supa.scrollToBottom()"
  is TerminalCommand.Wheel -> "supa.wheel(${if (up) -1 else 1},$lines,$programOnly)"
  TerminalCommand.ReportScreen -> "supa.reportScreen()"
  TerminalCommand.RequestText -> "supa.copyText()"
  TerminalCommand.MeasureGrid -> error("MeasureGrid носи височината на мястото, виж TerminalWebView")
  is TerminalCommand.Select -> "supa.selectRange(${start.col},${start.row},${end.col},${end.row})"
  TerminalCommand.CopySelection -> "supa.copySelection()"
  TerminalCommand.ClearSelection -> "supa.clearSelection()"
  is TerminalCommand.Write -> "supa.write(${ProtocolCodec.json.encodeToString(String.serializer(), b64)})"
}
