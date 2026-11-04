package com.idachev.supacoderemote.ui.terminal

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.util.Log
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.idachev.supacoderemote.protocol.ProtocolCodec
import com.idachev.supacoderemote.terminal.TerminalCommand
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
) {
  val context = LocalContext.current
  val currentOnReady by rememberUpdatedState(onReady)
  var ready by remember { mutableStateOf(false) }
  val main = remember { Handler(Looper.getMainLooper()) }

  val webView = remember {
    WebView(context).apply {
      settings.javaScriptEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      // Pinch zoom на страницата; бутоните за zoom не се показват.
      settings.setSupportZoom(true)
      settings.builtInZoomControls = true
      settings.displayZoomControls = false
      settings.useWideViewPort = true
      settings.loadWithOverviewMode = false
      // 120 колони на телефон дават шрифт около 5 px; без това WebView го вдига на 8 px
      // и колоните излизат извън екрана.
      settings.minimumFontSize = 1
      settings.minimumLogicalFontSize = 1
      settings.textZoom = 100
      setBackgroundColor(android.graphics.Color.rgb(0x1e, 0x1e, 0x1e))
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
      }, "SupaBridge")
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

  LaunchedEffect(webView, ready) {
    if (!ready) return@LaunchedEffect
    commands.collect { cmd -> webView.evaluateJavascript(cmd.toJs(), null) }
  }

  AndroidView(factory = { webView }, modifier = modifier)
}

private const val TAG = "TerminalWebView"

/** JS повикването за една команда. Низът се кодира като JSON, за да е винаги валиден литерал. */
private fun TerminalCommand.toJs(): String = when (this) {
  is TerminalCommand.Init -> "supa.init($cols,$rows)"
  is TerminalCommand.Resize -> "supa.resize($cols,$rows)"
  is TerminalCommand.ScrollPages -> "supa.scrollPages($pages)"
  TerminalCommand.ScrollToBottom -> "supa.scrollToBottom()"
  is TerminalCommand.Write -> "supa.write(${ProtocolCodec.json.encodeToString(String.serializer(), b64)})"
}
