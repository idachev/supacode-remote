package com.idachev.supacoderemote.ui.hosts

import com.idachev.supacoderemote.protocol.ErrorReply
import com.idachev.supacoderemote.protocol.HostInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostLabelsTest {

  @Test
  fun `Mac без име или с празно име е Mac без име`() {
    assertEquals("Mac без име", HostLabels.displayName(null))
    assertEquals("Mac без име", HostLabels.displayName("  "))
    assertEquals("Office Mac", HostLabels.displayName("Office Mac"))
  }

  @Test
  fun `името на свързания Mac идва от списъка, а не от hello`() {
    val hosts = listOf(HostInfo("office", "Office Mac (нов)", true), HostInfo("default"))
    assertEquals("Office Mac (нов)", HostLabels.boundName(hosts, "office", "Office Mac"))
    assertEquals("Mac без име", HostLabels.boundName(hosts, "default", null))
  }

  @Test
  fun `без списък (стар relay) остава името от hello`() {
    assertEquals("Mac mini", HostLabels.boundName(emptyList(), "office", "Mac mini"))
    assertNull(HostLabels.boundName(emptyList(), null, null))
  }

  @Test
  fun `банерът казва кой Mac е извън линия`() {
    assertEquals("Office Mac е извън линия", HostLabels.offlineBanner("Office Mac"))
    assertEquals("извън линия", HostLabels.status(false))
    assertEquals("на линия", HostLabels.status(true))
  }

  @Test
  fun `версията на Supacode е до статуса, а без нея статусът е както преди`() {
    assertEquals("на линия · Supacode 0.11.5 (154)", HostLabels.status(true, "Supacode 0.11.5 (154)"))
    assertEquals("на линия", HostLabels.status(true, null))
    assertEquals("извън линия", HostLabels.status(false, " "))
  }

  @Test
  fun `resize_failed казва, че размерът не се смени, с версията на Supacode`() {
    val error = ErrorReply(null, "terminal not ready", code = ErrorReply.RESIZE_FAILED, contentId = "c1")
    assertEquals("Размерът не се смени: terminal not ready (Supacode 0.11.5 (154))", HostLabels.error(error, "Supacode 0.11.5 (154)"))
    assertEquals("Размерът не се смени: terminal not ready", HostLabels.error(error, null))
    assertEquals("Размерът не се смени: Mac-ът не каза защо", HostLabels.error(error.copy(message = ""), null))
  }

  @Test
  fun `непознат код или грешка без код показва съобщението на host-а`() {
    assertEquals("nope", HostLabels.error(ErrorReply(7, "nope", code = "brand_new"), "Supacode 1"))
    assertEquals("boom", HostLabels.error(ErrorReply(4, "boom"), null))
    assertEquals("Грешка от host-а", HostLabels.error(ErrorReply(4, " "), null))
  }
}
