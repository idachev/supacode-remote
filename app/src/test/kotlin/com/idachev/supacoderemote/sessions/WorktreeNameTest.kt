package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.Worktree
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Същите примери като `web/test/worktree-name.test.mjs`. */
class WorktreeNameTest {

  @Test
  fun `добро име няма подсказка и интервалите около него не пречат`() {
    assertNull(WorktreeName.hint("feature/x-1"))
    assertNull(WorktreeName.hint("  fix-bug  "))
    assertNull(WorktreeName.hint("поправка"))
  }

  @Test
  fun `празно име и интервали вътре`() {
    assertEquals("Напиши име на branch", WorktreeName.hint(""))
    assertEquals("Напиши име на branch", WorktreeName.hint("   "))
    assertEquals("Без интервали в името", WorktreeName.hint("a b"))
    assertEquals("Без интервали в името", WorktreeName.hint("a\tb"))
  }

  @Test
  fun `правилата на git които се проверяват тук`() {
    assertTrue(WorktreeName.hint("-x")!!.contains("„-“"))
    assertTrue(WorktreeName.hint("a..b")!!.contains("„..“"))
    for (bad in listOf("a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b")) {
      assertTrue(bad, WorktreeName.hint(bad)!!.startsWith("Без знаците"))
    }
    assertTrue(WorktreeName.hint("a/")!!.contains("завършва"))
    assertTrue(WorktreeName.hint("a.lock")!!.contains("завършва"))
  }

  @Test
  fun `над 200 байта UTF-8 и кирилицата е по 2 байта`() {
    assertNull(WorktreeName.hint("a".repeat(200)))
    assertTrue(WorktreeName.hint("a".repeat(201))!!.contains("200 байта"))
    assertTrue(WorktreeName.hint("я".repeat(101))!!.contains("200 байта"))
  }

  @Test
  fun `съществуващо име или branch без значение от главни букви`() {
    assertTrue(WorktreeName.hint("Feature-X", listOf("feature-x"))!!.startsWith("Вече има"))
    assertNull(WorktreeName.hint("feature-y", listOf("feature-x")))
  }

  @Test
  fun `имената са от пълния списък на repository-то`() {
    val repos = listOf(
      Repository("r1", "r1", worktrees = listOf(Worktree("w1", "main", branch = "main"), Worktree("w2", "wt", branch = "feat/wt"))),
      Repository("r2", "r2", worktrees = listOf(Worktree("w3", "other"))),
    )
    assertEquals(listOf("main", "main", "wt", "feat/wt"), WorktreeName.existing(repos, "r1"))
    assertEquals(emptyList<String>(), WorktreeName.existing(repos, "nope"))
    assertEquals(emptyList<String>(), WorktreeName.existing(null, "r1"))
  }
}
