package au.com.vodalens

import kotlinx.coroutines.CancellationException

/** Forget locally before contacting the issuer. Offline/rejected revocation never restores data. */
internal suspend fun removeConnection(
    load: () -> Credentials?,
    clear: () -> Unit,
    revoke: suspend (String) -> Boolean
): Boolean {
    val loaded = runCatching(load)
    clear()
    if(loaded.isFailure) return false
    val credential = loaded.getOrNull() ?: return true
    return try { revoke(credential.refresh) }
    catch(error: CancellationException) { throw error }
    catch(_: Exception) { false }
}
