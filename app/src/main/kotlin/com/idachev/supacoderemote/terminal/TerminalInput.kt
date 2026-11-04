package com.idachev.supacoderemote.terminal

/** Лепкавият Ctrl в полето за текст: кой знак току-що е написан. */
object TextDiff {

  /**
   * Знакът, вмъкнат между [old] и [new], ако разликата е точно един вмъкнат знак.
   * Иначе `null` (поставяне, изтриване, автокорекция на цяла дума).
   */
  fun insertedChar(old: String, new: String): Char? {
    if (new.length != old.length + 1) return null
    var i = 0
    while (i < old.length && old[i] == new[i]) i++
    return if (new.removeRange(i, i + 1) == old) new[i] else null
  }
}
