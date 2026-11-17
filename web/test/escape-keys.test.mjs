import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscapeKeys } from '../src/escape-keys.mjs';

const k = () => new EscapeKeys();
const feed = (e, s) => {
  const r = e.feed(Buffer.from(s, 'binary'));
  return { forward: r.forward.toString('binary'), actions: r.actions };
};

test('обикновените байтове минават', () => assert.deepEqual(feed(k(), 'ls\r'), { forward: 'ls\r', actions: [] }));
test('Ctrl+] и r иска resize', () => assert.deepEqual(feed(k(), 'a\x1dr'), { forward: 'a', actions: ['resize'] }));
test('Ctrl+] и q иска изход', () => assert.deepEqual(feed(k(), '\x1dq'), { forward: '', actions: ['quit'] }));
test('двоен Ctrl+] праща един 0x1d', () => assert.deepEqual(feed(k(), '\x1d\x1d'), { forward: '\x1d', actions: [] }));
test('друг клавиш след Ctrl+] се изхвърля', () => assert.deepEqual(feed(k(), '\x1dxb'), { forward: 'b', actions: [] }));
test('Ctrl+] и r в две парчета', () => {
  const e = k();
  assert.deepEqual(feed(e, '\x1d'), { forward: '', actions: [] });
  assert.deepEqual(feed(e, 'r'), { forward: '', actions: ['resize'] });
});
test('kitty форма на Ctrl+] и r', () => assert.deepEqual(feed(k(), '\x1b[93;5u\x1b[114u'), { forward: '', actions: ['resize'] }));
test('kitty форма на двоен Ctrl+] праща 0x1d', () => assert.deepEqual(feed(k(), '\x1b[93;5u\x1b[93;5u'), { forward: '\x1d', actions: [] }));
test('kitty клавиш след Ctrl+] се изхвърля цял', () => assert.deepEqual(feed(k(), '\x1d\x1b[97;5ub'), { forward: 'b', actions: [] }));
test('стрелка минава', () => assert.deepEqual(feed(k(), '\x1b[A'), { forward: '\x1b[A', actions: [] }));
test('кирилица минава цяла', () => {
  const r = k().feed(Buffer.from('жq', 'utf8'));
  assert.equal(r.forward.toString('utf8'), 'жq');
});
