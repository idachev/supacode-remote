package com.idachev.supacoderemote.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class TextSizeTest {
  @Test
  fun `по подразбиране е по ширина`() {
    assertEquals(0, TextSize.FIT)
    assertEquals(TextSize.FIT, TextSize.sanitize(TextSize.FIT))
    assertEquals("По ширина", TextSize.label(TextSize.FIT))
  }

  @Test
  fun `фиксираните размери от 7 до 16 px остават`() {
    for (px in 7..16) assertEquals(px, TextSize.sanitize(px))
    assertEquals("12 px", TextSize.label(12))
  }

  @Test
  fun `непознат размер е по ширина`() {
    assertEquals(TextSize.FIT, TextSize.sanitize(6))
    assertEquals(TextSize.FIT, TextSize.sanitize(17))
    assertEquals(TextSize.FIT, TextSize.sanitize(-3))
    assertEquals("По ширина", TextSize.label(40))
  }
}
