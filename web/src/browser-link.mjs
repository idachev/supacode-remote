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
import { silentLogger } from './log.mjs';
import { parseConnectionKey, relayLabel } from './protocol.mjs';

const BAD_KEY = 'Ключът е „relay/ключ“, напр. relay.example.com/abcde-fghij-…';

export class BrowserLink {
  constructor({ relay, host, config, log = silentLogger }) {
    this.log = log;
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
    this.handlers = this.#handlers();
    this.#listen();
  }

  #listen() {
    this.relay.on('state', (state) => {
      this.#sendState();
      this.#autoSelect(state);
    });
    this.host.on('message', (message) => this.#send(this.active, message));
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
      this.#onMessage(ws, message).catch((err) => this.#failed(ws, message.t, err));
    });
    ws.on('close', () => {
      if (this.active !== ws) return;
      this.active = null;
      this.host.setActive(false);
      this.log.info('page.closed', {});
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
        .catch((err) => this.#failed(this.active, 'host.auto_select', err))
        .finally(() => { this.selecting = false; });
    });
  }

  /** Записва избора и се свързва наново с `?host=<id>`; старият списък и таб не важат. */
  async #selectHost(id) {
    if (!this.settings || typeof id !== 'string' || !id) return;
    // Първо записът: при грешка изборът остава стар, а автоматичният избор може да опита пак.
    await this.config.save({ connectionKey: this.connectionKey, selectedHostId: id });
    this.selectedHostId = id;
    this.log.info('host.selected', { host_id: id });
    this.host.reset();
    this.#send(this.active, { t: 'reset' });
    this.relay.configure(this.settings, id);
    this.#sendState();
  }

  #activate(ws) {
    const old = this.active;
    if (old && old !== ws) {
      this.#send(old, { t: 'replaced' });
      this.log.info('page.replaced', {});
      // Терминалът на старата страница не е на новата: тя ще отвори своя.
      this.host.close();
    }
    this.active = ws;
    this.host.setActive(true);
    this.#send(ws, this.state());
    if (this.host.lastList) this.#send(ws, this.host.lastList);
    this.log.info('page.active', {});
  }

  /** Съобщенията от активната страница. Стойностите се проверяват тук, преди да стигнат до host-а. */
  #handlers() {
    const str = (v) => typeof v === 'string';
    return {
      open: (_ws, m) => str(m.contentId) && this.host.open(m.contentId),
      close: () => this.host.close(),
      input: (_ws, m) => str(m.b64) && this.host.input(m.b64, m.contentId),
      line: (_ws, m) => str(m.text) && this.host.line(m.text, m.contentId),
      suggest: (_ws, m) => this.host.suggest(m.ref ?? null),
      resize: (_ws, m) => this.#resize(m),
      'tab.new': (_ws, m) => str(m.worktreeId) && this.host.newTab({ worktreeId: m.worktreeId, cols: m.cols, rows: m.rows, ref: m.ref ?? null }),
      refresh: () => this.host.refresh(),
      'host.select': (_ws, m) => this.#selectHost(m.id),
      reconnect: () => this.relay.reconnectNow(),
      setup: (ws, m) => this.#setup(ws, m.connectionKey),
    };
  }

  #resize(m) {
    const sent = this.host.resize({ contentId: m.contentId, cols: m.cols, rows: m.rows });
    this.log.info('terminal.resize_requested', { cols: m.cols, rows: m.rows, sent });
  }

  /** Грешката отива и в лога, и в страницата като съобщение. */
  #failed(ws, messageType, err) {
    this.log.error('page.request_failed', { message_type: String(messageType), error: err instanceof Error ? err : new Error(String(err)) });
    this.#send(ws, { t: 'error', message: String(err?.message ?? err) });
  }

  async #onMessage(ws, m) {
    if (m.t === 'takeover') {
      this.#activate(ws);
      return;
    }
    // Само активната страница управлява; непознат тип се прескача.
    if (ws !== this.active || !Object.hasOwn(this.handlers, m.t)) return;
    await this.handlers[m.t](ws, m);
  }

  async #setup(ws, text) {
    const settings = parseConnectionKey(text);
    if (!settings) {
      this.log.info('setup.rejected', { reason: 'format' });
      this.#send(ws, { t: 'setup.result', ok: false, message: BAD_KEY });
      return;
    }
    // Първо записът: при грешка в паметта остава старият ключ.
    const connectionKey = String(text).trim();
    await this.config.save({ connectionKey, selectedHostId: this.selectedHostId });
    this.connectionKey = connectionKey;
    this.log.info('setup.saved', {});
    this.#applySettings(ws, settings);
    this.#send(ws, { t: 'setup.result', ok: true });
    this.#sendState();
  }

  /** Друг relay или ключ — може и друг Mac: старият таб и списъкът вече не важат. */
  #applySettings(ws, settings) {
    const same = this.settings && this.settings.baseUrl === settings.baseUrl && this.settings.apiKey === settings.apiKey;
    this.settings = settings;
    if (!same) {
      this.host.reset();
      this.#send(ws, { t: 'reset' });
    }
    this.relay.configure(settings, this.selectedHostId);
  }

  #sendState() {
    this.#send(this.active, this.state());
  }

  #send(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}
