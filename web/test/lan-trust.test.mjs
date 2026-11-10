import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import selfsigned from 'selfsigned';
import { fingerprint, fpMacValid, pinMatches } from '../src/lan-trust.mjs';

// Векторът е същият като в Android `LanTrustTest`, изчислен с Node `crypto.createHmac`.
const key = 'abcde-fghij-klmno-pqrst-uvwxy-z2345';
const fp = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const fpMac = 'e1bef7bccaed983a401062bd7faa05f9fa1a1ca2315570c82009429bdde65a77';

test('fpMac от Node съвпада', () => {
  assert.equal(fpMacValid(key, fp, fpMac), true);
});

test('fpMac с главни букви в hex-а също минава', () => {
  assert.equal(fpMacValid(key, fp, fpMac.toUpperCase()), true);
});

test('друг ключ, друг отпечатък или счупен hex — без LAN', () => {
  assert.equal(fpMacValid(`${key}-x`, fp, fpMac), false);
  assert.equal(fpMacValid(key, fp.replace('0', '1'), fpMac), false);
  assert.equal(fpMacValid(key, fp.toUpperCase(), fpMac), false);
  assert.equal(fpMacValid(key, fp, fpMac.slice(0, -2)), false);
  assert.equal(fpMacValid(key, fp, 'zz' + fpMac.slice(2)), false);
  assert.equal(fpMacValid(key, fp, ''), false);
  assert.equal(fpMacValid(key, '', fpMac), false);
});

test('закованият сертификат минава, друг не', () => {
  const der = (cn) => new crypto.X509Certificate(selfsigned.generate([{ name: 'commonName', value: cn }], { keySize: 2048 }).cert).raw;
  const mac = der('mac');
  const other = der('other');
  const pin = fingerprint(mac);
  assert.match(pin, /^[0-9a-f]{64}$/);
  assert.equal(pinMatches(mac, pin), true);
  assert.equal(pinMatches(mac, pin.toUpperCase()), true);
  assert.equal(pinMatches(other, pin), false);
  assert.equal(pinMatches(mac, ''), false);
});
