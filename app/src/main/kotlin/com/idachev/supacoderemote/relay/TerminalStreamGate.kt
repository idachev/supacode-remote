package com.idachev.supacoderemote.relay

import com.idachev.supacoderemote.protocol.Attached
import com.idachev.supacoderemote.protocol.Detached
import com.idachev.supacoderemote.protocol.Output
import com.idachev.supacoderemote.protocol.ServerMessage
import com.idachev.supacoderemote.protocol.SizeChanged

/**
 * Кой път (relay сокетът или LAN сесията) носи потока на терминала към екраните.
 *
 * Mac-ът държи по един `attach` на връзка, затова при смяна на пътя за кратко стриймят и двете.
 * Към екрана минава само потокът на [current]. Нов `attach` по друг път не го сменя веднага:
 * старият поток тече, докато не дойде `attached` на новия (той носи екрана наново), и чак тогава
 * пътят се сменя, а старите attach-ове се спират с `detach` ([Decision.detach]). Кадри от път,
 * който вече не е [current] (закъснели, от паднала връзка, от стар attach), се изхвърлят.
 *
 * Не е thread-safe: [RelayClient] го пази с lock и пита [accept] в реда на доставка.
 */
internal class TerminalStreamGate {

  /** [deliver] — към екраните ли; [detach] — по кои пътища да тръгне `detach` за кой терминал. */
  data class Decision(val deliver: Boolean, val detach: List<Pair<Any, String>> = emptyList())

  private data class Pending(val via: Any, val id: Int, val contentId: String)

  private var current: Any? = null

  /** Терминалът, чийто `attached` направи [current] текущ. */
  private var currentContentId: String? = null
  private var pending: Pending? = null

  /**
   * Последният `attach` за всеки терминал. По жицата `detach` носи само contentId, затова
   * екран, чийто attach вече е заменен от нов екран със същия терминал, не бива да го праща.
   */
  private val latestAttachId = HashMap<String, Int>()

  /** Пътищата, по които Mac-ът държи наш attach, и терминалът му. */
  private val attachedOn = LinkedHashMap<Any, String>()

  /** `attach` е тръгнал по [via]. Викай преди отговорът да може да бъде обработен. */
  fun attachSent(via: Any, id: Int, contentId: String) {
    pending = Pending(via, id, contentId)
    latestAttachId[contentId] = id
    attachedOn[via] = contentId
  }

  /** `detach` е тръгнал по [via]: потокът спира; връща другите пътища със същия терминал. */
  fun detachSent(via: Any, contentId: String): List<Pair<Any, String>> {
    if (pending?.contentId == contentId) pending = null
    if (attachedOn[via] == contentId) attachedOn.remove(via)
    latestAttachId.remove(contentId)
    // Само detach на текущия терминал спира потока: закъснял detach на предишен екран
    // (onCleared след attach-а на нов таб) иначе изхвърля целия изход на новия. По кой път
    // е тръгнал, няма значение: той спира терминала и по другите пътища.
    if (currentContentId == contentId) clearCurrent()
    return takeOthers(except = null, contentId = contentId)
  }

  /**
   * `detach` от екран, чийто последен attach е [attachId], е остарял: след него друг екран
   * е закачил същия терминал (бързо A→B→A), и той би спрял потока на новия екран.
   */
  fun isStaleDetach(contentId: String, attachId: Int?): Boolean {
    val latest = latestAttachId[contentId] ?: return false
    return latest != attachId
  }

  /** Пътят е паднал: Mac-ът е забравил attach-а по него, кадрите му вече не се приемат. */
  fun closed(source: Any) {
    attachedOn.remove(source)
    if (current === source) clearCurrent()
    if (pending?.via === source) pending = null
  }

  fun accept(source: Any, message: ServerMessage): Decision {
    if (!isTerminalStream(message)) return Decision(deliver = true)
    val wait = pending
    if (message is Attached && wait != null && wait.via === source && message.contentId == wait.contentId &&
      (message.id == null || message.id == wait.id)
    ) {
      pending = null
      current = source
      currentContentId = wait.contentId
      return Decision(deliver = true, detach = takeOthers(except = source, contentId = null))
    }
    if (source !== current) return Decision(deliver = false)
    if (message is Detached && attachedOn[source] == message.contentId) attachedOn.remove(source)
    return Decision(deliver = true)
  }

  private fun clearCurrent() {
    current = null
    currentContentId = null
  }

  private fun takeOthers(except: Any?, contentId: String?): List<Pair<Any, String>> {
    val others = attachedOn.entries
      .filter { it.key !== except && (contentId == null || it.value == contentId) }
      .map { it.key to it.value }
    others.forEach { attachedOn.remove(it.first) }
    return others
  }

  companion object {
    fun isTerminalStream(message: ServerMessage): Boolean =
      message is Attached || message is Output || message is SizeChanged || message is Detached
  }
}
