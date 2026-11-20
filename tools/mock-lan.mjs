// LAN endpoint-ът на mock-а:
//
// wss://127.0.0.1:LAN_PORT/lan с TLS 1.3 и самоподписан сертификат, създаден в паметта при
// всяко пускане (пакетът `selfsigned`; нищо не се пише на диска). `fp` е SHA-256 на DER
// байтовете на сертификата, `fpMac` — HMAC-SHA256 с клиентския ключ върху
// "supacode-lan-fp-v1:" + fp. След upgrade-а съобщенията са същият текст като по relay-а.

import crypto from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import selfsigned from 'selfsigned';
import { WebSocketServer } from 'ws';
import { authorized, clients, rejectUpgrade } from './mock-clients.mjs';
import { KEY, LAN_ADDRS, LAN_AT_START, LAN_PORT } from './mock-config.mjs';
import { log } from './mock-log.mjs';

const lanIdentity = selfsigned.generate([{ name: 'commonName', value: 'supacode-mock-lan' }], {
  keySize: 2048, days: 3650, algorithm: 'sha256',
});
const LAN_FP = crypto.createHash('sha256').update(new crypto.X509Certificate(lanIdentity.cert).raw).digest('hex');
const LAN_FP_MAC = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8')).update('supacode-lan-fp-v1:' + LAN_FP).digest('hex');
/** Новите LAN връзки идват като `connection` събитие тук; приема ги mock-host.mjs. */
export const lanWss = new WebSocketServer({ noServer: true });
let lanServer = null;
let lanOn = LAN_AT_START;

/** `lan` в `hello`, докато endpoint-ът работи; иначе `null`. */
export const lanOffer = () => (lanOn ? { addrs: LAN_ADDRS, port: LAN_PORT, fp: LAN_FP, fpMac: LAN_FP_MAC } : null);

function startLan() {
  lanServer = createHttpsServer({
    key: lanIdentity.private, cert: lanIdentity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
  }, (req, res) => res.writeHead(404).end('not found'));
  lanServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'https://x').pathname !== '/lan') return rejectUpgrade(socket, 404);
    if (!authorized(req, 'lan')) return rejectUpgrade(socket, 401);
    lanWss.handleUpgrade(req, socket, head, (ws) => lanWss.emit('connection', ws));
  });
  lanServer.listen(LAN_PORT, '127.0.0.1', () => log('lan endpoint listening', {
    url: `wss://127.0.0.1:${LAN_PORT}/lan`, addrs: LAN_ADDRS.join(','), fp: LAN_FP,
  }));
}

export function setLan(on) {
  if (on === lanOn) return;
  lanOn = on;
  log('lan endpoint switched', { on });
  if (on) {
    startLan();
  } else {
    for (const c of clients) if (c.lan) c.ws.terminate();
    lanServer?.close();
    lanServer = null;
  }
}

/** Пуска endpoint-а при старт, ако не е изключен с LAN=0. */
export function startLanAtBoot() {
  if (lanOn) startLan();
}
