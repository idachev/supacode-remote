// `node web/attach.mjs [таб]` — един отдалечен таб на Mac-а в текущия терминал (етап 1, проба).
//
// Пуска се в таб на локалния Supacode (Ghostty) или друг терминал. Ghostty на лаптопа рисува и
// кодира клавишите, мишката и paste; процесът само носи байтовете. Ключът и избраният Mac са
// тези на уеб app-а (`~/.config/supacode-remote-web/config.json`); всеки процес има своя връзка,
// затова няколко таба вървят едновременно, а браузърът не се засяга.
//
// `Ctrl+]` и после `r`: размерът на таба на Mac-а по този прозорец. `Ctrl+]` и после `q`: изход.
// Логът е в `attach.log` до config-а: stdout е самият терминал.

import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AttachSession } from './src/attach-session.mjs';
import { findTab, listTabs } from './src/attach-tabs.mjs';
import { ConfigStore, defaultConfigDir } from './src/config-store.mjs';
import { HostController } from './src/host-controller.mjs';
import { createLogger } from './src/log.mjs';
import { parseConnectionKey } from './src/protocol.mjs';
import { RelayClient } from './src/relay-client.mjs';

const LIST_TIMEOUT_MS = 20_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Първият `list` от Mac-а, или `null` след таймаута (Mac извън линия, грешен ключ). */
function firstList(host) {
  if (host.lastList) return Promise.resolve(host.lastList);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { host.off('message', onMessage); resolve(null); }, LIST_TIMEOUT_MS);
    const onMessage = (message) => {
      if (message.t !== 'list') return;
      clearTimeout(timer);
      host.off('message', onMessage);
      resolve(message);
    };
    host.on('message', onMessage);
  });
}

/** Таб по аргумента или по номер от номерирания списък (преди stdin да мине в raw режим). */
async function chooseTab(tabs, query) {
  if (query) {
    const found = findTab(tabs, query);
    if (found.error) fail(found.error);
    return found.tab;
  }
  if (tabs.length === 0) fail('На Mac-а няма отворени табове.');
  tabs.forEach((tab, i) => process.stderr.write(`${String(i + 1).padStart(3)}  ${tab.label}\n`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('Таб № ');
  rl.close();
  const index = Number.parseInt(answer, 10) - 1;
  if (!(index >= 0 && index < tabs.length)) fail('Няма такъв номер.');
  return tabs[index];
}

/** Съобщението при изход; `q` е изричен изход и не казва нищо. */
function exitText(reason, message) {
  if (reason === 'quit') return null;
  if (reason === 'error') return `Mac-ът отказа: ${message}`;
  return `Табът приключи (${reason}).`;
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('attach иска терминал (stdin и stdout).');
  const config = await new ConfigStore().load();
  const settings = config.connectionKey ? parseConnectionKey(config.connectionKey) : null;
  if (!settings) fail('Няма ключ за връзка. Настрой уеб app-а (web/run.sh) и пробвай пак.');

  const logFile = createWriteStream(join(defaultConfigDir(), 'attach.log'), { flags: 'a', mode: 0o600 });
  // Логът не бива да спира процеса (пълен диск): без слушател грешката би била uncaught.
  logFile.on('error', () => {});
  const log = createLogger({ write: (line) => logFile.write(`${line}\n`) });
  log.info('attach.started', { pid: process.pid });

  const relay = new RelayClient({ log });
  const host = new HostController(relay);
  relay.configure(settings, config.selectedHostId);
  host.setActive(true);
  process.stderr.write('Свързване с Mac-а…\n');
  const list = await firstList(host);
  if (!list) {
    relay.stop();
    fail('Mac-ът не отговори.');
  }
  const tab = await chooseTab(listTabs(list), process.argv[2]);

  const session = new AttachSession({
    host,
    contentId: tab.contentId,
    write: (buf) => process.stdout.write(buf),
    localSize: () => ({ cols: process.stdout.columns, rows: process.stdout.rows }),
    log,
  });

  let stopping = false;
  const shutdown = (code, message) => {
    if (stopping) return;
    stopping = true;
    session.stop();
    process.stdin.setRawMode(false);
    log.info('attach.stopped', { pid: process.pid, code });
    // Затворен локален таб: stdout може никога да не извика callback-а.
    setTimeout(() => process.exit(code), 1_000);
    // Празният запис извиква callback-а след всичко писано преди него (RESTORE). После
    // връзката се затваря (ws праща чакащия `detach` преди close кадъра) и процесът излиза.
    process.stdout.write('', () => {
      relay.stop();
      if (message) process.stderr.write(`${message}\n`);
      setTimeout(() => process.exit(code), 100);
    });
  };
  // Неочаквана грешка след raw режима: терминалът първо се връща, после изход с код 1.
  process.on('uncaughtException', (err) => {
    log.error('attach.crashed', { error: err });
    shutdown(1, `attach: ${err?.message ?? err}`);
  });

  session.on('exit', ({ code, reason, message }) => shutdown(code, exitText(reason, message)));
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(0, null));
  process.stdout.on('resize', () => session.localResized());

  process.stdin.setRawMode(true);
  process.stdin.on('data', (bytes) => session.input(bytes));
  process.stdin.resume();
  session.start();
  log.info('attach.opened', { pid: process.pid });
}

main().catch((err) => fail(`attach: ${err?.message ?? err}`));
