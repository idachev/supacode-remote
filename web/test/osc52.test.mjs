// OSC 52 от програмата на Mac-а (УА4): какъв текст отива в clipboard-а на лаптопа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardText } from '../public/osc52.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('текстът от OSC 52 се декодира като UTF-8, и кирилица', () => {
  assert.equal(clipboardText(`c;${b64('здравей, test')}`), 'здравей, test');
});

test('празен списък с clipboard-и и друг clipboard също копират', () => {
  assert.equal(clipboardText(`;${b64('ls -la')}`), 'ls -la');
  assert.equal(clipboardText(`p;${b64('ред')}`), 'ред');
});

test('въпрос за clipboard-а, празно и счупено не копират нищо', () => {
  assert.equal(clipboardText('c;?'), null);
  assert.equal(clipboardText('c;'), null);
  assert.equal(clipboardText('без точка и запетая'), null);
  assert.equal(clipboardText('c;не е base64!'), null);
});
