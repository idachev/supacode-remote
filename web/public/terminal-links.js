// Линкове в терминала: http/https адресите в изхода на програмата се отварят с клик в браузъра.
//
// Изходът идва от програмата на Mac-а и не е доверен, затова се отваря само http и https с host:
// `javascript:` или `file:` от терминала не бива да стигат до браузъра. Същите правила има и
// телефонът (`TerminalLinks` в Kotlin).

/** Знаците, на които адресът свършва: интервал, кавички, ъглови скоби и рамките на TUI-тата. */
const URL_PATTERN = /https?:\/\/[^\s"'<>`─-▟]+/gi;

/** Пунктуацията след адреса в изречение е част от изречението, не от адреса. */
const TRAILING_PUNCTUATION = '.,;:!?';

const PAIRS = { ')': '(', ']': '[', '}': '{' };

/**
 * http или https с непразен host. Частта до `@` (userinfo) и портът не са host:
 * `http://user@/path` и `http://:8080/` не минават.
 */
export function isWebUrl(url) {
  return /^https?:\/\/(?:[^\s/?#]*@)?[^\s/?#@:][^\s/?#@]*(?=[/?#]|$)/i.test(url);
}

/** Затваряща скоба без отваряща в адреса е от текста около него: „(виж https://…)“. */
function unbalancedClose(url) {
  const close = url.at(-1);
  const open = PAIRS[close];
  if (!open) return false;
  let depth = 0;
  for (const ch of url) {
    if (ch === open) depth++;
    else if (ch === close) depth--;
  }
  return depth < 0;
}

function trimEnd(url) {
  let end = url.length;
  while (end > 0) {
    const part = url.slice(0, end);
    if (TRAILING_PUNCTUATION.includes(part.at(-1)) || unbalancedClose(part)) end--;
    else break;
  }
  return url.slice(0, end);
}

/** Адресите в текста: `start` и `end` (без него) са индекси в низа. */
export function findUrls(text) {
  const found = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = trimEnd(m[0]);
    if (isWebUrl(url)) found.push({ start: m.index, end: m.index + url.length, url });
  }
  return found;
}

/**
 * Редът на буфера заедно с пренесените му части (`isWrapped`) като един низ. `cells[i]` е
 * клетката (0-базирана) на i-тия code unit: широк знак (емоджи) заема две клетки, а в низа е
 * един знак, затова индекс в низа не е колона. Ред, разбит на две от самия TUI, не се събира.
 *
 * Широк знак, който не влиза в последната клетка, xterm.js пренася на следващия ред и оставя
 * клетката празна (без знак, не интервал). Пред пренесен ред такива клетки се пропускат: иначе
 * интервал би разделил адреса.
 */
export function wrappedLine(buffer, row) {
  if (!buffer.getLine(row)) return { text: '', cells: [] };
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    let end = line.length;
    if (buffer.getLine(y + 1)?.isWrapped) {
      while (end > 0 && isUnwritten(line.getCell(end - 1))) end--;
    }
    for (let x = 0; x < end; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x, y });
    }
  }
  return { text, cells };
}

function isUnwritten(cell) {
  return !!cell && cell.getWidth() === 1 && cell.getChars() === '';
}
