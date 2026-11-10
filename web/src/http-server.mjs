// Локалният сървър: статичните файлове на страницата и WebSocket-ът `/ws` към нея.
//
// Слуша само на 127.0.0.1. Всяка заявка трябва да е за `localhost:<port>` или
// `127.0.0.1:<port>` (срещу DNS rebinding), а upgrade-ът — и от страница със същия адрес
// (`Origin`). Иначе чужд сайт в същия браузър би писал в терминалите на Mac-а.

import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BrowserLink } from './browser-link.mjs';
import { ConfigStore } from './config-store.mjs';
import { HostController } from './host-controller.mjs';
import { RelayClient } from './relay-client.mjs';
import { silentLogger } from './log.mjs';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(WEB_DIR, 'public');
const XTERM_DIR = join(WEB_DIR, 'node_modules', '@xterm', 'xterm');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Файлът за пътя от URL-а, или `null`, ако излиза извън позволените папки. */
function resolveStatic(pathname) {
  if (pathname === '/') return join(PUBLIC_DIR, 'index.html');
  if (pathname === '/vendor/xterm.js') return join(XTERM_DIR, 'lib', 'xterm.js');
  if (pathname === '/vendor/xterm.css') return join(XTERM_DIR, 'css', 'xterm.css');
  const file = normalize(join(PUBLIC_DIR, decodeURIComponent(pathname)));
  return file.startsWith(PUBLIC_DIR + sep) ? file : null;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function pathOf(url) {
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return null;
  }
}

function staticFileFor(url) {
  const path = pathOf(url);
  if (!path) return null;
  try {
    return resolveStatic(path);
  } catch {
    // Счупено %-кодиране в пътя.
    return null;
  }
}

/** Страницата и нейните файлове. Иконата е в самата страница; браузърът пак пита за нея. */
async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  if (req.url === '/favicon.ico') return res.writeHead(204).end();
  const file = staticFileFor(req.url);
  if (!file) return res.writeHead(404).end('not found');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    return res.writeHead(404).end('not found');
  }
}

/** Само `localhost:<port>` и `127.0.0.1:<port>`; за WebSocket-а и `Origin` от същите. */
function localGuard(portOf) {
  const hosts = () => [`localhost:${portOf()}`, `127.0.0.1:${portOf()}`];
  return {
    host: (req) => hosts().includes(req.headers.host),
    origin: (req) => hosts().some((h) => req.headers.origin === `http://${h}`),
  };
}

function forbid(socket) {
  socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
}

/** WebSocket-ът `/ws` към страницата — само от `localhost` / `127.0.0.1`. */
function pageUpgrade({ wss, guard, link, log }) {
  return (req, socket, head) => {
    if (pathOf(req.url) !== '/ws' || !guard.host(req) || !guard.origin(req)) {
      log.warn('page.refused', { path: pathOf(req.url) ?? '', origin_ok: guard.origin(req), host_ok: guard.host(req) });
      return forbid(socket);
    }
    return wss.handleUpgrade(req, socket, head, (ws) => link.attach(ws));
  };
}

/** Клиентът към Mac-а: relay връзката, логиката на табовете и връзката със страницата. */
function createClient({ configDir, relayTiming, log }) {
  const relay = new RelayClient({ timing: relayTiming, log });
  const host = new HostController(relay);
  const link = new BrowserLink({ relay, host, config: new ConfigStore(configDir), log });
  return { relay, host, link };
}

export function createServer({ port = 8790, configDir, relayTiming, log = silentLogger } = {}) {
  const { relay, host, link } = createClient({ configDir, relayTiming, log });
  let boundPort = port;
  const guard = localGuard(() => boundPort);
  const server = createHttpServer((req, res) => (guard.host(req) ? serveStatic(req, res) : res.writeHead(403).end('forbidden')));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', pageUpgrade({ wss, guard, link, log }));

  const listen = async () => {
    await link.start();
    boundPort = await listenLocal(server, port);
    return boundPort;
  };
  const close = () => closeAll({ host, relay, wss, server });
  return { relay, host, link, listen, close };
}

async function closeAll({ host, relay, wss, server }) {
  host.setActive(false);
  relay.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => server.close(r));
}

/** Само на 127.0.0.1; връща истинския порт (при `port: 0` е случаен). */
async function listenLocal(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}
