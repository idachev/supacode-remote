// Логиката на екраните от Android (`SessionsRepository`, `TerminalViewModel`, `NewTabViewModel`),
// пренесена в Node, за да е на едно място и да се тества срещу mock-а. Браузърът само показва.
//
// - `list` на 3 s, докато има активна страница и онлайн host.
// - Един отворен терминал. При всяка нова `hostSession` (reconnect, смяна LAN ↔ Relay) —
//   `list` и нов `attach`: host-ът е забравил стария заедно със старата връзка.
// - Заявките със `id` (`suggest`, `tab.new`) получават `ref` от страницата, за да знае тя кой
//   отговор е неин.

import { EventEmitter } from 'node:events';
import { ATTACH_SCROLLBACK, isTerminalStream } from './protocol.mjs';

export const TAB_NEW_TIMEOUT_MS = 12_000;

export class HostController extends EventEmitter {
  constructor(relay, { listIntervalMs = 3_000, tabNewTimeoutMs = TAB_NEW_TIMEOUT_MS } = {}) {
    super();
    this.relay = relay;
    this.listIntervalMs = listIntervalMs;
    this.tabNewTimeoutMs = tabNewTimeoutMs;
    this.active = false;
    this.openContentId = null;
    this.lastAttachId = null;
    this.lastList = null;
    this.hostSession = relay.state.hostSession;
    this.pollTimer = null;
    /** id на заявка → {kind, ref, timer} */
    this.pending = new Map();
    relay.on('state', (state) => this.#onState(state));
    relay.on('message', (message) => this.#onMessage(message));
  }

  /** Има ли страница, която гледа. Без нея няма `list` и няма отворен терминал. */
  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.refresh();
      this.#schedulePoll();
    } else {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.close();
    }
  }

  /** Показва този таб: `detach` на стария и `attach` на новия. */
  open(contentId) {
    if (this.openContentId && this.openContentId !== contentId) this.close();
    this.openContentId = contentId;
    this.#attach();
  }

  close() {
    const old = this.openContentId;
    this.openContentId = null;
    if (old && this.relay.state.hostSession != null) this.relay.detach(old, this.lastAttachId);
    this.lastAttachId = null;
  }

  input(b64) {
    if (!this.openContentId || this.relay.state.hostSession == null) return false;
    return this.relay.send({ t: 'input', contentId: this.openContentId, b64 });
  }

  suggest(ref) {
    if (!this.openContentId) return false;
    return this.#request({ t: 'suggest', contentId: this.openContentId }, 'suggest', ref, this.tabNewTimeoutMs);
  }

  /** Нов таб; `cols`/`rows` — началният размер (ОП27), само заедно и само цели числа. */
  newTab(worktreeId, cols, rows, ref) {
    const message = { t: 'tab.new', worktreeId };
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      message.cols = cols;
      message.rows = rows;
    }
    return this.#request(message, 'tab.new', ref, this.tabNewTimeoutMs);
  }

  /** `list` веднага. Без онлайн host не праща нищо: relay-ят би отговорил с грешка. */
  refresh() {
    if (!this.active || this.relay.state.hostSession == null) return false;
    return this.relay.send({ t: 'list', id: this.relay.nextId() });
  }

  // ---- вътрешно ----

  #request(message, kind, ref, timeoutMs) {
    if (this.relay.state.hostSession == null) {
      this.emit('message', { t: 'error', ref, kind, message: 'Няма връзка с Mac-а' });
      return false;
    }
    const id = this.relay.nextId();
    if (!this.relay.send({ ...message, id })) {
      this.emit('message', { t: 'error', ref, kind, message: 'Няма връзка — не е изпратено' });
      return false;
    }
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      const text = kind === 'tab.new' ? 'Mac-ът не отвори таб навреме' : 'Mac-ът не отговори навреме';
      this.emit('message', { t: 'error', ref, kind, message: text });
    }, timeoutMs);
    this.pending.set(id, { kind, ref, timer });
    return true;
  }

  #attach() {
    if (!this.openContentId || this.relay.state.hostSession == null) return;
    const id = this.relay.nextId();
    if (this.relay.send({ t: 'attach', id, contentId: this.openContentId, scrollback: ATTACH_SCROLLBACK })) {
      this.lastAttachId = id;
    }
  }

  #schedulePoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.refresh(), this.listIntervalMs);
  }

  #onState(state) {
    if (state.hostSession === this.hostSession) return;
    this.hostSession = state.hostSession;
    if (state.hostSession == null) return;
    // Нова сесия с host-а: той е забравил attach-а и не е виждал списъка ни.
    this.refresh();
    this.#attach();
  }

  #onMessage(message) {
    if (message.t === 'list') {
      this.lastList = { ...message, id: null };
      this.emit('message', this.lastList);
      return;
    }
    if (isTerminalStream(message)) {
      // Закъснели кадри от предишния таб не стигат до екрана.
      if (message.contentId !== this.openContentId) return;
      if (message.t === 'attached' && message.id != null && message.id !== this.lastAttachId) return;
      this.emit('message', message);
      return;
    }
    if (message.t === 'suggest' || message.t === 'tab.new' || message.t === 'error') {
      const request = message.id != null ? this.pending.get(message.id) : null;
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.t === 'tab.new') this.refresh();
        this.emit('message', { ...message, ref: request.ref, kind: request.kind });
        return;
      }
      // Грешка без наша заявка (напр. „not attached“) — пак се показва, както в Android.
      if (message.t === 'error') this.emit('message', message);
    }
  }
}
