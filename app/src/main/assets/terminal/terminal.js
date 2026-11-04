// Мостът между xterm.js и приложението.
//
// Kotlin вика supa.init / write / resize / scrollPages / scrollToBottom / wheel / copyText;
// selectStart / selectMove / selectEnd (от дългото натискане в Android), selectRange /
// copySelection / clearSelection (от лентата за маркиране); страницата вика
// SupaBridge.ready(), text(), copy(), selection(), selectionGone(), overscroll(), input()
// и height().
//
// Размерът на терминала е винаги този на Mac-а (cols × rows от `attached` и `size`).
// Страницата никога не го сменя сама: вместо това подбира шрифта така, че всички колони
// да влязат в ширината на екрана, или ползва фиксирания от „Размер на текста“. Zoom няма.
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
    // Входът от xterm.js (onData) не се чете, освен по време на `supa.wheel` (виж там).
    // disableStdin би спрял и байтовете за скрола, затова е false.
    disableStdin: false,
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
  // отваря и onData не се чете (освен байтовете за скрола от `supa.wheel`).
  term.textarea.setAttribute('readonly', 'readonly');
  term.textarea.setAttribute('inputmode', 'none');

  // ---- Шрифтът, при който cols колони влизат точно в ширината ----
  function screenWidth() {
    var screen = term.element.querySelector('.xterm-screen');
    return screen ? screen.getBoundingClientRect().width : 0;
  }

  // „Размер на текста“: 0 — по ширина (колоните влизат в екрана), иначе точно толкова px.
  var fixedFont = 0;

  function fit() {
    if (fixedFont > 0) {
      if (term.options.fontSize !== fixedFont) term.options.fontSize = fixedFont;
      return;
    }
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
    // term.write е асинхронен, а reset и resize — не. Затова те чакат в същата опашка на
    // xterm.js (празен запис с callback): изходът преди тях, напр. пуснатият след „Пауза“,
    // се изписва с размера, за който е, и не попада след reset.
    init: function (cols, rows) {
      term.write('', function () {
        term.reset();
        term.resize(cols, rows);
        fit();
      });
    },
    write: function (b64) {
      term.write(decode(b64));
    },
    resize: function (cols, rows) {
      term.write('', function () {
        term.resize(cols, rows);
        fit();
      });
    },
    /** Историята на xterm.js (scrollback); програмата в PTY-то не разбира. */
    scrollPages: function (pages) {
      term.scrollPages(pages);
    },
    scrollToBottom: function () {
      term.scrollToBottom();
    },
    /** „Размер на текста“: [px] 0 е по ширина. По-широк терминал се мести хоризонтално. */
    fontSize: function (px) {
      fixedFont = px > 0 ? px : 0;
      fit();
    },
    /** Скрол като от колелото / trackpad-а; [dir] е -1 нагоре, 1 надолу. Виж wheel(). */
    wheel: function (dir) {
      wheel(dir);
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

  // Бутоните за маркираното („Копирай“, ◀ ▶, „Отказ“) са в Compose над WebView-то, за да
  // са с еднакъв размер. Страницата само показва диапазона и казва какъв е.
  var reported = null; // последно докладваното на Kotlin, за да не се праща същото

  function reportSelection(a, b) {
    var length = term.buffer.active.length;
    reported = [a.col, a.row, b.col, b.row, term.cols, length].join(',');
    if (bridge.selection) bridge.selection(a.col, a.row, b.col, b.row, term.cols, length);
  }

  function reportGone() {
    if (reported === null) return;
    reported = null;
    if (bridge.selectionGone) bridge.selectionGone();
  }

  // Маркираното изчезва и от само себе си (тап в терминала, reset): лентата се скрива.
  term.onSelectionChange(function () {
    if (!term.hasSelection()) reportGone();
  });

  // Нов изход: буферът расте, а при пълна история най-старите редове се режат и xterm.js
  // мести маркираното нагоре — или го маха, ако е изрязано, без onSelectionChange. Затова
  // след всеки запис диапазонът се чете наново и Kotlin получава новия.
  term.onWriteParsed(function () {
    if (!selectAnchor) rereadSelection();
  });

  /** Показаното маркирано наново от xterm.js; докладва се само ако се е сменило. */
  function rereadSelection() {
    if (reported === null) return;
    var pos = term.getSelectionPosition();
    if (!pos) { reportGone(); return; }
    // Краят от xterm.js е изключителен (x е от 1 до cols): последната клетка е x − 1.
    var start = { col: pos.start.x, row: pos.start.y };
    var end = { col: pos.end.x - 1, row: pos.end.y };
    var next = [start.col, start.row, end.col, end.row, term.cols, term.buffer.active.length].join(',');
    if (next !== reported) reportSelection(start, end);
  }

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
    var p = clientPoint(x, y);
    selectAnchor = cellAt(p.x, p.y);
    selectBetween(selectAnchor, selectAnchor);
    reportSelection(selectAnchor, selectAnchor);
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
    // Изходът, вече подаден на xterm.js, може да е изрязал историята по време на плъзгането:
    // докладва се показаното, както е сега, с днешния размер на буфера.
    rereadSelection();
  };
  /** Точният диапазон от лентата за маркиране (краищата включително, вече подредени). */
  window.supa.selectRange = function (startCol, startRow, endCol, endRow) {
    selectBetween({ col: startCol, row: startRow }, { col: endCol, row: endRow });
    // Kotlin вече знае този диапазон; запомня се, за да не се връща обратно като промяна.
    reported = [startCol, startRow, endCol, endRow, term.cols, term.buffer.active.length].join(',');
  };
  /** „Копирай“: точно показаното, после маркираното се маха. */
  window.supa.copySelection = function () {
    var text = term.getSelection();
    if (text && bridge.copy) bridge.copy(text);
    term.clearSelection();
  };
  window.supa.clearSelection = function () {
    term.clearSelection();
  };

  var touch = null; // { lastX, lastY, over, overDir }
  var lastOverscroll = 0;

  /**
   * Скрол отвъд ръба на историята на телефона: нагоре при най-стария ред (или без история —
   * напр. Claude Code на цял екран) стига до програмата като скрол от trackpad-а (Kotlin
   * отговаря със `supa.wheel`), нагоре при най-стария ред, надолу при живия край.
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

  function startTouch(t) {
    touch = { lastX: t.clientX, lastY: t.clientY, over: 0, overDir: null };
  }

  // Само слуша (passive): по вертикала страницата няма какво да скролва (WebView-то е
  // колкото терминала), а хоризонталното местене на по-широк терминал е на Chromium.
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) startTouch(e.touches[0]);
    else touch = null;
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!touch || e.touches.length !== 1) return;
    var x = e.touches[0].clientX;
    var y = e.touches[0].clientY;
    var dx = x - touch.lastX;
    var dy = y - touch.lastY;
    touch.lastX = x;
    touch.lastY = y;
    if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return;
    trackOverscroll(dy);
  }, { capture: true, passive: true });

  // От два пръста към един (вдигнат пръст): от оставащия започва ново плъзгане.
  function endTouch(e) {
    if (e.touches.length === 1) startTouch(e.touches[0]);
    else touch = null;
  }
  document.addEventListener('touchend', endTouch, { capture: true, passive: true });
  document.addEventListener('touchcancel', endTouch, { capture: true, passive: true });

  // Колелото на мишката (emulator, таблет с мишка): същото правило, натрупано по deltaY.
  var wheelOver = 0, wheelDir = null;
  term.element.addEventListener('wheel', function (e) {
    if (wheeling) return; // скролът от бутоните не е скрол до ръба
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

  // ---- Скрол като от колелото (плаващите бутони) ----
  //
  // Изкуствен WheelEvent на xterm.js: той сам решава какво значи — mouse report в
  // кодирането на програмата, ако тя следи мишката (Claude Code), стрелки в alternate
  // буфера без мишка, иначе превърта историята на телефона. Байтовете от onData / onBinary
  // се пращат само докато трае това събитие (xterm.js ги вдига синхронно); всичко друго от
  // onData — отговори на DA, клавиатура — пак не стига до PTY-то.
  var WHEEL_LINES = 3;
  var wheeling = false;

  function wheel(dir) {
    var screen = term.element.querySelector('.xterm-screen');
    var rect = screen.getBoundingClientRect();
    wheeling = true;
    try {
      screen.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir * WHEEL_LINES,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      }));
    } finally {
      wheeling = false;
    }
  }

  term.onData(function (data) {
    if (wheeling && bridge.input) bridge.input(data);
  });
  // X10 кодирането дава байтове над 127, които мостът (низ, UTF-8) би развалил: само ASCII.
  term.onBinary(function (data) {
    if (wheeling && bridge.input && !/[^\x00-\x7f]/.test(data)) bridge.input(data);
  });

  // Дългото натискане е наше: без системното меню и маркиране на WebView-то.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /** body е точно колкото прозореца; терминалът е долу в него (index.html). */
  function layout() {
    document.body.style.height = document.documentElement.clientHeight + 'px';
    fit();
  }

  // Височината на терминала (CSS px = dp) към Kotlin: WebView-то става точно толкова и
  // долу в мястото си, а празното над него е на Compose, извън страницата.
  var reportedHeight = 0;
  function reportHeight() {
    var h = Math.ceil(term.element.getBoundingClientRect().height);
    if (!h || h === reportedHeight) return;
    reportedHeight = h;
    if (bridge.height) bridge.height(h);
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(term.element);

  window.addEventListener('resize', layout);
  layout();
  reportHeight();
  bridge.ready();
})();
