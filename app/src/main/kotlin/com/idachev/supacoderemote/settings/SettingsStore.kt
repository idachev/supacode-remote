package com.idachev.supacoderemote.settings

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Адресът на relay-а и клиентският ключ — двете части на ключа за връзка. */
data class RelaySettings(val baseUrl: String, val apiKey: String)

/**
 * Избраният Mac (`hostId`), към който се връзва връзката с relay-а. Не е тайна. Отделен
 * интерфейс, за да го чете [com.idachev.supacoderemote.relay.RelayClient] още при първата
 * връзка и да се тества без Android.
 */
interface HostSelection {
  /** `null`, докато потребителят (или автоматичният избор) не е избрал Mac. */
  val selectedHostId: StateFlow<String?>

  fun setSelectedHostId(value: String?)
}

/** В паметта: за тестовете и докато няма друго. */
class MemoryHostSelection(initial: String? = null) : HostSelection {
  private val _selected = MutableStateFlow(initial)
  override val selectedHostId: StateFlow<String?> = _selected.asStateFlow()

  override fun setSelectedHostId(value: String?) {
    _selected.value = value
  }
}

interface SettingsStore : HostSelection {
  /** `null`, докато не е въведен ключ за връзка. */
  val settings: StateFlow<RelaySettings?>

  fun save(value: RelaySettings)

  /** „Известия, когато агент чака“. Не е тайна, затова не е криптирано. */
  val notifyAwaiting: StateFlow<Boolean>

  fun setNotifyAwaiting(value: Boolean)

  /** „Скрол стига до агента“: скрол отвъд историята на телефона стига до програмата (wheel). */
  val overscrollToProgram: StateFlow<Boolean>

  fun setOverscrollToProgram(value: Boolean)

  /** „Размер на текста“ в терминала: [TextSize.FIT] (по ширина) или px от [TextSize.FIXED]. */
  val textSize: StateFlow<Int>

  fun setTextSize(value: Int)
}

/**
 * „Размер на текста“: по подразбиране по ширина — шрифтът, при който колоните на Mac-а
 * влизат в екрана; иначе фиксиран размер в px. По-широк от екрана терминал се мести
 * хоризонтално.
 */
object TextSize {
  const val FIT = 0
  val FIXED = 7..16

  /** Непознато (стара или развалена стойност) е по ширина. */
  fun sanitize(value: Int): Int = if (value in FIXED) value else FIT

  fun label(value: Int): String = if (sanitize(value) == FIT) "По ширина" else "$value px"
}

/**
 * Пази настройките в private SharedPreferences, криптирани с AES-GCM ключ от Android
 * Keystore. Ключът не излиза от Keystore-а, затова копие на файла без телефона е безполезно.
 *
 * `EncryptedSharedPreferences` е deprecated, затова тук е същото на ръка, с Keystore-а
 * направо. Ако дешифрирането не стане (напр. файлът е върнат от backup на друг телефон),
 * настройките са `null` и „Настройка“ ги пита наново.
 */
class KeystoreSettingsStore(context: Context) : SettingsStore {

  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private val _settings = MutableStateFlow(load())
  override val settings: StateFlow<RelaySettings?> = _settings.asStateFlow()

  private val _notifyAwaiting = MutableStateFlow(prefs.getBoolean(KEY_NOTIFY, false))
  override val notifyAwaiting: StateFlow<Boolean> = _notifyAwaiting.asStateFlow()

  override fun setNotifyAwaiting(value: Boolean) {
    prefs.edit().putBoolean(KEY_NOTIFY, value).apply()
    _notifyAwaiting.value = value
  }

  private val _overscroll = MutableStateFlow(prefs.getBoolean(KEY_OVERSCROLL, true))
  override val overscrollToProgram: StateFlow<Boolean> = _overscroll.asStateFlow()

  override fun setOverscrollToProgram(value: Boolean) {
    prefs.edit().putBoolean(KEY_OVERSCROLL, value).apply()
    _overscroll.value = value
  }

  private val _textSize = MutableStateFlow(TextSize.sanitize(prefs.getInt(KEY_TEXT_SIZE, TextSize.FIT)))
  override val textSize: StateFlow<Int> = _textSize.asStateFlow()

  override fun setTextSize(value: Int) {
    val size = TextSize.sanitize(value)
    prefs.edit().putInt(KEY_TEXT_SIZE, size).apply()
    _textSize.value = size
  }

  private val _selectedHostId = MutableStateFlow(prefs.getString(KEY_SELECTED_HOST, null))
  override val selectedHostId: StateFlow<String?> = _selectedHostId.asStateFlow()

  override fun setSelectedHostId(value: String?) {
    prefs.edit().apply { if (value == null) remove(KEY_SELECTED_HOST) else putString(KEY_SELECTED_HOST, value) }.apply()
    _selectedHostId.value = value
  }

  override fun save(value: RelaySettings) {
    prefs.edit()
      .putString(KEY_URL, encrypt(value.baseUrl))
      .putString(KEY_API, encrypt(value.apiKey))
      .apply()
    _settings.value = value
  }

  private fun load(): RelaySettings? {
    val url = prefs.getString(KEY_URL, null) ?: return null
    val api = prefs.getString(KEY_API, null) ?: return null
    return try {
      RelaySettings(decrypt(url), decrypt(api))
    } catch (_: GeneralSecurityException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    }
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  /** IV-то (12 байта) стои пред шифъра в един base64 низ. */
  private fun encrypt(plain: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val out = cipher.iv + cipher.doFinal(plain.encodeToByteArray())
    return Base64.encodeToString(out, Base64.NO_WRAP)
  }

  private fun decrypt(stored: String): String {
    val data = Base64.decode(stored, Base64.NO_WRAP)
    require(data.size > IV_BYTES) { "кратък шифър" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, IV_BYTES))
    return cipher.doFinal(data, IV_BYTES, data.size - IV_BYTES).decodeToString()
  }

  private companion object {
    const val PREFS = "relay_settings"
    const val KEY_URL = "base_url"
    const val KEY_API = "api_key"
    const val KEY_NOTIFY = "notify_awaiting"
    const val KEY_OVERSCROLL = "overscroll_to_program"
    const val KEY_TEXT_SIZE = "terminal_text_size"
    const val KEY_SELECTED_HOST = "selected_host_id"
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "relay_settings_key"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
