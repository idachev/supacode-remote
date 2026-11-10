package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.HostInfo
import com.idachev.supacoderemote.settings.HostSelection
import com.idachev.supacoderemote.settings.MemoryHostSelection
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

  private fun client(selection: HostSelection = MemoryHostSelection()) =
    RelayClient(OkHttpClient(), scope, timing, selection).also { clients += it }

  private fun base() = "http://${server.hostName}:${server.port}"

  /** Relay, който при отваряне праща [statuses] едно след друго. */
  private fun hostUpgrade(
    vararg statuses: String = arrayOf("""{"t":"relay","hostOnline":true}"""),
    hello: String = """{"t":"hello","v":1,"host":"Test Mac"}""",
  ): MockResponse = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      openOnServer.incrementAndGet()
      serverSocket = webSocket
      statuses.forEach { webSocket.send(it) }
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      fromClient.put(text)
      if (text == "ping") webSocket.send("pong")
      if (text.contains("\"hello\"")) webSocket.send(hello)
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
  fun `401 спира опитите и казва „грешен ключ“`() = runBlocking<Unit> {
    server.enqueue(MockResponse.Builder().code(401).build())
    val relay = client()
    relay.configure(RelaySettings(base(), "bad"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.state.first { it == ConnectionState.Unauthorized } }
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `ключът е в Authorization, hello тръгва след hostOnline, после ping`() = runBlocking<Unit> {
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
  fun `host пада и се връща при жив WebSocket — нов hello и нова сесия`() = runBlocking<Unit> {
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
  fun `паднала връзка се отваря пак, а във фон се затваря`() = runBlocking<Unit> {
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

  // ---- Няколко Mac-а ----

  private val officeOn = """{"id":"office","name":"Office Mac","online":true}"""
  private val homeOn = """{"id":"home","name":"Home Mac","online":true}"""

  private fun relay(online: Boolean, host: String?, vararg hosts: String): String {
    val bound = host?.let { ""","host":"$it"""" }.orEmpty()
    return """{"t":"relay","hostOnline":$online$bound,"hosts":[${hosts.joinToString(",")}]}"""
  }

  private fun nextNotPing(): String {
    var line = next()
    while (line == "ping") line = next()
    return line
  }

  @Test
  fun `записаният Mac отива в host, а списъкът се вижда в hosts`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade(relay(true, "office", officeOn, homeOn)))
    val selection = MemoryHostSelection("office")
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("host=office", server.takeRequest().url.encodedQuery)
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hosts.first { it.size == 2 } }
    assertEquals(HostInfo("office", "Office Mac", true), relay.hosts.value[0])
    assertEquals("office", relay.boundHostId.value)
    assertTrue(relay.multiHost.value)
    assertEquals(0, relay.hostPickRequests.value)
    assertEquals("office", selection.selectedHostId.value)
  }

  @Test
  fun `без записан и с един онлайн Mac — избира го и се връзва към него`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade(relay(false, null, officeOn, """{"id":"mini","online":false}""")))
    server.enqueue(hostUpgrade(relay(true, "office", officeOn)))
    val selection = MemoryHostSelection()
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertNull(server.takeRequest().url.encodedQuery)
    assertEquals("host=office", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedQuery)
    assertEquals("office", selection.selectedHostId.value)
    assertEquals("office", relay.boundHostId.value)
    // Несвързаната връзка не праща нищо: hello е първото и идва по новата.
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hostSession.first { it != null } }
  }

  @Test
  fun `без записан и с два онлайн — пита веднъж и не избира сам`() = runBlocking<Unit> {
    val status = relay(false, null, officeOn, homeOn)
    server.enqueue(hostUpgrade(status, status))
    val selection = MemoryHostSelection()
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostPickRequests.first { it == 1 } }
    withTimeout(5_000) { relay.hosts.first { it.size == 2 } }
    Thread.sleep(300)
    assertEquals(1, relay.hostPickRequests.value)
    assertNull(selection.selectedHostId.value)
    assertEquals(1, server.requestCount)
    assertNull(relay.hostSession.value)
    // Без свързан Mac към relay-а не тръгва нищо освен ping.
    assertEquals("ping", next())
  }

  @Test
  fun `записан Mac, който липсва в списъка, остава избран, а Mac-ове се отваря веднъж`() = runBlocking<Unit> {
    val status = relay(false, "gone", officeOn)
    server.enqueue(hostUpgrade(status, status))
    val selection = MemoryHostSelection("gone")
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostPickRequests.first { it == 1 } }
    Thread.sleep(300)
    assertEquals(1, relay.hostPickRequests.value)
    assertEquals("gone", selection.selectedHostId.value)
    assertEquals("gone", relay.boundHostId.value)
    assertFalse(relay.hostOnline.value)
    assertEquals(1, server.requestCount)
  }

  @Test
  fun `relay само със списъка не праща втори hello`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade(relay(true, "office", officeOn), relay(true, "office", officeOn, homeOn)))
    val relay = client(MemoryHostSelection("office"))
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hosts.first { it.size == 2 } }
    assertEquals("ping", next())
    assertEquals(1, relay.hostSession.value)
  }

  @Test
  fun `selectHost записва, връзва се наново към новия Mac и почва нова сесия`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade(relay(true, "office", officeOn, homeOn)))
    server.enqueue(hostUpgrade(relay(true, "home", officeOn, homeOn)))
    val selection = MemoryHostSelection("office")
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("host=office", server.takeRequest().url.encodedQuery)
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }

    relay.selectHost("home")
    assertEquals("home", selection.selectedHostId.value)
    assertEquals("home", relay.boundHostId.value)
    assertEquals("host=home", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedQuery)
    withTimeout(5_000) { relay.hostSession.first { it == 2 } }
    assertEquals("""{"t":"hello","v":1}""", nextNotPing())

    // Същият Mac пак: нищо ново.
    relay.selectHost("home")
    Thread.sleep(200)
    assertEquals(2, server.requestCount)
  }

  @Test
  fun `стар relay без hosts — един Mac, записаният избор остава`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade())
    val selection = MemoryHostSelection("office")
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }
    assertFalse(relay.multiHost.value)
    assertEquals(emptyList<HostInfo>(), relay.hosts.value)
    assertEquals(0, relay.hostPickRequests.value)
    assertEquals("office", selection.selectedHostId.value)
  }

  @Test
  fun `hello от друг Mac не сменя името на свързания`() = runBlocking<Unit> {
    server.enqueue(
      hostUpgrade(relay(true, "office", officeOn), hello = """{"t":"hello","v":1,"host":"Home Mac","hostId":"home"}"""),
    )
    val relay = client(MemoryHostSelection("office"))
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("""{"t":"hello","v":1}""", next())
    Thread.sleep(300)
    assertNull(relay.hostName.value)
  }

  @Test
  fun `нов ключ за връзка пита наново за Mac, дори да е питано при стария relay`() = runBlocking<Unit> {
    val status = relay(false, "gone", officeOn)
    server.enqueue(hostUpgrade(status))
    server.enqueue(hostUpgrade(status))
    val relay = client(MemoryHostSelection("gone"))
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostPickRequests.first { it == 1 } }
    relay.configure(RelaySettings(base(), "k2"))
    withTimeout(5_000) { relay.hostPickRequests.first { it == 2 } }
  }

  @Test
  fun `поискан избор, решен после от автоматичния избор, вече не чака`() = runBlocking<Unit> {
    // Два онлайн: пита. После единият излиза: телефонът избира сам и изборът вече не е нужен.
    server.enqueue(hostUpgrade(relay(false, null, officeOn, homeOn)))
    server.enqueue(hostUpgrade(relay(true, "office", officeOn)))
    val selection = MemoryHostSelection()
    val relay = client(selection)
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    withTimeout(5_000) { relay.hostPickPending.first { it } }
    assertEquals(1, relay.hostPickRequests.value)
    serverSocket!!.send(relay(false, null, officeOn, """{"id":"home","name":"Home Mac","online":false}"""))
    withTimeout(5_000) { relay.hostSession.first { it != null } }
    assertEquals("office", selection.selectedHostId.value)
    assertFalse(relay.hostPickPending.value)
  }

  @Test
  fun `detach на терминал от стария Mac не тръгва по новата връзка`() = runBlocking<Unit> {
    server.enqueue(hostUpgrade(relay(true, "office", officeOn, homeOn)))
    // Новата връзка е отворена, но relay-ят още не е казал hostOnline:true.
    server.enqueue(hostUpgrade(relay(false, "home", officeOn, """{"id":"home","name":"Home Mac","online":false}""")))
    val relay = client(MemoryHostSelection("office"))
    relay.configure(RelaySettings(base(), "k"))
    relay.setForeground(true)
    assertEquals("""{"t":"hello","v":1}""", next())
    withTimeout(5_000) { relay.hostSession.first { it == 1 } }
    assertTrue(relay.send(AttachRequest(7, "c-office")))
    assertEquals("""{"t":"attach","id":7,"contentId":"c-office","scrollback":500}""", nextNotPing())

    relay.selectHost("home")
    withTimeout(5_000) { relay.hosts.first { list -> list.any { it.id == "home" && !it.online } } }
    assertEquals(ConnectionState.Connected, relay.state.value)
    fromClient.clear()
    assertTrue(relay.detach("c-office", 7))
    Thread.sleep(400)
    assertTrue(fromClient.none { it.contains("detach") })
  }
}
