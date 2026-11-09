package com.idachev.supacoderemote.sessions

/**
 * Търсене, което търпи грешки при писане на телефона: липсваща, излишна или сменена буква и
 * две разменени съседни букви (по една грешка всяка). Търсеното може да е където и да е в
 * името, както при точното търсене.
 *
 * Грешките растат с дължината на търсеното: с две грешки кратка дума би намирала почти всичко.
 */
object FuzzyMatch {

  /** До 3 букви — точно; 4–5 — една грешка; от 6 нагоре — две. */
  fun allowedErrors(query: String): Int = when {
    query.length <= 3 -> 0
    query.length <= 5 -> 1
    else -> 2
  }

  /** Има ли в [text] парче, което се различава от [query] с най-много [allowedErrors] грешки. */
  fun matches(text: String, query: String): Boolean {
    val q = query.lowercase()
    val t = text.lowercase()
    if (t.contains(q)) return true
    val maxErrors = allowedErrors(q)
    return maxErrors > 0 && bestDistance(t, q) <= maxErrors
  }

  /**
   * Най-малкото разстояние между [q] и някое парче от [t] (Sellers, с размяна на съседни букви
   * като при Damerau). Началото в [t] е без цена, затова първият ред е нули; краят е
   * най-малкото в последния ред. Пазят се три реда, защото размяната гледа два назад.
   */
  private fun bestDistance(t: String, q: String): Int {
    val m = q.length
    var prev2 = IntArray(m + 1)
    var prev = IntArray(m + 1) { it }
    var best = prev[m]
    for (j in 1..t.length) {
      val cur = IntArray(m + 1)
      for (i in 1..m) {
        val cost = if (q[i - 1] == t[j - 1]) 0 else 1
        var d = minOf(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost)
        if (i > 1 && j > 1 && q[i - 1] == t[j - 2] && q[i - 2] == t[j - 1]) d = minOf(d, prev2[i - 2] + 1)
        cur[i] = d
      }
      best = minOf(best, cur[m])
      prev2 = prev
      prev = cur
    }
    return best
  }
}
