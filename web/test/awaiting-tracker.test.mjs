// УА2: кои табове току-що започнаха да чакат вход — само те дават известие.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwaitingTracker } from '../public/awaiting-tracker.js';

const tab = (contentId, activity, title = 'claude') => ({ contentId, title, agents: activity ? [{ activity }] : [] });
const list = (...tabs) => ({ repos: [{ name: 'supacode', worktrees: [{ name: 'main', tabs }] }] });

test('първият списък само запомня: табовете, които вече чакат, не дават известие', () => {
  const tracker = new AwaitingTracker();
  assert.deepEqual(tracker.update(list(tab('a', 'awaitingInput'), tab('b', 'busy'))), []);
});

test('преход към „чака вход“ дава таба веднъж, с repo, worktree и заглавие', () => {
  const tracker = new AwaitingTracker();
  tracker.update(list(tab('a', 'busy')));
  const [found] = tracker.update(list(tab('a', 'awaitingInput')));
  assert.equal(found.contentId, 'a');
  assert.equal(found.title, 'supacode · main · claude');
  assert.deepEqual(tracker.update(list(tab('a', 'awaitingInput'))), []);
});

test('след работа агентът пак чака — пак известие; нов таб, който чака, също', () => {
  const tracker = new AwaitingTracker();
  tracker.update(list(tab('a', 'awaitingInput')));
  tracker.update(list(tab('a', 'busy')));
  assert.deepEqual(tracker.update(list(tab('a', 'awaitingInput'), tab('n', 'awaitingInput'))).map((t) => t.contentId), ['a', 'n']);
});

test('reset (нов Mac или ключ): следващият списък пак само запомня', () => {
  const tracker = new AwaitingTracker();
  tracker.update(list(tab('a', 'busy')));
  tracker.reset();
  assert.deepEqual(tracker.update(list(tab('a', 'awaitingInput'))), []);
});
