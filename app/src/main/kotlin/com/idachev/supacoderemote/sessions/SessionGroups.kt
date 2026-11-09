package com.idachev.supacoderemote.sessions

import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.protocol.Repository
import com.idachev.supacoderemote.protocol.SidebarSection
import com.idachev.supacoderemote.protocol.Worktree
import com.idachev.supacoderemote.protocol.WorktreeStatus

/** Групите на един repository по `status`: основен, закачени, активни (стар host без `sections`). */
data class RepositoryGroups(
  val repository: Repository,
  val main: List<Worktree>,
  val pinned: List<Worktree>,
  val active: List<Worktree>,
)

/** Един ред в списъка „Сесии“. */
sealed interface SessionRow {
  val key: String

  /** Глобалните секции „Active“ и „Pinned“ на sidebar-а, над групите. */
  data class SectionHeader(val id: String, val kind: String, val title: String) : SessionRow {
    override val key: String get() = "section:$id"
  }

  /**
   * Група от sidebar-а на Supacode, напр. „Work“. Сгъва се с докосване; [id] е
   * ключът за състоянието „сгъната“.
   */
  data class SidebarGroupHeader(val id: String, val name: String, val collapsed: Boolean = false) : SessionRow {
    override val key: String get() = "sidebar-group:$id"
  }

  data class RepositoryHeader(val repository: Repository) : SessionRow {
    override val key: String get() = "repo:${repository.id}"
  }

  /** „Закачени“ / „Активни“ под repository при стар host без `sections`. */
  data class GroupHeader(val repositoryId: String, val group: WorktreeStatus) : SessionRow {
    override val key: String get() = "group:$repositoryId:${group.wire}"
  }

  /**
   * Ред worktree. [repositoryName] е попълнено в секциите Active и Pinned, където редовете
   * са от различни repository-та и се показват като „repo · worktree“.
   */
  data class WorktreeRow(
    val repositoryId: String,
    val worktree: Worktree,
    val repositoryName: String? = null,
    val section: String = "",
  ) : SessionRow {
    override val key: String get() = "wt:$section:$repositoryId:${worktree.id}"
  }
}

object SessionGroups {

  /**
   * Подрежда по групи, без да пипа реда вътре в групата: host-ът вече праща реда на
   * sidebar-а, а тук само гарантираме main → pinned → активни, дори ако дойдат разбъркани.
   */
  fun of(repos: List<Repository>): List<RepositoryGroups> = repos.map { repo ->
    val byStatus = repo.worktrees.groupBy { WorktreeStatus.of(it.status) }
    RepositoryGroups(
      repository = repo,
      main = byStatus[WorktreeStatus.MAIN].orEmpty(),
      pinned = byStatus[WorktreeStatus.PINNED].orEmpty(),
      active = byStatus[WorktreeStatus.UNPINNED].orEmpty(),
    )
  }

  /**
   * Плоският списък за екрана. С `sections` е точно sidebar-ът на Supacode; без тях —
   * групиране по `status` във всеки repository. [collapsed] е изборът на телефона
   * по id на група; група без избор взима `collapsed` от Mac-а.
   *
   * Непразно [query] оставя само намереното ([filter]). Тогава всяка група с намерено е
   * разгъната, а групите без намерено изчезват с заглавието си: търси се, за да се стигне
   * до worktree-то, а не до сгънато заглавие. Изборът „сгъната“ не се пипа и се връща,
   * щом търсенето се изчисти.
   */
  fun rows(list: ListReply, collapsed: Map<String, Boolean> = emptyMap(), query: String = ""): List<SessionRow> =
    if (list.sections.isEmpty()) {
      rows(list.repos, collapsed, query)
    } else {
      sectionRows(list.repos, list.sections, collapsed, query.trim())
    }

  /**
   * Repository-тата, които отговарят на [query], без значение от главни и малки букви и с
   * търпими грешки ([FuzzyMatch]). Намерено име на repository-то оставя всичките му
   * worktree-та; иначе остават само worktree-тата с намерено име, заглавие или branch, а
   * repository без тях отпада.
   */
  fun filter(repos: List<Repository>, query: String): List<Repository> {
    val q = query.trim()
    if (q.isEmpty()) return repos
    return repos.mapNotNull { repo ->
      if (FuzzyMatch.matches(repo.name, q)) return@mapNotNull repo
      val found = repo.worktrees.filter { it.matches(q) }
      if (found.isEmpty()) null else repo.copy(worktrees = found)
    }
  }

  private fun Worktree.matches(q: String): Boolean =
    listOfNotNull(displayName, name, branch).any { FuzzyMatch.matches(it, q) }

