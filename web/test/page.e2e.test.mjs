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
import { RESIZE_REPLY_MS } from '../public/resize-feedback.js';

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
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write', 'notifications'], { origin: base });
});

after(async () => {
  await browser?.close();
  await app?.close();
  await mock?.stop();
});

/** Входът към даден таб от лога на mock-а след позиция `from`, като hex. */
function inputsSince(from, contentId) {
  return mock.log().slice(from).split('\n')
    .filter((l) => l.includes('input received,') && l.includes(`content: ${contentId},`))
    .map((l) => /hex: ([0-9a-f]*)/.exec(l)[1]);
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
  const line = mock.log().slice(from).split('\n').find((l) => l.includes('tab opened,') && l.includes('worktree: wt-remote,'));
  const [, cols, rows] = /cols: (\d+), rows: (\d+)$/.exec(line);
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
  const resized = /resize applied, .*content: content-codex, .*cols: (\d+), rows: (\d+)/;
  await waitFor(() => resized.test(mock.log().slice(from)), 'resize в mock-а');
  const [, cols, rows] = resized.exec(mock.log().slice(from));
  assert.notDeepEqual([Number(cols), Number(rows)], [120, 40]);
  // Потребителят вижда отговора на Mac-а, а второ натискане казва, че размерът вече е такъв.
  const toastText = () => page.locator('#toast').textContent();
  // Отговорът на Mac-а носи и версията на Supacode там (УА6).
  await waitFor(async () => (await toastText()) === `Mac-ът смени таба на ${cols} × ${rows} · Supacode 0.0.0-mock (1)`, 'съобщение за отговора');
  assert.equal(await page.locator('#host-name').getAttribute('title'), 'Supacode 0.0.0-mock (1)');
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
  await page.locator('#fit-button').click();
  await waitFor(async () => (await toastText()) === `Табът вече е ${cols} × ${rows}`, 'същият размер');
  // Shell-ът на Mac-а вижда поискания размер.
  await typeInTerminal('stty size');
  await waitFor(async () => (await screenText()).includes(`${rows} ${cols}`), 'stty size');
  // Mac-ът връща своя размер (тук: mock-resize) — шрифтът пак се вписва.
  await typeInTerminal('mock-resize');
  await waitFor(async () => (await rowCount()) === 30, 'размерът на Mac-а');
});

test('„Размер по този екран“: отказ от Mac-а се казва веднага, без „не отговори“ после', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  // След предишния тест табът е 100 × 30 (mock-resize), а при 14 px тук влиза друг размер.
  await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length)) === 30, 'табът е 100 × 30');
  const toastText = () => page.locator('#toast').textContent();
  const sent = mock.log().length;
  await typeInTerminal('mock-resize-fail');
  const failHex = Buffer.from('mock-resize-fail\r').toString('hex');
  await waitFor(() => inputsSince(sent, 'content-codex').join('').includes(failHex), 'mock-resize-fail в mock-а');
  await page.locator('#fit-button').click();
  const failed = 'Размерът не се смени: terminal did not start · Supacode 0.0.0-mock (1)';
  await waitFor(async () => (await toastText()) === failed, 'съобщение за отказа');
  // Отговорът е дошъл: след срока за `size` не идва „Mac-ът не отговори“.
  await new Promise((r) => setTimeout(r, RESIZE_REPLY_MS + 500));
  assert.equal(await toastText(), failed);
  const okSent = mock.log().length;
  await typeInTerminal('mock-resize-ok');
  const okHex = Buffer.from('mock-resize-ok\r').toString('hex');
  await waitFor(() => inputsSince(okSent, 'content-codex').join('').includes(okHex), 'mock-resize-ok в mock-а');
  const from = mock.log().length;
  await page.locator('#fit-button').click();
  await waitFor(async () => /^Mac-ът смени таба на \d+ × \d+ · /.test(await toastText()), 'resize пак минава');
  assert.ok(/resize applied, .*content: content-codex,/.test(mock.log().slice(from)));
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

test('„агент чака“: известие при преход, когато страницата не е пред очите (УА2)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  // Chrome без прозорец не показва известия: записваме ги и казваме, че прозорецът не е на фокус.
  await page.evaluate(() => {
    window.notes = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title, options) { Object.assign(this, { title, ...options }); window.notes.push(this); }
      close() {}
    };
    document.hasFocus = () => false;
  });
  await page.locator('#setup-button').click();
  await page.locator('#setup-notify').check();
  await page.locator('#setup-cancel').click();
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  await typeInTerminal('mock-await');
  await waitFor(async () => (await page.evaluate(() => window.notes.length)) === 1, 'едно известие');
  const note = await page.evaluate(() => ({ title: window.notes[0].title, body: window.notes[0].body }));
  assert.equal(note.title, 'Агент чака вход');
  assert.match(note.body, /codex review$/);
  // Щракване по известието отваря таба.
  await page.locator('.tab', { hasText: 'claude' }).click();
  await waitLive();
  await page.evaluate(() => window.notes[0].onclick());
  await waitFor(() => page.url().endsWith('#c=content-codex'), 'табът от известието');
  await waitLive();
  await typeInTerminal('mock-busy');
});

test('презареждане отваря същия таб наново', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  const url = page.url();
  await page.reload();
  await waitLive();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('.tab.open').count(), 1);
});

test('„+“ на repository-то: подсказки, грешка от Mac-а в диалога, после новият worktree с отворен таб (ЗД11)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  // notes-app е папка: Mac-ът казва `canCreateWorktree: false` и бутон няма.
  assert.equal(await page.locator('.row-repo', { hasText: 'notes-app' }).locator('.repo-new').count(), 0);
  await page.locator('.row-repo', { hasText: 'supacode' }).locator('.repo-new').click();
  assert.equal(await page.locator('#worktree-title').textContent(), 'Нов worktree в supacode');
  assert.ok(await page.locator('#worktree-create').isDisabled(), 'празно име');
  await page.locator('#worktree-name').fill('a b');
  assert.equal(await page.locator('#worktree-hint').textContent(), 'Без интервали в името');
  assert.ok(await page.locator('#worktree-create').isDisabled());
  await page.locator('#worktree-name').fill('Resume-Picker');
  assert.match(await page.locator('#worktree-hint').textContent(), /Вече има/);
  // Грешка от git на Mac-а: остава в диалога с името, без тост.
  await page.locator('#worktree-name').fill('mock-fail-e2e');
  await page.locator('#worktree-create').click();
  await page.locator('#worktree-error').waitFor({ state: 'visible', timeout: 5_000 });
  assert.match(await page.locator('#worktree-error').textContent(), /mock git failure/);
  assert.equal(await page.locator('#worktree-name').inputValue(), 'mock-fail-e2e');
  await page.locator('#worktree-name').fill('wt-e2e');
  await page.locator('#worktree-name').press('Enter');
  await waitFor(() => /#c=content-new-\d+$/.test(page.url()), 'табът на новия worktree', 6_000);
  await waitLive();
  assert.ok(await page.locator('#worktree').isHidden());
  await page.locator('.row-wt', { hasText: 'wt-e2e' }).waitFor({ timeout: 6_000 });
  assert.equal(await page.locator('.tab.open').count(), 1);
});
