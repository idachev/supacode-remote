package com.idachev.supacoderemote.relay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.io.encoding.Base64

/** `lan` в отговора на `hello`: къде слуша Mac-ът в локалната мрежа. */
@Serializable
data class LanInfo(val addrs: List<String> = emptyList(), val port: Int)

/**
 * Една отворена и удостоверена LAN връзка (`ws://<addr>:<port>/lan`). Всеки кадър е
 * шифриран: [send] приема същия текст като relay пътя.
 */
class LanSession private constructor(
  private val socket: WebSocket,
  private val sealer: LanFrameSealer,
  val address: String,
) {
  /** Вдига се, щом връзката е паднала — дори преди някой да е видял [Listener.onClosed]. */
  @Volatile var closed: Boolean = false
    private set

  fun send(text: String): Boolean = socket.send(sealer.seal(text.encodeToByteArray()).toByteString())

  fun close() {
    socket.close(1000, null)
  }

  /** Веднага, без да чака другата страна — за мълчаща връзка. */
  fun cancel() {
    socket.cancel()
  }

  /** Кой слуша събитията на сесията след успешното ръкостискане. */
  interface Listener {
    fun onText(session: LanSession, text: String)

    fun onClosed(session: LanSession, reason: String)
  }

  companion object {
    // encodeDefaults: `t` и `v` са стойности по подразбиране, а трябва да тръгнат.
    private val json = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
      explicitNulls = false
    }
    private val random = SecureRandom()

    @Serializable
    private data class Hello(val t: String = "lan.hello", val v: Int = 1, val nonce: String, val proof: String? = null)

    @Serializable
    private data class Auth(val t: String = "lan.auth", val proof: String)

    /**
     * Пробва адресите един по един с кратък таймаут. Връща първата сесия, при която Mac-ът
     * е доказал, че знае ключа, или `null`. Клиентският ключ не се праща — само доказателство.
     */
    suspend fun connect(
      http: OkHttpClient,
      info: LanInfo,
      clientKey: String,
      listener: Listener,
      connectTimeout: Duration = Duration.ofMillis(2_500),
    ): LanSession? {
      val client = http.newBuilder().connectTimeout(connectTimeout).build()
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
      handshakeTimeoutMs: Long,
    ): LanSession? {
      val ready = CompletableDeferred<LanSession?>()
      val clientNonce = ByteArray(LanCrypto.NONCE_BYTES).also(random::nextBytes)
      val request = Request.Builder().url("ws://$addr:$port/lan").build()
      val ws = http.newWebSocket(request, object : WebSocketListener() {
        private var session: LanSession? = null
        private var opener: LanFrameOpener? = null
        private val ended = AtomicBoolean(false)

        override fun onOpen(webSocket: WebSocket, response: Response) {
          webSocket.send(json.encodeToString(Hello.serializer(), Hello(nonce = Base64.encode(clientNonce))))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          // Текст е валиден само веднъж: отговорът на Mac-а в ръкостискането.
          if (session != null) return fail(webSocket, "текстов кадър след ръкостискането")
          val reply = runCatching { json.decodeFromString(Hello.serializer(), text) }.getOrNull()
          val macNonce = reply?.nonce?.let { runCatching { Base64.decode(it) }.getOrNull() }
          val macProof = reply?.proof?.let { runCatching { Base64.decode(it) }.getOrNull() }
          if (reply?.t != "lan.hello" || macNonce?.size != LanCrypto.NONCE_BYTES || macProof == null) {
            return fail(webSocket, "неочакван отговор")
          }
          val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
          if (!LanCrypto.sameBytes(macProof, LanCrypto.proof(keys.proof, LanCrypto.MAC_LABEL))) {
            return fail(webSocket, "Mac-ът не доказа ключа")
          }
          val proof = Base64.encode(LanCrypto.proof(keys.proof, LanCrypto.CLIENT_LABEL))
          webSocket.send(json.encodeToString(Auth.serializer(), Auth(proof = proof)))
          opener = LanFrameOpener(keys.s2c, LanCrypto.S2C)
          val ok = LanSession(webSocket, LanFrameSealer(keys.c2s, LanCrypto.C2S), addr)
          session = ok
          ready.complete(ok)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
          val s = session ?: return fail(webSocket, "шифриран кадър преди ръкостискането")
          val plain = try {
            opener!!.open(bytes.toByteArray())
          } catch (_: GeneralSecurityException) {
            return fail(webSocket, "повреден кадър")
          }
          listener.onText(s, plain.decodeToString())
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

        private fun fail(webSocket: WebSocket, reason: String) {
          webSocket.cancel()
          end(reason)
        }

        private fun end(reason: String) {
          if (!ended.compareAndSet(false, true)) return
          ready.complete(null)
          session?.let {
            it.closed = true
            listener.onClosed(it, reason)
          }
        }
      })
      val session = withTimeoutOrNull(handshakeTimeoutMs) { ready.await() }
      if (session == null) ws.cancel()
      return session
    }
  }
}
