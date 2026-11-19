package com.idachev.supacoderemote.terminal

import android.content.ComponentCallbacks2
import com.idachev.supacoderemote.Notices
import com.idachev.supacoderemote.protocol.Caps
import com.idachev.supacoderemote.protocol.ListReply
import com.idachev.supacoderemote.relay.HostLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.launch

/**
 * Живите терминали (ДЗ7, ДЗ17): последните [limit] отворени таба остават закачени (`attach` с
 * `keep`), за да е връщането към тях без мрежа. Подредени по последно отваряне (LRU); над
 * тавана най-отдавна видяният получава `detach`. Живее колкото процеса (в `AppContainer`).
 *
 * Без `attach.keep` в caps на Mac-а (стар Mac) Mac-ът държи един attach на връзка, затова
 * наборът е само видимият, както преди (ДЗ7.3, АЦ3). Ключът е `contentId`: заглавието на таба
 * се сменя постоянно, а Mac-ът е един — смяна на Mac или ключ изчиства пула ([resets], ДЗ13).
 *
 * [scope] трябва да е на main нишката: сесиите споделят състояние с екраните.
 */
class TerminalPool(
  private val link: HostLink,
  private val notices: Notices,
  private val scope: CoroutineScope,
  private val limit: Int = LIMIT,
  private val pauseCapBytes: Long = OutputPause.CAP_BYTES,
  private val hiddenCapBytes: Long = HiddenOutput.DEFAULT_CAP_BYTES,
  /** Всяка нова стойност след първата (друг Mac, нов ключ) изчиства пула. */
  resets: Flow<Any?> = emptyFlow(),
  private val log: (String) -> Unit = {},
  /** Часовникът за „дълго във фон“: замразен процес не върти таймера, но часовникът върви. */
  private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {

  private val entries = ArrayList<TerminalSession>()

  /** Кога приложението е отишло във фон; `null` — пред очите е. */
  private var backgroundedAt: Long? = null
  private var backgroundShrink: Job? = null

  /** Живите терминали, първият е последно отвореният. */
  val sessions: List<TerminalSession> get() = entries.toList()

  private val events = object : TerminalSession.Events {
    override fun attachSent(session: TerminalSession, keep: Boolean) {
      if (keep) return
      // Attach без keep откача всички други на връзката (виж протокола, „attach / detach“).
      entries.filter { it !== session }.forEach { it.markNeedsAttach() }
    }

    override fun attachLimit(session: TerminalSession) {
      log("attach_limit за ${session.contentId}: пулът се свива до видимия")
      entries.filter { it !== session }.forEach { release(it) }
    }

    override fun detachedWhileHidden(session: TerminalSession) {
      release(session, detach = false)
    }
  }

  init {
    scope.launch { resets.drop(1).collect { clear() } }
    scope.launch { link.messages.filterIsInstance<ListReply>().collect(::onList) }
  }

  /**
   * Екран [owner] показва таба [contentId]: живият терминал от пула или нов. Таб от пула, който
   * Mac-ът още държи, не праща нищо (ДЗ7.1).
   */
  fun open(contentId: String, owner: Any): TerminalSession {
    val session = entries.firstOrNull { it.contentId == contentId }
      ?: TerminalSession(link, contentId, notices, scope, pauseCapBytes, hiddenCapBytes, events)
    entries.remove(session)
    entries.add(0, session)
    session.owner = owner
    // Стар Mac (caps без attach.keep): един таб на връзка. Неизвестни caps (нов сокет преди
    // hello) не пускат нищо — другите вече са „нужен attach“ след новата сесия.
    val caps = link.hostCaps.value
    if (caps != null && Caps.ATTACH_KEEP !in caps) entries.filter { it !== session }.forEach { release(it) }
    while (entries.size > limit) release(entries.last())
    session.show()
    return session
  }

  /**
   * Екран [owner] вече не показва таба. Табът остава в пула скрит; без `attach.keep` (или
   * преди caps да са известни) — `detach`, както преди. Излизане на екран, чийто таб вече е
   * отворен от по-нов екран (бързо A → назад → A), не значи нищо.
   */
  fun leave(contentId: String, owner: Any) {
    val session = entries.firstOrNull { it.contentId == contentId } ?: return
    if (session.owner !== owner) return
    session.owner = null
    val caps = link.hostCaps.value
    if (caps == null || Caps.ATTACH_KEEP !in caps) release(session) else session.hide()
  }

  /** Недостиг на памет или дълго във фон (ДЗ20): остава само видимият. */
  fun shrinkToVisible() {
    entries.filter { !it.visible }.forEach { release(it) }
  }

  /**
   * Приложението отиде във фон (ДЗ20): скритите табове не теглят данни — `detach` и „нужен
   * attach“; терминалите им остават и при показване тръгва нов attach. След
   * [BACKGROUND_SHRINK_MS] във фон пулът се свива до видимия: до 4 WebView-та в паметта на
   * приложение, което може и да не се върне, са много.
   */
  fun backgrounded() {
    entries.filter { !it.visible && !it.needsAttach }.forEach {
      link.detach(it.contentId, it.lastAttachId)
      it.markNeedsAttach()
    }
    backgroundedAt = nowMs()
    backgroundShrink?.cancel()
    backgroundShrink = scope.launch {
      delay(BACKGROUND_SHRINK_MS)
      shrinkToVisible()
    }
  }

  /** Обратно пред очите: таймерът спира; ако процесът е бил замразен и времето е минало — свиване. */
  fun foregrounded() {
    backgroundShrink?.cancel()
    backgroundShrink = null
    val since = backgroundedAt ?: return
    backgroundedAt = null
    if (nowMs() - since >= BACKGROUND_SHRINK_MS) shrinkToVisible()
  }

  /** Друг Mac или нов ключ (ДЗ13): нито един терминал не е от новия. */
  fun clear() {
    entries.toList().forEach { release(it) }
  }

  /**
   * Скрит таб, изчезнал от списъка (затворен на Mac-а без `detached`, ДЗ12), излиза от пула.
   * Видимият остава: списък, поискан преди нов таб, още не го знае. Без сесия с host-а списъкът
   * е закъснял от стария Mac.
   */
  private fun onList(list: ListReply) {
    if (link.hostSession.value == null) return
    val alive = list.repos.flatMap { repo -> repo.worktrees.flatMap { wt -> wt.tabs.map { it.contentId } } }.toSet()
    entries.filter { !it.visible && it.contentId !in alive }.forEach { release(it) }
  }

  private fun release(session: TerminalSession, detach: Boolean = true) {
    entries.remove(session)
    session.release(detach)
  }

  companion object {
    /** Живи терминали на телефона (ЦЛ3). Mac-ът приема до 16 на връзка. */
    const val LIMIT = 4

    /** След толкова време във фон пулът се свива до видимия (ДЗ20, предложение на агента). */
    const val BACKGROUND_SHRINK_MS = 5 * 60_000L

    /**
     * `onTrimMemory`: свиване при недостиг на памет (RUNNING_LOW и по-сериозно, MODERATE и
     * COMPLETE). UI_HIDDEN и BACKGROUND само казват, че приложението е във фон — за това е
     * таймерът от [backgrounded].
     */
    @Suppress("DEPRECATION")
    fun shrinksOnTrim(level: Int): Boolean =
      level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
        level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
        level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE
  }
}
