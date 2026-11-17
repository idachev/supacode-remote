// Един отдалечен таб в локалния терминал (`attach`): кадрите от host-а към stdout, клавишите
// от stdin към PTY-то на Mac-а. Тук няма TTY и сигнали — те са в `attach.mjs`, — затова
// сесията се тества с фалшив host и срещу mock-а.
//
// Размерът е на Mac-а (ЗД12): сесията само показва двата размера в заглавието и праща `resize`
// единствено по изричния `Ctrl+]` и после `r`.

import { EventEmitter } from 'node:events';
import { EscapeKeys } from './escape-keys.mjs';
import { silentLogger } from './log.mjs';
import { QueryFilter } from './query-filter.mjs';

/**
 * Преди всеки redraw: история, екран, курсор горе. Нов `attached` (нов път LAN ↔ Relay,
 * reconnect) носи историята наново и без това тя би се повторила.
 */
export const CLEAR = '\x1b[3J\x1b[2J\x1b[H';

/**
 * Локалният терминал след изход: програмата на Mac-а може да е включила alternate screen,
 * мишка, bracketed paste, focus или kitty клавиатура, и те биха останали в локалния таб.
 */
export const RESTORE = '\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[0m';

const grid = (s) => `${s.cols}×${s.rows}`;

/** Заглавието на локалния таб (OSC 2): двата размера, за да се види разминаването. */
export function sizeTitle(mac, local) {
  return `\x1b]2;Mac ${mac ? grid(mac) : '?'} · тук ${grid(local)}\x07`;
}

export class AttachSession extends EventEmitter {
  constructor({ host, contentId, write, localSize, log = silentLogger }) {
    super();
    this.host = host;
    this.contentId = contentId;
    this.write = write;
    this.localSize = localSize;
    this.log = log;
    this.keys = new EscapeKeys();
    this.filter = new QueryFilter();
    this.macSize = null;
    this.onMessage = (message) => this.#onMessage(message);
  }

  start() {
    this.host.on('message', this.onMessage);
    this.host.setActive(true);
    this.host.open(this.contentId);
  }

  /** Байтове от stdin. */
  input(bytes) {
    const { forward, actions } = this.keys.feed(bytes);
    if (forward.length) this.host.input(forward.toString('base64'), this.contentId);
    for (const action of actions) this.#act(action);
  }

  /** Локалният прозорец смени размера си (SIGWINCH). */
  localResized() {
    this.#writeTitle();
  }

  stop() {
    this.host.off('message', this.onMessage);
    this.host.close();
    this.host.setActive(false);
    this.write(Buffer.from(RESTORE, 'latin1'));
  }

  #act(action) {
    if (action === 'quit') {
      this.emit('exit', { code: 0, reason: 'quit' });
      return;
    }
    const { cols, rows } = this.localSize();
    const sent = this.host.resize({ contentId: this.contentId, cols, rows });
    this.log.info('attach.resize_requested', { cols, rows, sent });
  }

  #onMessage(message) {
    if (message.contentId !== this.contentId) return;
    switch (message.t) {
      case 'attached':
        // Нов поток: незавършена последователност от стария не бива да се слепи с новия.
        this.filter = new QueryFilter();
        this.macSize = { cols: message.cols, rows: message.rows };
        this.write(Buffer.from(CLEAR, 'latin1'));
        this.#writeTitle();
        this.log.info('attach.attached', { cols: message.cols, rows: message.rows });
        break;
      case 'out':
        this.write(this.filter.push(Buffer.from(message.b64, 'base64')));
        break;
      case 'size':
        this.macSize = { cols: message.cols, rows: message.rows };
        this.#writeTitle();
        break;
      case 'detached':
        this.log.info('attach.detached', { reason: message.reason ?? '' });
        this.emit('exit', { code: 0, reason: message.reason ?? 'detached' });
        break;
      case 'error':
        this.log.warn('attach.host_error', { code: message.code ?? '', error_message: message.message ?? '' });
        break;
      default:
        break;
    }
  }

  #writeTitle() {
    this.write(Buffer.from(sizeTitle(this.macSize, this.localSize()), 'utf8'));
  }
}
