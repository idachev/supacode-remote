// Локалният WebSocket между страницата и Node (протоколът е в spec-а, раздел „Локалният
// протокол“). Node е единственият, който говори с host-а; страницата само показва и пише.
//
// Mac-ът държи по един `attach` на връзка, а Node има една връзка. Затова управлява само една
// страница: нова страница взима управлението, а старата получава `replaced` и чака `takeover`.
//
// Избор на Mac (multi-host, АН2 / ОП20 от дизайна на Supacode): нов relay праща `hosts`. Без
// записан избор и с точно един Mac на линия той се избира сам; иначе страницата показва
// „Mac-ове“. Записаният избор никога не се сменя сам, дори ако го няма в списъка. Стар relay
// (без `hosts`) е един Mac, както преди.

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { parseConnectionKey, relayLabel } from './protocol.mjs';

const BAD_KEY = 'Ключът е „relay/ключ“, напр. relay.example.com/abcde-fghij-…';

export class BrowserLink {
  constructor({ relay, host, config }) {
    this.relay = relay;
    this.host = host;
    this.config = config;
    this.settings = null;
    this.connectionKey = null;
    this.selectedHostId = null;
    this.selecting = false;
    this.active = null;
    /**
     * Ново при всяко пускане на сървъра. Страница от предишно пускане носи стария код на
     * страницата и се презарежда сама, иначе говори стария локален протокол.
     */
    this.bootId = randomUUID();
    relay.on('state', (state) => {
      this.#sendState();
      this.#autoSelect(state);
    });
    host.on('message', (message) => this.#send(this.active, message));
  }

  /** Чете записания ключ и тръгва към relay-а. */
  async start() {
    const saved = await this.config.load();
    this.selectedHostId = saved.selectedHostId;
    this.settings = saved.connectionKey ? parseConnectionKey(saved.connectionKey) : null;
    this.connectionKey = this.settings ? saved.connectionKey.trim() : null;
    this.relay.configure(this.settings, this.selectedHostId);
  }

  /** Нова страница: тя става активна. */
  attach(ws) {
    this.#activate(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      this.#onMessage(ws, message).catch((err) => this.#send(ws, { t: 'error', message: String(err?.message ?? err) }));
    });
    ws.on('close', () => {
      if (this.active !== ws) return;
      this.active = null;
      this.host.setActive(false);
    });
  }

  state() {
    return {
      t: 'state',
      bootId: this.bootId,
      configured: this.settings != null,
      relayLabel: this.settings ? relayLabel(this.settings.baseUrl) : null,
      ...this.relay.state,
      openContentId: this.host.openContentId,
      selectedHostId: this.selectedHostId,
      hostPick: this.#needsPick(this.relay.state.hosts),
    };
  }

  /** Страницата трябва да покаже „Mac-ове“: няма какво да се избере само. */
  #needsPick(hosts) {
    if (!Array.isArray(hosts)) return false;
    if (this.selectedHostId) return !hosts.some((h) => h.id === this.selectedHostId);
    return hosts.filter((h) => h.online).length !== 1;
  }

  /** Без записан избор и с точно един Mac на линия — той (АН2). */
  #autoSelect(state) {
    if (this.selecting || this.selectedHostId || !this.settings || !Array.isArray(state.hosts)) return;
    const online = state.hosts.filter((h) => h.online);
    if (online.length !== 1) return;
    // След текущото събитие: изборът рестартира връзката, а тук сме в нейното събитие.
    this.selecting = true;
    setImmediate(() => {
      this.#selectHost(online[0].id)
        .catch((err) => this.#send(this.active, { t: 'error', message: String(err?.message ?? err) }))
        .finally(() => { this.selecting = false; });
    });
  }

  /** Записва избора и се свързва наново с `?host=<id>`; старият списък и таб не важат. */
  async #selectHost(id) {
    if (!this.settings || typeof id !== 'string' || !id) return;
    // Първо записът: при грешка изборът остава стар, а автоматичният избор може да опита пак.
    await this.config.save({ connectionKey: this.connectionKey, selectedHostId: id });
    this.selectedHostId = id;
    this.host.reset();
    this.#send(this.active, { t: 'reset' });
    this.relay.configure(this.settings, id);
    this.#sendState();
  }

  #activate(ws) {
    const old = this.active;
    if (old && old !== ws) {
      this.#send(old, { t: 'replaced' });
      // Терминалът на старата страница не е на новата: тя ще отвори своя.
      this.host.close();
    }
    this.active = ws;
    this.host.setActive(true);
    this.#send(ws, this.state());
    if (this.host.lastList) this.#send(ws, this.host.lastList);
  }

  async #onMessage(ws, m) {
    if (m.t === 'takeover') {
      this.#activate(ws);
      return;
    }
    if (ws !== this.active) return;
    switch (m.t) {
      case 'open':
        if (typeof m.contentId === 'string') this.host.open(m.contentId);
        break;
      case 'close':
        this.host.close();
        break;
      case 'input':
        if (typeof m.b64 === 'string') this.host.input(m.b64, m.contentId);
        break;
      case 'line':
        if (typeof m.text === 'string') this.host.line(m.text, m.contentId);
        break;
      case 'suggest':
        this.host.suggest(m.ref ?? null);
        break;
      case 'tab.new':
        if (typeof m.worktreeId === 'string') this.host.newTab(m.worktreeId, m.cols, m.rows, m.ref ?? null);
        break;
      case 'refresh':
        this.host.refresh();
        break;
      case 'host.select':
        await this.#selectHost(m.id);
        break;
      case 'reconnect':
        this.relay.reconnectNow();
        break;
      case 'setup':
        await this.#setup(ws, m.connectionKey);
        break;
      default:
        break;
    }
  }

  async #setup(ws, text) {
    const settings = parseConnectionKey(text);
    if (!settings) {
      this.#send(ws, { t: 'setup.result', ok: false, message: BAD_KEY });
      return;
    }
    this.connectionKey = String(text).trim();
    await this.config.save({ connectionKey: this.connectionKey, selectedHostId: this.selectedHostId });
    const same = this.settings && this.settings.baseUrl === settings.baseUrl && this.settings.apiKey === settings.apiKey;
    this.settings = settings;
    if (!same) {
      // Друг relay или ключ — може и друг Mac: старият таб и списъкът вече не важат.
      this.host.reset();
      this.#send(ws, { t: 'reset' });
    }
    this.relay.configure(settings, this.selectedHostId);
    this.#send(ws, { t: 'setup.result', ok: true });
    this.#sendState();
  }

  #sendState() {
    this.#send(this.active, this.state());
  }

  #send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}
