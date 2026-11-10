import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existingNames, worktreeNameHint } from '../public/worktree-name.js';

test('добро име няма подсказка; интервалите около него не пречат', () => {
  assert.equal(worktreeNameHint('feature/x-1'), null);
  assert.equal(worktreeNameHint('  fix-bug  '), null);
  assert.equal(worktreeNameHint('поправка'), null);
});

test('празно име и интервали вътре', () => {
  assert.equal(worktreeNameHint(''), 'Напиши име на branch');
  assert.equal(worktreeNameHint('   '), 'Напиши име на branch');
  assert.equal(worktreeNameHint('a b'), 'Без интервали в името');
  assert.equal(worktreeNameHint('a\tb'), 'Без интервали в името');
});

test('правилата на git, които се проверяват тук', () => {
  assert.match(worktreeNameHint('-x'), /„-“/);
  assert.match(worktreeNameHint('a..b'), /„\.\.“/);
  for (const bad of ['a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b']) assert.match(worktreeNameHint(bad), /Без знаците/, bad);
  assert.match(worktreeNameHint('a/'), /завършва/);
  assert.match(worktreeNameHint('a.lock'), /завършва/);
});

test('над 200 байта UTF-8; кирилицата е по 2 байта', () => {
  assert.equal(worktreeNameHint('a'.repeat(200)), null);
  assert.match(worktreeNameHint('a'.repeat(201)), /200 байта/);
  assert.match(worktreeNameHint('я'.repeat(101)), /200 байта/);
});

test('съществуващо име или branch, без значение от главни букви', () => {
  assert.match(worktreeNameHint('Feature-X', ['feature-x']), /Вече има/);
  assert.equal(worktreeNameHint('feature-y', ['feature-x']), null);
});

test('имената са от пълния списък на repository-то', () => {
  const list = { repos: [{ id: 'r1', worktrees: [{ name: 'main', branch: 'main' }, { name: 'wt', branch: 'feat/wt' }] }, { id: 'r2', worktrees: [{ name: 'other' }] }] };
  assert.deepEqual(existingNames(list, 'r1'), ['main', 'main', 'wt', 'feat/wt']);
  assert.deepEqual(existingNames(list, 'nope'), []);
  assert.deepEqual(existingNames(null, 'r1'), []);
});
