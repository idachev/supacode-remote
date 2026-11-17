import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTab, listTabs } from '../src/attach-tabs.mjs';

const list = {
  repos: [{
    name: 'app',
    worktrees: [
      { name: 'main', tabs: [{ contentId: 'c1', title: 'claude' }, { contentId: 'c2' }] },
      { name: 'feat', tabs: [{ contentId: 'c3', title: 'vim' }] },
    ],
  }],
};

test('табовете са в реда на list с етикет repo / worktree / заглавие', () => assert.deepEqual(listTabs(list), [
  { contentId: 'c1', label: 'app / main / claude' },
  { contentId: 'c2', label: 'app / main / таб' },
  { contentId: 'c3', label: 'app / feat / vim' },
]));
test('счупен list дава празен списък', () => {
  assert.deepEqual(listTabs({ repos: [{ worktrees: [{ tabs: [{}] }] }] }), []);
  assert.deepEqual(listTabs({ repos: 'x' }), []);
  assert.deepEqual(listTabs(null), []);
});
test('намира по contentId', () => assert.equal(findTab(listTabs(list), 'c3').tab.contentId, 'c3'));
test('намира по част от етикета, без значение на главни букви', () => assert.equal(findTab(listTabs(list), 'CLAUDE').tab.contentId, 'c1'));
test('нула съвпадения е грешка', () => assert.equal(findTab(listTabs(list), 'nope').error, 'Няма таб „nope“'));
test('няколко съвпадения е грешка', () => assert.equal(findTab(listTabs(list), 'app').error, '„app“ съвпада с 3 таба'));
