// Суров WebSocket клиент към mock-а, без `RelayClient`: тестовете на mock-а проверяват самите кадри.
import WebSocket from 'ws';
import { waitFor } from './mock.mjs';

let nextId = 100;

/** Ново id за заявка, общо за всички клиенти в процеса. */
export const takeId = () => nextId++;

/** Свързва се с mock-а (по избор към `?host=`) и чака `relay` с `hostOnline:true`. */
export async function connect(target, hostId = null) {
  const query = hostId ? `?host=${hostId}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}/client${query}`, { headers: { Authorization: `Bearer ${target.key}` } });
  const frames = [];
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())); } catch { /* ping/pong */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await waitFor(() => frames.some((f) => f.t === 'relay' && f.hostOnline), 'relay hostOnline');
  const client = {
    ws, frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Праща заявка с ново id и чака отговора с това id (или `error`). */
    async request(msg) {
      const id = takeId();
      client.send({ ...msg, id });
      await waitFor(() => frames.some((f) => f.id === id), `отговор на ${msg.t}`);
      return frames.find((f) => f.id === id);
    },
    framesAfter: (mark) => frames.slice(mark),
    close: () => ws.close(),
  };
  return client;
}

export const allWorktrees = (list) => list.repos.flatMap((r) => r.worktrees);
export const worktreeOf = (list, worktreeId) => allWorktrees(list).find((w) => w.id === worktreeId);
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
