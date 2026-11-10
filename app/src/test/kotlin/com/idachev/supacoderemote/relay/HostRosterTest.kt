package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.HostInfo
import com.idachev.supacoderemote.protocol.RelayStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostRosterTest {

  private val roster = HostRoster()
  private val two = RelayStatus(false, hosts = listOf(HostInfo("a", "A", true), HostInfo("b", "B", true)))

  @Test
  fun `повторен списък, който пак иска избор, не вдига брояча втори път`() {
    roster.update(null, two)
    roster.update(null, two)
    assertEquals(1, roster.pickRequests.value)
    assertTrue(roster.pickPending.value)
  }

  @Test
  fun `решен избор и нов relay позволяват ново питане`() {
    roster.update(null, two)
    roster.pickResolved()
    roster.update(null, two)
    assertEquals(2, roster.pickRequests.value)
    roster.clear()
    assertFalse(roster.pickPending.value)
    assertFalse(roster.multiHost.value)
    assertEquals(emptyList<HostInfo>(), roster.hosts.value)
  }

  @Test
  fun `стар relay оставя списъка празен и режима с един Mac`() {
    assertEquals(HostChoice.Decision.None, roster.update("a", RelayStatus(true)))
    assertFalse(roster.multiHost.value)
    assertEquals(0, roster.pickRequests.value)
  }
}
