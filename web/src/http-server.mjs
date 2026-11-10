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

export function createServer({ port = 8790, configDir, relayTiming } = {}) {
  const relay = new RelayClient({ timing: relayTiming });
  const host = new HostController(relay);
  const link = new BrowserLink({ relay, host, config: new ConfigStore(configDir) });
  let boundPort = port;
  const allowedHosts = () => [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`];
  const hostAllowed = (req) => allowedHosts().includes(req.headers.host);
  const originAllowed = (req) => allowedHosts().some((h) => req.headers.origin === `http://${h}`);

  const server = createHttpServer(async (req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    // Иконата е в самата страница; браузърът пак пита тук.
    if (req.url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    let file;
    try {
      file = resolveStatic(new URL(req.url, 'http://x').pathname);
    } catch {
      file = null;
    }
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let path = null;
    try {
      path = new URL(req.url, 'http://x').pathname;
    } catch { /* счупен адрес — отказ по-долу */ }
    if (path !== '/ws' || !hostAllowed(req) || !originAllowed(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => link.attach(ws));
  });

  return {
    relay, host, link,
    async listen() {
      await link.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      boundPort = server.address().port;
      return boundPort;
    },
    async close() {
      host.setActive(false);
      relay.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
