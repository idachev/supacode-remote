// Единствената връзка на уеб app-а към `<relay>/client`, пренесена от Android `RelayClient.kt`.
//
// Живее, докато има настройки. Пада ли, се свързва пак след 1 s, 2 s, 4 s … до 30 s; успешна
// връзка връща паузата на 1 s. 401 спира опитите, докато ключът не се смени.
//
// `hello` и всичко друго към host-а тръгват едва когато relay-ът каже `hostOnline:true`:
// съобщение към офлайн host relay-ът връща като грешка.
//
// Пряката връзка в LAN е в `LanPath`. Щом е горе, тя поема всички заявки, а relay сокетът остава
// като резерва (само ping). Всяка смяна на пътя е нова `hostSession`: host-ът не знае за
// `attach`-а по другия път, затова терминалът го прави наново. Кой път носи потока на терминала,
// решава `TerminalStreamGate`.
//
// Node е на една нишка, затова тук няма lock-ове: всяко решение и `emit` стават в реда на
// пристигане на кадрите.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { HELLO, LanPath } from './lan-path.mjs';
import { silentLogger } from './log.mjs';
import { PING, clientUrl, decode, encode } from './protocol.mjs';
import { TerminalStreamGate } from './stream-gate.mjs';

export const DEFAULT_TIMING = Object.freeze({
  pingIntervalMs: 30_000,
  /** Без нито един кадър толкова време (след два ping-а) връзката се смята за мъртва. */
  silenceLimitMs: 75_000,
  firstRetryMs: 1_000,
  maxRetryMs: 30_000,
  handshakeTimeoutMs: 15_000,
  lanConnectTimeoutMs: 2_500,
  /** След паднал или неуспешен LAN опит: нов `hello` по relay-а след толкова, двойно до max. */
  lanRetryFirstMs: 10_000,
  lanRetryMaxMs: 300_000,
});

function initialState() {
  return {
    connection: 'idle', retryInMs: 0, reason: null,
    hostOnline: false, hostName: null, hostId: null, hostApp: null,
    path: 'none', hostSession: null,
    // multi-host: `null` — стар relay без списък; `[]` — нов relay, който не знае Mac.
    hosts: null, boundHost: null,
  };
}

/** Полетата, чиято промяна се записва в лога (`relay.state`). */
const LOGGED = ['connection', 'path', 'hostOnline', 'boundHost', 'reason'];

/** Списъците (`hosts`) идват наново при всяко `relay` съобщение: сравнение по съдържание. */
function sameValue(a, b) {
  return a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
}

function socketSend(ws, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(text);
  return true;
}

export class RelayClient extends EventEmitter {
  constructor({ timing = {}, log = silentLogger } = {}) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.log = log;
    this.settings = null;
    this.hostId = null;
    this.ids = 0;
    this.attempt = 0;
    this.socket = null;
    this.hostSessionCounter = 0;
    this.gate = new TerminalStreamGate();
    this.state = initialState();
    this.lanPath = new LanPath({ timing: this.timing, log, events: this.#lanEvents() });
  }

  /** Текущата LAN сесия или `null`. */
  get lan() {
    return this.lanPath.session;
  }

  nextId() {
    this.ids += 1;
    return this.ids;
  }

  /** Нови настройки (или `null`): старата връзка се затваря и, ако може, тръгва нова. */
  configure(settings, hostId = null) {
    const same = settings && this.settings && settings.baseUrl === this.settings.baseUrl &&
      settings.apiKey === this.settings.apiKey && hostId === this.hostId;
    if (same && this.state.connection !== 'unauthorized') return;
    this.settings = settings ? { baseUrl: settings.baseUrl, apiKey: settings.apiKey } : null;
    this.hostId = hostId || null;
    this.#restart();
  }

  /** Повторен опит веднага, напр. от бутона „Свържи отново“. */
  reconnectNow() {
    this.#restart();
  }

  stop() {
    this.settings = null;
    this.#restart();
  }

  /** По LAN, ако е горе, иначе по relay-а. `false`, ако съобщението не е тръгнало. */
  send(message) {
    const text = encode(message);
    if (message.t !== 'attach' && message.t !== 'detach') return this.#sendText(text);
    const via = this.#sendVia(text);
    if (!via) return false;
    if (message.t === 'attach') this.gate.attachSent(via, message.id, message.contentId);
    else this.#sendDetaches(this.gate.detachSent(via, message.contentId));
    return true;
  }

  /** `detach` от таб, чийто последен `attach` е `lastAttachId`; не тръгва, ако е остарял. */
  detach(contentId, lastAttachId) {
    if (this.gate.isStaleDetach(contentId, lastAttachId)) return true;
    return this.send({ t: 'detach', contentId });
  }

  // ---- състояние и изпращане ----

  #set(patch) {
    const changed = Object.entries(patch).filter(([k, v]) => !sameValue(this.state[k], v));
    if (!changed.length) return;
    for (const [k, v] of changed) this.state[k] = v;
    if (changed.some(([k]) => LOGGED.includes(k))) this.#logState();
    this.emit('state', { ...this.state });
  }

