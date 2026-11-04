package com.idachev.supacoderemote.relay

import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.cert.CertificateException

/** `fpMac` векторът е изчислен с Node `crypto.createHmac`, както го прави Mac-ът. */
class LanTrustTest {

  private val key = "abcde-fghij-klmno-pqrst-uvwxy-z2345"
  private val fp = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
  private val fpMac = "e1bef7bccaed983a401062bd7faa05f9fa1a1ca2315570c82009429bdde65a77"

  @Test
  fun `fpMac от Node съвпада`() {
    assertTrue(LanTrust.fpMacValid(key, fp, fpMac))
  }

  @Test
  fun `fpMac с главни букви в hex-а също минава`() {
    assertTrue(LanTrust.fpMacValid(key, fp, fpMac.uppercase()))
  }

  @Test
  fun `друг ключ, друг отпечатък или счупен hex — без LAN`() {
    assertFalse(LanTrust.fpMacValid("$key-x", fp, fpMac))
    assertFalse(LanTrust.fpMacValid(key, fp.replaceFirst('0', '1'), fpMac))
    // HMAC-ът е над текста на fp: главни букви в самия fp са друг текст.
    assertFalse(LanTrust.fpMacValid(key, fp.uppercase(), fpMac))
    assertFalse(LanTrust.fpMacValid(key, fp, fpMac.dropLast(2)))
    assertFalse(LanTrust.fpMacValid(key, fp, "zz" + fpMac.drop(2)))
    assertFalse(LanTrust.fpMacValid(key, fp, ""))
  }

  @Test
  fun `закованият сертификат минава, друг не`() {
    val mac = HeldCertificate.Builder().commonName("mac").build().certificate
    val other = HeldCertificate.Builder().commonName("other").build().certificate
    val pin = LanTrust.fingerprint(mac.encoded)
    assertTrue(pin.matches(Regex("[0-9a-f]{64}")))
    assertTrue(LanTrust.pinMatches(mac, pin))
    assertTrue(LanTrust.pinMatches(mac, pin.uppercase()))
    assertFalse(LanTrust.pinMatches(other, pin))

    val trust = PinnedTrustManager(pin)
    trust.checkServerTrusted(arrayOf(mac), "RSA")
    assertThrows(CertificateException::class.java) { trust.checkServerTrusted(arrayOf(other), "RSA") }
    assertThrows(CertificateException::class.java) { trust.checkServerTrusted(emptyArray(), "RSA") }
    assertThrows(CertificateException::class.java) { trust.checkClientTrusted(arrayOf(mac), "RSA") }
  }
}
