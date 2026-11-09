package com.idachev.supacoderemote.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FuzzyMatchTest {

  @Test
  fun `точното парче се намира навсякъде в името, без значение от главните букви`() {
    assertTrue(FuzzyMatch.matches("feature/billing", "BILL"))
    assertTrue(FuzzyMatch.matches("Поправка на входа", "входа"))
    assertTrue(FuzzyMatch.matches("web-shop", "b-s"))
  }

  @Test
  fun `позволените грешки растат с дължината на търсеното`() {
    assertEquals(0, FuzzyMatch.allowedErrors("abc"))
    assertEquals(1, FuzzyMatch.allowedErrors("abcd"))
    assertEquals(1, FuzzyMatch.allowedErrors("abcde"))
    assertEquals(2, FuzzyMatch.allowedErrors("abcdef"))
    assertEquals(2, FuzzyMatch.allowedErrors("abcdefghijkl"))
  }

  @Test
  fun `кратко търсене иска точно съвпадение`() {
    assertFalse(FuzzyMatch.matches("shop", "shx"))
    assertTrue(FuzzyMatch.matches("shop", "hop"))
  }

  @Test
  fun `една грешка при 4 и 5 букви — сменена, липсваща, излишна или разменена`() {
    assertTrue(FuzzyMatch.matches("web-shop", "shap"))
    assertTrue(FuzzyMatch.matches("web-shop", "shoop"))
    assertTrue(FuzzyMatch.matches("supacode", "spaco"))
    assertTrue(FuzzyMatch.matches("notes-app", "ntoes"))
    assertFalse(FuzzyMatch.matches("web-shop", "sxap"))
  }

  @Test
  fun `две грешки от 6 букви нагоре`() {
    // Липсващо „l“ и разменени „ng“.
    assertTrue(FuzzyMatch.matches("feature/billing", "bilign"))
    assertTrue(FuzzyMatch.matches("Remote access", "remtoe"))
    assertTrue(FuzzyMatch.matches("resume-picker", "resme-pikcer"))
    assertTrue(FuzzyMatch.matches("Поправка на входа", "пправкя"))
    assertFalse(FuzzyMatch.matches("feature/billing", "bxlxxng"))
    assertFalse(FuzzyMatch.matches("main", "billing"))
  }

  @Test
  fun `празно търсене отговаря на всичко`() {
    assertTrue(FuzzyMatch.matches("main", ""))
  }
}