  #logState() {
    const s = this.state;
    this.log.info('relay.state', {
      connection: s.connection, path: s.path, host_online: s.hostOnline, bound_host: s.boundHost, reason: s.reason,
    });
  }

  /** Пътят, по който тръгна текстът (LAN сесията или relay сокетът), или `null`. */
  #sendVia(text) {
    if (this.lan?.send(text)) return this.lan;
    return socketSend(this.socket, text) ? this.socket : null;
  }

  #sendText(text) {
    return this.#sendVia(text) != null;
  }

  #sendDetaches(targets) {
    for (const [source, contentId] of targets) {
      const text = encode({ t: 'detach', contentId });
      if (source instanceof WebSocket) socketSend(source, text);
      else source.send(text);
    }
  }

  /** Към слушателите, ако gate-ът пуска кадъра от `source`; спира старите attach-ове при смяна. */
  #deliver(source, message) {
    const decision = this.gate.accept(source, message);
    this.#sendDetaches(decision.detach);
    if (decision.deliver) this.emit('message', message);
  }

  #updateRoute() {
    const route = this.lan ? 'lan' : this.state.hostOnline ? 'relay' : 'none';
    if (route === this.state.path) return;
    if (route === 'none') {
      this.#set({ path: route, hostSession: null });
      return;
    }
    this.hostSessionCounter += 1;
    this.#set({ path: route, hostSession: this.hostSessionCounter });
  }

  // ---- relay сокетът ----

  #restart() {
    // Буди чакащия цикъл: той вижда новия `attempt` и спира.
    this.emit('restart-wait');
    // Старият опит спира веднага: закъснелите му събития вече не пипат състоянието.
    this.attempt += 1;
    this.#dropConnections();
    // Името и id-то са от hello на стария Mac: след смяна на Mac-а не бива да остават.
    this.#set({ hostOnline: false, hosts: null, boundHost: null, hostName: null, hostId: null, hostApp: null });
    this.#updateRoute();
    this.#startLoop();
  }

  #dropConnections() {
    const old = this.socket;
    this.socket = null;
    if (old) {
      this.gate.closed(old);
      old.terminate();
    }
    const lan = this.lanPath.reset();
    if (lan) this.gate.closed(lan);
  }

  #startLoop() {
    if (!this.settings) {
      this.#set({ connection: 'idle', retryInMs: 0, reason: null });
      return;
    }
    const url = clientUrl(this.settings.baseUrl, this.hostId);
    if (!url) {
      this.#set({ connection: 'waiting', retryInMs: 0, reason: 'невалиден адрес' });
      return;
    }
    this.#runLoop(url, this.attempt);
  }

  async #runLoop(url, attempt) {
    let retry = this.timing.firstRetryMs;
    while (attempt === this.attempt) {
      this.#set({ connection: 'connecting', retryInMs: 0 });
      const outcome = await this.#connectOnce(url, attempt);
      if (attempt !== this.attempt) return;
      if (outcome.unauthorized) {
        this.log.warn('relay.unauthorized', { status: 401 });
        this.#set({ connection: 'unauthorized', reason: null });
        return;
      }
      if (outcome.wasOpen) retry = this.timing.firstRetryMs;
      this.#set({ connection: 'waiting', retryInMs: retry, reason: outcome.reason });
      await this.#sleepUnlessRestarted(retry);
      retry = Math.min(retry * 2, this.timing.maxRetryMs);
    }
  }

  #sleepUnlessRestarted(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('restart-wait', wake);
        resolve();
      }, ms);
      this.once('restart-wait', wake);
    });
  }

  /** Един опит: свършва с `{unauthorized}` или `{reason, wasOpen}`, когато сокетът падне. */
  #connectOnce(url, attempt) {
    return new Promise((resolve) => {
      const ws = this.#openSocket(url);
      if (!ws) {
        resolve({ reason: 'невалиден адрес на relay-а', wasOpen: false });
        return;
      }
      const conn = { ws, attempt, resolve, opened: false, finished: false, lastFrameAt: Date.now(), keepalive: null };
      this.#watch(conn);
    });
  }

  /** `null` за невалиден адрес: `new WebSocket` хвърля веднага и иначе би спрял Node. */
  #openSocket(url) {
    try {
      // handshakeTimeout: upgrade без отговор (след sleep, мрежа, която гълта заявката) иначе виси.
      return new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.settings.apiKey}` },
        perMessageDeflate: false,
        handshakeTimeout: this.timing.handshakeTimeoutMs,
      });
    } catch {
      return null;
    }
  }

  #watch(conn) {
    const { ws } = conn;
    ws.on('open', () => this.#opened(conn));
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      this.#finish(conn, res.statusCode === 401 ? { unauthorized: true } : { reason: `HTTP ${res.statusCode}`, wasOpen: false });
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.#frame(conn, data.toString('utf8'));
    });
    ws.on('error', (err) => this.#finish(conn, { reason: err.message || 'грешка', wasOpen: conn.opened }));
    ws.on('close', (code, reason) => this.#finish(conn, { reason: reason?.toString() || `затворена (${code})`, wasOpen: conn.opened }));
    conn.keepalive = setInterval(() => this.#keepalive(conn), this.timing.pingIntervalMs);
  }

  #current(conn) {
    return !conn.finished && conn.attempt === this.attempt;
  }

  #opened(conn) {
    if (!this.#current(conn)) return;
    conn.opened = true;
    conn.lastFrameAt = Date.now();
    this.socket = conn.ws;
    this.#set({ connection: 'connected', retryInMs: 0, reason: null });
  }

  #frame(conn, text) {
    if (!this.#current(conn)) return;
    conn.lastFrameAt = Date.now();
    const message = decode(text);
    if (!message) return;
    if (message.t === 'relay') this.#onRelayStatus(conn.ws, message);
    else if (message.t === 'hello') this.#onRelayHello(message);
    this.#deliver(conn.ws, message);
  }

  #keepalive(conn) {
    if (this.socket !== conn.ws) return;
    if (Date.now() - conn.lastFrameAt > this.timing.silenceLimitMs) {
      this.#finish(conn, { reason: 'няма отговор от relay-а', wasOpen: conn.opened });
      return;
    }
    socketSend(conn.ws, PING);
  }

  #finish(conn, outcome) {
    if (conn.finished) return;
    conn.finished = true;
    clearInterval(conn.keepalive);
    const { ws } = conn;
    if (this.socket === ws) this.socket = null;
    this.gate.closed(ws);
    // LAN връзката остава (както в Android): тя не зависи от relay сокета.
    if (conn.attempt === this.attempt) {
      this.#set({ hostOnline: false });
      this.#updateRoute();
    }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    conn.resolve(outcome);
  }

  #onRelayStatus(ws, message) {
    // Само ръбът false → true значи нов host; повторен `true` носи само списъка на Mac-овете.
    if (message.hostOnline && !this.state.hostOnline) socketSend(ws, HELLO);
    this.#set({ hostOnline: message.hostOnline, hosts: message.hosts, boundHost: message.host });
    this.#updateRoute();
  }

  #onRelayHello(hello) {
    this.#set({ hostName: hello.host, hostId: hello.hostId, hostApp: hello.app });
    this.lanPath.offer(hello, { apiKey: this.settings?.apiKey, boundHostId: this.hostId });
  }

  // ---- LAN пътят ----

  #lanEvents() {
    return {
      opened: () => this.#updateRoute(),
      text: (session, text) => this.#lanText(session, text),
      closed: (session) => {
        this.gate.closed(session);
        this.#updateRoute();
      },
      askHello: () => {
        if (this.state.hostOnline) socketSend(this.socket, HELLO);
      },
    };
  }

  #lanText(session, text) {
    const message = decode(text);
    if (!message) return;
    // `lan` в hello по самия LAN не значи нищо ново.
    if (message.t === 'hello') this.#set({ hostName: message.host, hostId: message.hostId, hostApp: message.app });
    this.#deliver(session, message);
  }
}
