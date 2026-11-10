// xterm.js за един таб на Mac-а.
//
// Размерът е винаги на Mac-а (`attached` и `size`): страницата никога не сменя колоните и
// редовете, а избира шрифта така, че те да влязат в мястото. Само новият таб тръгва с размер от
// браузъра (`gridAt`), защото `tab.new` го приема (ОП27).
//
// Клавиатурата отива направо в xterm.js и от `onData` към PTY-то. xterm.js обаче сам отговаря
// на въпросите на програмата (DA, позиция на курсора и др.), а на Mac-а отговаря и Ghostty —
// втори отговор би влязъл в PTY-то като текст. Затова тези въпроси се спират в parser-а на
// xterm.js, преди той да напише отговор.

import { clipboardText } from './osc52.js';

const MIN_FONT = 6;
const MAX_FONT = 22;
const BASE_FONT = 14;

/** Отчетите за фокус (`CSI I` / `CSI O`): Ghostty на Mac-а ги праща за своя прозорец. */
const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O']);

function decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const encodeText = (text) => toB64(new TextEncoder().encode(text));

/**
 * Клавишите, които Ghostty на Mac-а на собственика праща по свой начин (`~/.config/ghostty/config`):
 * - Ctrl+буква по мястото на клавиша (US позиция), за да работи и на кирилица (БДС фонетична:
 *   Ctrl+Ц е ^C). I/J/M/O са изпуснати: техните C0 кодове са Tab/LF/CR/SI.
 * - Shift+Enter и Option+Enter пращат ESC+CR (нов ред в Claude Code и Grok).
 */
export function ghosttyKey(e) {
  return newlineKey(e) ?? ctrlLetter(e);
}

function newlineKey(e) {
  const plainEnter = e.key === 'Enter' && !e.ctrlKey && !e.metaKey;
  return plainEnter && (e.shiftKey || e.altKey) ? '\x1b\r' : null;
}

function ctrlLetter(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  if (!m || 'IJMO'.includes(m[1])) return null;
  return String.fromCharCode(m[1].charCodeAt(0) - 64);
}

const XTERM_OPTIONS = {
  cols: 80,
  rows: 24,
  scrollback: 5000,
  fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
  fontSize: BASE_FONT,
  lineHeight: 1.0,
  cursorBlink: false,
  convertEol: false,
  // Option пише специалните знаци, както в Supacode (Ghostty без `macos-option-as-alt`);
  // маркиране при програма с мишка — с Option.
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  minimumContrastRatio: 1,
  theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' },
};

/** Mouse report в старото X10 кодиране: байтове, не UTF-8. */
function binaryToB64(data) {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return toB64(bytes);
}

export class TerminalView {
  constructor(container, area, { onInput, onClipboard }) {
    this.area = area;
    this.onInput = onInput;
    this.onClipboard = onClipboard;
    this.term = new window.Terminal(XTERM_OPTIONS);
    this.term.open(container);
    this.#blockReplies();
    this.#wireClipboard();
    this.#wireInput();
    new ResizeObserver(() => this.fit()).observe(area);
  }

  #wireInput() {
    this.term.onData((data) => {
      if (!FOCUS_REPORTS.has(data)) this.onInput(encodeText(data));
    });
    this.term.onBinary((data) => this.onInput(binaryToB64(data)));
    this.term.attachCustomKeyEventHandler((e) => this.#onKey(e));
  }

