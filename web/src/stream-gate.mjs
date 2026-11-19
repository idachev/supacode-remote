// Кой път (relay сокетът или LAN сесията) носи потока на всеки терминал. Пренесено 1:1 от
// `TerminalStreamGate.kt`, със същите правила:
//
// С `attach keep` по една връзка текат няколко терминала, затова решението е по терминал: всеки
// има свой текущ път (`current`) и свой чакащ attach (`pending`). При смяна на пътя терминалът за
// кратко тече и по двата. Към екрана минава само потокът по текущия път на терминала. Нов
// `attach` по друг път не го сменя веднага: старият поток тече, докато не дойде `attached` на
// новия (той носи екрана наново), и чак тогава пътят се сменя, а attach-овете по другите пътища
// се спират с `detach` — и на скритите терминали: те не се местят между пътищата, а получават нов
// attach, когато се покажат (ДЗ8a). Кадри по път, който не е текущ за своя терминал (закъснели,
// от паднала връзка, от стар attach), се изхвърлят.

import { isTerminalStream } from './protocol.mjs';

export class TerminalStreamGate {
  constructor() {
    /** Терминал → пътят, чийто `attached` го е направил текущ. */
    this.current = new Map();
    /** Терминал → `{via, id}` на attach-а, чийто `attached` още не е дошъл. */
    this.pending = new Map();
    /** Последният `attach` за всеки терминал: остарял `detach` не бива да спре новия. */
    this.latestAttachId = new Map();
    /**
     * Път → терминалите, които Mac-ът държи (или ще държи) по него. С реда на вкарване:
     * `detach`-овете тръгват в предвидим ред, същия като в Kotlin.
     */
    this.attachedOn = new Map();
  }

  /**
   * `attach` е тръгнал по `via`. Викай преди отговорът да може да бъде обработен. Без `keep`
   * Mac-ът откача всички други терминали по `via`: те вече нямат поток там, а чакащите им
   * attach-ове по него се отменят (както преди `keep` с един чакащ attach).
   */
  attachSent(via, id, contentId, keep = false) {
    if (!keep) {
      for (const other of [...(this.attachedOn.get(via) ?? [])]) {
        if (other !== contentId) this.#forget(via, other);
      }
      for (const [other, wait] of [...this.pending]) {
        if (other !== contentId && wait.via === via) this.pending.delete(other);
      }
    }
    this.pending.set(contentId, { via, id });
    this.latestAttachId.set(contentId, id);
    this.#terminalsOn(via).add(contentId);
  }

  /**
   * `detach` за `contentId` е тръгнал по `via`: потокът му спира; връща другите пътища със
   * същия терминал. Другите терминали по `via` не се пипат — `detach` спира само своя.
   */
  detachSent(via, contentId) {
    this.pending.delete(contentId);
    this.attachedOn.get(via)?.delete(contentId);
    this.latestAttachId.delete(contentId);
    // По кой път е тръгнал, няма значение: той спира терминала и по другите пътища.
    this.current.delete(contentId);
    return this.#takeAttached((_path, terminal) => terminal === contentId);
  }

  /**
   * ДЗ8a: скрит терминал при нова сесия по `current` — Mac-ът още го държи по другите живи
   * пътища, а там той вече не бива да тече. Маха двойките и ги връща за `detach`; паднал път
   * (`closed`) вече го няма тук, затова по него нищо не тръгва.
   */
  takeOtherPaths(contentId, current) {
    return this.#takeAttached((path, terminal) => terminal === contentId && path !== current);
  }

  /** `detach` от таб, чийто последен attach е `attachId`, е остарял: друг го е закачил след него. */
  isStaleDetach(contentId, attachId) {
    if (!this.latestAttachId.has(contentId)) return false;
    return this.latestAttachId.get(contentId) !== attachId;
  }

  /** Mac-ът държи (или ще държи) наш attach за `contentId` по някой от живите пътища. */
  isAttached(contentId) {
    if (this.pending.has(contentId)) return true;
    return [...this.attachedOn.values()].some((terminals) => terminals.has(contentId));
  }

  /** Пътят е паднал: Mac-ът е забравил attach-овете по него, кадрите му вече не се приемат. */
  closed(source) {
    this.attachedOn.delete(source);
    for (const [terminal, path] of [...this.current]) if (path === source) this.current.delete(terminal);
    for (const [terminal, wait] of [...this.pending]) if (wait.via === source) this.pending.delete(terminal);
  }

  /** `{deliver, detach}`: към екрана ли; по кои пътища да тръгне `detach` за кой терминал. */
  accept(source, message) {
    if (!isTerminalStream(message)) return { deliver: true, detach: [] };
    const { contentId } = message;
    if (this.#answersPending(source, message)) {
      this.pending.delete(contentId);
      this.current.set(contentId, source);
      this.#terminalsOn(source).add(contentId);
      return { deliver: true, detach: this.#takeAttached((path) => path !== source) };
    }
    if (this.current.get(contentId) !== source) return { deliver: false, detach: [] };
    if (message.t === 'detached') this.attachedOn.get(source)?.delete(contentId);
    return { deliver: true, detach: [] };
  }

  /** `attached` на чакащия attach на своя терминал: по същия път и (ако го носи) със същия id. */
  #answersPending(source, message) {
    const wait = this.pending.get(message.contentId);
    if (message.t !== 'attached' || !wait || wait.via !== source) return false;
    return message.id == null || message.id === wait.id;
  }

  #terminalsOn(path) {
    let terminals = this.attachedOn.get(path);
    if (!terminals) {
      terminals = new Set();
      this.attachedOn.set(path, terminals);
    }
    return terminals;
  }

  /** Mac-ът вече не държи `contentId` по `path`: без поток и без чакащ attach там. */
  #forget(path, contentId) {
    this.attachedOn.get(path)?.delete(contentId);
    if (this.current.get(contentId) === path) this.current.delete(contentId);
    // Чакащ attach, отменен с detach: закъснелият му `attached` не бива да стане текущ и да
    // спре терминала по новия път.
    if (this.pending.get(contentId)?.via === path) this.pending.delete(contentId);
  }

  /** Маха двойките `[път, терминал]`, за които `match` е вярно, и ги връща за `detach`. */
  #takeAttached(match) {
    const taken = [];
    for (const [path, terminals] of this.attachedOn) {
      for (const terminal of terminals) if (match(path, terminal)) taken.push([path, terminal]);
    }
    for (const [path, terminal] of taken) this.#forget(path, terminal);
    for (const [path, terminals] of [...this.attachedOn]) if (terminals.size === 0) this.attachedOn.delete(path);
    return taken;
  }
}
