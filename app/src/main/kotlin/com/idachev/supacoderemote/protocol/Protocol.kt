package com.idachev.supacoderemote.protocol

import com.idachev.supacoderemote.relay.LanInfo
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/*
 * Протоколът v1 от docs/remote-access-protocol.md в repo-то на Supacode. Той е договорът
 * между телефона, relay-а и Mac-а, затова имената на полетата са точно неговите.
 */

/** Съобщение от телефона към host-а (през relay-а). Полето `t` идва от [SerialName]. */
@Serializable
sealed interface ClientMessage

@Serializable
@SerialName("hello")
data class HelloRequest(val v: Int = PROTOCOL_VERSION) : ClientMessage

@Serializable
@SerialName("list")
data class ListRequest(val id: Int) : ClientMessage

@Serializable
@SerialName("attach")
data class AttachRequest(val id: Int, val contentId: String, val scrollback: Int = ATTACH_SCROLLBACK) : ClientMessage

@Serializable
@SerialName("detach")
data class DetachRequest(val contentId: String) : ClientMessage

@Serializable
@SerialName("input")
data class InputRequest(val contentId: String, val b64: String) : ClientMessage

@Serializable
@SerialName("suggest")
data class SuggestRequest(val id: Int, val contentId: String) : ClientMessage

/**
 * „Размер по този екран“: host-ът прави таба [cols] × [rows] (сам ги ограничава) и праща `size` на
 * всички закачени. Само по изрично натискане — телефонът никога не праща размер сам.
 */
@Serializable
@SerialName("resize")
data class ResizeRequest(val contentId: String, val cols: Int, val rows: Int) : ClientMessage

/**
 * Нов терминален таб в worktree [worktreeId]; отговорът е [TabNewReply] или `error` със същото [id].
 * [cols] и [rows] са началният размер — винаги двете или нито едно (`null` се изпуска); без тях
 * host-ът дава до 120 × 40, а стар host ги пренебрегва.
 */
@Serializable
@SerialName("tab.new")
data class TabNewRequest(val id: Int, val worktreeId: String, val cols: Int? = null, val rows: Int? = null) :
  ClientMessage

/**
 * Нов worktree в repository [repositoryId] с branch [name] (ЗД11), като бутона „+“ на repository-то в
 * Supacode. Името е задължително — host-ът отказва празно. [cols] и [rows] са размерът на първия
 * таб, по правилата на [TabNewRequest]; Mac-ът показва новия worktree и табът после взима неговия
 * размер. Отговорът е [WorktreeNewReply] или `error` със същото [id].
 */
@Serializable
@SerialName("worktree.new")
data class WorktreeNewRequest(
  val id: Int,
  val repositoryId: String,
  val name: String,
  val cols: Int? = null,
  val rows: Int? = null,
) : ClientMessage

/**
 * Изтрива worktree [worktreeId] на Mac-а (ЗД13). Branch-ът остава винаги, а worktree с незаписани
 * промени Mac-ът отказва с `worktree_dirty`. Отговорът е [WorktreeDeleteReply] или `error`.
 */
@Serializable
@SerialName("worktree.delete")
data class WorktreeDeleteRequest(val id: Int, val worktreeId: String) : ClientMessage

/**
 * Mac-ът да прочете worktree-тата от git наново (ЗД13): след изтриване от терминала списъкът му
 * иначе остава стар. Отговорът е `list` със същото [id] или `error` `refresh_timeout`.
 */
@Serializable
@SerialName("worktrees.refresh")
data class WorktreesRefreshRequest(val id: Int) : ClientMessage

/** Съобщение към телефона: от relay-а (`relay`, `error`) или от host-а. */
sealed interface ServerMessage

/**
 * Състоянието от relay-а. [hostOnline] е за свързания Mac ([host]). [hosts] е `null` при стар
 * relay (един Mac, без списък) и празен списък при нов relay, който още не познава Mac — затова
 * е nullable. [host] липсва за връзка без избран Mac.
 */
@Serializable
data class RelayStatus(
  val hostOnline: Boolean,
  val host: String? = null,
  val hosts: List<HostInfo>? = null,
) : ServerMessage

/** Mac, който relay-ят познава. Без [name] телефонът показва „Mac без име“. */
@Serializable
data class HostInfo(val id: String, val name: String? = null, val online: Boolean = false)

@Serializable
data class HelloReply(
  val v: Int = PROTOCOL_VERSION,
  val host: String? = null,
  /** Mac-ът е в същата мрежа и слуша там (раздел „LAN shortcut“). */
  val lan: LanInfo? = null,
  /** Id-то на Mac-а, който отговаря; липсва при стар Supacode. */
  val hostId: String? = null,
  /** Версията на Supacode на Mac-а, напр. „Supacode 0.11.5 (154)“; стар host я изпуска. */
  val app: String? = null,
) : ServerMessage

