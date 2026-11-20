package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged

/**
 * Кой път (relay сокетът или LAN сесията) носи потока на всеки терминал към екраните.
 *
 * С `attach keep` по една връзка текат няколко терминала, затова решението е по терминал: всеки
 * има свой текущ път ([current]) и свой чакащ attach ([pending]). При смяна на пътя терминалът за
 * кратко тече и по двата. Към екрана минава само потокът по текущия път на терминала. Нов
 * `attach` по друг път не го сменя веднага: старият поток тече, докато не дойде `attached` на
 * новия (той носи екрана наново), и чак тогава пътят се сменя, а attach-овете по другите пътища
 * се спират с `detach` ([Decision.detach]) — и на скритите терминали: те не се местят между
 * пътищата, а получават нов attach, когато се покажат (ДЗ8a). Терминал, който също чака
 * `attached` по новия път, не се спира: той сменя пътя със своя `attached`. Кадри по път, който не е текущ за
 * своя терминал (закъснели, от паднала връзка, от стар attach), се изхвърлят.
 *
 * Не е thread-safe: [RelayClient] го пази с lock и пита [accept] в реда на доставка.
 */
internal class TerminalStreamGate {

  /** [deliver] — към екраните ли; [detach] — по кои пътища да тръгне `detach` за кой терминал. */
  data class Decision(val deliver: Boolean, val detach: List<Pair<Any, String>> = emptyList())

  private data class Pending(val via: Any, val id: Int)

  /** Терминал → пътят, чийто `attached` го е направил текущ. */
  private val current = HashMap<String, Any>()

  /** Терминал → attach-ът, чийто `attached` още не е дошъл. */
  private val pending = HashMap<String, Pending>()

  /**
   * Последният `attach` за всеки терминал. По жицата `detach` носи само contentId, затова
   * екран, чийто attach вече е заменен от нов екран със същия терминал, не бива да го праща.
   */
  private val latestAttachId = HashMap<String, Int>()

  /**
   * Пътищата, по които Mac-ът държи (или ще държи) наш attach, и терминалите им. С реда на
   * вкарване: `detach`-овете тръгват в предвидим ред.
   */
  private val attachedOn = LinkedHashMap<Any, LinkedHashSet<String>>()

  /**
   * `attach` е тръгнал по [via]. Викай преди отговорът да може да бъде обработен. Без [keep]
   * Mac-ът откача всички други терминали по [via]: те вече нямат поток там, а чакащите им
   * attach-ове по него се отменят (както преди `keep` с един чакащ attach).
   */
  fun attachSent(via: Any, id: Int, contentId: String, keep: Boolean = false) {
    if (!keep) {
      attachedOn[via]?.filter { it != contentId }?.forEach { forget(via, it) }
      pending.entries.removeAll { it.key != contentId && it.value.via === via }
    }
    pending[contentId] = Pending(via, id)
    latestAttachId[contentId] = id
    attachedOn.getOrPut(via) { LinkedHashSet() }.add(contentId)
  }

  /**
   * `detach` за [contentId] е тръгнал по [via]: потокът му спира; връща другите пътища със
   * същия терминал. Другите терминали по [via] не се пипат — `detach` спира само своя.
   */
  fun detachSent(via: Any, contentId: String): List<Pair<Any, String>> {
    pending.remove(contentId)
    attachedOn[via]?.remove(contentId)
    latestAttachId.remove(contentId)
    // По кой път е тръгнал, няма значение: той спира терминала и по другите пътища.
    current.remove(contentId)
    return takeAttached { _, terminal -> terminal == contentId }
  }

  /**
   * ДЗ8a: скрит терминал при нова сесия по [current] — Mac-ът още го държи по другите живи
   * пътища (relay сокетът при преминаване на LAN), а там той вече не бива да тече. Маха двойките
   * и ги връща за `detach`; паднал път ([closed]) вече го няма тук, затова по него нищо не тръгва.
   */
  fun takeOtherPaths(contentId: String, current: Any): List<Pair<Any, String>> =
    takeAttached { path, terminal -> terminal == contentId && path !== current }

  /**
   * `detach` от екран, чийто последен attach е [attachId], е остарял: след него друг екран
   * е закачил същия терминал (бързо A→B→A), и той би спрял потока на новия екран.
   */
  fun isStaleDetach(contentId: String, attachId: Int?): Boolean {
    val latest = latestAttachId[contentId] ?: return false
    return latest != attachId
  }

  /** Mac-ът държи (или ще държи) наш attach за [contentId] по някой от живите пътища. */
  fun isAttached(contentId: String): Boolean =
    attachedOn.values.any { contentId in it } || contentId in pending

  /** Пътят е паднал: Mac-ът е забравил attach-овете по него, кадрите му вече не се приемат. */
  fun closed(source: Any) {
    attachedOn.remove(source)
    current.entries.removeAll { it.value === source }
    pending.entries.removeAll { it.value.via === source }
  }

  fun accept(source: Any, message: ServerMessage): Decision {
    val contentId = streamContentId(message) ?: return Decision(deliver = true)
    if (message is Attached && isAwaited(message, source)) return switchPath(source, contentId)
    if (current[contentId] !== source) return Decision(deliver = false)
    if (message is Detached) attachedOn[source]?.remove(contentId)
    return Decision(deliver = true)
  }

  /** [attached] отговаря на чакащия attach по [source]: `id`-то се сверява само ако го има. */
  private fun isAwaited(attached: Attached, source: Any): Boolean {
    val wait = pending[attached.contentId] ?: return false
    return wait.via === source && (attached.id == null || attached.id == wait.id)
  }

  /** `attached` на чакащия attach: [source] става текущият път на терминала. */
  private fun switchPath(source: Any, contentId: String): Decision {
    pending.remove(contentId)
    current[contentId] = source
    attachedOn.getOrPut(source) { LinkedHashSet() }.add(contentId)
    // По другите пътища спира самият терминал и скритите; терминал, който също чака attached по
    // този път, тече по стария си път до своя attached (ДЗ14).
    val detach = takeAttached { path, terminal ->
      path !== source && (terminal == contentId || pending[terminal]?.via !== source)
    }
    return Decision(deliver = true, detach = detach)
  }

  /** Mac-ът вече не държи [contentId] по [path]: без поток и без чакащ attach там. */
  private fun forget(path: Any, contentId: String) {
    attachedOn[path]?.remove(contentId)
    if (current[contentId] === path) current.remove(contentId)
    // Чакащ attach, отменен с detach: закъснелият му `attached` не бива да стане текущ и да
    // спре терминала по новия път.
    if (pending[contentId]?.via === path) pending.remove(contentId)
  }

  /** Маха двойките (път, терминал), за които [match] е вярно, и ги връща за `detach`. */
  private fun takeAttached(match: (Any, String) -> Boolean): List<Pair<Any, String>> {
    val taken = attachedOn.flatMap { (path, terminals) -> terminals.filter { match(path, it) }.map { path to it } }
    taken.forEach { (path, terminal) -> forget(path, terminal) }
    attachedOn.entries.removeAll { it.value.isEmpty() }
    return taken
  }

  private companion object {
    /** Терминалът на кадъра от потока; `null` — не е от потока на терминал и минава винаги. */
    fun streamContentId(message: ServerMessage): String? = when (message) {
      is Attached -> message.contentId
      is Output -> message.contentId
      is SizeChanged -> message.contentId
      is Detached -> message.contentId
      else -> null
    }
  }
}
