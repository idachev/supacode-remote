package com.idachev.supacoderemote.alerts

import com.idachev.supacoderemote.protocol.AgentActivity
import com.idachev.supacoderemote.protocol.Repository

/** Таб, в който агент чака вход — всичко нужно за известието и за отваряне на терминала. */
data class AwaitingTab(
  val contentId: String,
  val repositoryId: String,
  val worktreeId: String,
  val worktreeName: String,
  val tabTitle: String,
  val agent: String,
)

/**
 * Кога агент **започва** да чака вход.
 *
 * Известие има само при прехода към `awaitingInput`. Докато табът стои в това състояние,
 * нови `list` отговори не дават второ известие; щом излезе от него (или табът изчезне),
 * следващото чакане е ново събитие.
 */
class AwaitingTracker {

  /** Табовете, които чакат в момента, по `contentId`. */
  private var awaiting: Map<String, AwaitingTab> = emptyMap()

  data class Changes(
    /** Започнаха да чакат: известие. */
    val started: List<AwaitingTab>,
    /** Вече не чакат: известието им се маха. */
    val ended: List<String>,
  )

  fun update(repos: List<Repository>): Changes {
    val now = buildMap {
      repos.forEach { repo ->
        repo.worktrees.forEach { wt ->
          wt.tabs.forEach { tab ->
            val agent = tab.agents.firstOrNull { AgentActivity.of(it.activity) == AgentActivity.AWAITING_INPUT }
            if (agent != null) {
              put(
                tab.contentId,
                AwaitingTab(
                  contentId = tab.contentId,
                  repositoryId = repo.id,
                  worktreeId = wt.id,
                  worktreeName = wt.displayName,
                  tabTitle = tab.title?.ifBlank { null } ?: "Таб",
                  agent = agent.agent,
                ),
              )
            }
          }
        }
      }
    }
    val started = now.values.filter { it.contentId !in awaiting }
    val ended = awaiting.keys.filter { it !in now }
    awaiting = now
    return Changes(started, ended)
  }
}
