// „Mac-ове“ в истински браузър срещу mock-а с няколко Mac-а (нов relay): версията на Supacode
// (УА6) стои на реда на свързания Mac. Иска инсталиран Google Chrome; без него тестът се прескача.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from '../src/http-server.mjs';
import { startMock } from './helpers/mock.mjs';

let mock;
let app;
let browser;
let page;
let base;

before(async () => {
  mock = await startMock({ lan: false, env: { MOCK_SINGLE_HOST: '0', MOCK_OLD_RELAY: '0' } });
  app = createServer({ port: 0, configDir: await mkdtemp(join(tmpdir(), 'supacode-web-hosts-')) });
  base = `http://localhost:${await app.listen()}`;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    browser = null;
  }
  if (browser) page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
});

after(async () => {
  await browser?.close();
  await app?.close();
  await mock?.stop();
});

test('„Mac-ове“: версията на Supacode е само на реда на свързания Mac', async (t) => {
  if (!browser) return t.skip('няма Google Chrome');
  await page.goto(base);
  await page.locator('#setup-key').fill(mock.connectionKey);
  await page.locator('#setup-save').click();
  // Два Mac-а на линия и нищо записано: „Mac-ове“ се отваря сам (АН2).
  await page.locator('#hosts').waitFor({ state: 'visible' });
  await page.locator('.host-row', { hasText: 'Office Mac' }).click();
  await page.locator('.row-wt').first().waitFor();
  await page.locator('#host-name').click();
  const office = page.locator('.host-row', { hasText: 'Office Mac' });
  await office.locator('.app').waitFor();
  assert.equal(await office.locator('.app').textContent(), 'Supacode 0.0.0-mock (1)');
  assert.equal(await page.locator('.host-row', { hasText: 'Home Mac' }).locator('.app').count(), 0);
  if (process.env.SHOT_DIR) await page.locator('#hosts .dialog').screenshot({ path: join(process.env.SHOT_DIR, 'hosts-web.png') });
});
