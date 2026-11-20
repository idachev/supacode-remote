package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.LanInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Една отворена LAN връзка (`wss://<addr>:<port>/lan`, TLS 1.3, заковани сертификат).
 * След upgrade-а съобщенията са същият текст като по relay-а.
 */
class LanSession private constructor(private val socket: WebSocket, val address: String) {

  /** Вдига се, щом връзката е паднала — дори преди някой да е видял [Listener.onClosed]. */
  @Volatile var closed: Boolean = false
    private set

  fun send(text: String): Boolean = socket.send(text)

  fun close() {
    socket.close(1000, null)
  }

  /** Веднага, без да чака другата страна — за мълчаща връзка. */
  fun cancel() {
    socket.cancel()
  }

  interface Listener {
    fun onText(session: LanSession, text: String)

    fun onClosed(session: LanSession, reason: String)
  }

  companion object {
    /**
     * Пробва адресите един по един. `null`, ако `fpMac` не е от някой, който знае ключа
     * (тогава не се пробва нищо), или ако никой адрес не мине TLS и upgrade-а. Ключът тръгва
     * само в заявката за upgrade — след като TLS е приел заковани сертификат.
     */
    suspend fun connect(
      http: OkHttpClient,
      info: LanInfo,
      clientKey: String,
      listener: Listener,
      connectTimeout: Duration = Duration.ofMillis(2_500),
    ): LanSession? {
      if (info.fp.isBlank() || !LanTrust.fpMacValid(clientKey, info.fp, info.fpMac)) return null
      val client = LanTrust.pinnedClient(http, info.fp, connectTimeout)
      for (addr in info.addrs) {
        val session = connectOne(client, addr, info.port, clientKey, listener, connectTimeout.toMillis() * 2)
        if (session != null) return session
      }
      return null
    }

    private suspend fun connectOne(
      http: OkHttpClient,
      addr: String,
      port: Int,
      clientKey: String,
      listener: Listener,
      openTimeoutMs: Long,
    ): LanSession? {
      val request = Request.Builder()
        .url("wss://$addr:$port/lan")
        .header("Authorization", "Bearer $clientKey")
        .build()
      val opening = Opening(addr, listener)
      val ws = http.newWebSocket(request, opening)
      val session = withTimeoutOrNull(openTimeoutMs) { opening.ready.await() }
      if (session == null) ws.cancel()
      return session
    }
  }

  /**
   * Сокетът към един адрес: [ready] получава сесията при upgrade или `null`, ако адресът падне
   * преди него. После кадрите и затварянето отиват в [listener].
   */
  private class Opening(private val addr: String, private val listener: Listener) : WebSocketListener() {
    val ready = CompletableDeferred<LanSession?>()
    private var session: LanSession? = null
    private val ended = AtomicBoolean(false)

    override fun onOpen(webSocket: WebSocket, response: Response) {
      val ok = LanSession(webSocket, addr)
      session = ok
      ready.complete(ok)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      session?.let { listener.onText(it, text) }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      end("затворена ($code)")
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      end(t.message ?: t.javaClass.simpleName)
    }

    private fun end(reason: String) {
      if (!ended.compareAndSet(false, true)) return
      ready.complete(null)
      session?.let {
        it.closed = true
        listener.onClosed(it, reason)
      }
    }
  }
}
