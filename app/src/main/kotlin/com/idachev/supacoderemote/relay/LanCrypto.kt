package com.idachev.supacoderemote.relay

import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Криптото на LAN пътя (раздел „LAN shortcut“ в протокола). Без сертификат: двете страни
 * знаят клиентския ключ и извеждат от него ключовете на сесията; самият ключ не минава
 * по LAN.
 */
object LanCrypto {

  const val INFO = "supacode-lan-v1"
  const val NONCE_BYTES = 16
  const val MAC_LABEL = "mac"
  const val CLIENT_LABEL = "client"

  /** Посоката в nonce-а на кадъра: `"c2s\0"` от телефона, `"s2c\0"` от Mac-а. */
  val C2S: ByteArray = byteArrayOf('c'.code.toByte(), '2'.code.toByte(), 's'.code.toByte(), 0)
  val S2C: ByteArray = byteArrayOf('s'.code.toByte(), '2'.code.toByte(), 'c'.code.toByte(), 0)

  /** Ключовете на една LAN сесия, в реда, в който HKDF ги дава. */
  class Keys(val c2s: ByteArray, val s2c: ByteArray, val proof: ByteArray)

  /** HKDF-SHA256 по RFC 5869: extract = HMAC(salt, ikm), после expand до [length] байта. */
  fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    require(length in 1..255 * 32) { "HKDF дължина $length" }
    val prk = hmac(salt, ikm)
    val out = ByteArray(length)
    var previous = ByteArray(0)
    var offset = 0
    var counter = 1
    while (offset < length) {
      val mac = Mac.getInstance("HmacSHA256")
      mac.init(SecretKeySpec(prk, "HmacSHA256"))
      mac.update(previous)
      mac.update(info)
      mac.update(counter.toByte())
      previous = mac.doFinal()
      val n = minOf(previous.size, length - offset)
      System.arraycopy(previous, 0, out, offset, n)
      offset += n
      counter++
    }
    return out
  }

  /** 96 байта от ключа и двата nonce-а: c2sKey, s2cKey, proofKey по 32. */
  fun deriveKeys(clientKey: String, clientNonce: ByteArray, macNonce: ByteArray): Keys {
    val okm = hkdf(clientKey.encodeToByteArray(), clientNonce + macNonce, INFO.encodeToByteArray(), 96)
    return Keys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64), okm.copyOfRange(64, 96))
  }

  /** Доказателството на една страна: HMAC-SHA256(proofKey, "mac" или "client"). */
  fun proof(proofKey: ByteArray, label: String): ByteArray = hmac(proofKey, label.encodeToByteArray())

  /** Сравнение за постоянно време — доказателството не бива да изтича по времето. */
  fun sameBytes(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    // Празна сол по RFC 5869 е 32 нулеви байта; тук солта е винаги 32 байта.
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
    return mac.doFinal(data)
  }
}

/**
 * Кадрите в една посока: 12 байта nonce (посока + брояч big-endian), после AES-256-GCM
 * шифър с таг, без associated data. Броячът почва от 0 и расте с 1.
 */
class LanFrameSealer(private val key: ByteArray, private val direction: ByteArray) {
  private var counter = 0L

  @Synchronized
  fun seal(plain: ByteArray): ByteArray {
    val nonce = LanFrames.nonce(direction, counter++)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    return nonce + cipher.doFinal(plain)
  }
}

/**
 * Отваря кадрите от другата страна. Иска точно следващия брояч и правилната посока; всичко
 * друго (повтор, разбъркан ред, сменен байт) е [GeneralSecurityException] и връзката се затваря.
 */
class LanFrameOpener(private val key: ByteArray, private val direction: ByteArray) {
  private var expected = 0L

  @Synchronized
  fun open(frame: ByteArray): ByteArray {
    if (frame.size < LanFrames.NONCE_BYTES + LanFrames.TAG_BYTES) throw GeneralSecurityException("кратък кадър")
    val nonce = frame.copyOfRange(0, LanFrames.NONCE_BYTES)
    if (!nonce.copyOfRange(0, 4).contentEquals(direction)) throw GeneralSecurityException("грешна посока")
    val counter = ByteBuffer.wrap(nonce, 4, 8).long
    if (counter != expected) throw GeneralSecurityException("брояч $counter вместо $expected")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    val plain = cipher.doFinal(frame, LanFrames.NONCE_BYTES, frame.size - LanFrames.NONCE_BYTES)
    expected++
    return plain
  }
}

object LanFrames {
  const val NONCE_BYTES = 12
  const val TAG_BYTES = 16

  fun nonce(direction: ByteArray, counter: Long): ByteArray =
    ByteBuffer.allocate(NONCE_BYTES).put(direction).putLong(counter).array()
}
