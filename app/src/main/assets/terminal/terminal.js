// Мостът между xterm.js и приложението.
//
// Kotlin вика supa.init / write / resize / scrollPages / scrollToBottom / copyText;
// selectStart / selectMove / selectEnd (от дългото натискане в Android); страницата вика
// SupaBridge.ready(), text(), copy() и overscroll().
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
    /**
     * Историята и екранът като обикновен текст, за да се маркира и копира в приложението
     * (докосването в xterm.js не маркира). Пренесените редове се слепват обратно в един.
     */
    copyText: function () {
      var buffer = term.buffer.active;
      var lines = [];
      for (var i = 0; i < buffer.length; i++) {
        var line = buffer.getLine(i);
        if (!line) continue;
        var text = line.translateToString(true);
        if (line.isWrapped && lines.length > 0) {
          lines[lines.length - 1] += text;
        } else {
          lines.push(text);
        }
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (bridge.text) bridge.text(lines.join('\n'));
    },
  };

  // ---- Докосване: маркиране (от Android) и скрол, който стига до програмата ----

  var OVERSCROLL_DEAD_PX = 40;
  var OVERSCROLL_EVERY_MS = 250;

  /** Клетката под пръста: колона и ред в буфера (с историята над екрана). */
  function cellAt(x, y) {
    var screen = term.element.querySelector('.xterm-screen');
    var rect = screen.getBoundingClientRect();
    var col = Math.floor((x - rect.left) / (rect.width / term.cols));
    var row = Math.floor((y - rect.top) / (rect.height / term.rows));
    col = Math.max(0, Math.min(term.cols - 1, col));
    row = Math.max(0, Math.min(term.rows - 1, row));
    return { col: col, row: row + term.buffer.active.viewportY };
  }

  function selectBetween(a, b) {
    var first = a, last = b;
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) { first = b; last = a; }
    var length = (last.row - first.row) * term.cols + (last.col - first.col) + 1;
    term.select(first.col, first.row, length);
  }

  // Плаващите бутони до маркираното: „Копирай“ и „×“.
  var actions = document.createElement('div');
  actions.id = 'select-actions';
  actions.innerHTML = '<button id="sel-copy">Копирай</button><button id="sel-cancel">×</button>';
  document.body.appendChild(actions);

  function hideActions() {
    actions.style.display = 'none';
  }

  function showActions(x, y) {
    actions.style.display = 'flex';
    var w = actions.offsetWidth, h = actions.offsetHeight;
    var left = Math.max(4, Math.min(document.documentElement.clientWidth - w - 4, x - w / 2));
    var top = y - h - 24 < 4 ? y + 24 : y - h - 24;
    actions.style.left = (left + window.scrollX) + 'px';
    actions.style.top = (top + window.scrollY) + 'px';
  }

  function clearSelection() {
    term.clearSelection();
    hideActions();
  }

  document.getElementById('sel-copy').addEventListener('click', function (e) {
    e.stopPropagation();
    var text = term.getSelection();
    if (text && bridge.copy) bridge.copy(text);
    clearSelection();
  });
  document.getElementById('sel-cancel').addEventListener('click', function (e) {
    e.stopPropagation();
    clearSelection();
  });

  // Маркирането идва от Android: дългото натискане се хваща там (GestureDetector), защото
  // Chromium прекъсва докосването на страницата (touchcancel), щом сам познае дълго
  // натискане. Координатите са пиксели на WebView-то; тук стават CSS точки на страницата.
  function clientPoint(x, y) {
    var vv = window.visualViewport;
    var scale = (vv ? vv.scale : 1) * window.devicePixelRatio;
    return { x: x / scale + (vv ? vv.offsetLeft : 0), y: y / scale + (vv ? vv.offsetTop : 0) };
  }

  var selectAnchor = null;

  window.supa.selectStart = function (x, y) {
    hideActions();
    var p = clientPoint(x, y);
    selectAnchor = cellAt(p.x, p.y);
    selectBetween(selectAnchor, selectAnchor);
  };
  window.supa.selectMove = function (x, y) {
    if (!selectAnchor) return;
    var p = clientPoint(x, y);
    selectBetween(selectAnchor, cellAt(p.x, p.y));
  };
  window.supa.selectEnd = function (x, y) {
    if (!selectAnchor) return;
    var p = clientPoint(x, y);
    selectBetween(selectAnchor, cellAt(p.x, p.y));
    selectAnchor = null;
    if (term.hasSelection()) showActions(p.x, p.y);
  };

  var touch = null; // { lastY, over, overDir }
  var lastOverscroll = 0;

  /**
   * Скрол отвъд ръба на историята на телефона: нагоре при най-стария ред (или без история —
   * напр. Claude Code на цял екран) праща PgUp към програмата, надолу при живия край — PgDn.
   * Мъртва зона, за да не стреля обикновен скрол, който само стига ръба, и пауза между
   * клавишите.
   */
  function trackOverscroll(dy) {
    var buffer = term.buffer.active;
    var atTop = buffer.viewportY <= 0;
    var atBottom = buffer.viewportY >= buffer.baseY;
    var dir = null;
    if (dy > 0 && atTop) dir = 'up';
    else if (dy < 0 && atBottom) dir = 'down';
    if (!dir) { touch.over = 0; touch.overDir = null; return; }
    if (dir !== touch.overDir) { touch.overDir = dir; touch.over = 0; }
    touch.over += Math.abs(dy);
    var now = Date.now();
    if (touch.over >= OVERSCROLL_DEAD_PX && now - lastOverscroll >= OVERSCROLL_EVERY_MS) {
      lastOverscroll = now;
      if (bridge.overscroll) bridge.overscroll(dir);
    }
  }

  term.element.addEventListener('touchstart', function (e) {
    hideActions();
    touch = e.touches.length === 1 ? { lastY: e.touches[0].clientY, over: 0, overDir: null } : null;
  }, { capture: true, passive: true });

  term.element.addEventListener('touchmove', function (e) {
    if (!touch || e.touches.length !== 1) return;
    var y = e.touches[0].clientY;
    var dy = y - touch.lastY;
    touch.lastY = y;
    trackOverscroll(dy);
  }, { capture: true, passive: true });

  function endTouch() { touch = null; }
  term.element.addEventListener('touchend', endTouch, { capture: true, passive: true });
  term.element.addEventListener('touchcancel', endTouch, { capture: true, passive: true });

  // Колелото на мишката (emulator, таблет с мишка): същото правило, натрупано по deltaY.
  var wheelOver = 0, wheelDir = null;
  term.element.addEventListener('wheel', function (e) {
    var buffer = term.buffer.active;
    var dir = null;
    if (e.deltaY < 0 && buffer.viewportY <= 0) dir = 'up';
    else if (e.deltaY > 0 && buffer.viewportY >= buffer.baseY) dir = 'down';
    if (!dir) { wheelOver = 0; wheelDir = null; return; }
    if (dir !== wheelDir) { wheelDir = dir; wheelOver = 0; }
    wheelOver += Math.abs(e.deltaY);
    var now = Date.now();
    if (wheelOver >= OVERSCROLL_DEAD_PX && now - lastOverscroll >= OVERSCROLL_EVERY_MS) {
      lastOverscroll = now;
      if (bridge.overscroll) bridge.overscroll(dir);
    }
  }, { capture: true, passive: true });

  // Дългото натискане е наше: без системното меню и маркиране на WebView-то.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('resize', fit);
  fit();
  bridge.ready();
})();