/**
 * Отговорът на `list`. [sections] е sidebar-ът на Supacode по ред (Active, Pinned, групи,
 * repository-та); стар host не го праща — тогава екранът групира сам по `status`.
 */
@Serializable
data class ListReply(
  val id: Int? = null,
  val repos: List<Repository> = emptyList(),
  val sections: List<SidebarSection> = emptyList(),
  /** Mac-ът може да прочете worktree-тата наново (`worktrees.refresh`); стар host го изпуска. */
  val canRefreshWorktrees: Boolean = false,
  /** Repository-тата, които Mac-ът не прочете; изпуска се, когато няма. */
  val loadFailures: List<LoadFailure> = emptyList(),
) : ServerMessage

/**
 * Една секция на sidebar-а. [kind] е `active` / `pinned` (редове worktree-та от всички
 * repository-та в [worktreeIds]), `group` (заглавие на група с [repositoryIds]) или
 * `repository` (repository без група, [repositoryId]). Низ, а не enum: непознат вид се
 * прескача, вместо да чупи списъка.
 */
@Serializable
data class SidebarSection(
  val kind: String,
  val title: String? = null,
  val collapsed: Boolean = false,
  val worktreeIds: List<String> = emptyList(),
  val repositoryIds: List<String> = emptyList(),
  val repositoryId: String? = null,
) {
  companion object {
    const val ACTIVE = "active"
    const val PINNED = "pinned"
    const val GROUP = "group"
    const val REPOSITORY = "repository"
  }
}

@Serializable
data class Attached(val id: Int? = null, val contentId: String, val cols: Int, val rows: Int) : ServerMessage

@Serializable
data class Output(val contentId: String, val b64: String) : ServerMessage

@Serializable
data class SizeChanged(val contentId: String, val cols: Int, val rows: Int) : ServerMessage

@Serializable
data class Detached(val contentId: String, val reason: String? = null) : ServerMessage

@Serializable
data class Suggestions(val id: Int? = null, val contentId: String, val suggestions: List<String> = emptyList()) :
  ServerMessage

/** Mac-ът е отворил новия таб; телефонът сам прави `attach` към [contentId]. */
@Serializable
data class TabNewReply(val id: Int? = null, val worktreeId: String = "", val tabId: String = "", val contentId: String) :
  ServerMessage

/**
 * Worktree-то е създадено. [tabId] и [contentId] са първият му таб, към който телефонът сам прави
 * `attach`; липсват заедно, когато табът не се е отворил — пак е успех, а таб се отваря с „Нов таб“.
 */
@Serializable
data class WorktreeNewReply(
  val id: Int? = null,
  val repositoryId: String = "",
  val worktreeId: String,
  val name: String = "",
  val tabId: String? = null,
  val contentId: String? = null,
) : ServerMessage

/** Worktree-то е изтрито; в следващия `list` го няма. Branch-ът му остава. */
@Serializable
data class WorktreeDeleteReply(val id: Int? = null, val worktreeId: String, val repositoryId: String = "") : ServerMessage

/**
 * Repository, което Mac-ът не успя да прочете (ЗД13): то липсва в `repos`, а [message] казва защо —
 * за да не изглежда като изтрито.
 */
@Serializable
data class LoadFailure(val repositoryId: String, val message: String = "")

/**
 * Грешка от host-а или relay-а. [code] е машинната причина ([RESIZE_FAILED], `worktree_*`) — низ, а
 * не enum: непознат код не бива да чупи четенето, екранът показва [message]. [contentId] е
 * терминалът, за който е грешката, при заявки без `id` (`resize`).
 */
@Serializable
data class ErrorReply(
  val id: Int? = null,
  val message: String = "",
  val code: String? = null,
  val contentId: String? = null,
) : ServerMessage {
  companion object {
    const val RESIZE_FAILED = "resize_failed"

    /** Отказите на `worktree.new` (ЗД11): всички започват така и се показват в диалога. */
    const val WORKTREE_PREFIX = "worktree_"

    /** Mac-ът не е разбрал до 300 s; worktree-то може пак да се появи в списъка. */
    const val WORKTREE_TIMEOUT = "worktree_timeout"

    /** Worktree-то има незаписани промени; [message] изброява файловете. */
    const val WORKTREE_DIRTY = "worktree_dirty"

    /** `worktrees.refresh` не е свършил до 60 s. */
    const val REFRESH_TIMEOUT = "refresh_timeout"
  }
}

