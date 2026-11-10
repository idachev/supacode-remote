// Избор на Mac с нов relay (multi-host, АН2 / ОП20). Relay-ят тук е малък фалшив сървър със
// същите правила: `/client` без `host` е несвързан (`hostOnline:false`, `hosts`, без `host`),
// а с `host=<id>` е свързан с този Mac.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from '../src/http-server.mjs';
import { waitFor } from './helpers/mock.mjs';

const KEY = 'test-key';
const closers = [];
after(async () => { for (const c of closers.reverse()) await c(); });

/** Фалшив relay с дадените Mac-ове; пази адресите, с които са дошли клиентите. */
async function fakeRelay(hosts) {
  const urls = [];
  const server = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    urls.push(req.url);
    const bound = new URL(req.url, 'http://x').searchParams.get('host');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const host = hosts.find((h) => h.id === bound);
      const online = Boolean(host?.online);
      ws.send(JSON.stringify({ t: 'relay', hostOnline: online, ...(bound ? { host: bound } : {}), hosts }));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (!online) {
          ws.send(JSON.stringify({ t: 'error', id: m.id ?? null, message: 'host offline' }));
        } else if (m.t === 'hello') {
          ws.send(JSON.stringify({ t: 'hello', v: 1, host: host.name, hostId: host.id }));
        } else if (m.t === 'list') {
          ws.send(JSON.stringify({ t: 'list', id: m.id, repos: [{ id: `r-${host.id}`, name: `repo of ${host.id}`, worktrees: [] }] }));
        }
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(r); }));
  return { key: `http://127.0.0.1:${server.address().port}/${KEY}`, urls };
}

async function app(config) {
  const dir = await mkdtemp(join(tmpdir(), 'supacode-web-hosts-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const a = createServer({ port: 0, configDir: dir });
  const port = await a.listen();
  closers.push(() => a.close());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://localhost:${port}`, Host: `localhost:${port}` } });
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  closers.push(async () => ws.close());
  const last = (t) => got.filter((m) => m.t === t).at(-1);
  const saved = async () => JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  return { dir, got, last, saved, send: (m) => ws.send(JSON.stringify(m)) };
}

test('без записан избор и с един Mac на линия — той се избира и записва', async () => {
  const relay = await fakeRelay([{ id: 'mac-a', name: 'Office Mac', online: true }, { id: 'mac-b', online: false }]);
  const p = await app({ connectionKey: relay.key });
  await waitFor(() => p.last('state')?.hostOnline === true, 'свързан с Mac-а');
  assert.equal(p.last('state').boundHost, 'mac-a');
  assert.equal(p.last('state').hostPick, false);
  assert.equal((await p.saved()).selectedHostId, 'mac-a');
  assert.ok(relay.urls.includes('/client?host=mac-a'));
  await waitFor(() => p.last('list')?.repos[0].id === 'r-mac-a', 'списъкът на Mac-а');
});

test('два Mac-а на линия — „Mac-ове“, нищо не се избира само; изборът се записва', async () => {
  const relay = await fakeRelay([{ id: 'mac-a', name: 'A', online: true }, { id: 'mac-b', name: 'B', online: true }]);
  const p = await app({ connectionKey: relay.key });
  await waitFor(() => p.last('state')?.hostPick === true, 'hostPick');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await p.saved()).selectedHostId, undefined);
  assert.ok(relay.urls.every((u) => u === '/client'));
  p.send({ t: 'host.select', id: 'mac-b' });
  await waitFor(() => p.last('state')?.hostOnline === true, 'свързан с B');
  assert.equal(p.last('state').boundHost, 'mac-b');
  assert.equal(p.last('state').hostPick, false);
  assert.equal((await p.saved()).selectedHostId, 'mac-b');
  assert.ok(p.last('reset'));
});

test('записаният Mac го няма в списъка — изборът остава, отваря се „Mac-ове“', async () => {
  const relay = await fakeRelay([{ id: 'mac-a', name: 'A', online: true }]);
  const p = await app({ connectionKey: relay.key, selectedHostId: 'gone' });
  await waitFor(() => p.last('state')?.hostPick === true, 'hostPick');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await p.saved()).selectedHostId, 'gone');
  assert.equal(p.last('state').selectedHostId, 'gone');
  assert.ok(relay.urls.every((u) => u === '/client?host=gone'));
});

test('нов relay, който не знае нито един Mac — „Mac-ове“ с празен списък', async () => {
  const relay = await fakeRelay([]);
  const p = await app({ connectionKey: relay.key });
  await waitFor(() => Array.isArray(p.last('state')?.hosts), 'hosts');
  assert.deepEqual(p.last('state').hosts, []);
  assert.equal(p.last('state').hostPick, true);
});

test('неуспешен запис — изборът остава стар и следващият опит минава', async () => {
  const relay = await fakeRelay([{ id: 'mac-a', name: 'A', online: true }, { id: 'mac-b', name: 'B', online: true }]);
  const p = await app({ connectionKey: relay.key });
  await waitFor(() => p.last('state')?.hostPick === true, 'hostPick');
  // Папка на мястото на временния файл: записът пада.
  await mkdir(join(p.dir, 'config.json.tmp'));
  p.send({ t: 'host.select', id: 'mac-b' });
  await waitFor(() => p.last('error'), 'грешка');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(p.last('state').selectedHostId, null);
  assert.ok(relay.urls.every((u) => u === '/client'));
  await rm(join(p.dir, 'config.json.tmp'), { recursive: true });
  p.send({ t: 'host.select', id: 'mac-b' });
  await waitFor(() => p.last('state')?.boundHost === 'mac-b' && p.last('state')?.hostOnline, 'свързан с B');
  assert.equal((await p.saved()).selectedHostId, 'mac-b');
});

test('смяна към Mac извън линия — името на стария Mac не остава', async () => {
  const relay = await fakeRelay([{ id: 'mac-a', name: 'Office Mac', online: true }, { id: 'mac-b', name: 'Home Mac', online: false }]);
  const p = await app({ connectionKey: relay.key });
  await waitFor(() => p.last('state')?.hostName === 'Office Mac', 'hello от A');
  p.send({ t: 'host.select', id: 'mac-b' });
  await waitFor(() => p.last('state')?.boundHost === 'mac-b', 'свързан с B');
  assert.equal(p.last('state').hostOnline, false);
  assert.equal(p.last('state').hostName, null);
});

