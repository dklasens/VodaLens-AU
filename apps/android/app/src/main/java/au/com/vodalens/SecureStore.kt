package au.com.vodalens

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-bound AES-GCM. Neither tokens nor account history enter backup or logs. */
class SecureStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "vodalens").apply { mkdirs() }
    private val key: SecretKey by lazy {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("vodalens.v1", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("vodalens.v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun write(name: String, value: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key); updateAAD(name.toByteArray()) }
        val encrypted = cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        val file = AtomicFile(File(directory, name))
        val stream = file.startWrite()
        try { stream.write(byteArrayOf(1)); stream.write(cipher.iv); stream.write(encrypted); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
    }
    @Synchronized fun read(name: String): JSONObject? {
        val file = AtomicFile(File(directory, name))
        if (!file.baseFile.exists()) return null
        val bytes = file.readFully()
        check(bytes.size > 29 && bytes[0].toInt() == 1) { "Stored data cannot be opened. Reconnect Vodafone." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13))); updateAAD(name.toByteArray()) }
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
    }
    @Synchronized fun delete(name: String) { AtomicFile(File(directory, name)).delete() }
    fun credentials(): Credentials? = read("connection")?.let { Credentials(it.getString("access"), it.getString("refresh"), it.getLong("expiresAt"), it.optBoolean("uncertain", false)) }
    fun credentials(value: Credentials) = write("connection", JSONObject().put("access", value.access).put("refresh", value.refresh).put("expiresAt", value.expiresAt).put("uncertain", value.uncertain))
    fun clear() { delete("connection"); delete("pending-connection"); delete("cache") }
}
