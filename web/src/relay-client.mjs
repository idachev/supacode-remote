// Единствената връзка на уеб app-а към `<relay>/client`, пренесена от Android `RelayClient.kt`.
//
// Живее, докато има настройки. Пада ли, се свързва пак след 1 s, 2 s, 4 s … до 30 s; успешна
// връзка връща паузата на 1 s. 401 спира опитите, докато ключът не се смени.
//
// `hello` и всичко друго към host-а тръгват едва когато relay-ът каже `hostOnline:true`:
// съобщение към офлайн host relay-ът връща като грешка.
//
// LAN пътят: `hello` по relay-а с `lan` и верен `fpMac` → пряка връзка (`connectLan`). Тя поема
// всички заявки, а relay сокетът остава като резерва (само ping). Всяка смяна на пътя е нова
// `hostSession`: host-ът не знае за `attach`-а по другия път, затова терминалът го прави наново.
// Кой път носи потока на терминала, решава `TerminalStreamGate`.
//
// Node е на една нишка, затова тук няма lock-ове: всяко решение и `emit` стават в реда на
// пристигане на кадрите.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { connectLan } from './lan-session.mjs';
import { fpMacValid } from './lan-trust.mjs';
import { PING, clientUrl, decode, encode } from './protocol.mjs';
import { TerminalStreamGate } from './stream-gate.mjs';

export const DEFAULT_TIMING = Object.freeze({
  pingIntervalMs: 30_000,
  /** Без нито един кадър толкова време (след два ping-а) връзката се смята за мъртва. */
  silenceLimitMs: 75_000,
  firstRetryMs: 1_000,
  maxRetryMs: 30_000,
  lanConnectTimeoutMs: 2_500,
  /** След паднал или неуспешен LAN опит: нов `hello` по relay-а след толкова, двойно до max. */
  lanRetryFirstMs: 10_000,
  lanRetryMaxMs: 300_000,
});

