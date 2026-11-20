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
  app = createServer({
    port: 0,
    configDir: await mkdtemp(join(tmpdir(), 'supacode-web-e2e-')),
    build: { sha: 'e2e1234', dirty: false, startedAt: '2026-11-20T05:04:23.000Z' },
  });
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

const screenText = () => page.evaluate(() => [...document.querySelectorAll('.term-view:not([hidden]) .xterm-rows > div')].map((d) => d.textContent).join('\n'));

async function typeInTerminal(text) {
  await page.locator('.term-view:not([hidden]) .xterm-helper-textarea').focus();
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

test('„Настройка“ показва кой код върти уеб app-ът (УА14)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('#setup-button').click();
  assert.equal(await page.locator('#setup-version').textContent(), 'Уеб app e2e1234 · пуснат 2026-11-20 05:04 UTC');
  await page.locator('#setup-cancel').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
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

// КЛ5: докато табът не е на живо (тук Mac-ът е изчезнал), редът не се праща, остава в полето и
// страницата казва защо.
test('ред без връзка с таба остава в полето със съобщение', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await waitLive();
  // При LAN `mock-offline` спира само relay-а: първо пътят минава на relay.
  await typeInTerminal('mock-lan-off');
  await waitFor(async () => (await page.locator('#path-chip').textContent()) === 'Relay', 'Relay чип');
  await waitLive();
  await typeInTerminal('mock-offline');
  await page.waitForFunction(() => !document.getElementById('term-status').hidden, null, { timeout: 5_000 });
  const from = mock.log().length;
  await page.locator('#line-input').fill('echo kl5');
  await page.locator('#line-input').press('Enter');
  assert.equal(await page.locator('#line-input').inputValue(), 'echo kl5');
  assert.equal(await page.locator('#toast').textContent(), 'Терминалът не е свързан — редът не е изпратен');
  await page.waitForFunction(() => document.getElementById('term-status').hidden, null, { timeout: 15_000 });
  assert.deepEqual(inputsSince(from, 'content-claude'), []);
  await page.locator('#line-input').fill('');
  await typeInTerminal('mock-lan-on');
  await waitFor(async () => (await page.locator('#path-chip').textContent()) === 'LAN', 'пак LAN', 20_000);
  await waitLive();
});

test('Ctrl+⌘+↓ сменя таба, нов таб тръгва с размера на прозореца', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('.term-view:not([hidden]) .xterm-helper-textarea').focus();
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
  const fontPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.term-view:not([hidden]) .xterm-rows')).fontSize));
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
  const rowCount = () => page.evaluate(() => document.querySelectorAll('.term-view:not([hidden]) .xterm-rows > div').length);
  await waitFor(async () => (await rowCount()) === Number(rows), 'редовете на страницата са поисканите');
  await waitFor(async () => { const f = await fontPx(); return f >= 14 && f < 15; }, 'шрифтът е между 14 и 15 px');
  // Целият терминал влиза в мястото.
  const fits = await page.evaluate(() => {
    const screen = document.querySelector('.term-view:not([hidden]) .xterm-screen').getBoundingClientRect();
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
  await waitFor(async () => (await page.evaluate(() => document.querySelectorAll('.term-view:not([hidden]) .xterm-rows > div').length)) === 30, 'табът е 100 × 30');
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

/** Средата на знака `offset` от първото срещане на `needle` в показаните редове на терминала. */
const pointOf = (needle, offset) => page.evaluate(({ needle, offset }) => {
  for (const row of document.querySelectorAll('.term-view:not([hidden]) .xterm-rows > div')) {
    let at = row.textContent.indexOf(needle);
    if (at < 0) continue;
    at += offset;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (at < node.length) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      at -= node.length;
    }
  }
  return null;
}, { needle, offset });

/**
 * Клик като от човек: мишката идва от друг ред. xterm.js пази линковете на реда, над който е
 * мишката, докато тя не мине на друг ред — и след нов изход на същия ред.
 */
async function clickAt(point) {
  await page.mouse.move(point.x, point.y + 60);
  await page.mouse.move(point.x - 3, point.y);
  await page.mouse.move(point.x, point.y);
  await new Promise((r) => setTimeout(r, 100));
  await page.mouse.down();
  await page.mouse.up();
}

test('http/https адрес и OSC 8 линк в терминала се отварят с клик в нов таб', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.evaluate(() => {
    window.opened = [];
    window.open = (...args) => { window.opened.push(args); return null; };
  });
  // Адресът се сглобява от printf, за да не е цял в командата на реда отгоре.
  await typeInTerminal("clear; printf 'виж https://relay.%s/e2e-link. и %s\\n' example.com край");
  await waitFor(async () => (await screenText()).includes('виж https://relay.example.com/e2e-link. и край'), 'адресът');
  await clickAt(await pointOf('виж https://relay.example.com', 10));
  await waitFor(async () => (await page.evaluate(() => window.opened.length)) === 1, 'отворен линк');
  assert.deepEqual(await page.evaluate(() => window.opened[0]),
    ['https://relay.example.com/e2e-link', '_blank', 'noopener,noreferrer']);
  // Нов изход на същия ред, докато мишката е на реда, но не върху адреса: xterm.js пази стария
  // отговор на provider-а за реда и после показва стария линк, но той не се отваря, защото адресът
  // вече не е там (F3). (Мишка върху линка би накарала xterm.js да попита наново.)
  const old = await pointOf('виж https://relay.example.com', 10);
  await page.mouse.move(old.x + 500, old.y);
  await new Promise((r) => setTimeout(r, 100));
  await typeInTerminal("clear; printf 'обикновен текст без никакъв адрес в него\\n'");
  await waitFor(async () => (await screenText()).includes('обикновен текст без никакъв'), 'новият ред');
  await page.mouse.move(old.x, old.y);
  await new Promise((r) => setTimeout(r, 100));
  await page.mouse.down();
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.opened.length), 1);
  await typeInTerminal("clear; printf 'виж https://relay.%s/e2e-link. и %s\\n' example.com край");
  await waitFor(async () => (await screenText()).includes('виж https://relay.example.com/e2e-link. и край'), 'адресът пак');
  // Текст до адреса не отваря нищо.
  await clickAt(await pointOf('и край', 3));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.opened.length), 1);

  // OSC 8: текстът е друг, отваря се адресът от последователността; javascript: — нищо.
  await typeInTerminal("clear; printf '\\033]8;;https://relay.example.com/osc8\\033\\\\Документация\\033]8;;\\033\\\\ \\033]8;;javascript:alert(1)\\033\\\\Опасно\\033]8;;\\033\\\\\\n'");
  await waitFor(async () => (await screenText()).includes('Документация Опасно'), 'OSC 8 линковете');
  await clickAt(await pointOf('Документация Опасно', 2));
  await waitFor(async () => (await page.evaluate(() => window.opened.length)) === 2, 'отворен OSC 8 линк');
  assert.equal(await page.evaluate(() => window.opened[1][0]), 'https://relay.example.com/osc8');
  await clickAt(await pointOf('Документация Опасно', 15));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.opened.length), 2);

  // Claude Code чупи дълъг адрес на два реда сам (не е пренос на xterm.js), но двете части носят
  // пълния адрес в OSC 8: отваря се целият, не първата част от текста.
  const full = 'https://relay.example.com/long/first-second';
  await typeInTerminal(`clear; printf '\\033]8;;${full}\\033\\\\https://relay.example.com/long/first-\\033]8;;\\033\\\\\\n\\033]8;;${full}\\033\\\\second\\033]8;;\\033\\\\ край\\n'`);
  await waitFor(async () => (await screenText()).includes('second край'), 'адресът на два реда');
  await clickAt(await pointOf('https://relay.example.com/long/first-', 10));
  await waitFor(async () => (await page.evaluate(() => window.opened.length)) === 3, 'първата част');
  await clickAt(await pointOf('second край', 2));
  await waitFor(async () => (await page.evaluate(() => window.opened.length)) === 4, 'втората част');
  assert.deepEqual(await page.evaluate(() => window.opened.slice(2).map((o) => o[0])), [full, full]);
});

