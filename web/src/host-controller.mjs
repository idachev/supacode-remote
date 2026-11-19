// Логиката на екраните от Android (`SessionsRepository`, `TerminalViewModel`, `NewTabViewModel`),
// пренесена в Node, за да е на едно място и да се тества срещу mock-а. Браузърът само показва.
//
// - Списъкът, докато има активна страница и онлайн host: `watch` (Mac-ът праща `list` сам при
//   промяна), ако го има в `caps` на текущия път, иначе `list` на 3 s (ДЗ5).
// - Набор от живи терминали (ДЗ7, ДЗ22): до 8, най-скоро гледаният първи (LRU), първият е
//   видимият. С `attach.keep` в `caps` всеки остава закачен и връщането към него е без мрежа;
//   изходът на всички стига до страницата. Над тавана най-отдавна видяният получава `detach`, а
//   страницата — `released`. Без `attach.keep` (стар Mac) — един терминал, както преди.
// - При всяка нова `hostSession` (reconnect, смяна LAN ↔ Relay) — `list` и `attach` само на
//   видимия: host-ът е забравил всички attach-ове. Скритите се закачат, когато се покажат (ДЗ8).
// - Заявките със `id` (`suggest`, `tab.new`, `worktree.new`) получават `ref` от страницата, за да знае тя кой
//   отговор е неин.

import { EventEmitter } from 'node:events';
import { silentLogger } from './log.mjs';
import { ATTACH_LIMIT, ATTACH_SCROLLBACK, CAPS, isTerminalStream } from './protocol.mjs';

/** Колко живи терминала държи уеб app-ът (ЦЛ3); Mac-ът приема до 16 на връзка. */
export const KEPT_LIMIT = 8;

export const TAB_NEW_TIMEOUT_MS = 12_000;
/**
 * ЗД11 (К3): Mac-ът отговаря на `worktree.new` до 310 s (300 s създаване + 10 s за първия таб);
 * клиентът чака малко повече, за да дойде първо неговият отговор.
 */
export const WORKTREE_NEW_TIMEOUT_MS = 320_000;
/** ЗД13 (К8): Mac-ът изтрива до 300 s и опреснява до 60 s; клиентът чака малко повече. */
export const WORKTREE_DELETE_TIMEOUT_MS = 310_000;
export const WORKTREES_REFRESH_TIMEOUT_MS = 70_000;
/** Кодът на грешката, когато отговорът на `worktree.*` не може да дойде (таймаут, паднала връзка). */
export const WORKTREE_LOST = 'worktree_lost';
/** Заявките, чийто отговор идва само по връзката, по която са тръгнали (К2, К7), и чакат дълго. */
const SESSION_BOUND = ['worktree.new', 'worktree.delete', 'worktrees.refresh'];
/** Отговори на заявки със `id`, които се връщат към страницата с нейния `ref`. */
const REPLIES = ['suggest', 'tab.new', 'worktree.new', 'worktree.delete', 'error'];
/** Текстът от полето и неговият Enter тръгват на толкова един от друг (ОП33). */
export const LINE_ENTER_DELAY_MS = 150;

