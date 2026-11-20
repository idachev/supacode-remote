// Escape клавишът на `attach`: `Ctrl+]`, после `r` (resize по локалния прозорец) или `q` (изход).
//
// Целият вход отива в PTY-то на Mac-а, затова командите на самия `attach` са зад клавиш, който
// програмите почти не ползват (както `telnet`). Когато програмата на Mac-а е включила kitty
// клавиатурата, локалният Ghostty кодира клавишите като `CSI <код>;<модификатори> u`, затова
// се познават и тези форми.

const CTRL_RB = ['\x1d', '\x1b[93;5u'];
const ACTIONS = new Map([['r', 'resize'], ['\x1b[114u', 'resize'], ['q', 'quit'], ['\x1b[113u', 'quit']]);
const KITTY_KEY = /^\x1b\[[0-9;:]*[A-Za-z~]/;
const KITTY_FORMS = [...CTRL_RB, ...ACTIONS.keys()].filter((f) => f.startsWith('\x1b['));
/** Самотен Esc и `ESC [` не чакат: Esc клавишът би закъснял до следващото натискане. */
const MIN_PARTIAL = 3;

/** Формата от `forms`, с която започва текстът, или `null`. */
function startsWithAny(text, forms) {
  return forms.find((f) => text.startsWith(f)) ?? null;
}

/** Начало на kitty форма, разделена между две събития на stdin. */
function isPartialForm(text) {
  return text.length >= MIN_PARTIAL && KITTY_FORMS.some((f) => f.length > text.length && f.startsWith(text));
}

/** Дължината на един клавиш: цяла escape последователност или цяла UTF-8 буква. */
function keyLength(text) {
  const kitty = KITTY_KEY.exec(text);
  if (kitty) return kitty[0].length;
  const lead = text.charCodeAt(0);
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

export class EscapeKeys {
  constructor() {
    /** След `Ctrl+]`: следващият клавиш е команда към `attach`, не към Mac-а. */
    this.armed = false;
    /** Непълна kitty форма от края на предното парче. */
    this.partial = '';
  }

  /** `forward` — за PTY-то на Mac-а; `actions` — командите в реда на натискане. */
  feed(bytes) {
    const text = this.partial + Buffer.from(bytes).toString('latin1');
    this.partial = '';
    const out = { forward: '', actions: [] };
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      if (isPartialForm(rest)) {
        this.partial = rest;
        break;
      }
      i += this.armed ? this.#command(rest, out) : this.#plain(rest, out);
      // След изхода нищо не стига до Mac-а: paste след `q` иначе би се изпълнил там.
      if (out.actions.at(-1) === 'quit') break;
    }
    return { forward: Buffer.from(out.forward, 'latin1'), actions: out.actions };
  }

  /** Клавиш без `Ctrl+]` преди него: към Mac-а, а `Ctrl+]` чака команда. Връща изядената дължина. */
  #plain(rest, out) {
    const escape = startsWithAny(rest, CTRL_RB);
    if (escape) {
      this.armed = true;
      return escape.length;
    }
    out.forward += rest[0];
    return 1;
  }

  /**
   * Клавишът след `Ctrl+]`: втори `Ctrl+]` стига до Mac-а като един 0x1d, `r` и `q` са команди,
   * друг клавиш се изхвърля цял. Връща изядената дължина.
   */
  #command(rest, out) {
    this.armed = false;
    const again = startsWithAny(rest, CTRL_RB);
    if (again) {
      out.forward += '\x1d';
      return again.length;
    }
    const action = startsWithAny(rest, [...ACTIONS.keys()]);
    if (!action) return keyLength(rest);
    out.actions.push(ACTIONS.get(action));
    return action.length;
  }
}
