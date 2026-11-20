// Мостът между xterm.js и приложението.
//
// Kotlin вика supa.init / write / resize / resizeFailed / reportGrid / scrollPages / scrollToBottom / wheel / copyText;
// selectStart / selectMove / selectEnd (от дългото натискане в Android), selectRange /
// copySelection / clearSelection (от лентата за маркиране), tap (тап за линковете); страницата вика
// SupaBridge.ready(), text(), copy(), selection(), selectionGone(), overscroll(), input(),
// height(), rowHeight(), grid(), gridEstimate(), tapText() и tapUrl().
//
// Размерът на терминала е винаги този на Mac-а (cols × rows от `attached` и `size`).
// Страницата никога не го сменя сама: вместо това подбира шрифта така, че всички колони
// да влязат в ширината на екрана, или ползва фиксирания от „Размер на текста“. Zoom няма.
// Единственото изключение е бутонът „Размер по този екран“: supa.measureGrid мери колко влиза,
// а приложението праща `resize` към Mac-а.
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
    // OSC 8 линковете се отварят от supa.tap (oscUrlAt), не от xterm.js: неговото отваряне по
    // подразбиране пита с confirm(), а диалог в WebView-то би спрял страницата.
    linkHandler: { activate: function () {} },
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

  /** Елементът, в който xterm.js рисува клетките; няма го до първото рисуване. */
  function screenElement() {
    return term.element.querySelector('.xterm-screen');
  }

  // ---- Шрифтът, при който cols колони влизат точно в ширината ----
  function screenWidth() {
    var screen = screenElement();
    return screen ? screen.getBoundingClientRect().width : 0;
  }

  // „Размер на текста“: 0 — по ширина (колоните влизат в екрана), иначе точно толкова px.
  var fixedFont = 0;

  // „Размер по този екран“: [pendingGrid] е поисканият размер и шрифтът, при който е мерен;
  // [heldGrid] — същото, след като Mac-ът е отговорил със `size` точно толкова (нов host
  // отговаря и когато размерът вече е бил такъв). Само тогава шрифтът остава (иначе fit() би го
  // наместил по ширината). Без отговор (стар host) задържане няма. Друг `size` от Mac-а
  // освобождава и двете, а `resize_failed` — чакащия (resizeFailed).
  var pendingGrid = null;
  var heldGrid = null;

  function keepRequestedFont() {
    if (!heldGrid || heldGrid.cols !== term.cols || heldGrid.rows !== term.rows) return false;
    if (term.options.fontSize !== heldGrid.font) term.options.fontSize = heldGrid.font;
    return true;
  }

  function sameGrid(grid, cols, rows) {
    return grid !== null && grid.cols === cols && grid.rows === rows;
  }

  /** `size` от Mac-а: отговор на поискания размер или друга промяна. */
  function onHostSize(cols, rows) {
    if (sameGrid(pendingGrid, cols, rows)) heldGrid = pendingGrid;
    else if (!sameGrid(heldGrid, cols, rows)) heldGrid = null;
    pendingGrid = null;
  }

  /** Нов `attached`: не е отговор на поискания размер, само пази задържания, ако е същият. */
  function onAttached(cols, rows) {
    if (!sameGrid(heldGrid, cols, rows)) heldGrid = null;
    pendingGrid = null;
  }

  function fit() {
    if (keepRequestedFont()) return;
    if (fixedFont > 0) {
      if (term.options.fontSize !== fixedFont) term.options.fontSize = fixedFont;
      return;
    }
    var avail = document.documentElement.clientWidth;
    if (avail) fitToWidth(avail);
  }

  /** Шрифтът, при който колоните на терминала влизат в [avail] CSS px. */
  function fitToWidth(avail) {
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

  // „Размер по този екран“ при „по ширина“ (решение на собственика): винаги толкова колони, а
  // редовете — колкото влизат при шрифта, при който те запълват ширината. Иначе ситният шрифт за
  // широкия Mac би добавил само редове.
  var PHONE_COLS = 120;

  /** Ширина и височина на клетка (CSS px) при сегашния шрифт; `null` преди първото рисуване. */
  function cellSize() {
    var screen = screenElement();
    if (!screen || !term.cols || !term.rows) return null;
    var rect = screen.getBoundingClientRect();
    return rect.width ? { w: rect.width / term.cols, h: rect.height / term.rows } : null;
  }

  /**
   * Клетката в цели device px. xterm.js рисува клетка от цели device px, а размера на екрана
   * закръгля до цял CSS px; делено на броя редове, това дава дроб с грешка, която при сто и
   * повече нови реда стига до цял ред. Цялото число се възстановява точно при редове > dpr.
   */
  function deviceCell() {
    var cell = cellSize();
    var dpr = window.devicePixelRatio || 1;
    return { w: Math.round(cell.w * dpr), h: Math.round(cell.h * dpr) };
  }

  /** Най-много клетки [cellDev], които xterm.js закръгля до не повече от [css] CSS px. */
  function fitCount(css, cellDev) {
    var dpr = window.devicePixelRatio || 1;
    var n = Math.floor((css + 0.5) * dpr / cellDev);
    while (n > 0 && Math.round(n * cellDev / dpr) > css) n--;
    return n;
  }

  /** Фиксиран „Размер на текста“: колкото колони и реда влизат при него. */
  function gridAtFont(height) {
    var cell = deviceCell();
    var cols = fitCount(document.documentElement.clientWidth, cell.w);
    return { cols: cols, rows: fitCount(height, cell.h), font: term.options.fontSize };
  }

  /**
   * „По ширина“: шрифтът, при който PHONE_COLS колони влизат точно в ширината, се мери наистина
   * (xterm.js закръгля клетките, пропорция би сбъркала с по ред на всеки няколко), после
   * шрифтът се връща.
   */
  function gridAtPhoneCols(height) {
    var current = term.options.fontSize;
    var font = fontForCols(PHONE_COLS);
    var rows = fitCount(height, deviceCell().h);
    term.options.fontSize = current;
    return { cols: PHONE_COLS, rows: rows, font: font };
  }

  /** Като fit(), но за [cols] колони вместо за тези на терминала. */
  function fontForCols(cols) {
    var avail = document.documentElement.clientWidth;
    var size = term.options.fontSize;
    for (var i = 0; i < 4; i++) {
      var next = size * avail / (cellSize().w * cols);
      if (Math.abs(next - size) < 0.01) break;
      size = next;
      term.options.fontSize = size;
    }
    while (fitCount(avail, deviceCell().w) < cols && size > 2) {
      size -= 0.1;
      term.options.fontSize = size;
    }
    return size;
  }

  /**
   * „Размер по този екран“: колко колони влизат в ширината и колко реда в [height] (dp, цялото
   * място за терминала) при сегашния шрифт; null преди първото рисуване или без място.
   */
  function measuredGrid(height) {
    if (!cellSize() || !height) return null;
    var grid = fixedFont > 0 ? gridAtFont(height) : gridAtPhoneCols(height);
    if (!grid || grid.cols < 1 || grid.rows < 1) return null;
    return grid;
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
        releasePan();
        term.reset();
        onAttached(cols, rows);
        term.resize(cols, rows);
        fit();
      });
    },
    write: function (b64) {
      term.write(decode(b64));
    },
    resize: function (cols, rows) {
      term.write('', function () {
        releasePan();
        onHostSize(cols, rows);
        term.resize(cols, rows);
        fit();
      });
    },
    /**
     * Mac-ът отказа поискания размер (`resize_failed`). В опашката след вече дошлите `size`:
     * така отказ след `size` с друг размер не пипа задържането, решено от него.
     */
    resizeFailed: function () {
      term.write('', function () {
        pendingGrid = null;
      });
    },
    /** Историята на xterm.js (scrollback); програмата в PTY-то не разбира. */
    scrollPages: function (pages) {
      term.scrollPages(pages);
    },
    scrollToBottom: function () {
      releasePan();
      term.scrollToBottom();
    },
    /** „Размер по този екран“ (виж measuredGrid). Отговорът е SupaBridge.grid(cols, rows). */
    measureGrid: function (height) {
      var grid = measuredGrid(height);
      if (!grid) return;
      pendingGrid = grid;
      if (bridge.grid) bridge.grid(grid.cols, grid.rows);
    },
    /**
     * Същата мярка като measureGrid, но само като оценка за нов таб (SupaBridge.gridEstimate):
     * без pendingGrid и без `resize`. В опашката на xterm.js — след вече дошлите init / resize.
     */
    reportGrid: function (height) {
      term.write('', function () {
        var grid = measuredGrid(height);
        if (!grid) return;
        if (bridge.gridEstimate) bridge.gridEstimate(grid.cols, grid.rows);
      });
    },
    /** „Размер на текста“: [px] 0 е по ширина. По-широк терминал се мести хоризонтално. */
    fontSize: function (px) {
      fixedFont = px > 0 ? px : 0;
      // Изричен избор на размер на текста е по-силен от шрифта на „Размер по този екран“.
      pendingGrid = null;
      heldGrid = null;
      fit();
    },
    /**
     * Скрол като от колелото / trackpad-а; [dir] е -1 нагоре, 1 надолу. [lines] — колко
     * събития (0 — WHEEL_LINES). С [programOnly] само ако програмата следи мишката. Виж wheel().
     */
    wheel: function (dir, lines, programOnly) {
      if (programOnly && term.modes.mouseTrackingMode === 'none') return;
      wheel(dir, lines || WHEEL_LINES);
    },
    /**
     * Подпис на горната половина от екрана за „Най-долу“: еднакъв подпис значи, че няма нови
     * редове. Долната половина не се гледа — там агентът върти spinner и полето си. Чака в
     * опашката на xterm.js, за да включи вече дошлия изход.
     */
    reportScreen: function () {
      term.write('', function () {
        var buffer = term.buffer.active;
        var hash = 0;
        for (var y = 0; y < Math.floor(term.rows / 2); y++) {
          var line = buffer.getLine(buffer.viewportY + y);
          var text = line ? line.translateToString(true) : '';
          for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
          hash = (hash * 31 + 10) | 0;
        }
        if (bridge.screenSignature) bridge.screenSignature(hash);
      });
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
    var screen = screenElement();
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

  /** Диапазонът [a]–[b] с размера на буфера, както се докладва на Kotlin. */
  function selectionKey(a, b) {
    return [a.col, a.row, b.col, b.row, term.cols, term.buffer.active.length].join(',');
  }

  function reportSelection(a, b) {
    var length = term.buffer.active.length;
    reported = selectionKey(a, b);
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
    if (selectionKey(start, end) !== reported) reportSelection(start, end);
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
    var start = { col: startCol, row: startRow };
    var end = { col: endCol, row: endRow };
    selectBetween(start, end);
    // Kotlin вече знае този диапазон; запомня се, за да не се връща обратно като промяна.
    reported = selectionKey(start, end);
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

  // ---- Линкове: тап по http/https адрес го отваря в браузъра ----
  //
  // Тапът се хваща в Android (onSingleTapUp), както дългото натискане: дали WebView-то прави от
  // тап mouse събитията, които xterm.js чака за своите линкове, не е сигурно. Страницата дава
  // само реда и мястото на тапа в него; адресът се търси и проверява в Kotlin (TerminalLinks).

  /**
   * Редът на [cell] заедно с пренесените му части (isWrapped) като един низ и индексът на
   * тапнатия знак в него. Широк знак (емоджи) заема две клетки, а в низа е един знак, затова
   * индексът не е колоната. Ред, разбит на две от самия TUI, не се събира. Същото правило има
   * уеб app-ът (`wrappedLine` в web/public/terminal-links.js, с тестове).
   *
   * Широк знак, който не влиза в последната клетка, xterm.js пренася на следващия ред и оставя
   * клетката празна (без знак, не интервал). Пред пренесен ред такива клетки се пропускат: иначе
   * интервал би разделил адреса.
   */
  function wrappedLineAt(cell) {
    var buffer = term.buffer.active;
    var first = wrapStart(cell.row);
    var found = { text: '', index: -1 };
    for (var y = first; y < buffer.length; y++) {
      var line = buffer.getLine(y);
      if (!line || (y > first && !line.isWrapped)) break;
      appendCells(found, writtenCells(line, buffer.getLine(y + 1)), y === cell.row ? cell.col : -1);
    }
    return found;
  }

  /** Първият ред на пренесения ред, в който е [row]. */
  function wrapStart(row) {
    var buffer = term.buffer.active;
    while (row > 0 && buffer.getLine(row) && buffer.getLine(row).isWrapped) row--;
    return row;
  }

  /** Клетките на [line], които се четат: пред пренесен ред [next] неписаните в края не са интервали. */
  function writtenCells(line, next) {
    var end = line.length;
    if (next && next.isWrapped) {
      while (end > 0 && isUnwritten(line.getCell(end - 1))) end--;
    }
    var cells = [];
    for (var x = 0; x < end; x++) cells.push(line.getCell(x));
    return cells;
  }

  /**
   * Знаците от [cells] (един ред) към found.text. Ако тапът е на този ред ([tapCol] не е -1),
   * found.index става индексът на тапнатия знак.
   */
  function appendCells(found, cells, tapCol) {
    var start = 0;
    for (var x = 0; x < cells.length; x++) {
      var c = cells[x];
      if (!c) continue;
      // Втората половина на широк знак е празна клетка с ширина 0: тап там е тап по знака пред нея.
      var secondHalf = c.getWidth() === 0;
      if (!secondHalf) start = found.text.length;
      if (x === tapCol) found.index = start;
      if (!secondHalf) found.text += c.getChars() || ' ';
    }
  }

  function isUnwritten(c) {
    return !!c && c.getWidth() === 1 && c.getChars() === '';
  }

  /**
   * OSC 8 адресът на [cell] или null. Claude Code чупи дълъг адрес на два реда сам (не е пренос
   * на xterm.js), но всяка част носи пълния адрес в OSC 8 — затова той е пред търсенето в текста,
   * което би дало само първата част. xterm.js няма публичен API за него: пита се неговият OSC 8
   * provider (вътрешен; xterm.js е вграден, 5.5.0). Ако го няма или отговори по-късно — null.
   */
  function oscUrlAt(cell) {
    var found = null;
    try {
      var providers = term._core._linkProviderService.linkProviders;
      for (var i = 0; i < providers.length && found === null; i++) found = providerUrlAt(providers[i], cell);
    } catch (e) {
      return null;
    }
    return found;
  }

  /** Адресът на [cell] от един provider на xterm.js, ако той отговори веднага; иначе null. */
  function providerUrlAt(provider, cell) {
    var found = null;
    provider.provideLinks(cell.row + 1, function (links) {
      (links || []).forEach(function (link) {
        if (found === null && rangeHas(link.range, cell)) found = link.text;
      });
    });
    return found;
  }

  /** Диапазонът на xterm.js е 1-базиран и включва края. */
  function rangeHas(range, cell) {
    var x = cell.col + 1, y = cell.row + 1;
    var afterStart = y > range.start.y || (y === range.start.y && x >= range.start.x);
    var beforeEnd = y < range.end.y || (y === range.end.y && x <= range.end.x);
    return afterStart && beforeEnd;
  }

  window.supa.tap = function (x, y) {
    // Тап при маркирано само маха маркираното.
    if (reported !== null || selectAnchor) return;
    var p = clientPoint(x, y);
    var cell = cellAt(p.x, p.y);
    var osc = oscUrlAt(cell);
    if (osc !== null) {
      if (bridge.tapUrl) bridge.tapUrl(osc);
      return;
    }
    var line = wrappedLineAt(cell);
    if (line.index >= 0 && /https?:\/\//i.test(line.text) && bridge.tapText) bridge.tapText(line.text, line.index);
  };

  var touch = null; // { startX, startY, lastX, lastY, over, overDir, axis }
  // Под толкова px от началото посоката на жеста още не е решена (виж touchmove).
  var AXIS_SLOP_PX = 8;
  var lastOverscroll = 0;

  /**
   * Скрол отвъд ръба на историята на телефона: нагоре при най-стария ред (или без история —
   * напр. Claude Code на цял екран) стига до програмата като скрол от trackpad-а (Kotlin
   * отговаря със `supa.wheel`), нагоре при най-стария ред, надолу при живия край.
   * Мъртва зона, за да не стреля обикновен скрол, който само стига ръба, и пауза между
   * клавишите.
   */
  function trackOverscroll(dy) {
    pushOverscroll(touch, edgeDir(dy > 0, dy < 0), Math.abs(dy));
  }

  /** 'up' при скрол нагоре от най-стария ред, 'down' надолу от живия край, иначе null. */
  function edgeDir(up, down) {
    var buffer = term.buffer.active;
    if (up && buffer.viewportY <= 0) return 'up';
    if (down && buffer.viewportY >= buffer.baseY) return 'down';
    return null;
  }

  /**
   * Натрупва [amount] px скрол към ръба [dir] (null — не е към ръба, броенето почва отначало) в
   * [edge] ({ over, overDir }) и след мъртвата зона праща скрол до програмата, най-много веднъж
   * на OVERSCROLL_EVERY_MS. Пръстът и колелото броят поотделно, а паузата е обща.
   */
  function pushOverscroll(edge, dir, amount) {
    if (!dir) { edge.over = 0; edge.overDir = null; return; }
    if (dir !== edge.overDir) { edge.overDir = dir; edge.over = 0; }
    edge.over += amount;
    var now = Date.now();
    if (edge.over >= OVERSCROLL_DEAD_PX && now - lastOverscroll >= OVERSCROLL_EVERY_MS) {
      lastOverscroll = now;
      if (bridge.overscroll) bridge.overscroll(dir);
    }
  }

  function startTouch(t) {
    touch = {
      startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY,
      over: 0, overDir: null, axis: null,
    };
  }

  // Само слуша (passive): по вертикала страницата няма какво да скролва (WebView-то е
  // колкото терминала), а хоризонталното местене на по-широк терминал е на Chromium.
  // xterm.js отменя touchmove при всяко вертикално отклонение, щом има история накъдето
  // да се превърти, и тогава Chromium не мести страницата. Затова при по-широк терминал
  // жестът се заключва в една посока: докато не е решена и ако е хоризонтална, xterm.js
  // не вижда движенията (stopPropagation във фазата capture).
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
    if (!touch.axis && document.documentElement.scrollWidth > document.documentElement.clientWidth) {
      var ax = Math.abs(x - touch.startX), ay = Math.abs(y - touch.startY);
      if (Math.max(ax, ay) < AXIS_SLOP_PX) { e.stopPropagation(); return; }
      touch.axis = ax > ay ? 'x' : 'y';
    }
    if (touch.axis === 'x') { e.stopPropagation(); return; }
    if (dy === 0 || Math.abs(dx) > Math.abs(dy)) return;
    // Първо скритите редове на по-висок от екрана терминал (виж panBy); мъртвата зона за
    // скрола до програмата почва от ръба.
    if (panBy(dy)) {
      e.stopPropagation();
      touch.over = 0;
      touch.overDir = null;
      return;
    }
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
  var wheelEdge = { over: 0, overDir: null };
  term.element.addEventListener('wheel', function (e) {
    if (wheeling) return; // скролът от бутоните не е скрол до ръба
    pushOverscroll(wheelEdge, edgeDir(e.deltaY < 0, e.deltaY > 0), Math.abs(e.deltaY));
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

  // По едно събитие на ред: при mouse tracking xterm.js дава един report на събитие,
  // каквото и да е deltaY, а програмата (Claude Code) брои report-ите като редове.
  function wheel(dir, lines) {
    var screen = screenElement();
    var rect = screen.getBoundingClientRect();
    wheeling = true;
    try {
      for (var i = 0; i < lines; i++) {
        screen.dispatchEvent(new WheelEvent('wheel', {
          deltaY: dir,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true,
        }));
      }
    } finally {
      wheeling = false;
    }
  }

  term.onData(function (data) {
    if (wheeling && bridge.input) bridge.input(data);
  });
  // X10 кодирането дава байтове над 127, които мостът (низ, UTF-8) би развалил: само ASCII.
  // Така при X10 и над ~190 колони скролът не стига до програмата; Claude Code и
  // съвременните TUI-та включват SGR (1006), където всичко е ASCII.
  term.onBinary(function (data) {
    if (wheeling && bridge.input && !/[^\x00-\x7f]/.test(data)) bridge.input(data);
  });

  // Дългото натискане е наше: без системното меню и маркиране на WebView-то.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /** body е точно колкото прозореца; терминалът е долу в него (index.html). */
  function layout() {
    document.body.style.height = document.documentElement.clientHeight + 'px';
    fit();
    follow();
  }

  // ---- По-висок от прозореца терминал: показаната част следва курсора ----
  //
  // Mac-ът може да е 50 реда, а на телефона да влизат 30. #frame реже (index.html), а тук
  // терминалът се мести надолу с translateY, за да се вижда редът с курсора и съдържанието
  // около него: при пълен екран последният ред е долу, а нов shell (банер и промпт в горните
  // редове, празно под тях) се вижда отгоре. Вертикално плъзгане първо мести показаното по
  // скритите редове (panBy), а чак от ръба превърта историята и стига до програмата.

  /**
   * Отместването отгоре (px в терминала) на показаната част. [rows] реда по [rowH] px,
   * [height] px място, [last] е броят редове до последния със съдържание, [cursor] е редът
   * на курсора в показаните или -1, ако не е на екрана (превъртяна история).
   */
  function visibleTop(rows, rowH, height, last, cursor) {
    var total = rows * rowH;
    if (total <= height) return 0;
    if (cursor >= 0) last = Math.max(last, cursor + 1);
    var top = Math.max(0, Math.min(total - height, last * rowH - height));
    if (cursor >= 0 && cursor * rowH < top) top = cursor * rowH;
    return top;
  }

  /** Броят редове до последния непразен в показаното (с историята, ако е превъртяна). */
  function lastContentRow() {
    var buffer = term.buffer.active;
    for (var r = term.rows - 1; r >= 0; r--) {
      var line = buffer.getLine(buffer.viewportY + r);
      if (line && line.translateToString(true) !== '') return r + 1;
    }
    return 0;
  }

  var shift = 0;
  var shownTop = 0; // отместването отгоре на показаната част сега (px в терминала)
  // Ръчно местене с пръст (виж panBy): докато не е null, показаната част е там, а не по курсора.
  var panTop = null;
  var panCursor = null; // курсорът при местенето; изход, който го мести, връща следването

  function cursorKey() {
    var buffer = term.buffer.active;
    return buffer.type + ',' + (buffer.baseY + buffer.cursorY) + ',' + buffer.cursorX;
  }

  /** Мястото и височината на терминала; null, ако целият се вижда. */
  function overflow() {
    var height = document.documentElement.clientHeight;
    var total = term.element.getBoundingClientRect().height;
    if (!height || total <= height) return null;
    return { height: height, total: total };
  }

  /** Отместването отгоре на показаната част в [box]: ръчното местене или частта с курсора. */
  function topToShow(screen, box) {
    if (panTop !== null) return Math.max(0, Math.min(box.total - box.height, panTop));
    var rowH = screen.getBoundingClientRect().height / term.rows;
    var buffer = term.buffer.active;
    var cursor = buffer.baseY + buffer.cursorY - buffer.viewportY;
    if (cursor < 0 || cursor >= term.rows) cursor = -1;
    return visibleTop(term.rows, rowH, box.height, lastContentRow(), cursor);
  }

  function follow() {
    var screen = screenElement();
    var box = overflow();
    var top = screen && box ? topToShow(screen, box) : 0;
    shownTop = top;
    // Долният край на терминала е долу в #frame; показано е [total − height, total].
    var next = box ? Math.round(box.total - box.height - top) : 0;
    if (next === shift) return;
    shift = next;
    term.element.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
  }

  /**
   * Вертикално местене с пръст на показаната част по редовете на терминала, до краищата му.
   * Връща false, ако накъдето е жестът няма скрити редове: тогава той продължава към
   * историята и скрола до програмата, както при терминал, който се вижда целият.
   */
  function panBy(dy) {
    var box = overflow();
    if (!box) return false;
    var next = Math.max(0, Math.min(box.total - box.height, shownTop - dy));
    if (Math.abs(next - shownTop) < 0.5) return false;
    panTop = next;
    panCursor = cursorKey();
    follow();
    return true;
  }

  function releasePan() {
    panTop = null;
    panCursor = null;
  }

  // Ръчното местене се държи до изход, който мести курсора (ехо от писане, нов ред, нов
  // промпт). Изход, който го оставя на място (spinner на агента), не го връща.
  term.onWriteParsed(function () {
    if (panTop !== null && cursorKey() !== panCursor) releasePan();
  });

  // onRender хваща изхода, курсора, превъртането на историята и resize; агентските TUI-та
  // рисуват много пъти в секунда, затова веднъж на кадър.
  var followQueued = false;
  term.onRender(function () {
    if (followQueued) return;
    followQueued = true;
    requestAnimationFrame(function () {
      followQueued = false;
      follow();
    });
  });
  window.supa.visibleTop = visibleTop; // за проверка от DevTools / тестовете на страницата

  // Височината на терминала (CSS px = dp) към Kotlin: WebView-то става точно толкова и
  // долу в мястото си, а празното над него е на Compose, извън страницата.
  var reportedHeight = 0;
  var reportedRow = 0;
  function reportHeight() {
    reportRowHeight();
    var h = Math.ceil(term.element.getBoundingClientRect().height);
    if (!h || h === reportedHeight) return;
    reportedHeight = h;
    if (bridge.height) bridge.height(h);
  }

  // Височината на един ред (CSS px = dp): на цял екран Compose оставя по толкова място горе и
  // долу, за да не режат заобленият екран и камерата буквите. Само страницата я знае: при
  // „по ширина“ шрифтът идва от fit(), а и при фиксиран клетката се мери от xterm.js.
  function reportRowHeight() {
    var screen = screenElement();
    if (!screen || !term.rows) return;
    var row = Math.round(screen.getBoundingClientRect().height / term.rows * 10) / 10;
    if (!row || row === reportedRow) return;
    reportedRow = row;
    if (bridge.rowHeight) bridge.rowHeight(row);
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(term.element);

  window.addEventListener('resize', layout);
  layout();
  reportHeight();
  bridge.ready();
})();
