// Локалният WebSocket между страницата и Node (протоколът е в spec-а, раздел „Локалният
// протокол“). Node е единственият, който говори с host-а; страницата само показва и пише.
//
// Mac-ът държи по един `attach` на връзка, а Node има една връзка. Затова управлява само една
// страница: нова страница взима управлението, а старата получава `replaced` и чака `takeover`.

import WebSocket from 'ws';
import { parseConnectionKey, relayLabel } from './protocol.mjs';

const BAD_KEY = 'Ключът е „relay/ключ“, напр. relay.example.com/abcde-fghij-…';

export class BrowserLink {
  constructor({ relay, host, config }) {
    this.relay = relay;
    this.host = host;
    this.config = config;
    this.settings = null;
    this.selectedHostId = null;
    this.active = null;
    relay.on('state', () => this.#sendState());
    host.on('message', (message) => this.#send(this.active, message));
  }

  /** Чете записания ключ и тръгва към relay-а. */
  async start() {
    const saved = await this.config.load();
    this.selectedHostId = saved.selectedHostId;
    this.settings = saved.connectionKey ? parseConnectionKey(saved.connectionKey) : null;
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
      configured: this.settings != null,
      relayLabel: this.settings ? relayLabel(this.settings.baseUrl) : null,
      ...this.relay.state,
      openContentId: this.host.openContentId,
    };
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
      case 'suggest':
        this.host.suggest(m.ref ?? null);
        break;
      case 'tab.new':
        if (typeof m.worktreeId === 'string') this.host.newTab(m.worktreeId, m.cols, m.rows, m.ref ?? null);
        break;
      case 'refresh':
        this.host.refresh();
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
    await this.config.save({ connectionKey: String(text).trim(), selectedHostId: this.selectedHostId });
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
