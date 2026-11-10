// Четимият ред на един лог запис — общ за Node сървъра (полето `message` в JSON реда) и за
// конзолата на браузъра. Един форматер, за да не се разминат двата.
//
//   relay state, connection: connected, path: lan, host_online: true
//   lan closed, reason: 'затворена (1006)'
//
// Съобщението е фиксирано (`event` с интервали вместо `.` и `_`), а стойностите са след него
// по реда, в който ги дава мястото на извикване: от по-стабилните към по-променливите.

const TOKEN = /^[\p{L}\p{N}_./:@+%=-]+$/u;
const EVENT = /^[a-z][a-z0-9_.]*$/;

/** Управляващите знаци се виждат, вместо да чупят реда или терминала. */
function visible(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function stringText(value) {
  const safe = visible(value);
  return TOKEN.test(safe) ? safe : `'${safe.replace(/'/g, "''")}'`;
}

/** Обект или масив като JSON; само истински цикъл (предшественик) става `[Circular]`. */
function structuredText(value) {
  const ancestors = [];
  const json = JSON.stringify(value, function replacer(_key, v) {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Error) return { error_type: v.name, error: v.message };
    if (v === null || typeof v !== 'object') return v;
    while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(v)) return '[Circular]';
    ancestors.push(v);
    return v;
  });
  return stringText(json ?? String(value));
}

/** Една стойност в четимия ред. `0`, `false`, `''` и `null` остават видими. */
export function fieldText(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `'${value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return stringText(value);
  if (value instanceof Error) return stringText(value.message);
  return structuredText(value);
}

/** `relay.state` → `relay state`; свободен текст остава както е. */
export function eventText(event) {
  return EVENT.test(event) ? event.replace(/[._]/g, ' ') : event;
}

export function formatMessage(event, fields = {}) {
  const values = Object.entries(fields).map(([key, value]) => `${key}: ${fieldText(value)}`);
  return [eventText(event), ...values].join(', ');
}
