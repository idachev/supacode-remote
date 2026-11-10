package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.Repository

/**
 * Подсказките за името на нов worktree (ЗД11), проверени на телефона, преди заявката да тръгне.
 * Това е част от правилата на git (`git check-ref-format`); последната дума е на Mac-а. Същите
 * правила и примери има и в уеб app-а (`web/public/worktree-name.js`).
 */
object WorktreeName {

  /** Mac-ът отказва име над толкова байта UTF-8 (след trim) с `worktree_invalid`. */
  const val MAX_BYTES = 200

  private val forbidden = Regex("""[~^:?*\[\\\u0000-\u001f\u007f]""")

  /**
   * Причината името да не става, или `null`. [existing] са имената и branch-овете на
   * worktree-тата в repository-то: Mac-ът сравнява без значение от главни и малки букви.
   */
  fun hint(raw: String, existing: List<String> = emptyList()): String? {
    val name = raw.trim()
    return when {
      name.isEmpty() -> "Напиши име на branch"
      name.any { it.isWhitespace() } -> "Без интервали в името"
      name.startsWith("-") -> "Името не може да започва с „-“"
      ".." in name -> "Името не може да съдържа „..“"
      forbidden.containsMatchIn(name) -> "Без знаците ~ ^ : ? * [ \\ в името"
      name.endsWith("/") || name.endsWith(".lock") -> "Името не може да завършва на „/“ или „.lock“"
      name.toByteArray(Charsets.UTF_8).size > MAX_BYTES -> "Името е по-дълго от $MAX_BYTES байта"
      existing.any { it.equals(name, ignoreCase = true) } -> "Вече има worktree или branch с това име"
      else -> null
    }
  }

  /** Имената и branch-овете в repository-то от пълния списък, не от търсенето. */
  fun existing(repos: List<Repository>?, repositoryId: String): List<String> =
    repos.orEmpty().firstOrNull { it.id == repositoryId }?.worktrees.orEmpty()
      .flatMap { listOfNotNull(it.name, it.branch) }
}
