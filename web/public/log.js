// Конзолата на браузъра: един четим ред на запис, без JSON и без време отпред.
//
//   log.error('link.bad_message', { error }) → link bad message, error: 'Unexpected token'

import { formatMessage } from './log-format.js';

function emit(method, event, fields) {
  try {
    console[method](formatMessage(event, fields));
  } catch {
    // Логът не бива да чупи страницата.
  }
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
