package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.ClientMessage
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min

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

  override fun send(message: ClientMessage): Boolean = socket?.send(ProtocolCodec.encode(message)) ?: false

  private fun restartLocked() {
    job?.cancel()
    job = null
    // Старият опит спира веднага за всички: закъснелите му callback-и и `finally` вече не
    // пипат състоянието, а `send` не тръгва по затварящия се сокет.
    attempts.incrementAndGet()
    socket = null
    _hostOnline.value = false
    _hostSession.value = null
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
          is HelloReply -> _hostName.value = message.host
          else -> Unit
        }
        // Чака, ако някой читател изостава: по-добре бавно, отколкото с дупка в терминала.
        runBlocking { _messages.emit(message) }
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
      val wasOnline = _hostOnline.value
      _hostOnline.value = online
      if (online && !wasOnline) {
        hostSessionCounter += 1
        _hostSession.value = hostSessionCounter
      } else if (!online) {
        _hostSession.value = null
      }
    }
  }
}