  /** OSC 52: копираното в програмата отива в clipboard-а на лаптопа; `true` — без отговор към PTY-то. */
  #wireClipboard() {
    this.term.parser.registerOscHandler(52, (data) => {
      const text = clipboardText(data);
      if (text) this.onClipboard(text);
      return true;
    });
  }

  /** `false` — xterm.js да не обработва клавиша. ⌘ е на браузъра; Ctrl+⌘ хваща app.js по-рано. */
  #onKey(e) {
    if (e.metaKey) return false;
    if (e.type !== 'keydown') return true;
    const bytes = ghosttyKey(e);
    if (bytes == null) return true;
    e.preventDefault();
    this.onInput(encodeText(bytes));
    return false;
  }

  /**
   * Въпросите, на които xterm.js би отговорил през `onData`. Handler, който връща `true`, казва
   * „обработено“ и xterm.js не пише нищо. Задаване на цвят (OSC без `?`) минава нататък.
   */
  #blockReplies() {
    const p = this.term.parser;
    const swallow = () => true;
    p.registerCsiHandler({ final: 'c' }, swallow); // DA1
    p.registerCsiHandler({ prefix: '>', final: 'c' }, swallow); // DA2
    p.registerCsiHandler({ prefix: '=', final: 'c' }, swallow); // DA3
    p.registerCsiHandler({ final: 'n' }, swallow); // DSR: статус и позиция на курсора
    p.registerCsiHandler({ prefix: '?', final: 'n' }, swallow); // DECDSR
    p.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow); // DECRQM
    p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow); // DECRQM частен
    p.registerCsiHandler({ prefix: '>', final: 'q' }, swallow); // XTVERSION
    p.registerCsiHandler({ final: 't' }, swallow); // отчети за прозореца
    p.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
    for (const osc of [4, 10, 11, 12]) p.registerOscHandler(osc, (data) => data.includes('?'));
  }

  #cellRatio() {
    // Ширината и височината на клетка на 1 px шрифт, от текущия рендер.
    const screen = this.term.element?.querySelector('.xterm-screen');
    const font = this.term.options.fontSize;
    if (!screen || !font) return null;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { w: rect.width / this.term.cols / font, h: rect.height / this.term.rows / font };
  }

  #avail() {
    const style = getComputedStyle(this.area);
    return {
      w: this.area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      h: this.area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
  }

  /** Шрифтът, при който колоните и редовете на Mac-а влизат в мястото. */
  fit() {
    const avail = this.#avail();
    if (avail.w <= 0 || avail.h <= 0) return;
    for (let i = 0; i < 4; i++) {
      const cell = this.#cellRatio();
      if (!cell) return;
      const want = Math.min(avail.w / (this.term.cols * cell.w), avail.h / (this.term.rows * cell.h));
      const next = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(want * 10) / 10));
      if (Math.abs(next - this.term.options.fontSize) < 0.05) break;
      this.term.options.fontSize = next;
    }
    // Клетките се закръглят: малко по-малко, докато влезе.
    const screen = this.term.element.querySelector('.xterm-screen');
    while (this.term.options.fontSize > MIN_FONT &&
      (screen.getBoundingClientRect().width > avail.w || screen.getBoundingClientRect().height > avail.h)) {
      this.term.options.fontSize = Math.round((this.term.options.fontSize - 0.1) * 10) / 10;
    }
  }

  /** Колко колони и редове влизат в мястото при шрифт `fontPx` — за нов таб и за бутона. */
  gridAt(fontPx) {
    const avail = this.#avail();
    const cell = this.#cellAt(fontPx);
    if (!cell || avail.w <= 0 || avail.h <= 0) return null;
    return {
      cols: Math.max(20, Math.min(500, Math.floor(avail.w / cell.w))),
      rows: Math.max(5, Math.min(200, Math.floor(avail.h / cell.h))),
    };
  }

  /**
   * Клетката, измерена при `fontPx`: рендерът закръгля размера ѝ за всеки шрифт, затова мащаб от
   * друг шрифт може да даде колона или ред повече, отколкото влиза. Шрифтът се връща веднага.
   */
  #cellAt(fontPx) {
    const before = this.term.options.fontSize;
    this.term.options.fontSize = fontPx;
    const ratio = this.#cellRatio();
    this.term.options.fontSize = before;
    return ratio ? { w: ratio.w * fontPx, h: ratio.h * fontPx } : null;
  }

  // `term.write` е асинхронен, а reset и resize — не. Затова те чакат в същата опашка (празен
  // запис с callback): изходът преди тях се изписва с размера, за който е.

  /** Нов attach: празен терминал с точния размер на Mac-а. */
  init(cols, rows) {
    this.term.write('', () => {
      this.term.reset();
      this.term.resize(cols, rows);
      this.fit();
    });
  }

  resize(cols, rows) {
    this.term.write('', () => {
      this.term.resize(cols, rows);
      this.fit();
    });
  }

  write(b64) {
    this.term.write(decode(b64));
  }

  clear() {
    this.term.reset();
  }

  focus() {
    this.term.focus();
  }

  /** Целият текст: историята и екранът. */
  /** Колоните и редовете, които Mac-ът е дал последно. */
  size() {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  allText() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines.join('\n');
  }
}
