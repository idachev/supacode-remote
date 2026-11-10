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
/** Отговори на заявки със `id`, които се връщат към страницата с нейния `ref`. */
const REPLIES = ['suggest', 'tab.new', 'error'];
/** Текстът от полето и неговият Enter тръгват на толкова един от друг (ОП33). */
export const LINE_ENTER_DELAY_MS = 150;

export class HostController extends EventEmitter {
  constructor(relay, { listIntervalMs = 3_000, tabNewTimeoutMs = TAB_NEW_TIMEOUT_MS, lineEnterDelayMs = LINE_ENTER_DELAY_MS } = {}) {
    super();
    this.lineEnterDelayMs = lineEnterDelayMs;
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

  /**
   * Вход за таба `contentId`. Друг таб (закъснял Enter след смяна на таба) не получава нищо:
   * байтовете биха изпълнили наполовина написан ред там.
   */
  input(b64, contentId) {
    if (!this.openContentId || contentId !== this.openContentId) return false;
    if (this.relay.state.hostSession == null) return false;
    return this.relay.send({ t: 'input', contentId: this.openContentId, b64 });
  }

  /**
   * Ред от полето: текстът, после `\r` след 150 ms (Claude Code и Codex вземат бързо дошло
   * парче за paste и `\r` в него става нов ред). Enter тръгва само ако сесията с host-а и
   * отвореният таб са същите: след смяна на пътя текстът може да е изгубен с падналата връзка,
   * а Enter би изпълнил стария ред в shell-а. Проверката е тук, защото тук се сменя сесията.
   */
  line(text, contentId) {
    if (!this.openContentId || contentId !== this.openContentId) return false;
    const session = this.relay.state.hostSession;
    if (session == null) return false;
    if (text && !this.relay.send({ t: 'input', contentId, b64: Buffer.from(text, 'utf8').toString('base64') })) return false;
    const enter = () => {
      if (this.openContentId !== contentId || this.relay.state.hostSession !== session) return;
      this.relay.send({ t: 'input', contentId, b64: Buffer.from('\r').toString('base64') });
    };
    if (text) setTimeout(enter, this.lineEnterDelayMs);
    else enter();
    return true;
  }

  /**
   * Размер на отворения таб по екрана на страницата (ЗД12, само от бутон). Host-ът ограничава до
   * 20…500 × 5…200 и отговаря със `size`; стар host не отговаря нищо.
   */
  resize({ contentId, cols, rows }) {
    if (!this.openContentId || contentId !== this.openContentId) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || this.relay.state.hostSession == null) return false;
    return this.relay.send({ t: 'resize', contentId, cols, rows });
  }

  suggest(ref) {
    if (!this.openContentId) {
      this.emit('message', { t: 'error', ref, kind: 'suggest', message: 'Няма отворен таб' });
      return false;
    }
    return this.#request({ t: 'suggest', contentId: this.openContentId }, { kind: 'suggest', ref });
  }

  /** Нов таб; `cols`/`rows` — началният размер (ОП27), само заедно и само цели числа. */
  newTab({ worktreeId, cols, rows, ref }) {
    const sized = Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
    const message = sized ? { t: 'tab.new', worktreeId, cols, rows } : { t: 'tab.new', worktreeId };
    return this.#request(message, { kind: 'tab.new', ref });
  }

  /** Нов ключ за връзка: старият таб и списъкът са на стария relay. */
  reset() {
    this.close();
    this.lastList = null;
  }

  /** `list` веднага. Без онлайн host не праща нищо: relay-ят би отговорил с грешка. */
  refresh() {
    if (!this.active || this.relay.state.hostSession == null) return false;
    return this.relay.send({ t: 'list', id: this.relay.nextId() });
  }

  // ---- вътрешно ----

  /** Заявка с `id`; отговорът (или грешка, или таймаут) стига до страницата с нейния `ref`. */
  #request(message, request) {
    const fail = (text) => {
      this.emit('message', { t: 'error', ...request, message: text });
      return false;
    };
    if (this.relay.state.hostSession == null) return fail('Няма връзка с Mac-а');
    const id = this.relay.nextId();
    if (!this.relay.send({ ...message, id })) return fail('Няма връзка — не е изпратено');
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) fail(request.kind === 'tab.new' ? 'Mac-ът не отвори таб навреме' : 'Mac-ът не отговори навреме');
    }, this.tabNewTimeoutMs);
    this.pending.set(id, { ...request, timer });
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
    if (message.t === 'list') this.#onList(message);
    else if (isTerminalStream(message)) this.#onTerminal(message);
    else if (REPLIES.includes(message.t)) this.#onReply(message);
  }

  #onList(message) {
    this.lastList = { ...message, id: null };
    this.emit('message', this.lastList);
  }

  /** Закъснели кадри от предишния таб или от стар attach не стигат до екрана. */
  #onTerminal(message) {
    if (message.contentId !== this.openContentId) return;
    if (message.t === 'attached' && message.id != null && message.id !== this.lastAttachId) return;
    this.emit('message', message);
  }

  #onReply(message) {
    const request = message.id != null ? this.pending.get(message.id) : null;
    if (!request) {
      // Грешка без наша заявка (напр. „not attached“) — пак се показва, както в Android.
      if (message.t === 'error') this.emit('message', message);
      return;
    }
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.t === 'tab.new') this.refresh();
    this.emit('message', { ...message, ref: request.ref, kind: request.kind });
  }
}
