// Редовете на лога на mock-а. Тестовете на web/ четат лога като текст (`web/test/helpers/mock.mjs`),
// затова форматът е един за всички модули на mock-а.

/** Прост token се пише както е; друг текст — в единични кавички, с видими управляващи знаци. */
function logValue(value) {
  if (value === null || value === undefined || typeof value !== 'string') return String(value);
  if (/^[\w.:/@+-]+$/.test(value)) return value;
  const visible = JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"');
  return `'${visible.replace(/'/g, "''")}'`;
}

/** `ЧЧ:ММ:СС.ммм <фиксирано съобщение>, поле: стойност, …` — стойностите са само в полетата. */
export function log(message, fields = {}) {
  const tail = Object.entries(fields).map(([k, v]) => `, ${k}: ${logValue(v)}`).join('');
  console.log(`${new Date().toISOString().slice(11, 23)} ${message}${tail}`);
}
