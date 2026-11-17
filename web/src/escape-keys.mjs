// Escape клавишът на `attach`: `Ctrl+]`, после `r` (resize по локалния прозорец) или `q` (изход).
//
// Целият вход отива в PTY-то на Mac-а, затова командите на самия `attach` са зад клавиш, който
// програмите почти не ползват (както `telnet`). Когато програмата на Mac-а е включила kitty
// клавиатурата, локалният Ghostty кодира клавишите като `CSI <код>;<модификатори> u`, затова
// се познават и тези форми.

const CTRL_RB = ['\x1d', '\x1b[93;5u'];
const ACTIONS = new Map([['r', 'resize'], ['\x1b[114u', 'resize'], ['q', 'quit'], ['\x1b[113u', 'quit']]);
const KITTY_KEY = /^\x1b\[[0-9;:]*[A-Za-z~]/;

/** Формата от `forms`, с която започва текстът, или `null`. */
function startsWithAny(text, forms) {
  return forms.find((f) => text.startsWith(f)) ?? null;
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
  }

  /** `forward` — за PTY-то на Mac-а; `actions` — командите в реда на натискане. */
  feed(bytes) {
    const text = Buffer.from(bytes).toString('latin1');
    let forward = '';
    const actions = [];
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      if (!this.armed) {
        const escape = startsWithAny(rest, CTRL_RB);
        if (escape) {
          this.armed = true;
          i += escape.length;
        } else {
          forward += rest[0];
          i += 1;
        }
        continue;
      }
      this.armed = false;
      const again = startsWithAny(rest, CTRL_RB);
      const action = startsWithAny(rest, [...ACTIONS.keys()]);
      if (again) {
        forward += '\x1d';
        i += again.length;
      } else if (action) {
        actions.push(ACTIONS.get(action));
        i += action.length;
      } else {
        i += keyLength(rest);
      }
    }
    return { forward: Buffer.from(forward, 'latin1'), actions };
  }
}
