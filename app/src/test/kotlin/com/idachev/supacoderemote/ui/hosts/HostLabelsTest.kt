package com.idachev.supacoderemote.ui.hosts

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
}
