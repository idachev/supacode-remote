// УА2: известие на браузъра „агент чака вход“. Както в Android: изключено по подразбиране,
// известие само при преход и само когато потребителят не гледа страницата. Работи, докато
// страницата е отворена в някой таб на браузъра: списъкът идва през нея.

import { AwaitingTracker } from './awaiting-tracker.js';
import { $, readJson, toast, writeStorage } from './dom.js';

export const NOTIFY_KEY = 'supacode-web.notifyAwaiting';

const tracker = new AwaitingTracker();
let openTab = () => {};

const supported = () => typeof Notification !== 'undefined';

function enabled() {
  return supported() && readJson(NOTIFY_KEY, false) === true && Notification.permission === 'granted';
}

export function initNotifyView({ onOpen }) {
  openTab = onOpen;
  $('setup-notify').addEventListener('change', onToggle);
}

/** Превключвателят показва дали известията наистина вървят: разрешението може да е отнето. */
export function syncNotifySetting() {
  $('setup-notify').disabled = !supported();
  $('setup-notify').checked = enabled();
}

/** Разрешението се иска при щракването: браузърът го дава само при действие на потребителя. */
async function onToggle(e) {
  const box = e.target;
  if (box.checked && Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    box.checked = false;
    toast('Браузърът не разреши известия');
  }
  writeStorage(NOTIFY_KEY, box.checked);
}

/** Всеки нов списък: преходът се запомня винаги, а известие има само ако не гледаш страницата. */
export function notifyAwaiting(list) {
  const fresh = tracker.update(list);
  if (!fresh.length || !enabled() || userSees()) return;
  fresh.forEach(show);
}

/** Нов Mac или ключ: табовете, които вече чакат там, не са нови. */
export function resetAwaiting() {
  tracker.reset();
}

function userSees() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function show({ contentId, title }) {
  const note = new Notification('Агент чака вход', { body: title, tag: contentId });
  note.onclick = () => {
    window.focus();
    openTab(contentId);
    note.close();
  };
}
