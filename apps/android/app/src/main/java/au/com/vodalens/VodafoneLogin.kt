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
    private val recovery = LoginRecoveryGate()
    private var documentLoading = true
    private var interactiveForm = false
    private val timeoutHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val handoff = LoginHandoffGate()
    private var activeTransaction: String? = null
    private var actionSequence = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setRecentsScreenshotEnabled(false)
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
            if(recovery.restartRequired) { recreate(); return@setOnClickListener }
            if(!LoginNavigationPolicy.portal(web.url.orEmpty())) { showError("Return to My Vodafone before connecting."); return@setOnClickListener }
            busy = true; handoff.request(); isEnabled = false; text = "Connecting securely…"
            val action = ++actionSequence
            web.evaluateJavascript("window.__lensTake && window.__lensTake()", null)
            timeoutHandler.postDelayed({ if(busy && !retired && actionSequence == action) showError("The connection did not finish. Restart sign-in to try again.") }, 15_000)
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
        web.webChromeClient = object : WebChromeClient() { override fun onProgressChanged(view: WebView?, value: Int) { documentLoading = value < 100; progress.progress = value; progress.visibility = if(value >= 100) View.GONE else View.VISIBLE } }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Apply to sub-frame navigations as well as the top-level page.
                val allowed = LoginNavigationPolicy.allowedDocument(request.url.toString()) || (!request.isForMainFrame && request.url.toString() == "about:blank")
                if(!allowed && request.isForMainFrame) rejectNavigation(view)
                return !allowed
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // shouldOverrideUrlLoading does not see form POSTs. Interception runs on a
                // worker thread; UI changes must be posted, and response bodies stay unread.
                if(!LoginNavigationPolicy.allowedDocument(request.url.toString()) && LoginNavigationPolicy.documentLike(request.isForMainFrame, request.requestHeaders)) {
                    if(request.isForMainFrame) view.post { rejectNavigation(view) }
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked navigation", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
                }
                return null
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if(url == "about:blank" && (retired || isFinishing)) return
                handoff.navigate(); sessionReady = false; documentLoading = true; interactiveForm = false; connect.isEnabled = false
                activeTransaction?.let(::discardPending); activeTransaction = null; staged = false
                if(!LoginNavigationPolicy.allowedDocument(url.orEmpty())) { rejectNavigation(view); return }
                domain.text = Uri.parse(url.orEmpty()).host ?: "Vodafone"
                if(busy) showError("Vodafone navigated during connection. Please restart sign-in.")
            }
            override fun onPageCommitVisible(view: WebView, url: String?) { if(isVodafoneOrigin(Uri.parse(url.orEmpty()))) view.evaluateJavascript(LOGIN_OBSERVER, null) }
            override fun onPageFinished(view: WebView, url: String?) { documentLoading = false; if(isVodafoneOrigin(Uri.parse(url.orEmpty()))) view.evaluateJavascript(LOGIN_OBSERVER, null) }
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
        WebViewCompat.addWebMessageListener(web, "VodaLensBridge", setOf(VODAFONE_ORIGIN)) { view, message, origin, mainFrame, reply ->
            if(!mainFrame || !isVodafoneOrigin(origin) || !isVodafoneOrigin(Uri.parse(view.url.orEmpty()))) return@addWebMessageListener
            val raw = message.data ?: return@addWebMessageListener
            if(raw.length > 40_000) return@addWebMessageListener
            val packet = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
            when(packet.text("type")) {
                "ready" -> if(!busy) {
                    interactiveForm = packet.optBoolean("interactive")
                    val ready = packet.optBoolean("ready")
                    if(recovery.acceptReady(ready)) {
                        sessionReady = ready
                        if(sessionReady) { connect.text = "Use this Vodafone account"; explanation.text = "Your Vodafone account is ready to connect." }
                        connect.isEnabled = sessionReady || recovery.restartRequired
                    }
                }
                "credential" -> {
                    if(!busy || activeTransaction != null) return@addWebMessageListener
                    val transaction = packet.text("transaction")
                    val generation = handoff.accept(transaction) ?: return@addWebMessageListener
                    val access = packet.text("access"); val refresh = packet.text("refresh"); val key = packet.text("key")
                    val expiry = runCatching { JSONObject(String(android.util.Base64.decode(access.split('.')[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING))).getLong("exp") * 1000 }.getOrNull()
                    if(!key.startsWith(CACHE_PREFIX) || access.length !in 20..20_000 || refresh.length !in 16..8192 || access.any(Char::isWhitespace) || refresh.any(Char::isWhitespace) || expiry == null || expiry < System.currentTimeMillis()+10_000 || expiry > System.currentTimeMillis()+86_400_000) { showError("Finish Vodafone sign-in, then try connecting again."); return@addWebMessageListener }
                    activeTransaction = transaction
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { store.write("pending-connection", JSONObject().put("access", access).put("refresh", refresh).put("expiresAt", expiry).put("handoff", transaction)) }
                            if(isFinishing || webDestroyed || !handoff.current(transaction, generation) || !LoginNavigationPolicy.portal(web.url.orEmpty())) {
                                discardPending(transaction); return@launch
                            }
                            staged = true
                            // Reply only to the originating JS object. Never interpolate a credential
                            // into evaluateJavascript, even if navigation occurs during the disk write.
                            reply.postMessage(JSONObject().put("type", "commit").put("transaction", transaction).toString())
                        } catch (_: Exception) {
                            discardPending(transaction)
                            if(handoff.current(transaction, generation)) { activeTransaction = null; handoff.cancel(); showError("Couldn’t save the connection securely on this phone.") }
                        } finally {
                            if(!retired && (!handoff.current(transaction, generation) || isFinishing || webDestroyed)) {
                                withContext(NonCancellable + Dispatchers.IO) { discardPendingNow(transaction) }
                            }
                        }
                    }
                }
                "retired" -> if(busy && staged && handoff.current(packet.text("transaction"))) {
                    retired = true; activeTransaction = null; handoff.cancel()
                    web.stopLoading(); web.loadUrl("about:blank")
                    if(profileName == null) CookieManager.getInstance().removeAllCookies(null)
                    setResult(Activity.RESULT_OK); finish()
                }
                "changed" -> {
                    if(!handoff.current(packet.text("transaction"))) return@addWebMessageListener
                    activeTransaction?.let(::discardPending); activeTransaction = null; handoff.cancel(); staged = false
                    showError("Vodafone renewed during connection. Please try once more.")
                }
            }
        }
        if(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, LOGIN_NAVIGATION_GUARD, setOf(VODAFONE_ORIGIN, "https://authn.vodafone.com.au"))
            WebViewCompat.addDocumentStartJavaScript(web, LOGIN_OBSERVER, setOf(VODAFONE_ORIGIN))
        }
        if(profileName != null) web.loadUrl(VODAFONE_ORIGIN)
        else {
            WebStorage.getInstance().deleteOrigin(VODAFONE_ORIGIN)
            WebStorage.getInstance().deleteOrigin("https://authn.vodafone.com.au")
            web.clearCache(true)
            CookieManager.getInstance().removeAllCookies { if(!isFinishing) web.loadUrl(VODAFONE_ORIGIN) }
        }
        timeoutHandler.postDelayed({
            val authPage = Uri.parse(web.url.orEmpty()).host == "authn.vodafone.com.au"
            if(!isFinishing && recovery.shouldOfferDelay(authPage, documentLoading, interactiveForm, sessionReady, busy)) {
                showError("Vodafone’s page is taking longer than expected. You can wait or restart sign-in.", pageDelay = true)
            }
        }, 30_000)
    }
    private fun rejectNavigation(view: WebView) {
        if(isFinishing || webDestroyed) return
        view.stopLoading(); handoff.navigate(); sessionReady = false
        activeTransaction?.let(::discardPending); activeTransaction = null; staged = false
        showError("This page is outside Vodafone sign-in. Restart sign-in to continue.")
    }
    private fun discardPending(transaction: String) {
        scope.launch(Dispatchers.IO) { discardPendingNow(transaction) }
    }
    private fun discardPendingNow(transaction: String) {
        synchronized(store) {
            if(store.read("pending-connection")?.text("handoff") == transaction) store.delete("pending-connection")
        }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun showError(message: String, pageDelay: Boolean = false) {
        activeTransaction?.let(::discardPending); activeTransaction = null; handoff.cancel(); staged = false
        explanation.text = message; busy = false; recovery.fail(pageDelay); connect.isEnabled = true; connect.text = "Restart sign-in"
    }
    override fun onDestroy() {
        if(!retired) activeTransaction?.let { runCatching { discardPendingNow(it) } }
        activeTransaction = null; handoff.cancel(); scope.cancel()
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
private fun isVodafoneOrigin(uri: Uri) = LoginNavigationPolicy.portal(uri.toString())
private const val CACHE_PREFIX = "@@auth0spajs@@::TE6munQ7o6txJRqZeSzLBzDECX1yVBJO::https://dsapi.vodafone.com.au::"
private val LOGIN_OBSERVER = """
(()=>{
 if(location.origin!=='https://my.vodafone.com.au'||window!==top||window.__lensObserver)return;
 window.__lensObserver=true;
 const prefix='$CACHE_PREFIX';
 function entry(){const keys=Object.keys(localStorage).filter(k=>k.startsWith(prefix));if(keys.length!==1)return null;try{const value=JSON.parse(localStorage.getItem(keys[0]));const b=value&&value.body;if(!b||!b.access_token||!b.refresh_token)return null;return {key:keys[0],body:b};}catch(e){return null;}}
 let pending=null;
 const timer=setInterval(()=>{const interactive=Array.from(document.querySelectorAll('input,select,textarea')).some(e=>e.type!=='hidden'&&e.getClientRects().length>0);VodaLensBridge.postMessage(JSON.stringify({type:'ready',ready:!!entry(),interactive}));},1200);
 VodaLensBridge.onmessage=event=>{
   try {
     const message=JSON.parse(event.data);
     if(message.type!=='commit'||!pending||message.transaction!==pending.transaction)return;
     const saved=pending; pending=null;
     const current=entry();
     if(!current||current.key!==saved.key||current.body.refresh_token!==saved.refresh){VodaLensBridge.postMessage(JSON.stringify({type:'changed',transaction:saved.transaction}));return;}
     localStorage.removeItem(saved.key); clearInterval(timer);
     VodaLensBridge.postMessage(JSON.stringify({type:'retired',transaction:saved.transaction}));window.stop();
   } catch(e) { if(pending){const transaction=pending.transaction;pending=null;VodaLensBridge.postMessage(JSON.stringify({type:'changed',transaction}));} }
 };
 window.__lensTake=()=>{
   if(pending)return;
   const e=entry();if(!e){VodaLensBridge.postMessage(JSON.stringify({type:'ready',ready:false}));return;}
   const transaction=crypto.randomUUID(); pending={key:e.key,refresh:e.body.refresh_token,transaction};
   VodaLensBridge.postMessage(JSON.stringify({type:'credential',transaction,key:e.key,access:e.body.access_token,refresh:e.body.refresh_token}));
 };
})()
""".trimIndent()

// Capture normal and programmatic form submission before a POST can leave the
// allowed document origins. Native checks remain authoritative for main frames.
private val LOGIN_NAVIGATION_GUARD = """
(()=>{
 if(window.__lensNavigationGuard)return; window.__lensNavigationGuard=true;
 const allowed=value=>{try{const u=new URL(value,location.href);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['my.vodafone.com.au','authn.vodafone.com.au'].includes(u.hostname);}catch(e){return false;}};
 const action=(form,button)=>button?.hasAttribute('formaction')?button.formAction:(form.action||location.href);
 document.addEventListener('submit',event=>{if(!allowed(action(event.target,event.submitter))){event.preventDefault();event.stopImmediatePropagation();}},true);
 const submit=HTMLFormElement.prototype.submit;
 HTMLFormElement.prototype.submit=function(){if(allowed(action(this)))return submit.apply(this,arguments);};
 const requestSubmit=HTMLFormElement.prototype.requestSubmit;
 if(requestSubmit)HTMLFormElement.prototype.requestSubmit=function(button){if(allowed(action(this,button)))return requestSubmit.apply(this,arguments);};
})()
""".trimIndent()
