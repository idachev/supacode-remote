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

interface SettingsStore {
  /** `null`, докато не е въведен ключ за връзка. */
  val settings: StateFlow<RelaySettings?>

  fun save(value: RelaySettings)

  /** „Известия, когато агент чака“. Не е тайна, затова не е криптирано. */
  val notifyAwaiting: StateFlow<Boolean>

  fun setNotifyAwaiting(value: Boolean)

  /** „Скрол стига до агента“: скрол отвъд историята на телефона праща PgUp / PgDn. */
  val overscrollToProgram: StateFlow<Boolean>

  fun setOverscrollToProgram(value: Boolean)
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
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "relay_settings_key"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
