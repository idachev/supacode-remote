package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.ListRequest
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.settings.RelaySettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.Collections
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

  @Volatile private var relaySocket: WebSocket? = null

  /** `out` с текст вместо байтове — по него тестът вижда кой път го е донесъл. */
  private fun out(contentId: String, marker: String) =
    """{"t":"out","contentId":"$contentId","b64":"${java.util.Base64.getEncoder().encodeToString(marker.encodeToByteArray())}"}"""

  private fun marker(message: Output): String = String(java.util.Base64.getDecoder().decode(message.b64))

  /** Mac-ът и на двата пътя отговаря на `attach` с `attached` и първия `out` (екрана). */
  private fun answerAttach(webSocket: WebSocket, text: String, path: String) {
    if (!text.contains("\"t\":\"attach\"")) return
    val contentId = Regex("\"contentId\":\"([^\"]+)\"").find(text)!!.groupValues[1]
    val id = Regex("\"id\":(\\d+)").find(text)!!.groupValues[1]
    webSocket.send("""{"t":"attached","id":$id,"contentId":"$contentId","cols":80,"rows":24}""")
    webSocket.send(out(contentId, "$path-screen"))
  }

  /**
   * Relay-ят: първият `hello` носи `lan`, но LAN опитът пада (404), за да е терминалът
   * отворен по relay-а; повторният `hello` след паузата пак носи `lan` и тогава LAN се вдига.
   */
  private fun relayHostWithAttach(lan: String): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      relaySocket = webSocket
      webSocket.send("""{"t":"relay","hostOnline":true}""")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClientOnRelay.put(text)
      if (text.contains("\"hello\"")) webSocket.send("""{"t":"hello","v":1,"host":"Test Mac"$lan}""")
      answerAttach(webSocket, text, "relay")
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

  private fun lanHostWithAttach(): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openSockets.incrementAndGet()
      lanSocket = webSocket
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClientOnLan.put(text)
      if (text.contains("\"hello\"")) webSocket.send("""{"t":"hello","v":1,"host":"Test Mac"}""")
      answerAttach(webSocket, text, "lan")
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

  private fun nextMatching(queue: LinkedBlockingQueue<String>, predicate: (String) -> Boolean): String {
    while (true) {
      val text = next(queue)
      if (predicate(text)) return text
    }
  }

  private fun awaitMarker(outputs: List<String>, marker: String) {
    val deadline = System.currentTimeMillis() + 5_000
    while (marker !in synchronized(outputs) { outputs.toList() }) {
      check(System.currentTimeMillis() < deadline) { "няма $marker в $outputs" }
      Thread.sleep(10)
    }
  }

  /** Терминалът по relay-а, после се вдига LAN, после LAN пада: всеки път само един поток. */
  @Test
  fun `при смяна на пътя изходът на терминала идва само по единия път`() = runBlocking<Unit> {
    val lanTiming = timing.copy(lanRetryFirstMs = 1_500)
    relayServer.enqueue(relayHostWithAttach(lanJson(lanServer.port)))
    lanServer.enqueue(MockResponse.Builder().code(404).build())
    lanServer.enqueue(lanHostWithAttach())
    val relay = RelayClient(OkHttpClient(), scope, lanTiming).also { clients += it }
    val outputs: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val collector = scope.launch {
      relay.messages.collect { message: ServerMessage -> if (message is Output) outputs += marker(message) }
    }
    relay.configure(RelaySettings("http://${relayServer.hostName}:${relayServer.port}", key))
    relay.setForeground(true)

    // 1. Терминалът е отворен по relay-а (първият LAN опит е паднал).
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    lanServer.takeRequest()
    relay.send(AttachRequest(id = 1, contentId = "c1"))
    nextMatching(fromClientOnRelay) { it.contains("\"t\":\"attach\"") }
    awaitMarker(outputs, "relay-screen")

    // 2. LAN се вдига: терминалът се закача по LAN; relay attach-ът спира след LAN `attached`.
    withTimeout(5_000) { relay.path.first { it == LinkPath.LAN } }
    relay.send(AttachRequest(id = 2, contentId = "c1"))
    nextMatching(fromClientOnLan) { it.contains("\"t\":\"attach\"") }
    awaitMarker(outputs, "lan-screen")
    assertEquals("""{"t":"detach","contentId":"c1"}""", nextMatching(fromClientOnRelay) { it.contains("detach") })
    // Mac-ът е пратил още нещо по relay-а, преди да види detach-а: не стига до терминала.
    relaySocket!!.send(out("c1", "relay-late"))
    relaySocket!!.send("""{"t":"size","contentId":"c1","cols":100,"rows":30}""")
    Thread.sleep(300)
    lanSocket!!.send(out("c1", "lan-live"))
    awaitMarker(outputs, "lan-live")
    Thread.sleep(200)
    assertFalse("relay out по време на LAN: $outputs", "relay-late" in synchronized(outputs) { outputs.toList() })

    // 3. LAN пада: пак по relay-а; новият attach там носи изхода, само веднъж.
    lanSocket!!.close(1001, "bye")
    withTimeout(5_000) { relay.path.first { it == LinkPath.RELAY } }
    relay.send(AttachRequest(id = 3, contentId = "c1"))
    // Mac-ът пише екрана от своята нишка: live изходът тръгва след него, както в истината.
    val deadline = System.currentTimeMillis() + 5_000
    while (synchronized(outputs) { outputs.count { it == "relay-screen" } } < 2) {
      check(System.currentTimeMillis() < deadline) { "няма втори relay-screen в $outputs" }
      Thread.sleep(10)
    }
    relaySocket!!.send(out("c1", "relay-live"))
    awaitMarker(outputs, "relay-live")
    Thread.sleep(200)
    val seen = synchronized(outputs) { outputs.toList() }
    assertEquals(listOf("relay-screen", "lan-screen", "lan-live", "relay-screen", "relay-live"), seen)
    collector.cancel()
  }
}
