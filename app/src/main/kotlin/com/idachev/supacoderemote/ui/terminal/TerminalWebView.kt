package com.idachev.supacoderemote.ui.terminal

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.protocol.ProtocolCodec
import com.idachev.supacoderemote.settings.TextSize
import com.idachev.supacoderemote.terminal.Cell
import com.idachev.supacoderemote.terminal.TerminalCommand
import com.idachev.supacoderemote.terminal.TerminalSelection
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.builtins.serializer

/**
 * xterm.js от assets в WebView. Няма CDN: всичко е в `assets/terminal/`.
 *
 * [onReady] идва при всяко зареждане на страницата — тогава екранът е празен и трябва
 * нов `attach`. Командите се изпълняват едва след това, в реда, в който са дошли.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalWebView(
  commands: Flow<TerminalCommand>,
  onReady: () -> Unit,
  onGone: () -> Unit,
  modifier: Modifier = Modifier,
  onText: (String) -> Unit = {},
  onCopy: (String) -> Unit = {},
  onOverscroll: (up: Boolean) -> Unit = {},
  onInput: (String) -> Unit = {},
  fontSize: Int = TextSize.FIT,
  onSelection: (TerminalSelection?) -> Unit = {},
) {
  val context = LocalContext.current
  val currentOnReady by rememberUpdatedState(onReady)
  val currentOnText by rememberUpdatedState(onText)
  val currentOnCopy by rememberUpdatedState(onCopy)
  val currentOnOverscroll by rememberUpdatedState(onOverscroll)
  val currentOnInput by rememberUpdatedState(onInput)
  val currentOnSelection by rememberUpdatedState(onSelection)
  var ready by remember { mutableStateOf(false) }
  // Височината на терминала в страницата (dp); до първия доклад WebView-то е цялото място.
  var pageHeight by remember { mutableStateOf<Int?>(null) }
  val main = remember { Handler(Looper.getMainLooper()) }

  val webView = remember {
    WebView(context).apply {
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
      // Методите на моста идват от нишката на WebView-то, не от main.
      addJavascriptInterface(object {
        @JavascriptInterface
        fun ready() {
          main.post {
            ready = true
            currentOnReady()
          }
        }

        /** Отговорът на `supa.copyText()`: текстът на терминала като обикновен текст. */
        @JavascriptInterface
        fun text(value: String) {
          main.post { currentOnText(value) }
        }

        /** „Копирай“ от лентата за маркиране: показаният текст. */
        @JavascriptInterface
        fun copy(value: String) {
          main.post { currentOnCopy(value) }
        }

        /**
         * Маркираното след дълго натискане: краищата (включително) и размерът на буфера
         * ([cols] × [rows] с историята), за да не излязат ◀ ▶ извън него.
         */
        @JavascriptInterface
        fun selection(startCol: Int, startRow: Int, endCol: Int, endRow: Int, cols: Int, rows: Int) {
          val value = TerminalSelection.of(Cell(startCol, startRow), Cell(endCol, endRow), cols, rows)
          main.post { currentOnSelection(value) }
        }

        /** Маркираното е изчезнало в страницата (тап, reset): лентата се скрива. */
        @JavascriptInterface
        fun selectionGone() {
          main.post { currentOnSelection(null) }
        }

        /** Скрол отвъд ръба на историята: "up" / "down" — скрол като от trackpad-а към програмата. */
        @JavascriptInterface
        fun overscroll(direction: String) {
          main.post { currentOnOverscroll(direction == "up") }
        }

        /**
         * Височината на терминала (CSS px = dp). WebView-то става точно толкова: така при
         * zoom видимата част не може да излезе в празното извън терминала.
         */
        @JavascriptInterface
        fun height(dp: Int) {
          main.post { pageHeight = dp }
        }

        /** Байтовете на xterm.js за скрола от `supa.wheel` (mouse report или стрелки). */
        @JavascriptInterface
        fun input(data: String) {
          main.post { currentOnInput(data) }
        }
      }, "SupaBridge")
      installSelectionGesture(this)
      loadUrl("file:///android_asset/terminal/index.html")
    }
  }

  DisposableEffect(webView) {
    onDispose {
      onGone()
      webView.removeJavascriptInterface("SupaBridge")
      webView.destroy()
    }
  }

  // „Размер на текста“ — и при всяко ново зареждане на страницата (ready).
  LaunchedEffect(webView, ready, fontSize) {
    if (ready) webView.evaluateJavascript("supa.fontSize($fontSize)", null)
  }

  LaunchedEffect(webView, ready) {
    if (!ready) return@LaunchedEffect
    commands.collect { cmd -> webView.evaluateJavascript(cmd.toJs(), null) }
  }

  // height е предпочитана височина: по-висок терминал взема цялото място, а страницата показва частта с курсора.
  val size = pageHeight?.let { Modifier.height(it.dp) } ?: Modifier.fillMaxHeight()
  AndroidView(factory = { webView }, modifier = modifier.then(size))
}

private const val TAG = "TerminalWebView"

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
  is TerminalCommand.ScrollPages -> "supa.scrollPages($pages)"
  TerminalCommand.ScrollToBottom -> "supa.scrollToBottom()"
  is TerminalCommand.Wheel -> "supa.wheel(${if (up) -1 else 1})"
  TerminalCommand.RequestText -> "supa.copyText()"
  is TerminalCommand.Select -> "supa.selectRange(${start.col},${start.row},${end.col},${end.row})"
  TerminalCommand.CopySelection -> "supa.copySelection()"
  TerminalCommand.ClearSelection -> "supa.clearSelection()"
  is TerminalCommand.Write -> "supa.write(${ProtocolCodec.json.encodeToString(String.serializer(), b64)})"
}
