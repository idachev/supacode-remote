// Една LAN връзка към Mac-а (`wss://<addr>:<port>/lan`), пренесена от `LanSession.kt`.
//
// Ключът тръгва в заявката за upgrade, затова сертификатът трябва да е проверен **преди**
// тя да тръгне. `ws` пита своя `https.Agent` за сокет; нашият Agent прави TLS 1.3 сам и
// дава сокета чак след `secureConnect` и съвпадащ отпечатък. Чужд сертификат не получава
// нито байт от HTTP заявката.

import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import { fpMacValid, pinMatches } from './lan-trust.mjs';

export const LAN_CONNECT_TIMEOUT_MS = 2_500;

/**
 * TLS 1.3 сокет към Mac-а, даден чак след `secureConnect` и съвпадащ отпечатък. Сертификатът е
 * самоподписан и името е IP: доверието е само в отпечатъка.
 */
function pinnedTlsSocket({ host, port }, fp, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('LAN: няма отговор')), timeoutMs);
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(false);
      if (!cert?.raw || !pinMatches(cert.raw, fp)) return fail(new Error('LAN: сертификатът не е този на Mac-а'));
      clearTimeout(timer);
      socket.off('error', fail);
      resolve(socket);
    });
  });
}

class PinnedAgent extends https.Agent {
  constructor(fp, timeoutMs) {
    // Без keep-alive и без общи сокети: всяка връзка минава проверката сама.
    super({ keepAlive: false, maxCachedSessions: 0 });
    this.fp = fp;
    this.timeoutMs = timeoutMs;
  }

  /** `undefined`: http чака callback-а, т.е. заявката с ключа тръгва чак след проверката. */
  createConnection(options, callback) {
    pinnedTlsSocket(options, this.fp, this.timeoutMs).then((socket) => callback(null, socket), (err) => callback(err));
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

/** WebSocket към един адрес; `null`, ако адресът е невалиден (тогава `new WebSocket` хвърля). */
function openLanSocket({ addr, port, clientKey, agent, timeoutMs }) {
  try {
    return new WebSocket(`wss://${addr}:${port}/lan`, {
      agent,
      headers: { Authorization: `Bearer ${clientKey}` },
      handshakeTimeout: timeoutMs * 2,
      perMessageDeflate: false,
    });
  } catch {
    return null;
  }
}

/** Отворената сесия или `null`; след отварянето подава текста и затварянето нататък. */
function sessionFrom(ws, addr, { onText, onClose }) {
  return new Promise((resolve) => {
    let session = null;
    ws.on('open', () => {
      session = new LanSession(ws, addr);
      resolve(session);
    });
    ws.on('message', (data, isBinary) => {
      if (session && !isBinary) onText?.(session, data.toString('utf8'));
    });
    endOnFailure(ws);
    ws.on('close', (code) => {
      resolve(null);
      ended(session, code, onClose);
    });
  });
}

/** Отказ при upgrade (напр. 401) и грешка завършват с `close`, където се решава всичко. */
function endOnFailure(ws) {
  ws.on('unexpected-response', (_req, res) => {
    res.resume();
    ws.terminate();
  });
  ws.on('error', () => {});
}

/** Отворена сесия, която падне, казва го веднъж. */
function ended(session, code, onClose) {
  if (!session || session.closed) return;
  session.closed = true;
  onClose?.(session, `затворена (${code})`);
}

function connectOne(target, callbacks) {
  const ws = openLanSocket(target);
  return ws ? sessionFrom(ws, target.addr, callbacks) : Promise.resolve(null);
}

/** fpMac пази само отпечатъка, не адресите и порта: relay-ят може да ги смени. */
function validTargets(info) {
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) return [];
  return (info.addrs ?? []).filter((addr) => net.isIP(addr) !== 0);
}

/**
 * Пробва адресите един по един. `null`, ако `fpMac` не е от някой, който знае ключа (тогава
 * не се пробва нищо), или ако никой адрес не мине TLS и upgrade-а.
 */
export async function connectLan(info, clientKey, { timeoutMs = LAN_CONNECT_TIMEOUT_MS, onText, onClose } = {}) {
  if (!info?.fp || !fpMacValid(clientKey, info.fp, info.fpMac)) return null;
  const agent = new PinnedAgent(info.fp, timeoutMs);
  for (const addr of validTargets(info)) {
    const session = await connectOne({ addr, port: info.port, clientKey, agent, timeoutMs }, { onText, onClose });
    if (session) return session;
  }
  return null;
}
