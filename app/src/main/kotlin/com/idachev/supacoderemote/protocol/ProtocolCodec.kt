package com.idachev.supacoderemote.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

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
   * да спира връзката. Типът се чете ръчно, защото `list`, `watch`, `suggest` и `tab.new` имат едно
   * и също `t` в двете посоки. Пропуснат елемент на масив (`list`, `hello`, `relay`) отива в
   * [onSkip] с пътя си.
   */
  fun decode(text: String, onSkip: (String) -> Unit = {}): ServerMessage? {
    if (text == PONG || text == PING) return null
    return try {
      val obj: JsonObject = json.parseToJsonElement(text).jsonObject
      val serializer = when (obj["t"]?.jsonPrimitive?.contentOrNull) {
        "relay" -> return LossyReader(onSkip).decode(obj, RelayStatus.serializer(), relayArrays)
        "hello" -> return LossyReader(onSkip).decode(obj, HelloReply.serializer(), helloArrays)
        "list" -> return LossyReader(onSkip).decode(obj, ListReply.serializer(), listArrays)
        "watch" -> WatchReply.serializer()
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

  /**
   * Масив, който се чете елемент по елемент; [nested] са масивите вътре в елемента. С
   * [serializer] `null` полето е обект (`lan` в `hello`): само масивите в него се четат така.
   */
  private class LossyArray(
    val key: String,
    val serializer: KSerializer<*>?,
    val nested: List<LossyArray> = emptyList(),
  )

  private val relayArrays = listOf(LossyArray("hosts", HostInfo.serializer()))

  private val helloArrays = listOf(
    LossyArray("caps", String.serializer()),
    LossyArray("lan", null, listOf(LossyArray("addrs", String.serializer()))),
  )

  private val listArrays = listOf(
    LossyArray(
      "repos",
      Repository.serializer(),
      listOf(
        LossyArray("rowIds", String.serializer()),
        LossyArray(
          "worktrees",
          Worktree.serializer(),
          listOf(LossyArray("tabs", Tab.serializer(), listOf(LossyArray("agents", AgentBadge.serializer())))),
        ),
      ),
    ),
    LossyArray(
      "sections",
      SidebarSection.serializer(),
      listOf(LossyArray("worktreeIds", String.serializer()), LossyArray("repositoryIds", String.serializer())),
    ),
    LossyArray("loadFailures", LoadFailure.serializer()),
  )

  /**
   * Четенето елемент по елемент (КЛ3 / КЛ7, R31 на Mac клиента). [onSkip] е в обекта, защото минава
   * през всяко ниво; вътрешен елемент получава свой читател, за да се докладва пропуснатото в него
   * само ако самият той се чете.
   */
  private class LossyReader(private val onSkip: (String) -> Unit) {

    /**
     * Съобщението първо се чете цяло. Ако не става, се чете наново елемент по елемент: лош елемент
     * на масив се пропуска, а не губи целия кадър — един таб с непознат вид не бива да скрие всички
     * табове, а една непозната стойност в `caps` — целия `hello`. Поле, което изобщо не е масив,
     * прави собственика си лош елемент, а на най-горното ниво — целия кадър.
     */
    fun <T : ServerMessage> decode(obj: JsonObject, serializer: KSerializer<T>, arrays: List<LossyArray>): T =
      try {
        json.decodeFromJsonElement(serializer, obj)
      } catch (_: SerializationException) {
        json.decodeFromJsonElement(serializer, readableArrays(obj, arrays, ""))
      }

    /** Копие на [obj], в което масивите от [arrays] държат само елементите, които се четат. */
    fun readableArrays(obj: JsonObject, arrays: List<LossyArray>, path: String): JsonObject {
      val out = obj.toMutableMap()
      for (array in arrays) {
        val value = obj[array.key]
        if (value == null || value is JsonNull) continue
        out[array.key] = readableField(value, array, if (path.isEmpty()) array.key else "$path.${array.key}")
      }
      return JsonObject(out)
    }

    /** Стойността на поле от [LossyArray]: масивът без елементите, които не се четат. */
    private fun readableField(value: JsonElement, array: LossyArray, path: String): JsonElement {
      if (array.serializer == null) {
        // Обект с масиви вътре; друг тип тук оставя строгото четене да откаже кадъра.
        return if (value is JsonObject) readableArrays(value, array.nested, path) else value
      }
      val items = value as? JsonArray ?: throw SerializationException("${array.key} не е масив")
      return JsonArray(items.mapIndexedNotNull { index, item -> readable(item, array, "$path[$index]") })
    }

    /**
     * Елементът с прочетените вътрешни масиви или `null`, ако не се чете. В [onSkip] отиват само
     * имената на полетата и индексите, никога стойност. Пропуснатото вътре в лош елемент не се
     * докладва: пропуска се целият елемент.
     */
    private fun readable(item: JsonElement, array: LossyArray, path: String): JsonElement? {
      val serializer = array.serializer ?: return item
      val inner = mutableListOf<String>()
      return try {
        val clean = if (array.nested.isNotEmpty() && item is JsonObject) {
          LossyReader(inner::add).readableArrays(item, array.nested, path)
        } else {
          item
        }
        json.decodeFromJsonElement(serializer, clean)
        inner.forEach(onSkip)
        clean
      } catch (_: RuntimeException) {
        // Освен SerializationException: обект на мястото на низ (`rowIds:[{}]`) kotlinx отказва с
        // IndexOutOfBoundsException, защото тук елементът се чете сам, а не вътре в обект.
        onSkip(path)
        null
      }
    }
  }
}
