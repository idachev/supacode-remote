package com.idachev.supacoderemote.relay

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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Истински WebSocket срещу MockWebServer: 401, Authorization, hello, ping, host, който пада. */
class RelayClientTest {

  private lateinit var server: MockWebServer
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val fromClient = LinkedBlockingQueue<String>()
  @Volatile private var serverSocket: WebSocket? = null
  private val openOnServer = AtomicInteger(0)

  private val timing = RelayClient.Timing(pingIntervalMs = 200, silenceLimitMs = 10_000, firstRetryMs = 50, maxRetryMs = 200)

  @Before
  fun setUp() {
    server = MockWebServer()
    server.start()
  }

  private val clients = mutableListOf<RelayClient>()

  @After
  fun tearDown() {
    // MockWebServer чака отворените WebSocket-и да се затворят, иначе close() пада.
    clients.forEach { it.setForeground(false) }
    val deadline = System.currentTimeMillis() + 5_000
    while (openOnServer.get() > 0 && System.currentTimeMillis() < deadline) Thread.yield()
    scope.cancel()
    server.close()
  }

  private fun client() = RelayClient(OkHttpClient(), scope, timing).also { clients += it }

  private fun base() = "http://${server.hostName}:${server.port}"

  private fun hostUpgrade(): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openOnServer.incrementAndGet()
      serverSocket = webSocket
      webSocket.send("""{"t":"relay","hostOnline":true}""")
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClient.put(text)
      if (text == "ping") webSocket.send("pong")
      if (text.contains("\"hello\"")) webSocket.send("""{"t":"hello","v":1,"host":"Test Mac"}""")
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      openOnServer.decrementAndGet()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      openOnServer.decrementAndGet()
    }
  }).build()

  private fun next(): String = fromClient.poll(5, TimeUnit.SECONDS) ?: error("нищо от клиента")

  @Test
  fun `401 спира опитите и казва „грешен ключ“`() = runBlocking {
    server.enqueue(MockResponse.Builder().code(401).build())
    val relay = client()
    relay.configure(RelaySettings(base(), "bad"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.state.first { it == ConnectionState.Unauthorized } }
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `ключът е в Authorization, hello тръгва след hostOnline, после ping`() = runBlocking {
    server.enqueue(hostUpgrade())
    val relay = client()
    relay.configure(RelaySettings(base(), "abcde-fghij"))
    relay.setForeground(true)
    val request = server.takeRequest()
    assertEquals("/client", request.url.encodedPath)
    assertEquals("Bearer abcde-fghij", request.headers["Authorization"])
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hostName.first { it == "Test Mac" } }
    assertEquals(1, relay.hostSession.value)
    assertEquals("ping", next())
  }

  @Test
  fun `host пада и се връща при жив WebSocket — нов hello и нова сесия`() = runBlocking {
    server.enqueue(hostUpgrade())
    val relay = client()
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }

    serverSocket!!.send("""{"t":"relay","hostOnline":false}""")
    withTimeout(5_000) { relay.hostSession.first { it == null } }
    assertEquals(ConnectionState.Connected, relay.state.value)

    serverSocket!!.send("""{"t":"relay","hostOnline":true}""")
    withTimeout(5_000) { relay.hostSession.first { it == 2 } }
    var line = next()
    while (line == "ping") line = next()
    assertEquals("""{"t":"hello","v":1}""", line)
  }

  @Test
  fun `с keepAlive връзката остава във фон и е същата`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade())
    val relay = client()
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }
    relay.setKeepAlive(true)
    relay.setForeground(false)
    assertEquals(ConnectionState.Connected, relay.state.value)
    assertEquals(1, relay.hostSession.value)
    relay.setForeground(true)
    relay.setKeepAlive(false)
    assertEquals(1, server.requestCount)
    assertEquals(1, relay.hostSession.value)
    relay.setForeground(false)
    withTimeout(5_000) { relay.state.first { it == ConnectionState.Idle } }
  }

  @Test
  fun `паднала връзка се отваря пак, а във фон се затваря`() = runBlocking {
    server.enqueue(hostUpgrade())
    server.enqueue(hostUpgrade())
    val relay = client()
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }
    serverSocket!!.close(1001, "going away")
    withTimeout(5_000) { relay.hostSession.first { it == 2 } }
    assertEquals(2, server.requestCount)

    relay.setForeground(false)
    withTimeout(5_000) { relay.state.first { it == ConnectionState.Idle } }
    withTimeout(5_000) { relay.hostSession.first { it == null } }
    assertNull(relay.hostSession.value)
  }
}
