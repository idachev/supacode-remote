// Мостът между xterm.js и приложението.
//
// Kotlin вика supa.init / write / resize / scrollPages / scrollToBottom; страницата вика
// SupaBridge.ready().
//
// Размерът на терминала е винаги този на Mac-а (cols × rows от `attached` и `size`).
// Страницата никога не го сменя сама: вместо това подбира шрифта така, че всички колони
// да влязат в ширината на екрана. Zoom-ът с два пръста е zoom на страницата.
(function () {
  'use strict';

  var BASE_FONT = 14;
  var bridge = window.SupaBridge || { ready: function () {} };

  var term = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 5000,
    fontFamily: 'monospace',
    fontSize: BASE_FONT,
    lineHeight: 1.0,
    letterSpacing: 0,
    cursorBlink: false,
    allowProposedApi: false,
    disableStdin: true,
    // Mac-ът праща сурови VT байтове; `\n` си е `\n`.
    convertEol: false,
    minimumContrastRatio: 1,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
      selectionBackground: '#264f78',
    },
  });
  term.open(document.getElementById('term'));

  // ---- Без писане направо в терминала ----
  //
  // Писането с клавиатурата на телефона в xterm.js (onData) беше проверено в emulator-а и
  // не е надеждно: Android IME-ът праща composition събития и буквите идват по два пъти
  // („echchho“). Освен това xterm.js сам отговаря на въпросите на програмата (DA, позиция
  // на курсора) — втори отговор след този на Ghostty би влязъл в PTY-то като текст.
  // Затова единственият път за писане е полето под терминала; тук клавиатурата не се
  // отваря и onData не се чете.
  term.textarea.setAttribute('readonly', 'readonly');
  term.textarea.setAttribute('inputmode', 'none');

  // ---- Шрифтът, при който cols колони влизат точно в ширината ----
  function screenWidth() {
    var screen = term.element.querySelector('.xterm-screen');
    return screen ? screen.getBoundingClientRect().width : 0;
  }

  function fit() {
    var avail = document.documentElement.clientWidth;
    if (!avail) return;
    var size = term.options.fontSize;
    for (var i = 0; i < 4; i++) {
      var w = screenWidth();
      if (!w) break;
      var next = size * avail / w;
      // Клетките се закръглят, затова няколко крачки и накрая малко по-малко, а не повече.
      if (Math.abs(next - size) < 0.01) break;
      size = next;
      term.options.fontSize = size;
    }
    while (screenWidth() > avail && size > 2) {
      size -= 0.1;
      term.options.fontSize = size;
    }
  }

  function decode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  window.supa = {
    /** Нов attach: празен терминал с точния размер на Mac-а. */
    init: function (cols, rows) {
      term.reset();
      term.resize(cols, rows);
      fit();
    },
    write: function (b64) {
      term.write(decode(b64));
    },
    resize: function (cols, rows) {
      term.resize(cols, rows);
      fit();
    },
    /** Историята на xterm.js (scrollback); програмата в PTY-то не разбира. */
    scrollPages: function (pages) {
      term.scrollPages(pages);
    },
    scrollToBottom: function () {
      term.scrollToBottom();
    },
  };

  window.addEventListener('resize', fit);
  fit();
  bridge.ready();
})();
