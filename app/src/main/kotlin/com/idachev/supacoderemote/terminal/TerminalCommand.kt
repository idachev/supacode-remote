package com.idachev.supacoderemote.terminal

/** Какво трябва да направи xterm.js. Изпълнява се в реда на пристигане. */
sealed interface TerminalCommand {
  /** Нов `attached`: терминалът се чисти и става точно [cols] × [rows]. */
  data class Init(val cols: Int, val rows: Int) : TerminalCommand

  data class Write(val b64: String) : TerminalCommand

  data class Resize(val cols: Int, val rows: Int) : TerminalCommand

  /**
   * Mac-ът не смени размера (`resize_failed`): поисканият размер вече не чака отговор, иначе
   * по-късен `size` със същия размер би задържал шрифта, мерен за отказа.
   */
  data object ResizeFailed : TerminalCommand

  /** Превърта историята на самия xterm.js с [pages] страници (минус е нагоре). */
  data class ScrollPages(val pages: Int) : TerminalCommand

  /** Обратно до живия край на терминала. */
  data object ScrollToBottom : TerminalCommand

  /**
   * Скрол като от колелото / trackpad-а: страницата праща WheelEvent на xterm.js и той прави
   * каквото прави за истинско колело — mouse report, ако програмата следи мишката, стрелки
   * в alternate буфера, иначе превърта историята на телефона. Байтовете идват през `onInput`.
   *
   * [lines] е броят събития (0 — колкото за един скрол на колелото в страницата). С
   * [programOnly] страницата скролира само ако програмата следи мишката; иначе не прави нищо,
   * за да не тръгнат стрелки към TUI без мишка и да не мърда историята на телефона.
   */
  data class Wheel(val up: Boolean, val lines: Int = 0, val programOnly: Boolean = false) : TerminalCommand

  /** Подпис на екрана обратно към приложението: „Най-долу“ гледа има ли нови редове. */
  data object ReportScreen : TerminalCommand

  /** Целият текст на терминала (историята и екрана) обратно към приложението, за копиране. */
  data object RequestText : TerminalCommand

  /** Колко колони и реда влизат в мястото на терминала при сегашния шрифт; идва през `onGrid`. */
  data object MeasureGrid : TerminalCommand

  /** Показва точно този диапазон като маркирано (след ◀ ▶ в лентата за маркиране). */
  data class Select(val start: Cell, val end: Cell) : TerminalCommand

  /** Маркираното в clipboard-а — точно показаното; отговорът идва през `onCopy`. */
  data object CopySelection : TerminalCommand

  data object ClearSelection : TerminalCommand
}
