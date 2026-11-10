// Страницата в истински браузър срещу mock-а: локалният сървър, Chrome без прозорец и mock-ът с
// истински shell-ове. Байтовете, които стигат до Mac-а, се проверяват в лога на mock-а (hex).
// Иска инсталиран Google Chrome; без него тестът се прескача.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../src/http-server.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';

let mock;
let app;
let base;
let browser;
let page;

before(async () => {
  mock = await startMock();
  app = createServer({ port: 0, configDir: await mkdtemp(join(tmpdir(), 'supacode-web-e2e-')) });
  base = `http://localhost:${await app.listen()}`;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = null;
  }
  if (!browser) return;
  page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
});

after(async () => {
  await browser?.close();
  await app?.close();
  await mock?.stop();
});

/** Входът към даден таб от лога на mock-а след позиция `from`, като hex. */
function inputsSince(from, contentId) {
  return mock.log().slice(from).split('\n')
    .filter((l) => l.includes(`input ${contentId} `))
    .map((l) => l.replace(/.*hex=/, ''));
}

const screenText = () => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent).join('\n'));

async function typeInTerminal(text) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function waitLive() {
  await page.waitForFunction(() => document.getElementById('term-status').hidden, null, { timeout: 8_000 });
}

test('„Настройка“ с ключа, списъкът и LAN чипът', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.goto(base);
  await page.locator('#setup-key').fill(mock.connectionKey);
  await page.locator('#setup-save').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
  await page.locator('.row-wt', { hasText: 'Remote access' }).waitFor();
  await waitFor(async () => (await page.locator('#path-chip').textContent()) === 'LAN', 'LAN чип');
  assert.equal(await page.locator('#host-name').textContent(), 'Mock Mac');
});

test('таб: клавишите стигат точно, xterm.js не отговаря на програмата', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('.row-wt', { hasText: 'Remote access' }).click();
  await page.locator('.tab', { hasText: 'claude' }).click();
  await waitLive();
  const from = mock.log().length;
  await typeInTerminal("printf '\\033[c\\033[6n\\033]11;?\\007'; echo e2e-$((6*7))");
  await waitFor(async () => (await screenText()).includes('e2e-42'), 'изпълнената команда');
  await new Promise((r) => setTimeout(r, 300));
  // Нито един ESC байт: въпросите DA, CPR и OSC 11 не получават отговор от браузъра.
  assert.ok(inputsSince(from, 'content-claude').every((hex) => !hex.includes('1b')));
  const keys = mock.log().length;
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Shift+Enter');
  await waitFor(() => inputsSince(keys, 'content-claude').length >= 3, 'три клавиша');
  assert.deepEqual(inputsSince(keys, 'content-claude'), ['1b5b41', '03', '1b0d']);
});

test('„Предложи“ само пълни полето, Esc не стига до агента, редът тръгва с Enter', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  const from = mock.log().length;
  await page.keyboard.press('Control+Meta+s');
  await page.locator('.suggestions .item', { hasText: 'git status' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#suggestions').isHidden(), true);
  await page.keyboard.press('Control+Meta+s');
  await page.locator('.suggestions .item', { hasText: 'ls -la' }).click();
  assert.equal(await page.locator('#line-input').inputValue(), 'ls -la');
  assert.deepEqual(inputsSince(from, 'content-claude'), []);
  await page.locator('#line-input').press('Enter');
  await waitFor(() => inputsSince(from, 'content-claude').length >= 2, 'текст и Enter');
  assert.deepEqual(inputsSince(from, 'content-claude'), [Buffer.from('ls -la').toString('hex'), '0d']);
});

test('Ctrl+⌘+↓ сменя таба, нов таб тръгва с размера на прозореца', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Meta+ArrowDown');
  await waitFor(() => page.url().endsWith('#c=content-codex'), 'таб codex');
  await waitLive();
  const from = mock.log().length;
  await page.locator('.new-tab').click();
  await waitFor(() => /#c=content-new-\d+$/.test(page.url()), 'новият таб');
  await waitLive();
  const line = mock.log().slice(from).split('\n').find((l) => l.includes('tab.new wt-remote'));
  const [, cols, rows] = /(\d+)x(\d+)$/.exec(line);
  // При 14 px в 1400 × 850 влизат над 100 колони и над 30 реда, не 120 × 40 по подразбиране.
  assert.ok(Number(cols) > 100 && Number(cols) !== 120, `cols ${cols}`);
  assert.ok(Number(rows) > 30 && Number(rows) !== 40, `rows ${rows}`);
});

test('„Размер по този екран“ сменя таба на Mac-а, шрифтът се вписва в новия размер', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  // Табът codex е с размера на Mac-а (120 × 40): шрифтът е вписан, не 14 px.
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  const fontPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize));
  assert.ok(Math.abs((await fontPx()) - 14) >= 0.5, `шрифт ${await fontPx()}`);
  const from = mock.log().length;
  await page.locator('#fit-button').click();
  await waitFor(() => /resize content-codex \d+x\d+/.test(mock.log().slice(from)), 'resize в mock-а');
  const [, cols, rows] = /resize content-codex (\d+)x(\d+)/.exec(mock.log().slice(from));
  assert.notDeepEqual([Number(cols), Number(rows)], [120, 40]);
  // Мрежата е сметната при 14 px; дошлият `size` вписва шрифта наново (ОП36): малко над 14 px.
  const rowCount = () => page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length);
  await waitFor(async () => (await rowCount()) === Number(rows), 'редовете на страницата са поисканите');
  await waitFor(async () => { const f = await fontPx(); return f >= 14 && f < 15; }, 'шрифтът е между 14 и 15 px');
  // Целият терминал влиза в мястото.
  const fits = await page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    const area = document.getElementById('term-area').getBoundingClientRect();
    return screen.width <= area.width && screen.height <= area.height;
  });
  assert.equal(fits, true);
  // Shell-ът на Mac-а вижда поискания размер.
  await typeInTerminal('stty size');
  await waitFor(async () => (await screenText()).includes(`${rows} ${cols}`), 'stty size');
  // Mac-ът връща своя размер (тук: mock-resize) — шрифтът пак се вписва.
  await typeInTerminal('mock-resize');
  await waitFor(async () => (await rowCount()) === 30, 'размерът на Mac-а');
});

test('OSC 52 от програмата копира в clipboard-а на браузъра (УА4)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.evaluate(() => navigator.clipboard.writeText('старо'));
  const b64 = Buffer.from('копирано от Mac-а', 'utf8').toString('base64');
  await typeInTerminal(`printf '\\033]52;c;%s\\007' ${b64}`);
  await waitFor(async () => (await page.evaluate(() => navigator.clipboard.readText())) === 'копирано от Mac-а', 'clipboard');
  // Въпрос за clipboard-а не получава отговор и не сменя нищо.
  const from = mock.log().length;
  await typeInTerminal(`printf '\\033]52;c;?\\007'`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'копирано от Mac-а');
  assert.ok(!/1b5d3532/.test(mock.log().slice(from)), 'отговор с OSC 52 към PTY-то');
});

test('презареждане отваря същия таб наново', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  const url = page.url();
  await page.reload();
  await waitLive();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('.tab.open').count(), 1);
});
