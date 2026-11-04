package com.idachev.supacoderemote.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalInputTest {

  @Test
  fun `вмъкнатият знак в полето`() {
    assertEquals('c', TextDiff.insertedChar("ab", "abc"))
    assertEquals('x', TextDiff.insertedChar("ab", "axb"))
    assertEquals('a', TextDiff.insertedChar("", "a"))
    assertEquals('a', TextDiff.insertedChar("aa", "aaa"))
    assertNull(TextDiff.insertedChar("ab", "abcd"))
    assertNull(TextDiff.insertedChar("abc", "ab"))
    assertNull(TextDiff.insertedChar("ab", "xyz"))
  }
}