export class RelayClient extends EventEmitter {
  constructor({ timing = {} } = {}) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.settings = null;
    this.hostId = null;
    this.ids = 0;
    this.attempt = 0;
    this.socket = null;
    this.lan = null;
    this.lanGeneration = 0;
    this.lanConnecting = false;
    this.lanOffered = false;
    this.lanRetryMs = this.timing.lanRetryFirstMs;
    this.lanRetryTimer = null;
    this.lanKeepalive = null;
    this.lanLastFrameAt = 0;
    this.hostSessionCounter = 0;
    this.gate = new TerminalStreamGate();
    this.state = {
      connection: 'idle', retryInMs: 0, reason: null,
      hostOnline: false, hostName: null, hostId: null,
      path: 'none', hostSession: null,
      // multi-host: `null` — стар relay без списък; `[]` — нов relay, който не знае Mac.
      hosts: null, boundHost: null,
    };
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
    let via = null;
    if (this.lan && this.lan.send(text)) via = this.lan;
    else if (this.#socketSend(this.socket, text)) via = this.socket;
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

  // ---- вътрешно ----

  #set(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k] !== v) {
        this.state[k] = v;
        changed = true;
      }
    }
    if (changed) this.emit('state', { ...this.state });
  }

  #socketSend(ws, text) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(text);
    return true;
  }

  #sendText(text) {
    if (this.lan && this.lan.send(text)) return true;
    return this.#socketSend(this.socket, text);
  }

  #sendDetaches(targets) {
    for (const [source, contentId] of targets) {
      const text = encode({ t: 'detach', contentId });
      if (source instanceof WebSocket) this.#socketSend(source, text);
      else source.send(text);
    }
  }

  /** Към слушателите, ако gate-ът пуска кадъра от `source`; спира старите attach-ове при смяна. */
  #deliver(source, message) {
    const decision = this.gate.accept(source, message);
    this.#sendDetaches(decision.detach);
    if (decision.deliver) this.emit('message', message);
  }

  #restart() {
    // Буди чакащия цикъл: той вижда новия `attempt` и спира.
    this.emit('restart-wait');
    // Старият опит спира веднага: закъснелите му събития вече не пипат състоянието.
    this.attempt += 1;
    const old = this.socket;
    this.socket = null;
    if (old) {
      this.gate.closed(old);
      old.terminate();
    }
    this.#closeLan();
    this.#set({ hostOnline: false, hosts: null, boundHost: null });
    this.#updateRoute();
    if (!this.settings) {
      this.#set({ connection: 'idle', retryInMs: 0, reason: null });
      return;
    }
    const url = clientUrl(this.settings.baseUrl, this.hostId);
    if (!url) {
      this.#set({ connection: 'waiting', retryInMs: 0, reason: 'невалиден адрес' });
      return;
    }
    this.#runLoop(url, this.settings.apiKey, this.attempt);
  }

  async #runLoop(url, apiKey, attempt) {
    let retry = this.timing.firstRetryMs;
    while (attempt === this.attempt) {
      this.#set({ connection: 'connecting', retryInMs: 0 });
      const outcome = await this.#connectOnce(url, apiKey, attempt);
      if (attempt !== this.attempt) return;
      if (outcome.unauthorized) {
        this.#set({ connection: 'unauthorized', reason: null });
        return;
      }
      if (outcome.wasOpen) retry = this.timing.firstRetryMs;
      this.#set({ connection: 'waiting', retryInMs: retry, reason: outcome.reason });
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { this.off('restart-wait', wake); resolve(); }, retry);
        this.once('restart-wait', wake);
      });
      retry = Math.min(retry * 2, this.timing.maxRetryMs);
    }
  }

  #connectOnce(url, apiKey, attempt) {
    return new Promise((resolve) => {
      let opened = false;
      let lastFrameAt = Date.now();
      let finished = false;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` }, perMessageDeflate: false });
      const current = () => !finished && attempt === this.attempt;
      const finish = (outcome) => {
        if (finished) return;
        finished = true;
        clearInterval(keepalive);
        if (this.socket === ws) this.socket = null;
        this.gate.closed(ws);
        // LAN връзката остава (както в Android): тя не зависи от relay сокета.
        if (attempt === this.attempt) {
          this.#set({ hostOnline: false });
          this.#updateRoute();
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
        resolve(outcome);
      };
      ws.on('open', () => {
        if (!current()) return;
        opened = true;
        lastFrameAt = Date.now();
        this.socket = ws;
        this.#set({ connection: 'connected', retryInMs: 0, reason: null });
      });
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        if (res.statusCode === 401) finish({ unauthorized: true });
        else finish({ reason: `HTTP ${res.statusCode}`, wasOpen: false });
      });
      ws.on('message', (data, isBinary) => {
        if (!current() || isBinary) return;
        lastFrameAt = Date.now();
        const message = decode(data.toString('utf8'));
        if (!message) return;
        if (message.t === 'relay') this.#onRelayStatus(ws, message);
        else if (message.t === 'hello') {
          this.#set({ hostName: message.host, hostId: message.hostId });
          this.#onRelayHello(message);
        }
        this.#deliver(ws, message);
      });
      ws.on('error', (err) => finish({ reason: err.message || 'грешка', wasOpen: opened }));
      ws.on('close', (code, reason) => finish({ reason: reason?.toString() || `затворена (${code})`, wasOpen: opened }));
      const keepalive = setInterval(() => {
        if (this.socket !== ws) return;
        if (Date.now() - lastFrameAt > this.timing.silenceLimitMs) {
          finish({ reason: 'няма отговор от relay-а', wasOpen: opened });
          return;
        }
        this.#socketSend(ws, PING);
      }, this.timing.pingIntervalMs);
    });
  }

  #onRelayStatus(ws, message) {
    // Само ръбът false → true значи нов host; повторен `true` носи само списъка на Mac-овете.
    if (message.hostOnline && !this.state.hostOnline) this.#socketSend(ws, encode({ t: 'hello', v: 1 }));
    this.#set({ hostOnline: message.hostOnline, hosts: message.hosts, boundHost: message.host });
    this.#updateRoute();
  }

  #updateRoute() {
    const route = this.lan ? 'lan' : this.state.hostOnline ? 'relay' : 'none';
    if (route === this.state.path) return;
    if (route === 'none') {
      this.#set({ path: route, hostSession: null });
    } else {
      this.hostSessionCounter += 1;
      this.#set({ path: route, hostSession: this.hostSessionCounter });
    }
  }

  // ---- LAN пътят ----

  /**
   * `hello` по relay-а. С `lan` — опит за пряка връзка. Без `lan`, но след като LAN вече е
   * бил предложен в тази връзка — нов `hello` по-късно, за да се върнем на LAN, щом пак е там.
   * `hello` от друг Mac (multi-host, различен `hostId`) не пуска LAN.
   */
  #onRelayHello(hello) {
    if (this.hostId && hello.hostId && hello.hostId !== this.hostId) return;
    const info = hello.lan;
    const key = this.settings?.apiKey;
    if (info && key && fpMacValid(key, info.fp, info.fpMac)) {
      this.lanOffered = true;
      this.#maybeStartLan(info);
    } else if (info) {
      // Отпечатък без верен fpMac: не е от Mac-а (или relay-ят го е пипал) — без LAN.
    } else if (this.lanOffered && !this.lan && !this.lanConnecting) {
      this.#scheduleLanRetry();
    }
  }

  async #maybeStartLan(info) {
    if (this.lan || this.lanConnecting || info.addrs.length === 0) return;
    const key = this.settings?.apiKey;
    if (!key) return;
    const generation = this.lanGeneration;
    clearTimeout(this.lanRetryTimer);
    this.lanConnecting = true;
    const session = await connectLan(info, key, {
      timeoutMs: this.timing.lanConnectTimeoutMs,
      onText: (s, text) => this.#onLanText(s, text),
      onClose: (s) => this.#onLanClosed(s),
    });
    if (generation !== this.lanGeneration) {
      session?.close();
      return;
    }
    this.lanConnecting = false;
    if (!session || session.closed) {
      session?.close();
      this.#scheduleLanRetry();
      return;
    }
    this.lan = session;
    this.lanLastFrameAt = Date.now();
    this.lanRetryMs = this.timing.lanRetryFirstMs;
    // hello първо, после новата сесия: по нея терминалът прави attach, а списъкът — list.
    session.send(encode({ t: 'hello', v: 1 }));
    this.#updateRoute();
    this.lanKeepalive = setInterval(() => {
      if (this.lan !== session) return;
      if (Date.now() - this.lanLastFrameAt > this.timing.silenceLimitMs) {
        session.cancel();
        this.#onLanClosed(session);
        return;
      }
      session.send(PING);
    }, this.timing.pingIntervalMs);
  }

  #onLanText(session, text) {
    if (this.lan !== session) return;
    this.lanLastFrameAt = Date.now();
    const message = decode(text);
    if (!message) return;
    // `lan` в hello по самия LAN не значи нищо ново.
    if (message.t === 'hello') this.#set({ hostName: message.host, hostId: message.hostId });
    this.#deliver(session, message);
  }

  #onLanClosed(session) {
    this.gate.closed(session);
    if (this.lan !== session) return;
    this.lan = null;
    clearInterval(this.lanKeepalive);
    // Обратно на relay-а: нова сесия, терминалът прави attach наново там.
    this.#updateRoute();
    this.#scheduleLanRetry();
  }

  /** Следващият `hello` по relay-а: отговорът носи `lan`, ако Mac-ът още е в същата мрежа. */
  #scheduleLanRetry() {
    clearTimeout(this.lanRetryTimer);
    const wait = this.lanRetryMs;
    this.lanRetryMs = Math.min(this.lanRetryMs * 2, this.timing.lanRetryMaxMs);
    const generation = this.lanGeneration;
    this.lanRetryTimer = setTimeout(() => {
      if (generation !== this.lanGeneration || this.lan || !this.state.hostOnline) return;
      this.#socketSend(this.socket, encode({ t: 'hello', v: 1 }));
    }, wait);
  }

  #closeLan() {
    this.lanGeneration += 1;
    this.lanConnecting = false;
    clearInterval(this.lanKeepalive);
    clearTimeout(this.lanRetryTimer);
    this.lanRetryMs = this.timing.lanRetryFirstMs;
    this.lanOffered = false;
    const lan = this.lan;
    this.lan = null;
    if (lan) {
      this.gate.closed(lan);
      lan.close();
    }
  }
}
