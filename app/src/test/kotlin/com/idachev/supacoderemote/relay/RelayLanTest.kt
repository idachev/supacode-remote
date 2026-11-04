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
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Двата пътя заедно: relay (обикновен WebSocket) и LAN (wss с TLS 1.3 и самоподписан
 * сертификат, закован по отпечатък). LAN сървърът тук играе Mac-а.
 */
class RelayLanTest {

  private val key = "abcde-fghij"
  private val macCert: HeldCertificate = HeldCertificate.Builder().commonName("mac").build()
  private val fp = LanTrust.fingerprint(macCert.certificate.encoded)

  private lateinit var relayServer: MockWebServer
  private lateinit var lanServer: MockWebServer
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val timing = RelayClient.Timing(pingIntervalMs = 60_000, firstRetryMs = 50, maxRetryMs = 200, lanRetryFirstMs = 60_000)
  private val clients = mutableListOf<RelayClient>()

  private val fromClientOnRelay = LinkedBlockingQueue<String>()
  private val fromClientOnLan = LinkedBlockingQueue<String>()
  @Volatile private var lanSocket: WebSocket? = null
  private val openSockets = AtomicInteger(0)

  @Before
  fun setUp() {
    relayServer = MockWebServer().apply { start() }
    lanServer = MockWebServer().apply {
      useHttps(HandshakeCertificates.Builder().heldCertificate(macCert).build().sslSocketFactory())
      start()
    }
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

  private fun fpMac(clientKey: String, fingerprint: String): String =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(clientKey.encodeToByteArray(), "HmacSHA256")) }
      .doFinal("supacode-lan-fp-v1:$fingerprint".encodeToByteArray())
      .joinToString("") { "%02x".format(it) }

  private fun lanJson(port: Int, fingerprint: String = fp, mac: String = fpMac(key, fingerprint)) =
    ""","lan":{"addrs":["127.0.0.1"],"port":$port,"fp":"$fingerprint","fpMac":"$mac"}"""

  private fun relayHost(lan: String?): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      webSocket.send("""{"t":"relay","hostOnline":true}""")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClientOnRelay.put(text)
      if (text.contains("\"hello\"")) webSocket.send("""{"t":"hello","v":1,"host":"Test Mac"${lan.orEmpty()}}""")
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

  /** Mac-ът на LAN: същите текстови съобщения като по relay-а, без relay статус. */
  private fun lanHost(): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      lanSocket = webSocket
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClientOnLan.put(text)
      if (text.contains("\"hello\"")) webSocket.send("""{"t":"hello","v":1,"host":"Test Mac"}""")
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
    relayServer.enqueue(relayHost(lan = null))
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    assertEquals("""{"t":"hello","v":1}""", next(fromClientOnRelay))
    relay.send(ListRequest(7))
    assertEquals("""{"t":"list","id":7}""", next(fromClientOnRelay))
    assertEquals(0, lanServer.requestCount)
  }

  @Test
  fun `с lan заявките минават по LAN, а при паднал LAN — пак по relay-а`() = runBlocking<Unit> {
    relayServer.enqueue(relayHost(lanJson(lanServer.port)))
    lanServer.enqueue(lanHost())
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.LAN } }
    val lanSession = relay.hostSession.value!!
    val request = lanServer.takeRequest()
    assertEquals("/lan", request.url.encodedPath)
    assertEquals("Bearer $key", request.headers["Authorization"])
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
  fun `чужд сертификат спира TLS преди заявката — ключът не стига до сървъра`() = runBlocking<Unit> {
    val otherFp = LanTrust.fingerprint(HeldCertificate.Builder().commonName("other").build().certificate.encoded)
    relayServer.enqueue(relayHost(lanJson(lanServer.port, fingerprint = otherFp)))
    lanServer.enqueue(lanHost())
    val relay = client()
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    Thread.sleep(1_500)
    assertEquals(0, lanServer.requestCount)
    assertEquals(LinkPath.RELAY, relay.path.value)
  }

  @Test
  fun `грешен fpMac — няма дори опит за връзка`() = runBlocking<Unit> {
    ServerSocket(0).use { listener ->
      val accepted = AtomicInteger(0)
      val acceptor = Thread {
        runCatching { while (true) listener.accept().use { accepted.incrementAndGet() } }
      }.apply { isDaemon = true; start() }
      relayServer.enqueue(relayHost(lanJson(listener.localPort, mac = fpMac("$key-other", fp))))
      val relay = client()
      withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
      assertEquals("""{"t":"hello","v":1}""", next(fromClientOnRelay))
      Thread.sleep(1_500)
      assertEquals(0, accepted.get())
      assertEquals(LinkPath.RELAY, relay.path.value)
      acceptor.interrupt()
    }
  }
}
