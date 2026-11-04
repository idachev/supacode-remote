package com.idachev.supacoderemote.relay

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.TlsVersion
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Duration
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager

/**
 * Доверието в LAN връзката (раздел „LAN shortcut“ в протокола): TLS 1.3 със самоподписан
 * сертификат на Mac-а, закован по SHA-256 на DER байтовете му (`fp`).
 *
 * `fp` идва през relay-а, който би могъл да го подмени. Затова `fpMac` — HMAC-SHA256 с
 * клиентския ключ — се проверява преди всеки опит: relay-ят знае само хеша на ключа.
 */
object LanTrust {

  private const val FP_MAC_PREFIX = "supacode-lan-fp-v1:"

  /** SHA-256 на DER байтовете като малки шестнадесетични букви. */
  fun fingerprint(der: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(der).toHex()

  /**
   * `fpMac` е от някой, който знае клиентския ключ. Сравнява байтове за постоянно време;
   * главни или малки букви в hex-а нямат значение, а невалиден hex е несъвпадение.
   */
  fun fpMacValid(clientKey: String, fp: String, fpMac: String): Boolean {
    val expected = hmac(clientKey.encodeToByteArray(), (FP_MAC_PREFIX + fp).encodeToByteArray())
    val given = fpMac.hexToBytesOrNull() ?: return false
    return MessageDigest.isEqual(expected, given)
  }

  /** Отпечатъкът на сертификата съвпада ли със заковани `fp` (без значение главни/малки). */
  fun pinMatches(certificate: X509Certificate, fp: String): Boolean =
    MessageDigest.isEqual(fingerprint(certificate.encoded).encodeToByteArray(), fp.trim().lowercase().encodeToByteArray())

  /**
   * Клиент само за този Mac: TLS 1.3, сертификатът се приема само при съвпадащ отпечатък, а
   * името на хоста се пропуска само ако сесията е на същия заковани сертификат.
   */
  fun pinnedClient(base: OkHttpClient, fp: String, connectTimeout: Duration): OkHttpClient {
    val trust = PinnedTrustManager(fp)
    val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val tls13 = ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build()
    return base.newBuilder()
      .connectTimeout(connectTimeout)
      .sslSocketFactory(context.socketFactory, trust)
      .hostnameVerifier(PinnedHostnameVerifier(fp))
      .connectionSpecs(listOf(tls13))
      .build()
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

  private fun String.hexToBytesOrNull(): ByteArray? {
    val s = trim()
    if (s.length % 2 != 0) return null
    return ByteArray(s.length / 2) { i ->
      val hi = Character.digit(s[2 * i], 16)
      val lo = Character.digit(s[2 * i + 1], 16)
      if (hi < 0 || lo < 0) return null
      ((hi shl 4) or lo).toByte()
    }
  }
}

/** Приема сървъра само ако първият сертификат във веригата е заковани. Клиенти не приема. */
class PinnedTrustManager(private val fp: String) : X509TrustManager {
  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("клиентски сертификати не се приемат")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("празна верига")
    if (!LanTrust.pinMatches(leaf, fp)) throw CertificateException("сертификатът не е този на Mac-а")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * Името на хоста е IP в локалната мрежа и не е в сертификата; затова вместо него се гледа
 * дали сесията е на заковани сертификат. Само за клиента от [LanTrust.pinnedClient].
 */
class PinnedHostnameVerifier(private val fp: String) : HostnameVerifier {
  override fun verify(hostname: String?, session: SSLSession?): Boolean {
    val leaf = try {
      session?.peerCertificates?.firstOrNull() as? X509Certificate
    } catch (_: SSLPeerUnverifiedException) {
      null
    } ?: return false
    return LanTrust.pinMatches(leaf, fp)
  }
}
