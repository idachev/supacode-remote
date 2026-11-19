// Линкове в терминала: кои http/https адреси от текста се отварят в браузъра с клик.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUrls, isWebUrl, wrappedLine } from '../public/terminal-links.js';

const urls = (text) => findUrls(text).map((u) => u.url);

test('http и https адрес в реда се намира с точните краища', () => {
  const text = 'виж https://relay.example.com/a?b=1#c и http://10.0.2.2:8787/x';
  assert.deepEqual(findUrls(text), [
    { start: 4, end: 37, url: 'https://relay.example.com/a?b=1#c' },
    { start: 40, end: 62, url: 'http://10.0.2.2:8787/x' },
  ]);
});

test('пунктуацията след адреса не е част от него', () => {
  assert.deepEqual(urls('Отвори https://relay.example.com/docs.'), ['https://relay.example.com/docs']);
  assert.deepEqual(urls('адрес: https://relay.example.com/a, после'), ['https://relay.example.com/a']);
  assert.deepEqual(urls('готово?! https://relay.example.com/x?!'), ['https://relay.example.com/x']);
});

test('скоба и кавички около адреса остават извън него, скоба в самия адрес остава', () => {
  assert.deepEqual(urls('(виж https://relay.example.com/a)'), ['https://relay.example.com/a']);
  assert.deepEqual(urls('"https://relay.example.com/a"'), ['https://relay.example.com/a']);
  assert.deepEqual(urls('<https://relay.example.com/a>'), ['https://relay.example.com/a']);
  assert.deepEqual(urls('https://relay.example.com/wiki/A_(b)'), ['https://relay.example.com/wiki/A_(b)']);
  assert.deepEqual(urls('[https://relay.example.com/a]'), ['https://relay.example.com/a']);
});

test('кирилица непосредствено около адреса и рамка от TUI не влизат в него', () => {
  assert.deepEqual(urls('│ https://relay.example.com/a │'), ['https://relay.example.com/a']);
  assert.deepEqual(urls('адрес:https://relay.example.com/път'), ['https://relay.example.com/път']);
  assert.deepEqual(urls('https://relay.example.com/a след'), ['https://relay.example.com/a']);
});

test('без host, друга схема и празно не са линкове', () => {
  assert.deepEqual(urls('https:// и http:///x'), []);
  assert.deepEqual(urls('ftp://relay.example.com file:///etc/hosts javascript:alert(1)'), []);
  assert.deepEqual(urls(''), []);
});

test('схемата е без значение за малки и главни букви', () => {
  assert.deepEqual(urls('HTTPS://Relay.Example.com/A'), ['HTTPS://Relay.Example.com/A']);
});

test('isWebUrl пуска само http и https с host', () => {
  assert.equal(isWebUrl('https://relay.example.com'), true);
  assert.equal(isWebUrl('http://10.0.2.2:8787/test'), true);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(isWebUrl('file:///etc/hosts'), false);
  assert.equal(isWebUrl('https://'), false);
  assert.equal(isWebUrl(' https://relay.example.com'), false);
  // Само userinfo или само порт не е host (F5).
  assert.equal(isWebUrl('http://user@/path'), false);
  assert.equal(isWebUrl('http://a@b@/x'), false);
  assert.equal(isWebUrl('http://:8080/x'), false);
  assert.equal(isWebUrl('https://user@relay.example.com:8443/x'), true);
});

/** Буфер като този на xterm.js: редове от клетки, `wrapped` — продължение на горния ред. */
function fakeBuffer(rows) {
  return {
    length: rows.length,
    getLine(y) {
      const row = rows[y];
      if (!row) return undefined;
      return {
        isWrapped: row.wrapped ?? false,
        length: row.cells.length,
        getCell: (x) => {
          const c = row.cells[x];
          return c && { getChars: () => c.chars, getWidth: () => c.width };
        },
      };
    },
  };
}

const cellsOf = (text) => [...text].map((chars) => ({ chars, width: 1 }));

test('wrappedLine събира пренесения ред и знае клетката на всеки знак', () => {
  const buffer = fakeBuffer([
    { cells: cellsOf('$ ls      ') },
    { cells: cellsOf('see https:') },
    { cells: cellsOf('//a.b/cd  '), wrapped: true },
    { cells: cellsOf('next      ') },
  ]);
  for (const y of [1, 2]) {
    const line = wrappedLine(buffer, y);
    assert.equal(line.text, 'see https://a.b/cd  ');
    assert.deepEqual(line.cells[4], { x: 4, y: 1 });
    assert.deepEqual(line.cells[10], { x: 0, y: 2 });
  }
  assert.equal(wrappedLine(buffer, 3).text, 'next      ');
});

test('wrappedLine: широк знак е един знак в текста, празна клетка е интервал', () => {
  const buffer = fakeBuffer([{
    cells: [
      { chars: '🚀', width: 2 }, { chars: '', width: 0 },
      { chars: '', width: 1 },
      ...cellsOf('https://a.b'),
    ],
  }]);
  const line = wrappedLine(buffer, 0);
  assert.equal(line.text, '🚀 https://a.b');
  // 🚀 е две code unit-а в низа, и двата сочат клетка 0.
  assert.deepEqual(line.cells.slice(0, 4), [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  const [url] = findUrls(line.text);
  assert.deepEqual(line.cells[url.start], { x: 3, y: 0 });
});

test('wrappedLine: празната клетка в края на ред, когато широк знак не е влязъл, не е интервал (F1)', () => {
  // xterm.js пренася широкия знак на следващия ред и оставя последната клетка празна.
  const buffer = fakeBuffer([
    { cells: [...cellsOf('https://a.b/'), { chars: '', width: 1 }] },
    { cells: [{ chars: '路', width: 2 }, { chars: '', width: 0 }, ...cellsOf('x  ')], wrapped: true },
  ]);
  const line = wrappedLine(buffer, 1);
  assert.equal(line.text, 'https://a.b/路x  ');
  assert.deepEqual(findUrls(line.text).map((u) => u.url), ['https://a.b/路x']);
  assert.deepEqual(line.cells[12], { x: 0, y: 1 });
});

test('wrappedLine на ред извън буфера е празен', () => {
  assert.deepEqual(wrappedLine(fakeBuffer([]), 5), { text: '', cells: [] });
});