test('програма, която следи мишката: обикновеният клик е неин, линкът се отваря с ⌘+клик (ЛК1)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.evaluate(() => { window.opened = []; });
  // `cat` поема mouse report-ите, за да не стигнат до реда на shell-а.
  await typeInTerminal("clear; printf '\\033[?1000h\\033[?1006hвиж https://relay.%s/mouse\\n' example.com; cat > /dev/null");
  await waitFor(async () => (await screenText()).includes('виж https://relay.example.com/mouse'), 'адресът');
  const from = mock.log().length;
  await clickAt(await pointOf('виж https://relay.example.com', 10));
  await waitFor(() => /text: '\\u001b\[<0;/.test(mock.log().slice(from)), 'кликът при програмата');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.opened.length), 0);
  await page.keyboard.down('Meta');
  await clickAt(await pointOf('виж https://relay.example.com', 10));
  await page.keyboard.up('Meta');
  await waitFor(async () => (await page.evaluate(() => window.opened.length)) === 1, '⌘+клик');
  assert.equal(await page.evaluate(() => window.opened[0][0]), 'https://relay.example.com/mouse');
  await page.locator('.term-view:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');
  await typeInTerminal("printf '\\033[?1006l\\033[?1000l'; clear");
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

// ---- живи терминали (ДЗ23): смяната на таб е без мрежа ----

/** Има ли в лога на mock-а след `from` attach за този таб (по relay-а или по LAN). */
const attachSince = (from, contentId) => new RegExp(`type: attach,.*"contentId":"${contentId}"`).test(mock.log().slice(from));

test('A → B → A връща същия екран без нов attach', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('.tab', { hasText: 'claude' }).click();
  await waitLive();
  // `%s`: редът на командата не съдържа маркера, само изходът.
  await typeInTerminal("clear; printf 'маркер-%s\\n' A");
  await waitFor(async () => (await screenText()).includes('маркер-A'), 'маркерът в A');
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  assert.ok(!(await screenText()).includes('маркер-A'), 'B показва своя екран');
  const from = mock.log().length;
  await page.locator('.tab', { hasText: 'claude' }).click();
  // Веднага, без чакане на `attached`: терминалът на A е същият, xterm.js само го рисува в
  // следващия кадър.
  assert.equal(await page.locator('#term-status').isHidden(), true);
  await waitFor(async () => (await screenText()).includes('маркер-A'), 'екранът на A', 500);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(attachSince(from, 'content-claude'), false);
  assert.equal(await page.locator('.term-view').count() >= 3, true, 'празният и двата таба');
});

test('A → B → A пази скрола в историята', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  const firstRow = () => page.evaluate(() => document.querySelector('.term-view:not([hidden]) .xterm-rows > div')?.textContent.trim());
  await typeInTerminal('clear; seq 1 300');
  await waitFor(async () => /^300$/m.test(await screenText()), 'seq до края');
  const bottom = await firstRow();
  const area = await page.locator('#term-area').boundingBox();
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.wheel(0, -1200);
  await waitFor(async () => (await firstRow()) !== bottom, 'скрол нагоре');
  await new Promise((r) => setTimeout(r, 200));
  const scrolled = await firstRow();
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  await page.locator('.tab', { hasText: 'claude' }).click();
  await waitFor(async () => (await firstRow()) === scrolled, `същият скрол (${scrolled})`, 1_000);
});

