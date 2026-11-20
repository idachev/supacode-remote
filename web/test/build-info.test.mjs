// Кой код върти уеб app-ът (УА14): SHA на checkout-а при пускане, за „Настройка“ и лога.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBuildInfo } from '../src/build-info.mjs';

const startedAt = new Date('2026-11-20T05:04:23Z');

/** Фалшив `git`: отговорите по първия аргумент след `git`. */
const git = (answers) => (_cmd, args) => {
  const answer = answers[args[0]];
  if (answer instanceof Error) throw answer;
  return answer;
};

test('SHA и чисто дърво', () => {
  const info = readBuildInfo({ cwd: '/x', exec: git({ 'rev-parse': 'abc1234\n', status: '' }), now: startedAt });
  assert.deepEqual(info, { sha: 'abc1234', dirty: false, startedAt: '2026-11-20T05:04:23.000Z' });
});

test('промени в проследените файлове се казват', () => {
  const info = readBuildInfo({ cwd: '/x', exec: git({ 'rev-parse': 'abc1234\n', status: ' M web/src/x.mjs\n' }), now: startedAt });
  assert.equal(info.dirty, true);
});

test('без git SHA няма, а сървърът пак тръгва', () => {
  const info = readBuildInfo({ cwd: '/x', exec: git({ 'rev-parse': new Error('not a git repository'), status: new Error('x') }), now: startedAt });
  assert.deepEqual(info, { sha: null, dirty: false, startedAt: '2026-11-20T05:04:23.000Z' });
});
