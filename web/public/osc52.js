// OSC 52 (УА4): програмата на Mac-а казва на терминала „сложи това в clipboard-а“. Claude Code
// го прави, щом маркираш с мишката. Без това текстът отиваше само в clipboard-а на Mac-а.

/**
 * Текстът за clipboard-а от данните на `ESC ] 52 ; <clipboard-и> ; <base64>`, или `null`.
 * Въпрос (`?`) не се изпълнява: страницата не дава clipboard-а на лаптопа на програмата.
 */
export function clipboardText(data) {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (!payload || payload === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
