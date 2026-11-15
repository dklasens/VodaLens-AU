package au.com.vodalens

import kotlinx.coroutines.sync.Mutex
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.UUID

const val VODAFONE_CLIENT = "TE6munQ7o6txJRqZeSzLBzDECX1yVBJO"
const val VODAFONE_ORIGIN = "https://my.vodafone.com.au"
const val TOKEN_ENDPOINT = "https://authn.vodafone.com.au/oauth/token"
const val PLANS_PATH = "/tpg-api/customerManagement/v1/customer/planDetails"
const val CONSUMPTION_PATH = "/tmf-api/usageConsumption/v4/queryUsageConsumption"
const val HISTORY_PATH = "/tmf-api/usageManagement/v4/usage"
const val BILL_PATH = "/tmf-api/customerBillManagement/v4/customerBill"

internal data class HttpResult(val status: Int, val body: String, val partial: Boolean)
class VodafoneApi(private val store: SecureStore, online: () -> Boolean = { true }) {
    companion object { private val processRenewalGate = Mutex() }
    private val renewal = SessionRenewal(
        load = store::credentials,
        save = store::credentials,
        exchange = { refresh ->
            val form = mapOf("client_id" to VODAFONE_CLIENT, "grant_type" to "refresh_token", "refresh_token" to refresh, "redirect_uri" to VODAFONE_ORIGIN).entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
            val response = request(TOKEN_ENDPOINT, "POST", form = form)
            if(response.status != 200) {
                val failure = runCatching { JSONObject(response.body) }.getOrNull()
                val code = failure?.text("error")?.takeIf { it in setOf("invalid_grant", "invalid_request", "access_denied", "too_many_requests") } ?: "unclassified"
                val description = failure?.text("error_description").orEmpty().lowercase()
                val category = when { "reuse" in description || "already used" in description -> "reuse_detected"; "expired" in description -> "expired"; "revoked" in description -> "revoked"; else -> "grant_rejected" }
                android.util.Log.w("VodaLensSession", "Renewal rejected: http=${response.status}; code=$code; category=$category")
                throw VodafoneFailure(401, "Vodafone needs you to sign in again.")
            }
            val json = JSONObject(response.body)
            RenewalResponse(json.text("access_token"), json.text("refresh_token"), json.optLong("expires_in"), json.text("token_type"))
        },
        online = online,
        onRenewed = { event -> android.util.Log.w("VodaLensSession", "Renewal accepted: previousExpired=${event.previousExpired}; rotated=${event.rotated}; lifetimeSeconds=${event.lifetimeSeconds}") },
        gate = processRenewalGate
    )
    private fun request(url: String, method: String = "GET", token: String? = null, form: String? = null, version: String = "v1"): HttpResult {
        val uri = URI(url)
        require(uri.scheme == "https" && uri.host in setOf("dsapi.vodafone.com.au", "authn.vodafone.com.au"))
        val connection = uri.toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000; connection.readTimeout = 25_000
            connection.requestMethod = method
            connection.setRequestProperty("Accept", "application/json")
            if (token != null) {
                connection.setRequestProperty("Authorization", "Bearer $token")
                mapOf("brand" to "tpg", "channel" to "oneapp-web", "vf-project" to "ONEAPP", "vf-api-version" to version, "ext-bp-id" to UUID.randomUUID().toString(), "trace-transaction-id" to UUID.randomUUID().toString()).forEach { (key, value) -> connection.setRequestProperty(key, value) }
            }
            if (form != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.outputStream.use { it.write(form.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            // Error bodies can contain account data. They are deliberately never surfaced.
            val body = if (status in 200..299) connection.inputStream.bufferedReader().use { it.readText() } else if(url == TOKEN_ENDPOINT) connection.errorStream?.bufferedReader()?.use { it.readText().take(8192) }.orEmpty() else ""
            return HttpResult(status, body, status == 206 || connection.getHeaderField("Link")?.contains("rel=\"next\"") == true)
        } finally { connection.disconnect() }
    }
    private suspend fun read(path: String, params: Map<String, String> = emptyMap(), version: String = "v1"): HttpResult {
        require(path in setOf(PLANS_PATH, CONSUMPTION_PATH, HISTORY_PATH) || path.startsWith("$BILL_PATH/") && Regex("[A-Za-z0-9_-]+").matches(path.removePrefix("$BILL_PATH/")))
        val url = "https://dsapi.vodafone.com.au$path" + if (params.isEmpty()) "" else params.entries.joinToString("&", "?") { (key, value) -> "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}" }
        var token = renewal.access()
        var response = request(url, token = token, version = version)
        if (response.status == 401) { token = renewal.access(token); response = request(url, token = token, version = version) }
        if (response.status !in 200..299) throw VodafoneFailure(response.status, when(response.status) { 401 -> "Your Vodafone connection needs a new sign-in."; 403 -> "Vodafone has not made this information available to this session."; 429 -> "Vodafone is busy. Please try again in a few minutes."; else -> "Vodafone couldn’t return this information. Please try again later." })
        return response
    }
    suspend fun services(): List<Service> = VodafoneParser.services(JSONObject(read(PLANS_PATH).body))
    suspend fun consumption(number: String): JSONObject = JSONObject(read(CONSUMPTION_PATH, mapOf("id" to "61${canonicalNumber(number).drop(1)}")).body)
    suspend fun history(number: String, cycle: Cycle): History {
        val end = minOf(cycle.end.minusDays(1), java.time.LocalDate.now())
        val result = read(HISTORY_PATH, mapOf("id" to "61${canonicalNumber(number).drop(1)}", "startdate" to cycle.start.toString(), "enddate" to end.toString(), "eventtype" to "All"))
        return VodafoneParser.history(JSONArray(result.body), number, cycle, !result.partial)
    }
    suspend fun bills(account: String, current: Boolean): List<Bill> {
        require(Regex("[A-Za-z0-9_-]+").matches(account))
        val json = JSONObject(read("$BILL_PATH/$account", mapOf("bill" to if(current) "current" else "previous"), "v4").body)
        android.util.Log.i("VodaLensData", "Billing schema: period=${if(current) "current" else "previous"}; rows=${json.array("customerBill").size}; keys=${json.keys().asSequence().toList()}; rowKeys=${json.array("customerBill").firstOrNull()?.keys()?.asSequence()?.toList()}")
        return VodafoneParser.bills(json, current)
    }
}
