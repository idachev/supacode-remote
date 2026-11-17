// Филтър на изхода на Mac-а за `attach`: маха въпросите към терминала (DA, DSR, DECRQM, …).
//
// Ghostty на Mac-а вече е отговорил на всеки въпрос в PTY-то. Ако въпросът стигне и до
// локалния Ghostty, той също ще отговори, отговорът ще влезе в stdin на `attach` и оттам като
// `input` в PTY-то — втори отговор, който програмата чете като въведен текст. Затова въпросите
// не стигат до локалния терминал. Списъкът е същият като в `public/terminal.js`.
//
// Последователност може да е разделена между два `out`, затова филтърът пази състояние.
// 8-битовите C1 (0x9b и др.) не се разпознават: в UTF-8 тези байтове са част от букви.

/** Над толкова байта незавършена последователност се пуска както е: иначе счупен OSC би глътнал всичко. */
export const MAX_PENDING = 4096;

const ESC = 0x1b;
const BEL = 0x07;
/** CAN и SUB прекъсват всяка последователност и в терминала. */
const CAN = 0x18;
const SUB = 0x1a;
const PREFIXES = new Set(['?', '>', '=', '<']);
const OSC_QUERIES = new Set(['4', '10', '11', '12']);

/** CSI въпрос по префикс, междинни байтове и финал. */
function isCsiQuery(body) {
  const final = body[body.length - 1];
  const prefix = PREFIXES.has(body[0]) ? body[0] : '';
  const intermediates = body.slice(prefix.length, -1).replace(/[^\x20-\x2f]/g, '');
  switch (final) {
    case 'c': return prefix === '' || prefix === '>' || prefix === '=';
    case 'n': return prefix === '' || prefix === '?';
    case 'p': return intermediates.includes('$');
    case 'q': return prefix === '>';
    case 't': return true;
    case 'u': return prefix === '?';
    default: return false;
  }
}

/** OSC 4/10/11/12 с `?` пита за цвят; със стойност го задава и минава. */
function isOscQuery(body) {
  const semi = body.indexOf(';');
  return semi > 0 && OSC_QUERIES.has(body.slice(0, semi)) && body.includes('?', semi);
}

/** DECRQSS (`DCS $ q`) и XTGETTCAP (`DCS + q`). */
function isDcsQuery(body) {
  return body.startsWith('$q') || body.startsWith('+q');
}

export class QueryFilter {
  constructor() {
    this.state = 'ground';
    /** Байтовете на текущата последователност, от ESC нататък. */
    this.pending = [];
  }

  /** Байтовете за stdout; незавършената последователност остава за следващия `push`. */
  push(bytes) {
    const out = [];
    for (const byte of bytes) this.#step(byte, out);
    return Buffer.from(out);
  }

  #step(byte, out) {
    switch (this.state) {
      case 'ground':
        if (byte === ESC) this.#begin(byte);
        else out.push(byte);
        return;
      case 'esc':
        return this.#afterEsc(byte, out);
      case 'csi':
        if (byte === ESC) return this.#restart(byte, out);
        this.pending.push(byte);
        if (byte === CAN || byte === SUB) return this.#flush(out);
        if (byte >= 0x40 && byte <= 0x7e) this.#end(out, isCsiQuery(this.#body(2, 0)));
        return this.#capped(out);
      case 'osc':
      case 'dcs':
        if (byte === BEL && this.state === 'osc') {
          this.pending.push(byte);
          return this.#end(out, isOscQuery(this.#body(2, 1)));
        }
        this.pending.push(byte);
        if (byte === CAN || byte === SUB) return this.#flush(out);
        if (byte === ESC) this.state += '-esc';
        return this.#capped(out);
      case 'osc-esc':
      case 'dcs-esc':
        return this.#afterStringEsc(byte, out);
      default:
        return undefined;
    }
  }

  #afterEsc(byte, out) {
    this.pending.push(byte);
    if (byte === 0x5b) this.state = 'csi'; // [
    else if (byte === 0x5d) this.state = 'osc'; // ]
    else if (byte === 0x50) this.state = 'dcs'; // P
    else this.#flush(out); // ESC 7, ESC ( B …: не са въпроси
  }

  /** ESC вътре в OSC/DCS: `ESC \` го завършва, друго го прекъсва (както в терминала). */
  #afterStringEsc(byte, out) {
    const kind = this.state.slice(0, 3);
    if (byte === 0x5c) {
      this.pending.push(byte);
      const body = this.#body(2, 2);
      return this.#end(out, kind === 'osc' ? isOscQuery(body) : isDcsQuery(body));
    }
    // Прекъсната последователност минава; ESC-ът е начало на нова.
    this.pending.pop();
    this.#restart(ESC, out);
    return this.#afterEsc(byte, out);
  }

  #begin(byte) {
    this.state = 'esc';
    this.pending = [byte];
  }

  /**
   * ESC прекъсва текущата последователност. Терминалът би я прекъснал на същия ESC, но ако
   * новата последователност е въпрос, ESC-ът не стига до него — затова CAN я затваря изрично.
   */
  #restart(byte, out) {
    this.#flush(out);
    out.push(CAN);
    this.#begin(byte);
  }

  /** Тялото на последователността без началото (`ESC [`) и края (терминатора). */
  #body(head, tail) {
    return Buffer.from(this.pending.slice(head, this.pending.length - tail)).toString('latin1');
  }

  #end(out, drop) {
    if (!drop) out.push(...this.pending);
    this.state = 'ground';
    this.pending = [];
  }

  #flush(out) {
    this.#end(out, false);
  }

  #capped(out) {
    if (this.pending.length > MAX_PENDING) this.#flush(out);
  }
}
