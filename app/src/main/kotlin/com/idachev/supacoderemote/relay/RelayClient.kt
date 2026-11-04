package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.AttachRequest
import com.idachev.supacoderemote.protocol.ClientMessage
import com.idachev.supacoderemote.protocol.DetachRequest
import com.idachev.supacoderemote.protocol.HelloReply
import com.idachev.supacoderemote.protocol.HelloRequest
import com.idachev.supacoderemote.protocol.PING
import com.idachev.supacoderemote.protocol.ProtocolCodec
import com.idachev.supacoderemote.protocol.RelayStatus
import com.idachev.supacoderemote.protocol.RelayUrl
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.settings.RelaySettings
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.time.Duration
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

/** По кой път вървят заявките към host-а в момента. */
enum class LinkPath { NONE, RELAY, LAN }

/** Състоянието на WebSocket-а към relay-а. Дали Mac-ът е там, е отделно: [RelayClient.hostOnline]. */
sealed interface ConnectionState {
  /** Няма настройки или приложението е във фон — не се свързваме. */
  data object Idle : ConnectionState

  data object Connecting : ConnectionState

  data object Connected : ConnectionState

  /** Връзката падна; следващият опит е след [retryInMs]. */
  data class Waiting(val retryInMs: Long, val reason: String?) : ConnectionState

  /** Relay-ът върна 401. Не опитваме пак, докато ключът не се смени. */
  data object Unauthorized : ConnectionState
}

/**
 * Каналът към host-а, както го виждат екраните. Интерфейс, за да се тестват без WebSocket.
 */
interface HostLink {
  /** Всички съобщения от relay-а и host-а в реда на пристигане. */
  val messages: SharedFlow<ServerMessage>

  /** Расте при всяка нова връзка с онлайн host; `null`, докато няма такава. */
  val hostSession: StateFlow<Int?>

  /** `false`, ако връзката не е горе: тогава съобщението не е тръгнало. */
  fun send(message: ClientMessage): Boolean

  /**
   * `detach` от екрана, чийто последен `attach` е [lastAttachId] (`null` — не е правил).
   * Не тръгва, ако след него друг екран е закачил същия терминал.
   */
  fun detach(contentId: String, lastAttachId: Int?): Boolean = send(DetachRequest(contentId))

  /** Id за заявка, която чака отговор със същото `id`. */
  fun nextId(): Int
}

/**
 * Единственият WebSocket на приложението към `<relay>/client`.
 *
 * Живее, докато има настройки и приложението е на преден план ([setForeground]) или
 * service-ът за известия го държи ([setKeepAlive]). Пада ли,
 * се свързва пак след 1 s, 2 s, 4 s … до 30 s. Успешна връзка връща паузата на 1 s.
 *
 * `hello` и всичко друго към host-а тръгват едва когато relay-ът каже `hostOnline:true`:
 * съобщение към офлайн host relay-ът връща като грешка, а списъкът се пита на 3 s.
 */