export class HostController extends EventEmitter {
  constructor(relay, {
    listIntervalMs = 3_000, tabNewTimeoutMs = TAB_NEW_TIMEOUT_MS, worktreeNewTimeoutMs = WORKTREE_NEW_TIMEOUT_MS,
    worktreeDeleteTimeoutMs = WORKTREE_DELETE_TIMEOUT_MS, worktreesRefreshTimeoutMs = WORKTREES_REFRESH_TIMEOUT_MS,
    lineEnterDelayMs = LINE_ENTER_DELAY_MS, keptLimit = KEPT_LIMIT, log = silentLogger,
  } = {}) {
    super();
    this.timeouts = {
      'worktree.new': worktreeNewTimeoutMs,
      'worktree.delete': worktreeDeleteTimeoutMs,
      'worktrees.refresh': worktreesRefreshTimeoutMs,
    };
    this.lineEnterDelayMs = lineEnterDelayMs;
    this.relay = relay;
    this.log = log;
    this.listIntervalMs = listIntervalMs;
    this.tabNewTimeoutMs = tabNewTimeoutMs;
    this.keptLimit = keptLimit;
    this.active = false;
    /** Живите терминали, най-скоро гледаният първи (LRU). */
    this.kept = [];
    /**
     * Видимият терминал — към него само вървят вход, `resize` и `suggest` (АЦ1). Ако не е
     * `null`, е `kept[0]`; `null` — страницата не показва таб, а скритите още живеят.
     */
    this.visible = null;
    /** Терминали от набора, които Mac-ът не държи по текущата сесия: при показване — `attach`. */
    this.needsAttach = new Set();
    /** Терминал → id на последния му `attach`: закъснял `attached` и остарял `detach` се познават по него. */
    this.attachIds = new Map();
    /** Терминал → сесията, в която е дошъл неговият `attached`. */
    this.attachedIn = new Map();
    /** id на последния `watch` с `on:true` и сесията му; отговор с друго id не се гледа. */
    this.watchId = null;
    this.watchSession = null;
    /** Сесията, в която Mac-ът отказа `watch`: в нея остава таймерът. */
    this.watchRefused = null;
    this.lastList = null;
    this.hostSession = relay.state.hostSession;
    this.pollTimer = null;
    /** id на заявка → {kind, ref, timer} */
    this.pending = new Map();
    relay.on('state', (state) => this.#onState(state));
    relay.on('message', (message) => this.#onMessage(message));
  }

  /** Видимият таб (името е от времето с един терминал; ползват го страницата и `attach.mjs`). */
  get openContentId() {
    return this.visible;
  }

  /** id на последния `attach` на видимия таб. */
  get lastAttachId() {
    return this.visible ? this.attachIds.get(this.visible) ?? null : null;
  }

  /** Сесията, в която е дошъл `attached` на видимия таб; `null`, докато не е дошъл. */
  get attachedSession() {
    return this.visible ? this.attachedIn.get(this.visible) ?? null : null;
  }

  /**
   * Има ли страница, която гледа. Без нея няма `list`, `watch` и живи терминали: новата
   * страница започва без терминали (ДЗ24) и отваря своя таб с нов `attach`.
   */
  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.#startListing();
    } else {
      this.#stopWatch();
      this.#syncPoll();
      this.releaseAll();
    }
  }

  /**
   * Показва този таб (ДЗ7): жив терминал от набора — само става видим, без мрежа; иначе
   * `attach`. Без `attach.keep` старият таб получава `detach`, както преди.
   */
  open(contentId) {
    if (this.#keepMode() === 'single' && this.visible && this.visible !== contentId) this.close();
    if (!this.kept.includes(contentId)) this.needsAttach.add(contentId);
    this.kept = [contentId, ...this.kept.filter((c) => c !== contentId)];
    this.visible = contentId;
    if (this.needsAttach.has(contentId)) this.#attach(contentId);
    while (this.kept.length > this.keptLimit) this.#release(this.kept.at(-1));
  }

  /** Страницата затвори видимия таб (изтрит worktree): той излиза от набора. */
  close() {
    if (this.visible) this.#release(this.visible);
  }

  /** Всички живи терминали излизат от набора: смяна на страницата, на ключа или на Mac-а. */
  releaseAll() {
    for (const contentId of [...this.kept]) this.#release(contentId);
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
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    // Само след `attached` в текущата сесия: по нов път (LAN ↔ relay) host-ът още не знае таба.
    if (this.attachedSession == null || this.attachedSession !== this.relay.state.hostSession) return false;
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

  /**
   * Нов worktree в repository-то (ЗД11). Името е задължително: без него Mac-ът връща
   * `worktree_invalid`, затова празно не тръгва изобщо.
   */
  newWorktree({ repositoryId, name, cols, rows, ref }) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      this.emit('message', { t: 'error', ref, kind: 'worktree.new', message: 'Няма име на branch', code: 'worktree_invalid' });
      return false;
    }
    const sized = Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0;
    const message = { t: 'worktree.new', repositoryId, name: trimmed, ...(sized ? { cols, rows } : {}) };
    return this.#request(message, { kind: 'worktree.new', ref });
  }

  /** Изтрива worktree на Mac-а (ЗД13); branch-ът остава. */
  deleteWorktree({ worktreeId, ref }) {
    return this.#request({ t: 'worktree.delete', worktreeId }, { kind: 'worktree.delete', ref });
  }

  /** Mac-ът да прочете worktree-тата наново (ЗД13); отговорът е `list` със същото `id`. */
  refreshWorktrees({ ref }) {
    return this.#request({ t: 'worktrees.refresh' }, { kind: 'worktrees.refresh', ref });
  }

