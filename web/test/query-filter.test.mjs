// Въпросите към терминала се махат от изхода на Mac-а: на тях вече е отговорил Ghostty там, а
// локалният Ghostty иначе би пратил втори отговор в PTY-то (виж дизайна на `attach`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PENDING, QueryFilter } from '../src/query-filter.mjs';

const run = (...chunks) => {
  const f = new QueryFilter();
  return Buffer.concat(chunks.map((c) => f.push(Buffer.from(c, 'binary')))).toString('binary');
};

test('обикновен текст и цветове минават', () => assert.equal(run('a\x1b[31mb\x1b[0m'), 'a\x1b[31mb\x1b[0m'));
test('махат се DA1, DA2, DA3', () => assert.equal(run('x\x1b[c\x1b[0c\x1b[>c\x1b[=cy'), 'xy'));
test('махат се DSR и DECDSR', () => assert.equal(run('\x1b[5n\x1b[6n\x1b[?6n'), ''));
test('махат се DECRQM и частният DECRQM', () => assert.equal(run('\x1b[4$p\x1b[?2004$p'), ''));
test('маха се XTVERSION', () => assert.equal(run('\x1b[>0q'), ''));
test('махат се всички CSI t', () => assert.equal(run('\x1b[14t\x1b[8;40;120t'), ''));
test('маха се kitty въпросът, push и pop минават', () => assert.equal(run('\x1b[?u\x1b[>1u\x1b[<u'), '\x1b[>1u\x1b[<u'));
test('махат се DECRQSS и XTGETTCAP', () => assert.equal(run('\x1bP$qm\x1b\\\x1bP+q544e\x1b\\'), ''));
test('махат се OSC 4/10/11/12 с ?, заглавието минава', () => {
  const title = Buffer.from('\x1b]2;заглавие\x07', 'utf8').toString('binary');
  assert.equal(run('\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]4;1;?\x07\x1b]12;?\x07', title), title);
});
test('OSC 11 със стойност минава', () => assert.equal(run('\x1b]11;rgb:00/00/00\x07'), '\x1b]11;rgb:00/00/00\x07'));
test('режимите на мишката и alternate screen минават', () => assert.equal(run('\x1b[?1049h\x1b[?1006h'), '\x1b[?1049h\x1b[?1006h'));
test('DCS, който не е въпрос, минава', () => assert.equal(run('\x1bPq#0;2;0;0;0\x1b\\'), '\x1bPq#0;2;0;0;0\x1b\\'));
test('ESC последователност без CSI минава', () => assert.equal(run('\x1b7a\x1b8\x1b(B'), '\x1b7a\x1b8\x1b(B'));
test('въпрос, разделен на две парчета, се маха', () => assert.equal(run('a\x1b[', '6nb'), 'ab'));
test('ESC в края на парчето чака следващото', () => assert.equal(run('a\x1b', '[cb'), 'ab'));
test('OSC въпрос, разделен на две парчета, се маха', () => assert.equal(run('\x1b]11', ';?\x07z'), 'z'));
test('кирилица, разделена на две парчета, излиза цяла', () => {
  const f = new QueryFilter();
  const bytes = Buffer.from('ж', 'utf8');
  assert.equal(Buffer.concat([f.push(bytes.subarray(0, 1)), f.push(bytes.subarray(1))]).toString('utf8'), 'ж');
});
test('незатворен OSC се пуска след MAX_PENDING байта', () => {
  const f = new QueryFilter();
  const big = '\x1b]2;' + 'a'.repeat(MAX_PENDING);
  assert.equal(f.push(Buffer.from(big, 'binary')).toString('binary'), big);
  assert.equal(f.push(Buffer.from('b\x1b[6n', 'binary')).toString('binary'), 'b');
});

// Ревю F1: прекъсната последователност се затваря с CAN, иначе махнатият въпрос след нея би
// оставил локалния терминал вътре в нея и той би глътнал следващия текст.
test('OSC, прекъснат от въпрос, се затваря с CAN', () => assert.equal(run('\x1b]2;old\x1b[6nhello\x07'), '\x1b]2;old\x18hello\x07'));
test('CSI, прекъснат от въпрос, се затваря с CAN', () => assert.equal(run('\x1b[1\x1b[6nX'), '\x1b[1\x18X'));
// Ревю F2: CAN и SUB прекъсват последователността и в терминала.
test('CAN прекъсва OSC и текстът след него минава', () => assert.equal(run('\x1b]11;?\x18hello\x07'), '\x1b]11;?\x18hello\x07'));
test('SUB прекъсва DCS', () => assert.equal(run('\x1bP$q\x1ahi'), '\x1bP$q\x1ahi'));
test('CAN прекъсва CSI', () => assert.equal(run('\x1b[6\x18n'), '\x1b[6\x18n'));
test('маха се четенето на clipboard-а с OSC 52, записът минава', () => {
  assert.equal(run('\x1b]52;c;?\x07a\x1b]52;;?\x1b\\b'), 'ab');
  assert.equal(run('\x1b]52;c;aGk=\x07'), '\x1b]52;c;aGk=\x07');
});
test('маха се DECID (ESC Z), back-tab минава', () => assert.equal(run('a\x1bZb\x1b[Z'), 'ab\x1b[Z'));
test('въпрос след двоен ESC се маха', () => assert.equal(run('a\x1b\x1b[cb'), 'ab'));
test('двоен ESC пред обикновена последователност я пуска с един ESC', () => assert.equal(run('\x1b\x1b[31m'), '\x1b[31m'));
test('OSC 3008 (агентът на Supacode) се маха винаги: с BEL, с ESC \\ и без параметри', () => {
  assert.equal(run('a\x1b]3008;start=1;agent=claude\x07b'), 'ab');
  assert.equal(run('a\x1b]3008;end=1\x1b\\b'), 'ab');
  assert.equal(run('a\x1b]3008\x07b'), 'ab');
});
test('OSC 3008, разделен на две парчета, се маха', () => assert.equal(run('a\x1b]30', '08;start=1\x07b'), 'ab'));
test('OSC 30080 и заглавието минават', () => {
  assert.equal(run('\x1b]30080;x\x07'), '\x1b]30080;x\x07');
  assert.equal(run('\x1b]2;3008\x07'), '\x1b]2;3008\x07');
});
