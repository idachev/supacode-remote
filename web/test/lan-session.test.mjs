import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import selfsigned from 'selfsigned';
import { WebSocketServer } from 'ws';
import { connectLan } from '../src/lan-session.mjs';
import { fingerprint } from '../src/lan-trust.mjs';

const KEY = 'test-key';

function identity(cn) {
  const pems = selfsigned.generate([{ name: 'commonName', value: cn }], { keySize: 2048, days: 30, algorithm: 'sha256' });
  const fp = fingerprint(new crypto.X509Certificate(pems.cert).raw);
  const fpMac = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('supacode-lan-fp-v1:' + fp).digest('hex');
  return { ...pems, fp, fpMac };
}

const mac = identity('mac');
const stranger = identity('stranger');
const servers = [];

/** LAN endpoint като този на Mac-а. Пази всеки HTTP байт, който стигне до него след TLS. */
async function lanServer(id, { tlsVersion = 'TLSv1.3' } = {}) {
  const seen = { bytes: 0, auth: null, upgrades: 0 };
  const server = https.createServer({ key: id.private, cert: id.cert, minVersion: tlsVersion, maxVersion: tlsVersion });
  server.on('secureConnection', (socket) => socket.on('data', (d) => { seen.bytes += d.length; }));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.upgrades += 1;
    seen.auth = req.headers.authorization ?? null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) => ws.send(`echo:${d}`));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: server.address().port, seen };
}

after(() => servers.forEach((s) => s.close()));

const info = (id, port) => ({ addrs: ['127.0.0.1'], port, fp: id.fp, fpMac: id.fpMac });

test('заковани сертификат — upgrade с ключа и текст в двете посоки', async () => {
  const { port, seen } = await lanServer(mac);
  const got = [];
  const session = await connectLan(info(mac, port), KEY, { onText: (_s, t) => got.push(t) });
  assert.ok(session);
  assert.equal(seen.auth, `Bearer ${KEY}`);
  session.send('ping');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got, ['echo:ping']);
  session.close();
});

test('чужд сертификат — до сървъра не стига нито байт от заявката с ключа', async () => {
  const { port, seen } = await lanServer(stranger);
  // fp и fpMac са на Mac-а, а на адреса седи друг сертификат.
  const session = await connectLan(info(mac, port), KEY);
  assert.equal(session, null);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.bytes, 0);
  assert.equal(seen.upgrades, 0);
});

test('TLS 1.2 се отказва', async () => {
  const { port, seen } = await lanServer(mac, { tlsVersion: 'TLSv1.2' });
  assert.equal(await connectLan(info(mac, port), KEY), null);
  assert.equal(seen.upgrades, 0);
});

test('грешен fpMac — никакъв опит за връзка', async () => {
  let connections = 0;
  const server = net.createServer((s) => { connections += 1; s.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const bad = { ...info(mac, server.address().port), fpMac: stranger.fpMac };
  assert.equal(await connectLan(bad, KEY), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connections, 0);
});

test('пробва следващия адрес, ако първият не отговаря', async () => {
  const { port } = await lanServer(mac);
  // 192.0.2.1 е TEST-NET-1: не се стига до никого и опитът свършва с таймаута.
  const started = Date.now();
  const session = await connectLan({ ...info(mac, port), addrs: ['192.0.2.1', '127.0.0.1'] }, KEY, { timeoutMs: 300 });
  assert.ok(session);
  assert.equal(session.address, '127.0.0.1');
  assert.ok(Date.now() - started >= 250);
  session.close();
});

test('невалиден адрес или порт от relay-а — без опит и без грешка, следващият адрес работи', async () => {
  const { port } = await lanServer(mac);
  assert.equal(await connectLan({ ...info(mac, port), port: 70000 }, KEY), null);
  assert.equal(await connectLan({ ...info(mac, port), port: 'x' }, KEY), null);
  const session = await connectLan({ ...info(mac, port), addrs: ['[', 'not an ip', '127.0.0.1'] }, KEY);
  assert.ok(session);
  assert.equal(session.address, '127.0.0.1');
  session.close();
});

