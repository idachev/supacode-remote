// Доверието в LAN връзката (раздел „LAN shortcut“ в протокола), пренесено от `LanTrust.kt`:
// TLS 1.3 със самоподписан сертификат на Mac-а, закован по SHA-256 на DER байтовете (`fp`).
//
// `fp` идва през relay-а, който би могъл да го подмени. Затова `fpMac` (HMAC-SHA256 с
// клиентския ключ) се проверява преди всеки опит: relay-ят знае само хеша на ключа.

import crypto from 'node:crypto';

const FP_MAC_PREFIX = 'supacode-lan-fp-v1:';

/** SHA-256 на DER байтовете като малки шестнадесетични букви. */
export function fingerprint(der) {
  return crypto.createHash('sha256').update(der).digest('hex');
}

function hexBytes(text) {
  const s = String(text ?? '').trim();
  if (s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

/**
 * `fpMac` е от някой, който знае клиентския ключ. Сравнява байтове за постоянно време;
 * главни или малки букви в hex-а на `fpMac` нямат значение, а невалиден hex е несъвпадение.
 * HMAC-ът е над текста на `fp`, затова главни букви в самия `fp` са друг текст.
 */
export function fpMacValid(clientKey, fp, fpMac) {
  const given = hexBytes(fpMac);
  if (!given || !fp) return false;
  const expected = crypto.createHmac('sha256', Buffer.from(String(clientKey), 'utf8'))
    .update(FP_MAC_PREFIX + fp, 'utf8').digest();
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Отпечатъкът на сертификата (DER) съвпада ли със закования `fp` (без значение главни/малки). */
export function pinMatches(der, fp) {
  const actual = Buffer.from(fingerprint(der), 'utf8');
  const wanted = Buffer.from(String(fp ?? '').trim().toLowerCase(), 'utf8');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}
