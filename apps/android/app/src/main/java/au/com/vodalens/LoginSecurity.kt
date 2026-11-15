package au.com.vodalens

import java.net.URI

/** Navigation policy is separate from resource loading: CDN scripts/fonts are not documents. */
internal object LoginNavigationPolicy {
    private val hosts = setOf("my.vodafone.com.au", "authn.vodafone.com.au")
    fun allowedDocument(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme.equals("https", true) && uri.host?.lowercase() in hosts && uri.rawUserInfo == null && uri.port in setOf(-1, 443)
    }.getOrDefault(false)
    // Google's documented reCAPTCHA frame namespace only; never a top-level login origin.
    private val captchaHosts = setOf("www.google.com", "recaptcha.google.com", "www.recaptcha.net")
    fun captchaFrame(url: String): Boolean = runCatching {
        val uri = URI(url)
        val path = uri.rawPath.orEmpty()
        uri.scheme.equals("https", true) && uri.host?.lowercase() in captchaHosts && uri.rawUserInfo == null && uri.port in setOf(-1, 443) &&
            path.startsWith("/recaptcha/") && path == uri.path && '%' !in path && '\\' !in path && ';' !in path && "//" !in path && uri.normalize().rawPath == path
    }.getOrDefault(false)
    fun allowedFrame(url: String) = allowedDocument(url) || url == "about:blank" || captchaFrame(url)
    fun allowedNavigation(url: String, mainFrame: Boolean) = if(mainFrame) allowedDocument(url) else allowedFrame(url)
    fun portal(url: String): Boolean = allowedDocument(url) && runCatching { URI(url).host.equals("my.vodafone.com.au", true) }.getOrDefault(false)
    /**
     * Recognise document navigation without treating API/XHR POSTs as documents.
     * WebResourceRequest cannot authoritatively distinguish every subframe from
     * every resource, and Fetch Metadata may be absent. This is a navigation
     * defence alongside URL callbacks and the form guard, not a WebView firewall.
     */
    fun documentLike(mainFrame: Boolean, headers: Map<String, String>): Boolean {
        fun header(name: String) = headers.entries.firstOrNull { it.key.equals(name, true) }?.value.orEmpty().trim().lowercase()
        if(mainFrame) return true
        val destination = header("Sec-Fetch-Dest")
        val mode = header("Sec-Fetch-Mode")
        if(destination in setOf("document", "iframe", "frame", "fencedframe", "object", "embed") || mode == "navigate") return true
        if(destination in setOf("empty", "audio", "audioworklet", "font", "image", "json", "manifest", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "track", "video", "worker", "xslt") || mode in setOf("cors", "same-origin", "no-cors", "websocket")) return false
        val acceptedTypes = header("Accept").split(',').map { it.substringBefore(';').trim() }
        if(acceptedTypes.any { it in setOf("text/html", "application/xhtml+xml") }) return true
        if(acceptedTypes.any { it == "application/json" || it.endsWith("+json") } || header("Content-Type").substringBefore(';').trim().let { it == "application/json" || it.endsWith("+json") }) return false
        // HTTP method alone cannot tell a form submission from fetch(), XHR or
        // telemetry. Leave unknown resources alone; native/page form guards remain.
        return false
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
