// Малките помощници за DOM и за паметта на браузъра, общи за всички екрани.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** localStorage може да хвърли (частен прозорец): тогава важи стойността по подразбиране. */
export function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* частен прозорец */ }
}

let toastTimer = null;

/** Кратко съобщение долу; изчезва след 4 s. */
export function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4_000);
}