  private fun sectionRows(
    allRepos: List<Repository>,
    sections: List<SidebarSection>,
    collapsed: Map<String, Boolean>,
    query: String,
  ): List<SessionRow> {
    val searching = query.isNotEmpty()
    val repos = filter(allRepos, query)
    val repoById = repos.associateBy { it.id }
    val owner = repos.flatMap { r -> r.worktrees.map { it.id to r } }.toMap()
    return buildList {
      sections.forEachIndexed { index, section ->
        when (section.kind) {
          SidebarSection.ACTIVE, SidebarSection.PINNED -> {
            val id = "$index:${section.kind}"
            val rows = section.worktreeIds.mapNotNull { wtId ->
              val repo = owner[wtId] ?: return@mapNotNull null
              val wt = repo.worktrees.first { it.id == wtId }
              SessionRow.WorktreeRow(repo.id, wt, repositoryName = repo.name, section = id)
            }
            if (rows.isNotEmpty()) {
              val title = section.title?.ifBlank { null }
                ?: if (section.kind == SidebarSection.ACTIVE) "Active" else "Pinned"
              add(SessionRow.SectionHeader(id, section.kind, title))
              addAll(rows)
            }
          }
          SidebarSection.GROUP -> {
            val id = "$index:${section.title.orEmpty()}"
            val groupRepos = section.repositoryIds.mapNotNull(repoById::get)
              .filter { !searching || it.shownWhileSearching(query) }
            if (searching && groupRepos.isEmpty()) return@forEachIndexed
            val isCollapsed = !searching && (collapsed[id] ?: section.collapsed)
            add(SessionRow.SidebarGroupHeader(id, section.title?.ifBlank { null } ?: "Група", isCollapsed))
            if (!isCollapsed) groupRepos.forEach { addRepository(it, "$index") }
          }
          SidebarSection.REPOSITORY -> section.repositoryId?.let(repoById::get)
            ?.takeIf { !searching || it.shownWhileSearching(query) }
            ?.let { addRepository(it, "$index") }
          else -> Unit
        }
      }
    }
  }

  /** Repository и редовете под него: `rowIds` по ред, а без тях — всичките му worktree-та. */
  private fun MutableList<SessionRow>.addRepository(repo: Repository, section: String) {
    add(SessionRow.RepositoryHeader(repo))
    repo.rows().forEach { add(SessionRow.WorktreeRow(repo.id, it, section = section)) }
  }

  private fun Repository.rows(): List<Worktree> {
    val byId = worktrees.associateBy { it.id }
    return rowIds?.mapNotNull(byId::get) ?: worktrees
  }

  /**
   * При търсене repository-то остава под групата си само с ред за показване или с намерено
   * име. Намереното worktree може да е само в Active / Pinned (не е в `rowIds`) и тогава
   * долу би стояло празно заглавие.
   */
  private fun Repository.shownWhileSearching(query: String): Boolean =
    FuzzyMatch.matches(name, query) || rows().isNotEmpty()

  /**
   * Групите на sidebar-а по `group` (стар host без `sections`): първо repository-тата без
   * група, после всяка група по реда на първата ѝ поява. Вътре редът е както е дошъл.
   */
  fun bySidebarGroup(repos: List<Repository>): List<Pair<String?, List<Repository>>> {
    val ungrouped = repos.filter { it.sidebarGroup == null }
    val grouped = repos.filter { it.sidebarGroup != null }.groupBy { it.sidebarGroup!! }
    return buildList {
      if (ungrouped.isNotEmpty()) add(null to ungrouped)
      grouped.forEach { (name, list) -> add(name to list) }
    }
  }

  /**
   * Резервният списък без `sections`: групата на sidebar-а има заглавие; основният
   * worktree стои веднага под името на repository-то; „Закачени“ и „Активни“ имат
   * заглавие само ако не са празни.
   */
  fun rows(repos: List<Repository>, collapsed: Map<String, Boolean> = emptyMap(), query: String = ""): List<SessionRow> =
    bySidebarGroup(filter(repos, query)).flatMap { (groupName, groupRepos) ->
      buildList {
        if (groupName != null) {
          val id = "group:$groupName"
          val isCollapsed = query.isBlank() && (collapsed[id] ?: false)
          add(SessionRow.SidebarGroupHeader(id, groupName, isCollapsed))
          if (isCollapsed) return@buildList
        }
        of(groupRepos).forEach { g ->
          val repoId = g.repository.id
          add(SessionRow.RepositoryHeader(g.repository))
          g.main.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          if (g.pinned.isNotEmpty()) {
            add(SessionRow.GroupHeader(repoId, WorktreeStatus.PINNED))
            g.pinned.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          }
          if (g.active.isNotEmpty()) {
            add(SessionRow.GroupHeader(repoId, WorktreeStatus.UNPINNED))
            g.active.forEach { add(SessionRow.WorktreeRow(repoId, it)) }
          }
        }
      }
    }

  /** Празно или само интервали име на група е „без група“. */
  private val Repository.sidebarGroup: String? get() = group?.trim()?.ifEmpty { null }

  fun findWorktree(repos: List<Repository>, repositoryId: String, worktreeId: String): Worktree? =
    repos.firstOrNull { it.id == repositoryId }?.worktrees?.firstOrNull { it.id == worktreeId }
}