test('изходът на скрит таб стига до него', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await typeInTerminal("clear; sleep 1; printf 'късно-%s\\n' A");
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  await new Promise((r) => setTimeout(r, 2_000));
  assert.ok(!(await screenText()).includes('късно-A'));
  await page.locator('.tab', { hasText: 'claude' }).click();
  await waitFor(async () => (await screenText()).includes('късно-A'), 'изходът на A, докато беше скрит', 1_000);
});

test('вход отива само във видимия таб', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.locator('.tab', { hasText: 'codex review' }).click();
  await waitLive();
  const from = mock.log().length;
  await typeInTerminal('echo samo-$((2*4))');
  await waitFor(async () => (await screenText()).includes('samo-8'), 'ехото в B');
  assert.ok(inputsSince(from, 'content-codex').length > 0);
  assert.deepEqual(inputsSince(from, 'content-claude'), []);
});

test('над тавана най-отдавна видяният терминал изчезва от страницата', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  const terminalOf = (contentId) => page.locator(`.term-view[data-content-id="${contentId}"]`).count();
  app.host.keptLimit = 2;
  try {
    await page.locator('.tab', { hasText: 'claude' }).click();
    await waitLive();
    await page.locator('.tab', { hasText: 'codex review' }).click();
    await waitLive();
    assert.equal(await terminalOf('content-claude'), 1);
    // Третият таб на worktree-то (новият от теста с Ctrl+⌘+↓).
    await page.keyboard.press('Control+Meta+ArrowDown');
    await waitFor(() => /#c=content-new-\d+$/.test(page.url()), 'третият таб');
    await waitLive();
    await waitFor(async () => (await terminalOf('content-claude')) === 0, 'терминалът на A е махнат');
    assert.equal(await terminalOf('content-codex'), 1);
    // Празният и двата живи.
    assert.equal(await page.locator('.term-view').count(), 3);
    // Следващите тестове чакат адрес `#c=content-new-…` от свой нов таб: тук се връщаме на codex.
    await page.locator('.tab', { hasText: 'codex review' }).click();
    await waitLive();
  } finally {
    app.host.keptLimit = 8;
  }
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

test('🗑 на worktree-то: потвърждение с текста на собственика, после го няма; ⟳ опреснява (ЗД13)', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  assert.ok(await page.locator('#refresh-button').isVisible());
  // Основният worktree не се трие: бутон няма.
  assert.equal(await page.locator('.row-wt', { hasText: 'main' }).first().locator('.wt-delete').count(), 0);
  const row = page.locator('.row-wt', { hasText: 'wt-e2e' });
  await row.locator('.wt-delete').click();
  assert.equal(await page.locator('#confirm-delete-text').textContent(),
    'Изтрий worktree wt-e2e в supacode? Папката и терминалите му се затварят; branch-ът остава.');
  await page.locator('#confirm-delete-ok').click();
  await row.locator('.deleting').waitFor({ timeout: 3_000 });
  await row.waitFor({ state: 'detached', timeout: 6_000 });
  // Отвореният таб беше в него: терминалът е затворен.
  assert.ok(!page.url().includes('#c='));
  await page.locator('#refresh-button').click();
  await waitFor(async () => !(await page.locator('#refresh-button').isDisabled()), 'опреснено', 3_000);
});
