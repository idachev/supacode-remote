package com.idachev.supacoderemote.terminal

/** Колони × редове на терминал. */
data class GridSize(val cols: Int, val rows: Int)

/**
 * Последният размер, който страницата на терминала е премерила по правилото на „Размер по този
 * екран“ (АН1). Нов таб от „Worktree“ тръгва с него, а там страница няма: размерът зависи от
 * шрифта и мястото, които мери само xterm.js. Мястото е същият екран, в който ще се отвори
 * новият таб, затова последната мярка е добра оценка.
 *
 * Пази се с „Размер на текста“, при който е мерен: друга настройка значи друг шрифт и мярката
 * не важи, докато страницата не премери наново. Само в паметта — след рестарт host-ът дава своя
 * размер по подразбиране.
 */
class TerminalGridMemory {

  private data class Measured(val textSize: Int, val grid: GridSize)

  @Volatile
  private var last: Measured? = null

  fun remember(textSize: Int, cols: Int, rows: Int) {
    if (cols < 1 || rows < 1) return
    last = Measured(textSize, GridSize(cols, rows))
  }

  /** Размерът за [textSize]; `null`, ако няма мярка при нея. */
  fun gridFor(textSize: Int): GridSize? = last?.takeIf { it.textSize == textSize }?.grid
}
