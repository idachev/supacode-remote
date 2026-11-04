package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalSelectionTest {

  // 10 колони, 5 реда в буфера.
  private fun sel(sc: Int, sr: Int, ec: Int, er: Int) = TerminalSelection(Cell(sc, sr), Cell(ec, er), 10, 5)

  @Test
  fun `началото и краят се местят с по една клетка`() {
    val s = sel(3, 1, 6, 1)
    assertEquals(Cell(2, 1), s.moveStart(-1).start)
    assertEquals(Cell(4, 1), s.moveStart(1).start)
    assertEquals(Cell(5, 1), s.moveEnd(-1).end)
    assertEquals(Cell(7, 1), s.moveEnd(1).end)
  }

  @Test
  fun `крачка през края на реда минава на съседния ред`() {
    assertEquals(Cell(9, 1), sel(0, 2, 5, 3).moveStart(-1).start)
    assertEquals(Cell(0, 3), sel(0, 2, 9, 2).moveEnd(1).end)
    assertEquals(Cell(0, 3), sel(9, 2, 5, 3).moveStart(1).start)
    assertEquals(Cell(9, 2), sel(0, 2, 0, 3).moveEnd(-1).end)
  }

  @Test
  fun `не излиза извън буфера`() {
    assertEquals(Cell(0, 0), sel(0, 0, 4, 0).moveStart(-1).start)
    assertEquals(Cell(9, 4), sel(0, 3, 9, 4).moveEnd(1).end)
  }

  @Test
  fun `началото никога не минава след края`() {
    val one = sel(4, 2, 4, 2)
    assertEquals(one, one.moveStart(1))
    assertEquals(one, one.moveEnd(-1))
    val two = sel(9, 1, 0, 2)
    assertEquals(Cell(0, 2), two.moveStart(1).start)
    assertEquals(two.moveStart(1), two.moveStart(1).moveStart(1))
  }

  @Test
  fun `диапазонът от страницата се подрежда и слага в буфера`() {
    val s = TerminalSelection.of(Cell(5, 3), Cell(2, 1), 10, 5)
    assertEquals(sel(2, 1, 5, 3), s)
    val clamped = TerminalSelection.of(Cell(-1, 0), Cell(12, 9), 10, 5)
    assertEquals(sel(0, 0, 9, 4), clamped)
    assertNull(TerminalSelection.of(Cell(0, 0), Cell(0, 0), 0, 5))
  }
}
