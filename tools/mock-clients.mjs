// Връзките към mock-а (по relay-а и по LAN): кой може да влезе, кои са свързани и как им се праща.

import { KEY } from './mock-config.mjs';
import { log } from './mock-log.mjs';

/** Всички свързани клиенти; `c.hostId` е Mac-ът, към който е вързан (`null` — несвързан). */
export const clients = new Set();

export function send(c, msg) {
  c.sendText(JSON.stringify(msg));
}

/** Клиентите, вързани към Mac-а и закачени за този таб. */
export function attachedClients(host, contentId) {
  return [...clients].filter((c) => c.hostId === host.id && c.attachments.has(contentId));
}

export const replyUnknownType = (c, msg) => send(c, { t: 'error', id: msg.id ?? null, message: `unknown message type: ${msg.t}` });

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found' };

export function rejectUpgrade(socket, status, body = '') {
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function authorized(req, endpoint) {
  if (req.headers.authorization === `Bearer ${KEY}`) return true;
  log('upgrade rejected', { endpoint, status: 401, remote: req.socket.remoteAddress });
  return false;
}
