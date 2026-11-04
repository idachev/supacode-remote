package com.idachev.supacoderemote.terminal

/** Клетка в буфера на xterm.js: колона и ред, броен от най-стария ред на историята. */
data class Cell(val col: Int, val row: Int)

/**
 * Маркираното в терминала: от [start] до [end] включително, в буфер с [cols] колони и
 * [rows] реда (историята и екрана). Логиката е тук, а не в страницата, за да се проверява
 * с JVM тестове; страницата само показва диапазона, който получи.
 *
 * Клетките се броят в един ред един след друг (ред × колони + колона), затова крачка
 * отвъд края на реда минава на следващия, а преди началото му — на предишния.
 */
data class TerminalSelection(val start: Cell, val end: Cell, val cols: Int, val rows: Int) {

  /** Началото с [delta] клетки; никога след края и никога извън буфера. */
  fun moveStart(delta: Int): TerminalSelection =
    copy(start = cellOf((indexOf(start) + delta).coerceIn(0, indexOf(end))))

  /** Краят с [delta] клетки; никога преди началото и никога извън буфера. */
  fun moveEnd(delta: Int): TerminalSelection =
    copy(end = cellOf((indexOf(end) + delta).coerceIn(indexOf(start), lastIndex)))

  private val lastIndex: Int get() = cols * rows - 1

  private fun indexOf(cell: Cell): Int = cell.row * cols + cell.col

  private fun cellOf(index: Int): Cell = Cell(col = index % cols, row = index / cols)

  companion object {
    /**
     * Диапазонът, както го докладва страницата. Краищата се подреждат и се слагат в буфера,
     * защото плъзгането може да е назад, а пръстът — извън екрана. `null`, ако буферът е празен.
     */
    fun of(a: Cell, b: Cell, cols: Int, rows: Int): TerminalSelection? {
      if (cols <= 0 || rows <= 0) return null
      fun clamp(c: Cell) = Cell(c.col.coerceIn(0, cols - 1), c.row.coerceIn(0, rows - 1))
      val x = clamp(a)
      val y = clamp(b)
      val ordered = x.row < y.row || (x.row == y.row && x.col <= y.col)
      return if (ordered) TerminalSelection(x, y, cols, rows) else TerminalSelection(y, x, cols, rows)
    }
  }
}
