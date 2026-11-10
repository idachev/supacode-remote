// „Размер по този екран“: какво вижда потребителят след натискането (иначе нищо не се вижда).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESIZE_SILENT, resizeAskText, resizeFailedText, resizeReplyText, withHostApp } from '../public/resize-feedback.js';

test('същият размер не се праща: табът вече е такъв', () => {
  assert.deepEqual(resizeAskText({ cols: 122, rows: 47 }, { cols: 122, rows: 47 }), { send: false, text: 'Табът вече е 122 × 47' });
});

test('друг размер се праща и съобщението го казва', () => {
  assert.deepEqual(resizeAskText({ cols: 139, rows: 56 }, { cols: 122, rows: 47 }), { send: true, text: 'Пратено към Mac-а: 139 × 56…' });
});

test('отговорът `size`: поисканият или друг размер от Mac-а', () => {
  assert.equal(resizeReplyText({ cols: 139, rows: 56 }, { cols: 139, rows: 56 }), 'Mac-ът смени таба на 139 × 56');
  assert.equal(resizeReplyText({ cols: 600, rows: 56 }, { cols: 500, rows: 56 }), 'Mac-ът върна 500 × 56 (поискано 600 × 56)');
});

test('без отговор: казва защо може да е', () => {
  assert.match(RESIZE_SILENT, /не отговори/);
});

test('версията на Supacode на Mac-а се добавя към съобщението, ако Mac-ът я е казал', () => {
  assert.equal(withHostApp('Mac-ът не отговори', 'Supacode 0.11.5 (154)'), 'Mac-ът не отговори · Supacode 0.11.5 (154)');
  assert.equal(withHostApp('Mac-ът не отговори', null), 'Mac-ът не отговори');
});

test('отказ от Mac-а: причината от host-а, а без нея само че размерът не се е сменил', () => {
  assert.equal(resizeFailedText('terminal did not start'), 'Размерът не се смени: terminal did not start');
  assert.equal(resizeFailedText(''), 'Размерът не се смени');
});