class RelayClient(
  private val http: OkHttpClient,
  private val scope: CoroutineScope,
  private val timing: Timing = Timing(),
) : HostLink {

  /** Паузите са тук, за да може тестът да ги свие. */
  data class Timing(
    val pingIntervalMs: Long = 30_000,
    /** Без нито един кадър толкова време (след два ping-а) връзката се смята за мъртва. */
    val silenceLimitMs: Long = 75_000,
    val firstRetryMs: Long = 1_000,
    val maxRetryMs: Long = 30_000,
    /** Таймаут за свързване към всеки LAN адрес. */
    val lanConnectTimeoutMs: Long = 2_500,
    /** След паднал или неуспешен LAN опит: нов `hello` по relay-а след толкова, двойно до max. */
    val lanRetryFirstMs: Long = 10_000,
    val lanRetryMaxMs: Long = 300_000,
  )

  private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
  val state: StateFlow<ConnectionState> = _state.asStateFlow()

  private val _hostOnline = MutableStateFlow(false)
  val hostOnline: StateFlow<Boolean> = _hostOnline.asStateFlow()

  private val _hostName = MutableStateFlow<String?>(null)
  val hostName: StateFlow<String?> = _hostName.asStateFlow()

  /**
   * Номер на текущата „сесия с host-а“: расте всеки път, когато връзката е горе и
   * Mac-ът е онлайн; `null`, докато не е. Терминалът по него прави `attach` наново след
   * reconnect, защото host-ът е забравил предишния `attach` заедно със старата връзка.
   */
  private val _hostSession = MutableStateFlow<Int?>(null)
  override val hostSession: StateFlow<Int?> = _hostSession.asStateFlow()
  private var hostSessionCounter = 0

  /**
   * LAN, ако е отворена удостоверена LAN връзка към Mac-а, иначе Relay, ако relay-ът казва,
   * че Mac-ът е там. Всяка смяна на пътя е нова [hostSession]: host-ът не знае за `attach`-а
   * по другия път, затова терминалът го прави наново.
   */
  private val _path = MutableStateFlow(LinkPath.NONE)
  val path: StateFlow<LinkPath> = _path.asStateFlow()

  @Volatile private var lan: LanSession? = null
  @Volatile private var lanLastFrameAt = 0L
  private var lanJob: Job? = null
  private var lanKeepalive: Job? = null
  private var lanRetry: Job? = null
  private var lanRetryMs = timing.lanRetryFirstMs
  /** Расте при restart: закъснял LAN опит от старите настройки не се приема. */
  private var lanGeneration = 0
  /** Mac-ът е предлагал LAN в тази връзка — значи сме в една мрежа и си струва да опитваме. */
  private var lanOffered = false

  /**
   * Кой път носи потока на терминала ([TerminalStreamGate]). Пази се със [streamLock]; той не се
   * държи по време на `emit`, затова `send` от събирача на съобщенията не чака блокиран читател.
   */
  private val gate = TerminalStreamGate()
  private val streamLock = Any()

  /**
   * Двата читателя (relay и LAN) минават през решението на [gate] и `emit` един по един: кадър,
   * приет преди смяната на пътя, стига до екраните преди `attached`-а, който я прави.
   */
  private val deliverLock = Any()

  /**
   * Всички съобщения в реда на пристигане. Читателят на OkHttp чака, ако буферът е пълен,
   * вместо да изпусне байтове на терминала.
   */
  private val _messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 256)
  override val messages: SharedFlow<ServerMessage> = _messages.asSharedFlow()

  private val ids = AtomicInteger(0)
  private val attempts = AtomicInteger(0)

  @Volatile private var socket: WebSocket? = null
  @Volatile private var lastFrameAt = 0L

  private var settings: RelaySettings? = null
  private var foreground = false
  private var keepAlive = false
  private var job: Job? = null
  private val lock = Any()

  override fun nextId(): Int = ids.incrementAndGet()

  /** Нови настройки (или `null`): старата връзка се затваря и, ако може, тръгва нова. */
  fun configure(newSettings: RelaySettings?) {
    synchronized(lock) {
      if (newSettings == settings && _state.value != ConnectionState.Unauthorized) return
      settings = newSettings
      restartLocked()
    }
  }

  fun setForeground(value: Boolean) {
    synchronized(lock) {
      if (foreground == value) return
      val wasActive = activeLocked()
      foreground = value
      if (activeLocked() != wasActive) restartLocked()
    }
  }

  /**
   * Връзката остава и във фон — за известията „агент чака“ (service-ът ги държи). Пак е
   * една връзка: смяната между преден план и фон не я къса.
   */
  fun setKeepAlive(value: Boolean) {
    synchronized(lock) {
      if (keepAlive == value) return
      val wasActive = activeLocked()
      keepAlive = value
      if (activeLocked() != wasActive) restartLocked()
    }
  }

  private fun activeLocked(): Boolean = foreground || keepAlive

  /** Повторен опит веднага, напр. от бутона в банера. */
  fun reconnectNow() {
    synchronized(lock) { restartLocked() }
  }

  /** По LAN, ако е горе, иначе по relay-а. Relay сокетът остава отворен като резерва. */
  override fun send(message: ClientMessage): Boolean {
    val text = ProtocolCodec.encode(message)
    if (message !is AttachRequest && message !is DetachRequest) return sendText(text)
    // Под streamLock-а: отговорът по пътя не може да бъде решен, преди gate да знае за заявката.
    synchronized(streamLock) {
      val lanNow = lan
      val ws = socket
      val via: Any = when {
        lanNow != null && lanNow.send(text) -> lanNow
        ws != null && ws.send(text) -> ws
        else -> return false
      }
      when (message) {
        is AttachRequest -> gate.attachSent(via, message.id, message.contentId)
        is DetachRequest -> sendDetaches(gate.detachSent(via, message.contentId))
      }
      return true
    }
  }

  override fun detach(contentId: String, lastAttachId: Int?): Boolean {
    // Под streamLock-а (той е reentrant): нов attach не може да влезе между проверката и detach-а.
    synchronized(streamLock) {
      if (gate.isStaleDetach(contentId, lastAttachId)) return true
      return send(DetachRequest(contentId))
    }
  }

  private fun sendDetaches(targets: List<Pair<Any, String>>) {
    for ((source, contentId) in targets) {
      val text = ProtocolCodec.encode(DetachRequest(contentId))
      when (source) {
        is WebSocket -> source.send(text)
        is LanSession -> source.send(text)
      }
    }
  }

  /** Към екраните, ако [gate] пуска кадъра от [source]; спира старите attach-ове при смяна. */
  private fun deliver(source: Any, message: ServerMessage) {
    synchronized(deliverLock) {
      val decision = synchronized(streamLock) {
        gate.accept(source, message).also { sendDetaches(it.detach) }
      }
      if (!decision.deliver) return
      // Чака, ако някой читател изостава: по-добре бавно, отколкото с дупка в терминала.
      runBlocking { _messages.emit(message) }
    }
  }

  private fun sourceClosed(source: Any) {
    synchronized(streamLock) { gate.closed(source) }
  }

  private fun sendText(text: String): Boolean {
    lan?.let { if (it.send(text)) return true }
    return socket?.send(text) ?: false
  }

  private fun restartLocked() {
    job?.cancel()
    job = null
    // Старият опит спира веднага за всички: закъснелите му callback-и и `finally` вече не
    // пипат състоянието, а `send` не тръгва по затварящия се сокет.
    attempts.incrementAndGet()
    socket = null
    closeLanLocked()
    _hostOnline.value = false
    updateRouteLocked()
    val current = settings
    if (current == null || !activeLocked()) {
      _state.value = ConnectionState.Idle
      return
    }
    val url = RelayUrl.clientUrl(current.baseUrl)
    if (url == null) {
      _state.value = ConnectionState.Waiting(0, "невалиден адрес")
      return
    }
    job = scope.launch { runLoop(url, current.apiKey) }
  }

  private suspend fun runLoop(url: String, apiKey: String) {
    var retry = timing.firstRetryMs
    while (true) {
      _state.value = ConnectionState.Connecting
      when (val outcome = connectOnce(url, apiKey)) {
        Outcome.Unauthorized -> {
          _state.value = ConnectionState.Unauthorized
          return
        }
        is Outcome.Closed -> {
          if (outcome.wasOpen) retry = timing.firstRetryMs
          _state.value = ConnectionState.Waiting(retry, outcome.reason)
          delay(retry)
          retry = min(retry * 2, timing.maxRetryMs)
        }
      }
    }
  }

  private sealed interface Outcome {
    data object Unauthorized : Outcome

    data class Closed(val reason: String?, val wasOpen: Boolean) : Outcome
  }

  private suspend fun connectOnce(url: String, apiKey: String): Outcome {
    val done = CompletableDeferred<Outcome>()
    // Callback-ите на OkHttp идват от друга нишка и може да закъснеят след края на опита.
    val finished = AtomicBoolean(false)
    val attempt = attempts.incrementAndGet()
    // Новата връзка започва без host: стар опит може да е оставил `hostOnline` вдигнат.
    setHostOnline(false, attempt)
    var opened = false
    val request = Request.Builder().url(url).header("Authorization", "Bearer $apiKey").build()
    val ws = http.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (finished.get() || attempt != attempts.get()) return
        opened = true
        lastFrameAt = System.currentTimeMillis()
        socket = webSocket
        _state.value = ConnectionState.Connected
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (finished.get() || attempt != attempts.get()) return
        lastFrameAt = System.currentTimeMillis()
        val message = ProtocolCodec.decode(text) ?: return
        when (message) {
          is RelayStatus -> onHostOnline(webSocket, message.hostOnline, attempt)
          is HelloReply -> {
            _hostName.value = message.host
            onRelayHello(message.lan)
          }
          else -> Unit
        }
        deliver(webSocket, message)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        done.complete(Outcome.Closed(reason.ifBlank { "затворена ($code)" }, opened))
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (response?.code == 401) {
          done.complete(Outcome.Unauthorized)
        } else {
          val reason = response?.let { "HTTP ${it.code}" } ?: t.message ?: t.javaClass.simpleName
          done.complete(Outcome.Closed(reason, opened))
        }
      }
    })
    val keepalive = scope.launch {
      while (true) {
        delay(timing.pingIntervalMs)
        if (socket === ws) {
          if (System.currentTimeMillis() - lastFrameAt > timing.silenceLimitMs) {
            ws.cancel()
            done.complete(Outcome.Closed("няма отговор от relay-а", opened))
            return@launch
          }
          ws.send(PING)
        }
      }
    }
    try {
      return done.await()
    } finally {
      finished.set(true)
      keepalive.cancel()
      if (socket === ws) socket = null
      sourceClosed(ws)
      // Нормално затваряне при отиване във фон; при вече паднала връзка не прави нищо.
      ws.close(1000, null)
      setHostOnline(false, attempt)
    }
  }

  private fun onHostOnline(webSocket: WebSocket, online: Boolean, attempt: Int) {
    if (online && !_hostOnline.value) {
      webSocket.send(ProtocolCodec.encode(HelloRequest()))
    }
    setHostOnline(online, attempt)
  }

  /** Само последният опит пипа състоянието: `finally` на стар, отказан опит може да закъснее. */
  private fun setHostOnline(online: Boolean, attempt: Int) {
    synchronized(lock) {
      if (attempt != attempts.get()) return
      _hostOnline.value = online
      updateRouteLocked()
    }
  }

  private fun updateRouteLocked() {
    val route = when {
      lan != null -> LinkPath.LAN
      _hostOnline.value -> LinkPath.RELAY
      else -> LinkPath.NONE
    }
    if (route == _path.value) return
    _path.value = route
    if (route == LinkPath.NONE) {
      _hostSession.value = null
    } else {
      hostSessionCounter += 1
      _hostSession.value = hostSessionCounter
    }
  }

  // ---- LAN пътят ----

  /**
   * `hello` по relay-а. С `lan` — опит за пряка връзка. Без `lan`, но след като LAN вече е
   * бил предложен в тази връзка (напр. Mac-ът го е спрял за малко) — нов `hello` по-късно,
   * с растяща пауза, за да се върнем на LAN, щом пак е там.
   */
  private fun onRelayHello(info: LanInfo?) {
    synchronized(lock) {
      val key = settings?.apiKey
      if (info != null && key != null && LanTrust.fpMacValid(key, info.fp, info.fpMac)) {
        lanOffered = true
        maybeStartLan(info)
      } else if (info != null) {
        // Отпечатък без верен fpMac: не е от Mac-а (или relay-ят го е пипал) — без LAN.
        return
      } else if (lanOffered && lan == null && lanJob?.isActive != true) {
        scheduleLanRetryLocked()
      }
    }
  }

  /** `hello` по relay-а донесе `lan`: опит за пряка връзка, ако вече няма такава. */
  private fun maybeStartLan(info: LanInfo) {
    synchronized(lock) {
      if (lan != null || lanJob?.isActive == true || info.addrs.isEmpty()) return
      val key = settings?.apiKey ?: return
      val generation = lanGeneration
      lanRetry?.cancel()
      lanJob = scope.launch {
        val session = LanSession.connect(http, info, key, lanListener, Duration.ofMillis(timing.lanConnectTimeoutMs))
        synchronized(lock) {
          if (generation != lanGeneration || session == null || session.closed) {
            session?.close()
            if (generation == lanGeneration) scheduleLanRetryLocked()
            return@launch
          }
          lan = session
          lanLastFrameAt = System.currentTimeMillis()
          lanRetryMs = timing.lanRetryFirstMs
          // hello първо, после новата сесия: по нея терминалът прави attach, а екраните — list.
          session.send(ProtocolCodec.encode(HelloRequest()))
          updateRouteLocked()
          lanKeepalive = scope.launch { keepLanAlive(session) }
        }
      }
    }
  }

  private val lanListener = object : LanSession.Listener {
    override fun onText(session: LanSession, text: String) {
      lanLastFrameAt = System.currentTimeMillis()
      val message = ProtocolCodec.decode(text) ?: return
      // `lan` в hello по самия LAN не значи нищо ново.
      if (message is HelloReply) _hostName.value = message.host
      deliver(session, message)
    }

    override fun onClosed(session: LanSession, reason: String) {
      sourceClosed(session)
      synchronized(lock) {
        if (lan !== session) return
        lan = null
        lanKeepalive?.cancel()
        // Обратно на relay-а: нова сесия, терминалът прави attach наново там.
        updateRouteLocked()
        scheduleLanRetryLocked()
      }
    }
  }

  private suspend fun keepLanAlive(session: LanSession) {
    while (true) {
      delay(timing.pingIntervalMs)
      if (lan !== session) return
      if (System.currentTimeMillis() - lanLastFrameAt > timing.silenceLimitMs) {
        session.cancel()
        return
      }
      session.send(PING)
    }
  }

  /**
   * Следващият `hello` по relay-а — неговият отговор носи `lan`, ако Mac-ът още е в същата
   * мрежа. Паузата расте, за да не се чука постоянно в LAN, който не отговаря.
   */
  private fun scheduleLanRetryLocked() {
    lanRetry?.cancel()
    val wait = lanRetryMs
    lanRetryMs = min(lanRetryMs * 2, timing.lanRetryMaxMs)
    val generation = lanGeneration
    lanRetry = scope.launch {
      delay(wait)
      synchronized(lock) {
        if (generation != lanGeneration || lan != null || !_hostOnline.value) return@launch
        socket?.send(ProtocolCodec.encode(HelloRequest()))
      }
    }
  }

  private fun closeLanLocked() {
    lanGeneration += 1
    lanJob?.cancel()
    lanKeepalive?.cancel()
    lanRetry?.cancel()
    lanRetryMs = timing.lanRetryFirstMs
    lanOffered = false
    lan?.close()
    lan = null
  }
}
