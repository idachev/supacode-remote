// Пътят по LAN до Mac-а (раздел „LAN shortcut“ в протокола), пренесен от LAN частта на
// Android `RelayClient.kt`. Отделен от relay връзката, защото живее по свои правила: тръгва от
// `hello` по relay-а, държи свой keepalive и се връща сам с растяща пауза.
//
// `hello` с `lan` и верен `fpMac` → пряка връзка (`connectLan`). Паднал или неуспешен опит →
// нов `hello` по relay-а след 10 s, 20 s … до 300 s; отговорът носи `lan`, ако Mac-ът още е в
// същата мрежа. `hello` от друг Mac (multi-host, различен `hostId`) не пуска LAN.

import { connectLan } from './lan-session.mjs';
import { fpMacValid } from './lan-trust.mjs';
import { PING, encode } from './protocol.mjs';
import { silentLogger } from './log.mjs';

const HELLO = encode({ t: 'hello', v: 1 });

export class LanPath {
  /**
   * `events`: `opened(session)`, `text(session, text)`, `closed(session)` и `askHello()` (нов
   * `hello` по relay-а, ако Mac-ът е онлайн). Всяко е извикано само за текущата сесия.
   */
  constructor({ timing, events, log = silentLogger }) {
    this.timing = timing;
    this.events = events;
    this.log = log;
    this.session = null;
    this.generation = 0;
    this.connecting = false;
    this.offered = false;
    this.retryMs = timing.lanRetryFirstMs;
    this.retryTimer = null;
    this.keepalive = null;
    this.lastFrameAt = 0;
  }

  /** `hello` по relay-а: с `lan` — опит; без `lan`, но след предложен LAN — нов `hello` по-късно. */
  offer(hello, { apiKey, boundHostId }) {
    if (boundHostId && hello.hostId && hello.hostId !== boundHostId) return;
    const info = hello.lan;
    if (!info) {
      if (this.offered && !this.session && !this.connecting) this.#scheduleRetry();
      return;
    }
    if (!apiKey || !fpMacValid(apiKey, info.fp, info.fpMac)) {
      // Отпечатък без верен fpMac: не е от Mac-а (или relay-ят го е пипал) — без LAN.
      this.log.warn('lan.refused', { reason: 'fp_mac' });
      return;
    }
    this.offered = true;
    this.#start(info, apiKey);
  }

  /** Затваря всичко; връща затворената сесия, за да я забрави и gate-ът. */
  reset() {
    this.generation += 1;
    this.connecting = false;
    clearInterval(this.keepalive);
    clearTimeout(this.retryTimer);
    this.retryMs = this.timing.lanRetryFirstMs;
    this.offered = false;
    const old = this.session;
    this.session = null;
    old?.close();
    return old;
  }

  async #start(info, apiKey) {
    if (this.session || this.connecting || info.addrs.length === 0) return;
    const generation = this.generation;
    clearTimeout(this.retryTimer);
    this.connecting = true;
    const session = await this.#connect(info, apiKey);
    if (generation !== this.generation) {
      session?.close();
      return;
    }
    this.connecting = false;
    if (!session || session.closed) {
      session?.close();
      this.log.info('lan.failed', { addresses: info.addrs.length, port: info.port });
      this.#scheduleRetry();
      return;
    }
    this.#adopt(session);
  }

  async #connect(info, apiKey) {
    try {
      return await connectLan(info, apiKey, {
        timeoutMs: this.timing.lanConnectTimeoutMs,
        onText: (s, text) => this.#onText(s, text),
        onClose: (s, reason) => this.#onClosed(s, reason),
      });
    } catch {
      // Неуспешен опит: остава relay пътят. Без catch грешката би спряла Node.
      return null;
    }
  }

  #adopt(session) {
    this.session = session;
    this.lastFrameAt = Date.now();
    this.retryMs = this.timing.lanRetryFirstMs;
    // hello първо, после новата сесия: по нея терминалът прави attach, а списъкът — list.
    session.send(HELLO);
    this.log.info('lan.connected', { address: session.address });
    this.events.opened(session);
    this.keepalive = setInterval(() => this.#ping(session), this.timing.pingIntervalMs);
  }

  #ping(session) {
    if (this.session !== session) return;
    if (Date.now() - this.lastFrameAt <= this.timing.silenceLimitMs) {
      session.send(PING);
      return;
    }
    session.cancel();
    this.#onClosed(session, 'няма отговор');
  }

  #onText(session, text) {
    if (this.session !== session) return;
    this.lastFrameAt = Date.now();
    this.events.text(session, text);
  }

  #onClosed(session, reason) {
    if (this.session !== session) {
      this.events.closed(session);
      return;
    }
    this.session = null;
    clearInterval(this.keepalive);
    this.log.info('lan.closed', { address: session.address, reason });
    // Обратно на relay-а: нова сесия, терминалът прави attach наново там.
    this.events.closed(session);
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    clearTimeout(this.retryTimer);
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.timing.lanRetryMaxMs);
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation && !this.session) this.events.askHello();
    }, wait);
  }
}

export { HELLO };
