// Една LAN връзка към Mac-а (`wss://<addr>:<port>/lan`), пренесена от `LanSession.kt`.
//
// Ключът тръгва в заявката за upgrade, затова сертификатът трябва да е проверен **преди**
// тя да тръгне. `ws` пита своя `https.Agent` за сокет; нашият Agent прави TLS 1.3 сам и
// дава сокета чак след `secureConnect` и съвпадащ отпечатък. Чужд сертификат не получава
// нито байт от HTTP заявката.

import https from 'node:https';
import tls from 'node:tls';
import WebSocket from 'ws';
import { fpMacValid, pinMatches } from './lan-trust.mjs';

export const LAN_CONNECT_TIMEOUT_MS = 2_500;

class PinnedAgent extends https.Agent {
  constructor(fp, timeoutMs) {
    // Без keep-alive и без общи сокети: всяка връзка минава проверката сама.
    super({ keepAlive: false, maxCachedSessions: 0 });
    this.fp = fp;
    this.timeoutMs = timeoutMs;
  }

  createConnection(options, callback) {
    let done = false;
    const finish = (err, socket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callback(err, socket);
    };
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      // Сертификатът е самоподписан и името е IP: доверието е само в отпечатъка по-долу.
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error('LAN: няма отговор'));
    }, this.timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert?.raw || !pinMatches(cert.raw, this.fp)) {
        socket.destroy();
        finish(new Error('LAN: сертификатът не е този на Mac-а'));
        return;
      }
      finish(null, socket);
    });
    socket.once('error', (err) => finish(err));
    // undefined: http ще чака callback-а (асинхронно създаване на сокета).
    return undefined;
  }
}

/** Отворена LAN връзка. След upgrade-а съобщенията са същият текст като по relay-а. */
export class LanSession {
  constructor(ws, address) {
    this.ws = ws;
    this.address = address;
    this.closed = false;
  }

  send(text) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  close() {
    this.closed = true;
    try { this.ws.close(1000); } catch { /* вече е затворена */ }
  }

  /** Веднага, без да чака другата страна — за мълчаща връзка. */
  cancel() {
    this.closed = true;
    this.ws.terminate();
  }
}

function connectOne(addr, port, clientKey, agent, timeoutMs, { onText, onClose }) {
  return new Promise((resolve) => {
    let session = null;
    let settled = false;
    const ws = new WebSocket(`wss://${addr}:${port}/lan`, {
      agent,
      headers: { Authorization: `Bearer ${clientKey}` },
      handshakeTimeout: timeoutMs * 2,
      perMessageDeflate: false,
    });
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ws.on('open', () => {
      session = new LanSession(ws, addr);
      settle(session);
    });
    ws.on('message', (data, isBinary) => {
      if (session && !isBinary) onText?.(session, data.toString('utf8'));
    });
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
    });
    ws.on('error', () => { /* close идва след error */ });
    ws.on('close', (code) => {
      settle(null);
      if (session && !session.closed) {
        session.closed = true;
        onClose?.(session, `затворена (${code})`);
      }
    });
  });
}

/**
 * Пробва адресите един по един. `null`, ако `fpMac` не е от някой, който знае ключа (тогава
 * не се пробва нищо), или ако никой адрес не мине TLS и upgrade-а.
 */
export async function connectLan(info, clientKey, { timeoutMs = LAN_CONNECT_TIMEOUT_MS, onText, onClose } = {}) {
  if (!info?.fp || !fpMacValid(clientKey, info.fp, info.fpMac)) return null;
  const agent = new PinnedAgent(info.fp, timeoutMs);
  for (const addr of info.addrs ?? []) {
    const session = await connectOne(addr, info.port, clientKey, agent, timeoutMs, { onText, onClose });
    if (session) return session;
  }
  return null;
}
