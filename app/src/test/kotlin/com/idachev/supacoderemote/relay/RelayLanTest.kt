package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.ListRequest
import com.idachev.supacoderemote.settings.RelaySettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.SecureRandom
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.encoding.Base64

/**
 * Двата пътя заедно: relay (обикновен WebSocket) и LAN (ръкостискане + шифрирани кадри).
 * LAN страната тук е Mac-ът, написан с [LanCrypto] — същите формули, сверени с Node в
 * [LanCryptoTest].
 */
class RelayLanTest {

  private val key = "abcde-fghij"
  private lateinit var relayServer: MockWebServer
  private lateinit var lanServer: MockWebServer
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val timing = RelayClient.Timing(pingIntervalMs = 60_000, firstRetryMs = 50, maxRetryMs = 200, lanRetryFirstMs = 60_000)
  private val clients = mutableListOf<RelayClient>()

  private val fromClientOnRelay = LinkedBlockingQueue<String>()
  private val fromClientOnLan = LinkedBlockingQueue<String>()
  private val lanAuthOk = LinkedBlockingQueue<Boolean>()
  @Volatile private var lanSocket: WebSocket? = null
  private val openSockets = AtomicInteger(0)

  @Before
  fun setUp() {
    relayServer = MockWebServer().apply { start() }
    lanServer = MockWebServer().apply { start() }
  }

  @After
  fun tearDown() {
    clients.forEach { it.setForeground(false) }
    val deadline = System.currentTimeMillis() + 5_000
    while (openSockets.get() > 0 && System.currentTimeMillis() < deadline) Thread.yield()
    scope.cancel()
    relayServer.close()
    lanServer.close()
  }

  private fun hello(withLan: Boolean): String {
    val lan = if (withLan) ""","lan":{"addrs":["${lanServer.hostName}"],"port":${lanServer.port}}""" else ""
    return """{"t":"hello","v":1,"host":"Test Mac"$lan}"""
  }

  private fun relayHost(withLan: Boolean): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      webSocket.send("""{"t":"relay","hostOnline":true}""")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClientOnRelay.put(text)
      if (text.contains("\"hello\"")) webSocket.send(hello(withLan))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      openSockets.decrementAndGet()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      openSockets.decrementAndGet()
    }
  }).build()

  /** Mac-ът на LAN. С [macKey] различен от клиентския ключ доказателството му е грешно. */
  private fun lanHost(macKey: String = key): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    private var keys: LanCrypto.Keys? = null
    private var opener: LanFrameOpener? = null
    private var sealer: LanFrameSealer? = null

    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      lanSocket = webSocket
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      val obj = Json.parseToJsonElement(text).jsonObject
      when (obj["t"]?.jsonPrimitive?.content) {
        "lan.hello" -> {
          val clientNonce = Base64.decode(obj["nonce"]!!.jsonPrimitive.content)
          val macNonce = ByteArray(16).also(SecureRandom()::nextBytes)
          val k = LanCrypto.deriveKeys(macKey, clientNonce, macNonce)
          keys = k
          val proof = Base64.encode(LanCrypto.proof(k.proof, LanCrypto.MAC_LABEL))
          webSocket.send("""{"t":"lan.hello","v":1,"nonce":"${Base64.encode(macNonce)}","proof":"$proof"}""")
        }
        "lan.auth" -> {
          val k = keys!!
          val ok = LanCrypto.sameBytes(
            Base64.decode(obj["proof"]!!.jsonPrimitive.content),
            LanCrypto.proof(k.proof, LanCrypto.CLIENT_LABEL),
          )
          lanAuthOk.put(ok)
          opener = LanFrameOpener(k.c2s, LanCrypto.C2S)
          sealer = LanFrameSealer(k.s2c, LanCrypto.S2C)
        }
      }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      val text = opener!!.open(bytes.toByteArray()).decodeToString()
      fromClientOnLan.put(text)
      if (text.contains("\"hello\"")) {
        webSocket.send(sealer!!.seal("""{"t":"hello","v":1,"host":"Test Mac"}""".encodeToByteArray()).toByteString())
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      openSockets.decrementAndGet()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      openSockets.decrementAndGet()
    }
  }).build()

  private fun client(): RelayClient = RelayClient(OkHttpClient(), scope, timing).also {
    clients += it
    it.configure(RelaySettings("http://${relayServer.hostName}:${relayServer.port}", key))
    it.setForeground(true)
  }

  private fun next(queue: LinkedBlockingQueue<String>): String = queue.poll(5, TimeUnit.SECONDS) ?: error("нищо")

  @Test
  fun `без lan в hello няма опит за LAN`() = runBlocking<Unit> {
    relayServer.enqueue(relayHost(withLan = false))
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    assertEquals("""{"t":"hello","v":1}""", next(fromClientOnRelay))
    relay.send(ListRequest(7))
    assertEquals("""{"t":"list","id":7}""", next(fromClientOnRelay))
    assertEquals(0, lanServer.requestCount)
  }

  @Test
  fun `с lan заявките минават по LAN, а при паднал LAN — пак по relay-а`() = runBlocking<Unit> {
    relayServer.enqueue(relayHost(withLan = true))
    lanServer.enqueue(lanHost())
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.LAN } }
    val lanSession = relay.hostSession.value!!
    assertTrue(lanAuthOk.poll(5, TimeUnit.SECONDS)!!)
    // Ключът не минава по LAN: в заявката няма Authorization.
    assertEquals(null, lanServer.takeRequest().headers["Authorization"])
    assertEquals("""{"t":"hello","v":1}""", next(fromClientOnLan))

    relay.send(ListRequest(8))
    assertEquals("""{"t":"list","id":8}""", next(fromClientOnLan))

    // LAN пада: обратно на relay-а с нова сесия (терминалът прави attach наново).
    lanSocket!!.close(1001, "bye")
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    assertTrue(relay.hostSession.value!! > lanSession)
    fromClientOnRelay.clear()
    relay.send(ListRequest(9))
    assertEquals("""{"t":"list","id":9}""", next(fromClientOnRelay))
  }

  @Test
  fun `Mac без ключа не минава ръкостискането и не получава доказателство`() = runBlocking<Unit> {
    relayServer.enqueue(relayHost(withLan = true))
    lanServer.enqueue(lanHost(macKey = "чужд-ключ"))
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    lanServer.takeRequest(5, TimeUnit.SECONDS)
    // Клиентът затваря след грешното доказателство на Mac-а и не праща своето.
    assertEquals(null, lanAuthOk.poll(1, TimeUnit.SECONDS))
    assertEquals(LinkPath.RELAY, relay.path.value)
    fromClientOnRelay.clear()
    relay.send(ListRequest(10))
    assertEquals("""{"t":"list","id":10}""", next(fromClientOnRelay))
    assertFalse(fromClientOnLan.isNotEmpty())
  }
}