/**
 * Repository от sidebar-а на Supacode. [group] е групата на sidebar-а (напр. „Work“);
 * host-ът изпуска полето, когато repository-то не е в група. [rowIds] са worktree-тата,
 * които sidebar-ът показва под него, без вдигнатите в Active / Pinned; `null` при стар host.
 */
@Serializable
data class Repository(
  val id: String,
  val name: String,
  val group: String? = null,
  val rowIds: List<String>? = null,
  val worktrees: List<Worktree> = emptyList(),
  /** Може ли Mac-ът да създаде worktree тук (ЗД11); стар host го изпуска — значи не. */
  val canCreateWorktree: Boolean = false,
)

/**
 * Worktree. `status` остава низ, а не enum: нова стойност от Mac-а не бива да чупи
 * четенето на целия списък. Групата се смята в [WorktreeStatus.of].
 */
@Serializable
data class Worktree(
  val id: String,
  val name: String,
  val branch: String? = null,
  val status: String = WorktreeStatus.UNPINNED.wire,
  val focused: Boolean = false,
  val title: String? = null,
  val working: Boolean = false,
  val tabs: List<Tab> = emptyList(),
  /** Може ли да се изтрие от телефона (ЗД13): не основният, не зает; стар host го изпуска. */
  val canDeleteWorktree: Boolean = false,
) {
  /** Собственото заглавие, ако е дадено в Supacode, иначе името на worktree-то. */
  val displayName: String get() = title?.takeIf { it.isNotBlank() } ?: name
}

/** Таб в worktree. `contentId` е id-то, с което работят terminal съобщенията. */
@Serializable
data class Tab(
  val id: String,
  val contentId: String,
  val title: String? = null,
  val focused: Boolean = false,
  val working: Boolean = false,
  val readOnly: Boolean = false,
  val agents: List<AgentBadge> = emptyList(),
)

/** Агент в таб. И двете полета са суровите стойности от Supacode (`claude`, `busy` …). */
@Serializable
data class AgentBadge(val agent: String, val activity: String)

enum class WorktreeStatus(val wire: String) {
  MAIN("main"),
  PINNED("pinned"),
  UNPINNED("unpinned");

  companion object {
    /** Непознат статус отива в „Активни“ — там Supacode слага всичко, което не е main или pinned. */
    fun of(wire: String): WorktreeStatus = entries.firstOrNull { it.wire == wire } ?: UNPINNED
  }
}

enum class AgentActivity(val wire: String) {
  BUSY("busy"),
  AWAITING_INPUT("awaitingInput"),
  IDLE("idle"),
  ERROR("error"),
  COMPACTING("compacting"),
  UNKNOWN("");

  companion object {
    fun of(wire: String): AgentActivity = entries.firstOrNull { it.wire == wire } ?: UNKNOWN
  }
}

const val PROTOCOL_VERSION = 1
const val ATTACH_SCROLLBACK = 500

/** Текстът на keepalive-а. Не е JSON. */
const val PING = "ping"
const val PONG = "pong"

/** Четене и писане на съобщенията. Един [Json] за целия протокол. */
object ProtocolCodec {

  val json: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    classDiscriminator = "t"
  }

  fun encode(message: ClientMessage): String = json.encodeToString(ClientMessage.serializer(), message)

  /**
   * Връща `null` за `pong`, за непознат тип и за счупен JSON: нищо от relay-а не бива
   * да спира връзката. Типът се чете ръчно, защото `list`, `suggest` и `tab.new` имат едно и също
   * `t` в двете посоки.
   */
  fun decode(text: String): ServerMessage? {
    if (text == PONG || text == PING) return null
    return try {
      val obj: JsonObject = json.parseToJsonElement(text).jsonObject
      val serializer = when (obj["t"]?.jsonPrimitive?.contentOrNull) {
        "relay" -> RelayStatus.serializer()
        "hello" -> HelloReply.serializer()
        "list" -> ListReply.serializer()
        "attached" -> Attached.serializer()
        "out" -> Output.serializer()
        "size" -> SizeChanged.serializer()
        "detached" -> Detached.serializer()
        "suggest" -> Suggestions.serializer()
        "tab.new" -> TabNewReply.serializer()
        "worktree.new" -> WorktreeNewReply.serializer()
        "worktree.delete" -> WorktreeDeleteReply.serializer()
        "error" -> ErrorReply.serializer()
        else -> return null
      }
      json.decodeFromJsonElement(serializer, obj)
    } catch (_: SerializationException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    }
  }
}
