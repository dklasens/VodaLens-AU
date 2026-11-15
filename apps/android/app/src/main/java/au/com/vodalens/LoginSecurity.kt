package au.com.vodalens

import java.net.URI

/** Navigation policy is separate from resource loading: CDN scripts/fonts are not documents. */
internal object LoginNavigationPolicy {
    private val hosts = setOf("my.vodafone.com.au", "authn.vodafone.com.au")
    fun allowedDocument(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme.equals("https", true) && uri.host?.lowercase() in hosts && uri.rawUserInfo == null && uri.port in setOf(-1, 443)
    }.getOrDefault(false)
    fun portal(url: String): Boolean = allowedDocument(url) && runCatching { URI(url).host.equals("my.vodafone.com.au", true) }.getOrDefault(false)
    fun documentLike(mainFrame: Boolean, method: String, headers: Map<String, String>): Boolean {
        fun header(name: String) = headers.entries.firstOrNull { it.key.equals(name, true) }?.value.orEmpty().lowercase()
        return mainFrame || method.uppercase() !in setOf("GET", "HEAD") || header("Sec-Fetch-Dest") in setOf("document", "iframe", "frame") || "text/html" in header("Accept") || "application/xhtml+xml" in header("Accept")
    }
}

/** A page navigation invalidates both the user action and any asynchronous storage completion. */
internal class LoginHandoffGate {
    private var generation = 0L
    private var requestedGeneration: Long? = null
    private var transaction: String? = null
    fun navigate() { generation++; requestedGeneration = null; transaction = null }
    fun request() { requestedGeneration = generation; transaction = null }
    fun accept(id: String): Long? {
        if(requestedGeneration != generation || transaction != null || !id.matches(Regex("[A-Za-z0-9-]{16,80}"))) return null
        transaction = id
        return generation
    }
    fun current(id: String, expectedGeneration: Long) = generation == expectedGeneration && transaction == id && requestedGeneration == generation
    fun current(id: String) = transaction == id && requestedGeneration == generation
    fun cancel() { requestedGeneration = null; transaction = null }
}

/** A slow document may recover when sign-in finishes; security failures require a restart. */
internal class LoginRecoveryGate {
    private enum class Failure { NONE, PAGE_DELAY, FATAL }
    private var failure = Failure.NONE
    val restartRequired get() = failure != Failure.NONE
    fun fail(pageDelay: Boolean = false) { if(failure != Failure.FATAL) failure = if(pageDelay) Failure.PAGE_DELAY else Failure.FATAL }
    fun acceptReady(ready: Boolean): Boolean {
        if(failure == Failure.FATAL || (failure == Failure.PAGE_DELAY && !ready)) return false
        if(ready) failure = Failure.NONE
        return true
    }
    fun shouldOfferDelay(authPage: Boolean, documentLoading: Boolean, interactiveForm: Boolean, sessionReady: Boolean, busy: Boolean) =
        !restartRequired && !authPage && documentLoading && !interactiveForm && !sessionReady && !busy
}
