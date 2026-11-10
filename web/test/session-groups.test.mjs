// Общите модули на страницата (`public/`), пускани в Node: търсенето и редовете на „Сесии“.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedErrors, fuzzyMatches } from '../public/fuzzy-match.js';
import { findTab, sessionRows, worktreeOrder } from '../public/session-groups.js';

test('грешките растат с дължината на търсеното', () => {
  assert.deepEqual(['abc', 'abcd', 'abcde', 'abcdef'].map(allowedErrors), [0, 1, 1, 2]);
});

test('търсене с грешки, размяна и кирилица', () => {
  assert.equal(fuzzyMatches('supacode', 'code'), true);
  assert.equal(fuzzyMatches('supacode', 'sup'), true);
  assert.equal(fuzzyMatches('supacode', 'spa'), false);
  assert.equal(fuzzyMatches('remote-access', 'remtoe'), true);
  assert.equal(fuzzyMatches('remote-access', 'rmote'), true);
  assert.equal(fuzzyMatches('remote-access', 'zzzzzz'), false);
  assert.equal(fuzzyMatches('Работа', 'работ'), true);
});

const wt = (id, status, extra = {}) => ({ id, name: id, branch: id, status, tabs: [], ...extra });
const repos = [
  { id: 'r1', name: 'supacode', rowIds: ['w-main', 'w-x'], worktrees: [wt('w-main', 'main'), wt('w-pin', 'pinned'), wt('w-x', 'unpinned'), wt('w-act', 'unpinned')] },
  { id: 'r2', name: 'shop', group: 'Work', rowIds: ['s-main'], worktrees: [wt('s-main', 'main', { tabs: [{ id: 't', contentId: 'c-shop' }] })] },
];
const sections = [
  { kind: 'active', title: 'Active', worktreeIds: ['w-act'] },
  { kind: 'pinned', title: 'Pinned', worktreeIds: ['w-pin'] },
  { kind: 'mystery', title: '?' },
  { kind: 'group', title: 'Work', collapsed: true, repositoryIds: ['r2'] },
  { kind: 'repository', repositoryId: 'r1' },
];
const shape = (rows) => rows.map((r) => (r.kind === 'worktree' ? `wt:${r.worktree.id}` : r.kind === 'repository' ? `repo:${r.repository.id}` : `${r.kind}:${r.title ?? r.status}${r.collapsed ? '+' : ''}`));

test('секциите са sidebar-ът на Supacode, непознат kind се прескача', () => {
  assert.deepEqual(shape(sessionRows({ repos, sections })), [
    'section:Active', 'wt:w-act', 'section:Pinned', 'wt:w-pin', 'group:Work+', 'repo:r1', 'wt:w-main', 'wt:w-x',
  ]);
  const active = sessionRows({ repos, sections })[1];
  assert.equal(active.repositoryName, 'supacode');
});

test('изборът в браузъра разгъва групата', () => {
  assert.deepEqual(shape(sessionRows({ repos, sections }, { '3:Work': false })).slice(4, 7), ['group:Work', 'repo:r2', 'wt:s-main']);
});

test('търсенето разгъва групата с намерено и маха останалото', () => {
  assert.deepEqual(shape(sessionRows({ repos, sections }, {}, 'shop')), ['group:Work', 'repo:r2', 'wt:s-main']);
  assert.deepEqual(shape(sessionRows({ repos, sections }, {}, 'w-pin')), ['section:Pinned', 'wt:w-pin']);
});

test('без sections — групи по group и основен, закачени, активни', () => {
  const old = repos.map(({ rowIds, ...r }) => r);
  old[0].worktrees.push(wt('w-odd', 'archived?'));
  assert.deepEqual(shape(sessionRows({ repos: old })), [
    'repo:r1', 'wt:w-main', 'status:pinned', 'wt:w-pin', 'status:unpinned', 'wt:w-x', 'wt:w-act', 'wt:w-odd',
    'group:Work', 'repo:r2', 'wt:s-main',
  ]);
});

test('редът на worktree-тата е без повторения, а табът се намира по contentId', () => {
  assert.deepEqual(worktreeOrder(sessionRows({ repos, sections })).map((r) => r.worktree.id), ['w-act', 'w-pin', 'w-main', 'w-x']);
  assert.equal(findTab({ repos }, 'c-shop').worktree.id, 's-main');
  assert.equal(findTab({ repos }, 'nope'), null);
});
