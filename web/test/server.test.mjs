// Локалният сървър: проверките на Host и Origin, „Настройка“ и втората страница.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/http-server.mjs';
import { startMock, waitFor } from './helpers/mock.mjs';

let mock;
let app;
let port;
let configDir;

before(async () => {
  mock = await startMock();
  configDir = await mkdtemp(join(tmpdir(), 'supacode-web-'));
  app = createServer({ port: 0, configDir });
  port = await app.listen();
});
after(async () => {
  await app?.close();
  await mock?.stop();
});

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

/** Страница: WebSocket към /ws и всичко, което е получила. */
function page({ origin = `http://localhost:${port}`, host = `localhost:${port}` } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin, Host: host } });
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  const opened = new Promise((resolve, reject) => {
    ws.on('open', () => resolve(true));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', reject);
  });
  return { ws, got, opened, send: (m) => ws.send(JSON.stringify(m)), last: (t) => got.filter((m) => m.t === t).at(-1) };
}

test('страницата и xterm.js се дават само за localhost', async () => {
  assert.equal((await get('/', { Host: `localhost:${port}` })).status, 200);
  assert.equal((await get('/vendor/xterm.js', { Host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await get('/', { Host: `evil.example.com:${port}` })).status, 403);
  assert.equal((await get('/../src/config-store.mjs', { Host: `localhost:${port}` })).status, 404);
  assert.equal((await get('/%2e%2e/package.json', { Host: `localhost:${port}` })).status, 404);
});

test('чужд Origin или чужд Host — без WebSocket', async () => {
  assert.equal(await page({ origin: 'https://evil.example.com' }).opened, 403);
  assert.equal(await page({ host: `evil.example.com:${port}` }).opened, 403);
  assert.equal(await page({ origin: 'null' }).opened, 403);
});

test('лош ключ за връзка — грешка и нищо не се записва', async () => {
  const p = page();
  assert.equal(await p.opened, true);
  await waitFor(() => p.last('state'), 'state');
  assert.equal(p.last('state').configured, false);
  p.send({ t: 'setup', connectionKey: 'relay.example.com' });
  const result = await waitFor(() => p.last('setup.result'), 'setup.result');
  assert.equal(result.ok, false);
  await assert.rejects(stat(join(configDir, 'config.json')));
  p.ws.close();
});

test('верен ключ — файл 0600, връзка с Mac-а, ключът не стига до страницата', async () => {
  const p = page();
  await p.opened;
  p.send({ t: 'setup', connectionKey: mock.connectionKey });
  assert.equal((await waitFor(() => p.last('setup.result'), 'setup.result')).ok, true);
  const file = join(configDir, 'config.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).connectionKey, mock.connectionKey);
  await waitFor(() => p.last('state')?.hostSession != null, 'сесия с host-а');
  await waitFor(() => p.last('list'), 'list');
  for (const m of p.got) assert.ok(!JSON.stringify(m).includes(mock.key), `ключът изтече в ${m.t}`);
  assert.equal(p.last('state').relayLabel, `http://127.0.0.1:${mock.port}`);
  p.ws.close();
});

test('втора страница взима управлението, първата може да си го върне', async () => {
  const a = page();
  await a.opened;
  await waitFor(() => a.last('state')?.hostSession != null, 'сесия');
  a.send({ t: 'open', contentId: 'content-shell-main' });
  await waitFor(() => a.last('attached'), 'attached на A');

  const b = page();
  await b.opened;
  await waitFor(() => a.last('replaced'), 'replaced за A');
  // Входът от A вече не стига до Mac-а.
  const before = mock.log().length;
  a.send({ t: 'input', b64: Buffer.from('echo from-a\r').toString('base64') });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!mock.log().slice(before).includes('from-a'));

  b.send({ t: 'open', contentId: 'content-idle' });
  await waitFor(() => b.last('attached')?.contentId === 'content-idle', 'attached на B');

  a.send({ t: 'takeover' });
  await waitFor(() => b.last('replaced'), 'replaced за B');
  a.send({ t: 'open', contentId: 'content-shell-main' });
  await waitFor(() => a.got.filter((m) => m.t === 'attached').length === 2, 'нов attached на A');
  a.ws.close();
  b.ws.close();
});
