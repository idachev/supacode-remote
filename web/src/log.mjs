// Логът на локалния сървър: един JSON обект на ред в stdout.
//
//   {"timestamp":"…","severity":"INFO","event":"relay.state","message":"relay state, connection: connected, path: lan","connection":"connected","path":"lan"}
//
// `message` е четимият ред (общ форматер с браузъра), а полетата са и отделно, с типовете си.
// Никога не се логват ключът за връзка и имена на Mac-ове; адресът на relay-а не се логва нарочно
// (текст на мрежова грешка в `reason` може да го съдържа — логът е само локален). Логват се id-та,
// състояния и броеве. Нивото идва от `LOG_LEVEL` (debug, info, warn, error; по подразбиране info).

import { formatMessage } from '../public/log-format.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

/** Error става две полета; стекът е последен, за да не скрива по-важното. */
function jsonFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) Object.assign(out, jsonField(key, value));
  return out;
}

function jsonField(key, value) {
  if (!(value instanceof Error)) return { [key]: typeof value === 'bigint' ? `${value}n` : value };
  return value.stack ? { error_type: value.name, [key]: value.message, stack: value.stack } : { error_type: value.name, [key]: value.message };
}

function record(level, event, fields) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    severity: SEVERITY[level],
    event,
    message: formatMessage(event, fields),
    ...jsonFields(fields),
  });
}

/**
 * `write` е мястото, където отива редът (stdout; в тестовете — масив). Грешка при форматиране
 * или писане не стига до извикващия: логът не бива да чупи сървъра.
 */
export function createLogger({ level = process.env.LOG_LEVEL || 'info', write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, event, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    try {
      write(record(lvl, event, fields));
    } catch {
      try {
        write(JSON.stringify({ timestamp: new Date().toISOString(), severity: 'ERROR', event: 'log.failed', message: 'log failed', failed_event: event }));
      } catch { /* няма къде да се пише */ }
    }
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

/** Логър, който не пише нищо — по подразбиране в модулите, за да не пълнят изхода на тестовете. */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