  /** Нов ключ за връзка: старите табове и списъкът са на стария relay. */
  reset() {
    this.releaseAll();
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
    const fail = (text, code) => {
      this.emit('message', { t: 'error', ...request, message: text, ...(code ? { code } : {}) });
      return false;
    };
    const session = this.relay.state.hostSession;
    if (session == null) return fail('Няма връзка с Mac-а');
    const id = this.relay.nextId();
    if (!this.relay.send({ ...message, id })) return fail('Няма връзка — не е изпратено');
    const bound = SESSION_BOUND.includes(request.kind);
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      if (bound) fail('Mac-ът не отговори навреме', WORKTREE_LOST);
      else fail(request.kind === 'tab.new' ? 'Mac-ът не отвори таб навреме' : 'Mac-ът не отговори навреме');
    }, this.timeouts[request.kind] ?? this.tabNewTimeoutMs);
    this.pending.set(id, { ...request, timer, session });
    return true;
  }

  /**
   * К2, К7: отговорът на `worktree.*` идва само по връзката, по която е тръгнала заявката. Нова
   * сесия с host-а (reconnect, LAN ↔ Relay) значи, че той няма да дойде, а Mac-ът продължава
   * да създава. Страницата казва това веднага, вместо да чака 320 s.
   */
  #dropWorktreeWaits(session) {
    for (const [id, request] of this.pending) {
      if (!SESSION_BOUND.includes(request.kind) || request.session === session) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      this.emit('message', { t: 'error', kind: request.kind, ref: request.ref, message: 'Връзката с Mac-а падна', code: WORKTREE_LOST });
    }
  }

  /** `caps` на текущия път: `keep` — с `attach.keep`; `single` — без него; `unknown` — `hello` още няма. */
  #keepMode() {
    const caps = this.relay.state.caps;
    if (!Array.isArray(caps)) return 'unknown';
    return caps.includes(CAPS.ATTACH_KEEP) ? 'keep' : 'single';
  }

  /**
   * `attach` с `keep`, щом пътят го може. Без него (стар Mac или `hello` по новия сокет още не
   * е дошъл, ДЗ8b) Mac-ът откача другите терминали на връзката, затова те чакат нов attach.
   */
  #attach(contentId) {
    if (this.relay.state.hostSession == null) return;
    const keep = this.#keepMode() === 'keep';
    const id = this.relay.nextId();
    const message = { t: 'attach', id, contentId, scrollback: ATTACH_SCROLLBACK, ...(keep ? { keep: true } : {}) };
    if (!this.relay.send(message)) return;
    this.attachIds.set(contentId, id);
    this.attachedIn.delete(contentId);
    this.needsAttach.delete(contentId);
    if (!keep) for (const other of this.kept) if (other !== contentId) this.needsAttach.add(other);
  }

  /**
   * Терминалът излиза от набора: `detach`, ако Mac-ът още го държи по тази сесия, и `released`
   * към страницата, за да махне своя терминал.
   */
  #release(contentId) {
    const attached = !this.needsAttach.has(contentId);
    this.kept = this.kept.filter((c) => c !== contentId);
    if (this.visible === contentId) this.visible = null;
    this.needsAttach.delete(contentId);
    if (attached && this.relay.state.hostSession != null) this.relay.detach(contentId, this.attachIds.get(contentId) ?? null);
    this.attachIds.delete(contentId);
    this.attachedIn.delete(contentId);
    this.emit('message', { t: 'released', contentId });
  }

  /** Без `attach.keep` наборът е само видимият (АЦ3). */
  #shrinkToVisible() {
    for (const contentId of [...this.kept]) if (contentId !== this.visible) this.#release(contentId);
  }

  /** ДЗ10: не би трябвало да стане (8 < 16); ако стане — само видимият и пак `attach`. */
  #onAttachLimit(message) {
    this.log.warn('terminal.attach_limit', { kept: this.kept.length });
    this.#shrinkToVisible();
    if (!this.visible) return;
    this.needsAttach.add(this.visible);
    this.#attach(this.visible);
  }

  // ---- списъкът: watch или таймер ----

  /** `list` веднага, после `watch` или таймерът. */
  #startListing() {
    this.refresh();
    this.#syncWatch();
  }

  #watching() {
    return this.watchSession != null && this.watchSession === this.relay.state.hostSession;
  }

  /** `watch` веднъж за сесия, щом страницата гледа и пътят го може; връща дали е тръгнал сега. */
  #syncWatch() {
    const session = this.relay.state.hostSession;
    const caps = this.relay.state.caps;
    const can = this.active && session != null && Array.isArray(caps) && caps.includes(CAPS.WATCH);
    let started = false;
    if (can && !this.#watching() && this.watchRefused !== session) {
      const id = this.relay.nextId();
      if (this.relay.send({ t: 'watch', id, on: true })) {
        this.watchId = id;
        this.watchSession = session;
        started = true;
      }
    }
    this.#syncPoll();
    return started;
  }

  /** Таймерът върви само докато има страница и няма `watch`. */
  #syncPoll() {
    const poll = this.active && !this.#watching();
    if (poll && !this.pollTimer) this.pollTimer = setInterval(() => this.refresh(), this.listIntervalMs);
    if (!poll && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  #stopWatch() {
    if (this.#watching()) this.relay.send({ t: 'watch', id: this.relay.nextId(), on: false });
    this.watchId = null;
    this.watchSession = null;
  }

  /**
   * Само отговорът на последния `watch` с `on:true` значи нещо: `on:false` (или грешка) — Mac-ът
   * не гледа, остава таймерът. Отговорът на `on:false` от стария път се пренебрегва.
   */
  #onWatchReply(message) {
    if (message.id == null || message.id !== this.watchId) return;
    if (message.t === 'watch' && message.on) return;
    this.log.warn('list.watch_refused', { reason: message.t === 'error' ? message.message : 'off' });
    this.watchRefused = this.watchSession;
    this.watchId = null;
    this.watchSession = null;
    this.#syncPoll();
  }

  #onState(state) {
    if (state.hostSession === this.hostSession) {
      this.#onCaps();
      return;
    }
    this.hostSession = state.hostSession;
    this.#dropWorktreeWaits(state.hostSession);
    // Нова сесия (или никаква): host-ът е забравил всички attach-ове и watch-а.
    for (const contentId of this.kept) this.needsAttach.add(contentId);
    this.attachedIn.clear();
    if (state.hostSession == null) {
      this.#syncPoll();
      return;
    }
    // Той не е виждал и списъка ни; видимият таб се закача веднага, скритите — при показване.
    this.#startListing();
    if (this.visible) this.#attach(this.visible);
    // ДЗ8a: скритите не текат по стария път, ако той още е жив (relay сокетът при LAN), и без видим.
    for (const contentId of this.kept) if (contentId !== this.visible) this.relay.detachOtherPaths(contentId);
    this.#onCaps();
  }

  /** `caps` на пътя може да дойдат след сесията (`hello` по нов сокет, ДЗ8b). */
  #onCaps() {
    if (this.#syncWatch()) this.refresh();
    if (this.#keepMode() === 'single') this.#shrinkToVisible();
  }

  #onMessage(message) {
    if (message.t === 'list') this.#onList(message);
    else if (message.t === 'watch') this.#onWatchReply(message);
    else if (isTerminalStream(message)) this.#onTerminal(message);
    else if (message.t === 'error' && message.id != null && message.id === this.watchId) this.#onWatchReply(message);
    else if (message.t === 'error' && message.code === ATTACH_LIMIT) this.#onAttachLimit(message);
    else if (REPLIES.includes(message.t)) this.#onReply(message);
  }

  #onList(message) {
    this.lastList = { ...message, id: null };
    this.#dropClosedTabs(message);
    this.emit('message', this.lastList);
    // Отговорът на „Опресни“ е `list` със същото id (ЗД13): страницата спира да чака.
    const request = message.id != null ? this.pending.get(message.id) : null;
    if (request?.kind !== 'worktrees.refresh') return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    this.emit('message', { t: 'worktrees.refresh', ref: request.ref, kind: request.kind });
  }

  /**
   * ДЗ12: скрит таб, който го няма в списъка (затворен на стар Mac без `detached`), излиза от
   * набора. Видимият остава: за него Mac-ът праща `detached` и страницата казва, че е затворен.
   */
  #dropClosedTabs(list) {
    const present = new Set(list.repos.flatMap((r) => (r.worktrees ?? []).flatMap((w) => (w.tabs ?? []).map((t) => t.contentId))));
    for (const contentId of [...this.kept]) if (contentId !== this.visible && !present.has(contentId)) this.#release(contentId);
  }

  /** Кадрите на всеки жив терминал отиват към страницата; на пуснат таб или от стар attach — не. */
  #onTerminal(message) {
    const { contentId } = message;
    if (!this.kept.includes(contentId)) return;
    if (message.t === 'attached') {
      if (message.id != null && message.id !== this.attachIds.get(contentId)) return;
      this.attachedIn.set(contentId, this.relay.state.hostSession);
    }
    if (message.t === 'detached') {
      // Mac-ът вече не го държи: без `detach` при пускане, а видимият — „Свържи отново“ (ДЗ9).
      this.attachedIn.delete(contentId);
      this.needsAttach.add(contentId);
      if (contentId !== this.visible) {
        this.#release(contentId);
        return;
      }
    }
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
    if (['tab.new', 'worktree.new', 'worktree.delete'].includes(message.t)) this.refresh();
    this.emit('message', { ...message, ref: request.ref, kind: request.kind });
  }
}
