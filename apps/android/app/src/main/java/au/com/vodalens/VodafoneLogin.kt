package au.com.vodalens

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.ProfileStore
import kotlinx.coroutines.*
import org.json.JSONObject

/** A normal native View hierarchy avoids WebView/Compose rendering and focus issues. */
class VodafoneLoginActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var connect: Button
    private lateinit var explanation: TextView
    private lateinit var domain: TextView
    private lateinit var progress: ProgressBar
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store by lazy { SecureStore(this) }
    private var busy = false
    private var retired = false
    private var staged = false
    private var webDestroyed = false
    private var profileName: String? = null
    private var sessionReady = false
    private var retryMode = false
    private val timeoutHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var refreshInFlight: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = true
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        val toolbar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(8), dp(4), dp(16), dp(4)) }
        toolbar.addView(Button(this).apply { text = "Cancel"; setOnClickListener { if(!busy) finish() } }, LinearLayout.LayoutParams(dp(96), dp(52)))
        toolbar.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), 0, 0, 0)
            addView(TextView(this@VodafoneLoginActivity).apply { text = "Connect Vodafone"; textSize = 18f; setTextColor(Color.rgb(20, 32, 31)); setTypeface(null, android.graphics.Typeface.BOLD) })
            domain = TextView(this@VodafoneLoginActivity).apply { text = "my.vodafone.com.au"; textSize = 12f; setTextColor(Color.DKGRAY) }
            addView(domain)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(toolbar)
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        root.addView(progress, LinearLayout.LayoutParams(-1, dp(3)))
        web = WebView(this)
        if(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            val profiles = ProfileStore.getInstance()
            profiles.allProfileNames.filter { it.startsWith("vodalens-login-") }.forEach { runCatching { profiles.deleteProfile(it) } }
            profileName = "vodalens-login-${java.util.UUID.randomUUID()}"
            WebViewCompat.setProfile(web, profileName!!)
        }
        root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(12), dp(20), dp(12)); setBackgroundColor(Color.rgb(245, 247, 246)) }
        explanation = TextView(this).apply { text = "Sign in on Vodafone’s page. Your password and verification code stay with Vodafone."; textSize = 13f; setTextColor(Color.DKGRAY) }
        footer.addView(explanation)
        connect = Button(this).apply { text = "Use this Vodafone account"; isAllCaps = false; isEnabled = false; setOnClickListener {
            if(retryMode) { recreate(); return@setOnClickListener }
            busy = true; isEnabled = false; text = "Connecting securely…"; web.evaluateJavascript("window.__lensTake && window.__lensTake()", null)
        } }
        footer.addView(connect, LinearLayout.LayoutParams(-1, dp(56)).apply { topMargin = dp(8) })
        root.addView(footer)
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { if(!busy) finish() } })
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            useWideViewPort = true; loadWithOverviewMode = true; textZoom = 100
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true; setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.webChromeClient = object : WebChromeClient() { override fun onProgressChanged(view: WebView?, value: Int) { progress.progress = value; progress.visibility = if(value >= 100) View.GONE else View.VISIBLE } }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url
                val allowed = url.scheme == "https" && url.host in setOf("my.vodafone.com.au", "authn.vodafone.com.au") && (url.port == -1 || url.port == 443)
                if(!allowed) showError("This link opens outside Vodafone sign-in. Return to the sign-in page to continue.")
                return !allowed
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { domain.text = Uri.parse(url.orEmpty()).host ?: "Vodafone"; connect.isEnabled = false }
            override fun onPageCommitVisible(view: WebView, url: String?) { if(isVodafoneOrigin(Uri.parse(url.orEmpty()))) view.evaluateJavascript(LOGIN_OBSERVER, null) }
            override fun onPageFinished(view: WebView, url: String?) { if(isVodafoneOrigin(Uri.parse(url.orEmpty()))) view.evaluateJavascript(LOGIN_OBSERVER, null) }
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, sslError: SslError?) { handler.cancel(); showError("Vodafone’s secure connection could not be verified.") }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest, failure: WebResourceError?) { if(request.isForMainFrame) showError("Couldn’t load Vodafone sign-in. Check your connection and try again.") }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.destroy(); webDestroyed = true
                Toast.makeText(this@VodafoneLoginActivity, "Vodafone sign-in closed. Please try again.", Toast.LENGTH_LONG).show()
                finish()
                return true
            }
        }
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { showError("Update Android System WebView to connect securely."); return }
        WebViewCompat.addWebMessageListener(web, "VodaLensBridge", setOf(VODAFONE_ORIGIN)) { view, message, origin, mainFrame, _ ->
            if(!mainFrame || !isVodafoneOrigin(origin) || !isVodafoneOrigin(Uri.parse(view.url.orEmpty()))) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if(raw.length > 40_000) return@addWebMessageListener
            val packet = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
            when(packet.text("type")) {
                "ready" -> if(!busy) {
                    sessionReady = packet.optBoolean("ready")
                    if(sessionReady) { retryMode = false; connect.text = "Use this Vodafone account"; explanation.text = "Your Vodafone account is ready to connect." }
                    connect.isEnabled = sessionReady || retryMode
                }
                "credential" -> {
                    if(!busy || refreshInFlight != null) return@addWebMessageListener
                    val access = packet.text("access"); val refresh = packet.text("refresh"); val key = packet.text("key")
                    val expiry = runCatching { JSONObject(String(android.util.Base64.decode(access.split('.')[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING))).getLong("exp") * 1000 }.getOrNull()
                    if(!key.startsWith(CACHE_PREFIX) || access.length !in 20..20_000 || refresh.length !in 16..8192 || access.any(Char::isWhitespace) || refresh.any(Char::isWhitespace) || expiry == null || expiry < System.currentTimeMillis()+10_000 || expiry > System.currentTimeMillis()+86_400_000) { showError("Finish Vodafone sign-in, then try connecting again."); return@addWebMessageListener }
                    refreshInFlight = refresh
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { store.write("pending-connection", JSONObject().put("access", access).put("refresh", refresh).put("expiresAt", expiry)) }
                            staged = true
                            web.evaluateJavascript("""(()=>{try{const k=${JSONObject.quote(key)},r=${JSONObject.quote(refresh)};const v=JSON.parse(localStorage.getItem(k));if(v?.body?.refresh_token!==r){VodaLensBridge.postMessage(JSON.stringify({type:'changed'}));return;}localStorage.removeItem(k);VodaLensBridge.postMessage(JSON.stringify({type:'retired'}));window.stop();}catch(e){VodaLensBridge.postMessage(JSON.stringify({type:'changed'}));}})()""", null)
                        } catch (_: Exception) { refreshInFlight = null; showError("Couldn’t save the connection securely on this phone.") }
                    }
                }
                "retired" -> if(busy && staged && refreshInFlight != null) {
                    retired = true; refreshInFlight = null
                    web.stopLoading(); web.loadUrl("about:blank")
                    if(profileName == null) CookieManager.getInstance().removeAllCookies(null)
                    setResult(Activity.RESULT_OK); finish()
                }
                "changed" -> {
                    refreshInFlight = null
                    scope.launch { withContext(Dispatchers.IO) { store.delete("pending-connection") }; staged = false }
                    showError("Vodafone renewed during connection. Please try once more.")
                }
            }
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) WebViewCompat.addDocumentStartJavaScript(web, LOGIN_OBSERVER, setOf(VODAFONE_ORIGIN))
        if(profileName != null) web.loadUrl(VODAFONE_ORIGIN)
        else {
            WebStorage.getInstance().deleteOrigin(VODAFONE_ORIGIN)
            WebStorage.getInstance().deleteOrigin("https://authn.vodafone.com.au")
            web.clearCache(true)
            CookieManager.getInstance().removeAllCookies { if(!isFinishing) web.loadUrl(VODAFONE_ORIGIN) }
        }
        timeoutHandler.postDelayed({ if(!isFinishing && !sessionReady && !busy) showError("Vodafone is taking longer than expected. You can restart sign-in if its page stays stuck.") }, 30_000)
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun showError(message: String) { explanation.text = message; busy = false; retryMode = true; connect.isEnabled = true; connect.text = "Restart sign-in" }
    override fun onDestroy() {
        if(!retired && staged) runCatching { store.delete("pending-connection") }
        refreshInFlight = null; scope.cancel()
        timeoutHandler.removeCallbacksAndMessages(null)
        if(::web.isInitialized && !webDestroyed) {
            web.stopLoading()
            if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) WebViewCompat.removeWebMessageListener(web, "VodaLensBridge")
            web.loadUrl("about:blank"); web.removeAllViews(); web.destroy()
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) profileName?.let { runCatching { ProfileStore.getInstance().deleteProfile(it) } }
        super.onDestroy()
    }
}
private fun isVodafoneOrigin(uri: Uri) = uri.scheme == "https" && uri.host == "my.vodafone.com.au" && (uri.port == -1 || uri.port == 443)
private const val CACHE_PREFIX = "@@auth0spajs@@::TE6munQ7o6txJRqZeSzLBzDECX1yVBJO::https://dsapi.vodafone.com.au::"
private val LOGIN_OBSERVER = """
(()=>{
 if(location.origin!=='https://my.vodafone.com.au'||window!==top||window.__lensObserver)return;
 window.__lensObserver=true;
 const prefix='$CACHE_PREFIX';
 function entry(){const keys=Object.keys(localStorage).filter(k=>k.startsWith(prefix));if(keys.length!==1)return null;try{const value=JSON.parse(localStorage.getItem(keys[0]));const b=value&&value.body;if(!b||!b.access_token||!b.refresh_token)return null;return {key:keys[0],body:b};}catch(e){return null;}}
 const timer=setInterval(()=>{VodaLensBridge.postMessage(JSON.stringify({type:'ready',ready:!!entry()}));},1200);
 window.__lensTake=()=>{const e=entry();if(!e){VodaLensBridge.postMessage(JSON.stringify({type:'changed'}));return;}VodaLensBridge.postMessage(JSON.stringify({type:'credential',key:e.key,access:e.body.access_token,refresh:e.body.refresh_token}));};
})()
""".trimIndent()
