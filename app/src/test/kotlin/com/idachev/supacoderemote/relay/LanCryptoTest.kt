package com.idachev.supacoderemote.relay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.GeneralSecurityException

/**
 * Векторите са изчислени с Node `crypto` (hkdfSync, createHmac, aes-256-gcm) по същите
 * формули, както ги прави Mac-ът и mock-ът. Така двете реализации се проверяват една с друга.
 */
class LanCryptoTest {

  private fun hex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  private fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

  private val clientKey = "abcde-fghij-klmno-pqrst-uvwxy-z2345"
  private val clientNonce = ByteArray(16) { it.toByte() }
  private val macNonce = ByteArray(16) { (it + 16).toByte() }

  @Test
  fun `HKDF по RFC 5869 тест 1`() {
    val okm = LanCrypto.hkdf(
      ikm = hex("0b".repeat(22)),
      salt = hex("000102030405060708090a0b0c"),
      info = hex("f0f1f2f3f4f5f6f7f8f9"),
      length = 42,
    )
    assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", okm.hex())
  }

  @Test
  fun `ключовете на сесията и доказателствата съвпадат с Node`() {
    val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    assertEquals("49530eef5aa6d5b6a52ae3e9ae09bb20916c1e38e1e398950bdfbf0c5999836f", keys.c2s.hex())
    assertEquals("f3bf4daca6c72d86a7e3b7f6ec479a7a0ca1918ee2e7641de20cabab627e5ee2", keys.s2c.hex())
    assertEquals("d17967963099d0086fba2be8c5803e367674b0c2604f7c91c40ad48060390651", keys.proof.hex())
    assertEquals(
      "54c87aad54ef6e9508f90d882045b5a71c3bdbba9553dd9190541f22114c6dbe",
      LanCrypto.proof(keys.proof, LanCrypto.MAC_LABEL).hex(),
    )
    assertEquals(
      "de083c5daa3c539ec7ec2cd922449a669d9c43502ade00ad069c0ab68b096c14",
      LanCrypto.proof(keys.proof, LanCrypto.CLIENT_LABEL).hex(),
    )
  }

  @Test
  fun `друг ключ дава друго доказателство`() {
    val good = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    val bad = LanCrypto.deriveKeys("$clientKey-x", clientNonce, macNonce)
    assertFalse(
      LanCrypto.sameBytes(LanCrypto.proof(good.proof, LanCrypto.MAC_LABEL), LanCrypto.proof(bad.proof, LanCrypto.MAC_LABEL)),
    )
  }

  @Test
  fun `кадрите от телефона са като в Node, брояч от 0`() {
    val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    val sealer = LanFrameSealer(keys.c2s, LanCrypto.C2S)
    assertEquals(
      "633273000000000000000000cb2d349b30490034099c03cfd6c8c61c23469b5b48135ad7280732498f07485599e81b",
      sealer.seal("""{"t":"hello","v":1}""".encodeToByteArray()).hex(),
    )
    assertEquals(
      "63327300000000000000000188bdcdd5b82dd4ae81c518f5e82747d0c37839db",
      sealer.seal("ping".encodeToByteArray()).hex(),
    )
  }

  @Test
  fun `векторите на Mac страната — ping с брояч 0 и pong с брояч 1`() {
    val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    assertEquals(
      "633273000000000000000000c0662ede6c48126a265b194290d75da025c7d299",
      LanFrameSealer(keys.c2s, LanCrypto.C2S).seal("ping".encodeToByteArray()).hex(),
    )
    val macSealer = LanFrameSealer(keys.s2c, LanCrypto.S2C)
    macSealer.seal("first".encodeToByteArray())
    assertEquals(
      "73326300000000000000000117292dad8758a6c12f4ffbb0127fd3069cd53c63",
      macSealer.seal("pong".encodeToByteArray()).hex(),
    )
    // Отварянето иска поред 0, после 1: кадърът с брояч 1 минава само след първия.
    val opener = LanFrameOpener(keys.s2c, LanCrypto.S2C)
    opener.open(LanFrameSealer(keys.s2c, LanCrypto.S2C).seal("first".encodeToByteArray()))
    assertEquals("pong", opener.open(hex("73326300000000000000000117292dad8758a6c12f4ffbb0127fd3069cd53c63")).decodeToString())
  }

  @Test
  fun `кадър от Mac-а се отваря, с кирилица и emoji`() {
    val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    val opener = LanFrameOpener(keys.s2c, LanCrypto.S2C)
    val frame = hex("7332630000000000000000006908f7bd16f7a82e29b3d365c311701485fcb887f44ad8fd2778739c17e786d9b85935")
    assertEquals("здравей 👋", opener.open(frame).decodeToString())
  }

  @Test
  fun `повтор, пропуснат брояч, чужда посока и сменен байт затварят`() {
    val keys = LanCrypto.deriveKeys(clientKey, clientNonce, macNonce)
    val sealer = LanFrameSealer(keys.s2c, LanCrypto.S2C)
    val first = sealer.seal("a".encodeToByteArray())
    val second = sealer.seal("b".encodeToByteArray())
    val third = sealer.seal("c".encodeToByteArray())

    val replay = LanFrameOpener(keys.s2c, LanCrypto.S2C)
    assertArrayEquals("a".encodeToByteArray(), replay.open(first))
    assertThrows(GeneralSecurityException::class.java) { replay.open(first) }

    assertThrows(GeneralSecurityException::class.java) { LanFrameOpener(keys.s2c, LanCrypto.S2C).open(second) }

    val ownDirection = LanFrameSealer(keys.s2c, LanCrypto.C2S).seal("x".encodeToByteArray())
    assertThrows(GeneralSecurityException::class.java) { LanFrameOpener(keys.s2c, LanCrypto.S2C).open(ownDirection) }

    val tampered = first.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
    assertThrows(GeneralSecurityException::class.java) { LanFrameOpener(keys.s2c, LanCrypto.S2C).open(tampered) }

    val inOrder = LanFrameOpener(keys.s2c, LanCrypto.S2C)
    assertTrue(listOf(first, second, third).map { inOrder.open(it).decodeToString() } == listOf("a", "b", "c"))
  }
}
