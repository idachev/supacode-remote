// Кой път (relay сокетът или LAN сесията) носи потока на терминала. Пренесено 1:1 от
// `TerminalStreamGate.kt`, със същите правила:
//
// Mac-ът държи по един `attach` на връзка, затова при смяна на пътя за кратко стриймят и
// двете. Към екрана минава само потокът на `current`. Нов `attach` по друг път не го сменя
// веднага: старият поток тече, докато не дойде `attached` на новия (той носи екрана наново),
// и чак тогава пътят се сменя, а старите attach-ове се спират с `detach`. Кадри от път, който
// вече не е `current` (закъснели, от паднала връзка, от стар attach), се изхвърлят.

import { isTerminalStream } from './protocol.mjs';

export class TerminalStreamGate {
  constructor() {
    this.current = null;
    /** Терминалът, чийто `attached` направи `current` текущ. */
    this.currentContentId = null;
    this.pending = null;
    /** Последният `attach` за всеки терминал: остарял `detach` не бива да спре новия. */
    this.latestAttachId = new Map();
    /** Пътищата, по които Mac-ът държи наш attach, и терминалът му. */
    this.attachedOn = new Map();
  }

  /** `attach` е тръгнал по `via`. Викай преди отговорът да може да бъде обработен. */
  attachSent(via, id, contentId) {
    this.pending = { via, id, contentId };
    this.latestAttachId.set(contentId, id);
    this.attachedOn.set(via, contentId);
  }

  /** `detach` е тръгнал по `via`: потокът спира; връща другите пътища със същия терминал. */
  detachSent(via, contentId) {
    if (this.pending?.contentId === contentId) this.pending = null;
    if (this.attachedOn.get(via) === contentId) this.attachedOn.delete(via);
    this.latestAttachId.delete(contentId);
    // Само detach на текущия терминал спира потока: закъснял detach на предишен таб иначе
    // изхвърля целия изход на новия.
    if (this.currentContentId === contentId) this.#clearCurrent();
    return this.#takeOthers(null, contentId);
  }

  /** `detach` от таб, чийто последен attach е `attachId`, е остарял: друг го е закачил след него. */
  isStaleDetach(contentId, attachId) {
    if (!this.latestAttachId.has(contentId)) return false;
    return this.latestAttachId.get(contentId) !== attachId;
  }

  /** Пътят е паднал: Mac-ът е забравил attach-а по него, кадрите му вече не се приемат. */
  closed(source) {
    this.attachedOn.delete(source);
    if (this.current === source) this.#clearCurrent();
    if (this.pending?.via === source) this.pending = null;
  }

  /** `{deliver, detach}`: към екрана ли; по кои пътища да тръгне `detach` за кой терминал. */
  accept(source, message) {
    if (!isTerminalStream(message)) return { deliver: true, detach: [] };
    if (this.#answersPending(source, message)) {
      this.current = source;
      this.currentContentId = this.pending.contentId;
      this.pending = null;
      return { deliver: true, detach: this.#takeOthers(source, null) };
    }
    if (source !== this.current) return { deliver: false, detach: [] };
    if (message.t === 'detached' && this.attachedOn.get(source) === message.contentId) this.attachedOn.delete(source);
    return { deliver: true, detach: [] };
  }

  /** `attached` на чакащия attach: по същия път, за същия терминал и (ако го носи) със същия id. */
  #answersPending(source, message) {
    const wait = this.pending;
    if (message.t !== 'attached' || !wait || wait.via !== source || message.contentId !== wait.contentId) return false;
    return message.id == null || message.id === wait.id;
  }

  #clearCurrent() {
    this.current = null;
    this.currentContentId = null;
  }

  #takeOthers(except, contentId) {
    const others = [...this.attachedOn.entries()]
      .filter(([via, c]) => via !== except && (contentId == null || c === contentId));
    for (const [via] of others) this.attachedOn.delete(via);
    return others;
  }
}
