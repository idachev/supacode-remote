package com.idachev.supacoderemote.alerts

import com.idachev.supacoderemote.protocol.AgentActivity
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.Tab
import com.idachev.supacoderemote.protocol.Worktree

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

  /**
   * Смяна на Mac-а: чакащите табове са от стария (известията им се махат), а следващият `list`
   * е от новия и всяко чакане в него е ново.
   */
  fun reset(): List<String> = awaiting.keys.toList().also { awaiting = emptyMap() }

  fun update(repos: List<Repository>): Changes {
    val now = awaitingTabs(repos).associateBy { it.contentId }
    val started = now.values.filter { it.contentId !in awaiting }
    val ended = awaiting.keys.filter { it !in now }
    awaiting = now
    return Changes(started, ended)
  }

  /** Табовете с агент в `awaitingInput`, в реда на списъка. */
  private fun awaitingTabs(repos: List<Repository>): List<AwaitingTab> =
    repos.flatMap { repo -> repo.worktrees.map { repo to it } }
      .flatMap { (repo, wt) -> wt.tabs.mapNotNull { tab -> awaitingTab(repo, wt, tab) } }

  /** `null`, ако никой агент в таба не чака вход. */
  private fun awaitingTab(repo: Repository, wt: Worktree, tab: Tab): AwaitingTab? {
    val agent = tab.agents.firstOrNull { AgentActivity.of(it.activity) == AgentActivity.AWAITING_INPUT } ?: return null
    return AwaitingTab(
      contentId = tab.contentId,
      repositoryId = repo.id,
      worktreeId = wt.id,
      worktreeName = wt.displayName,
      tabTitle = tab.title?.ifBlank { null } ?: "Таб",
      agent = agent.agent,
    )
  }
}
