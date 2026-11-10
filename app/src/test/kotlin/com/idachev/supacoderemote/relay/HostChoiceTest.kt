package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.HostInfo
import com.idachev.supacoderemote.protocol.RelayStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class HostChoiceTest {

  private val office = HostInfo("office", "Office Mac", online = true)
  private val home = HostInfo("home", "Home Mac", online = true)
  private val mini = HostInfo("mini", "Mac mini", online = false)

  private fun status(vararg hosts: HostInfo, host: String? = null) =
    RelayStatus(hostOnline = hosts.any { it.id == host && it.online }, host = host, hosts = hosts.toList())

  @Test
  fun `стар relay без hosts — нищо, дори без записан Mac`() {
    assertEquals(HostChoice.Decision.None, HostChoice.decide(null, RelayStatus(true)))
    assertEquals(HostChoice.Decision.None, HostChoice.decide("office", RelayStatus(true)))
  }

  @Test
  fun `без записан и точно един онлайн — избира него`() {
    assertEquals(HostChoice.Decision.Select("office"), HostChoice.decide(null, status(office)))
    assertEquals(HostChoice.Decision.Select("office"), HostChoice.decide(null, status(office, mini)))
  }

  @Test
  fun `без записан и два или нула онлайн — пита потребителя`() {
    assertEquals(HostChoice.Decision.AskUser, HostChoice.decide(null, status(office, home)))
    assertEquals(HostChoice.Decision.AskUser, HostChoice.decide(null, status(mini)))
    assertEquals(HostChoice.Decision.AskUser, HostChoice.decide(null, status()))
  }

  @Test
  fun `записан Mac в списъка — нищо, дори да е извън линия или да има други онлайн`() {
    assertEquals(HostChoice.Decision.None, HostChoice.decide("mini", status(office, home, mini, host = "mini")))
    assertEquals(HostChoice.Decision.None, HostChoice.decide("default", status(HostInfo("default", online = true), host = "default")))
  }

  @Test
  fun `записан Mac, който липсва в списъка — пита, без да сменя избора`() {
    assertEquals(HostChoice.Decision.AskUser, HostChoice.decide("gone", status(office, host = "gone")))
  }
}
