import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { LanPath } from '../src/lan-path.mjs';

const KEY = 'test-key';
const FP = 'ab'.repeat(32);
const FP_MAC = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('supacode-lan-fp-v1:' + FP).digest('hex');

/** Порт, на който никой не слуша: опитът свършва веднага с ECONNREFUSED. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test('lan.failed носи кода на грешката, за да се види защо LAN не мина', async () => {
  const lines = [];
  const log = { debug() {}, warn() {}, error() {}, info: (event, fields) => lines.push({ event, fields }) };
  const timing = { lanRetryFirstMs: 60_000, lanRetryMaxMs: 60_000, lanConnectTimeoutMs: 500, pingIntervalMs: 60_000, silenceLimitMs: 60_000 };
  const events = { opened() {}, text() {}, closed() {}, askHello() {} };
  const path = new LanPath({ timing, events, log });

  path.offer({ lan: { addrs: ['127.0.0.1'], port: await closedPort(), fp: FP, fpMac: FP_MAC } }, { apiKey: KEY });
  const deadline = Date.now() + 3_000;
  while (!lines.some((l) => l.event === 'lan.failed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  path.reset();

  const failed = lines.find((l) => l.event === 'lan.failed');
  assert.ok(failed, 'няма lan.failed');
  assert.equal(failed.fields.reasons, 'ECONNREFUSED');
  assert.equal(failed.fields.addresses, 1);
});
