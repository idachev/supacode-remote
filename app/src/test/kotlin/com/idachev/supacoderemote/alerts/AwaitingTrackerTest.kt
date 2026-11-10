package com.idachev.supacoderemote.alerts

import com.idachev.supacoderemote.protocol.AgentBadge
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.Tab
import com.idachev.supacoderemote.protocol.Worktree
import org.junit.Assert.assertEquals
import org.junit.Test

class AwaitingTrackerTest {

  private val tracker = AwaitingTracker()

  private fun repos(vararg tabs: Pair<String, List<String>>) = listOf(
    Repository(
      id = "r",
      name = "supacode",
      worktrees = listOf(
        Worktree(
          id = "w",
          name = "remote-access",
          title = "Remote access",
          tabs = tabs.map { (contentId, activities) ->
            Tab(
              id = "t-$contentId",
              contentId = contentId,
              title = "tab $contentId",
              agents = activities.map { AgentBadge("claude", it) },
            )
          },
        ),
      ),
    ),
  )

  private fun started(vararg tabs: Pair<String, List<String>>) = tracker.update(repos(*tabs)).started.map { it.contentId }

  @Test
  fun `известие само при прехода към awaitingInput`() {
    assertEquals(emptyList<String>(), started("a" to listOf("busy")))
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput")))
    // Същото състояние на следващия list: без второ известие.
    assertEquals(emptyList<String>(), started("a" to listOf("awaitingInput")))
    assertEquals(emptyList<String>(), started("a" to listOf("awaitingInput")))
  }

  @Test
  fun `след излизане от awaitingInput следващото чакане е ново известие`() {
    started("a" to listOf("awaitingInput"))
    val left = tracker.update(repos("a" to listOf("busy")))
    assertEquals(listOf("a"), left.ended)
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput")))
  }

  @Test
  fun `изчезнал таб се забравя`() {
    started("a" to listOf("awaitingInput"))
    assertEquals(listOf("a"), tracker.update(emptyList()).ended)
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput")))
  }

  @Test
  fun `всеки таб поотделно и данните за известието`() {
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput"), "b" to listOf("idle")))
    assertEquals(listOf("b"), started("a" to listOf("awaitingInput"), "b" to listOf("busy", "awaitingInput")))
    val tab = AwaitingTracker().update(repos("c" to listOf("idle", "awaitingInput"))).started.single()
    assertEquals(AwaitingTab("c", "r", "w", "Remote access", "tab c", "claude"), tab)
  }

  @Test
  fun `два агента в таба, единият още чака — табът остава чакащ`() {
    started("a" to listOf("awaitingInput", "awaitingInput"))
    val changes = tracker.update(repos("a" to listOf("busy", "awaitingInput")))
    assertEquals(emptyList<String>(), changes.started.map { it.contentId })
    assertEquals(emptyList<String>(), changes.ended)
  }

  @Test
  fun `смяна на Mac-а връща чакащите и почва на чисто`() {
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput"), "b" to listOf("busy")))
    assertEquals(listOf("a"), tracker.reset())
    // Същият contentId на новия Mac е ново чакане, не продължение на старото.
    assertEquals(listOf("a"), started("a" to listOf("awaitingInput")))
    assertEquals(emptyList<String>(), AwaitingTracker().reset())
  }
}
