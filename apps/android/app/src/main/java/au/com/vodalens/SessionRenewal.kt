package au.com.vodalens

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class VodafoneFailure(val status: Int = 0, message: String) : Exception(message)
data class RenewalResponse(val access: String, val refresh: String, val expiresIn: Long, val tokenType: String)
data class RenewalEvent(val previousExpired: Boolean, val rotated: Boolean, val lifetimeSeconds: Long)

/** One owner rotates a session. An uncertain exchange is never replayed, including after restart. */
class SessionRenewal(
    private val load: () -> Credentials?,
    private val save: (Credentials) -> Unit,
    private val exchange: suspend (String) -> RenewalResponse,
    private val online: () -> Boolean = { true },
    private val now: () -> Long = System::currentTimeMillis,
    private val onRenewed: (RenewalEvent) -> Unit = {},
    private val gate: Mutex = Mutex()
) {
    suspend fun access(rejectedToken: String? = null): String = gate.withLock {
        val old = load() ?: throw VodafoneFailure(401, "Connect to My Vodafone to update your data.")
        if(old.uncertain) throw VodafoneFailure(401, "Reconnect to My Vodafone to renew this connection safely.")
        if(old.expiresAt > now() + 45_000 && (rejectedToken == null || rejectedToken != old.access)) return@withLock old.access
        // A known offline device can keep its credential for a later online attempt.
        if(!online()) throw java.net.UnknownHostException("Device is offline")
        save(old.copy(uncertain = true))
        val response = try { exchange(old.refresh) } catch (error: VodafoneFailure) { throw error } catch (_: Exception) { throw VodafoneFailure(401, "The renewal response was interrupted. Reconnect to My Vodafone.") }
        if(response.access.isBlank() || response.refresh.isBlank() || response.expiresIn !in 1..86_400 || !response.tokenType.equals("Bearer", true)) throw VodafoneFailure(401, "Vodafone could not renew this connection. Please reconnect.")
        val updated = Credentials(response.access, response.refresh, now() + response.expiresIn * 1000)
        save(updated)
        onRenewed(RenewalEvent(old.expiresAt <= now(), old.refresh != response.refresh, response.expiresIn))
        updated.access
    }
}
