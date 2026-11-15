package au.com.vodalens

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.time.LocalDate

class LensViewModel(application: Application) : AndroidViewModel(application) {
    private val store = SecureStore(application)
    private val debugLogging = application.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
    private val networkGate = Semaphore(4)
    private val api = VodafoneApi(store, debugLogging = debugLogging) {
        val manager = application.getSystemService(android.net.ConnectivityManager::class.java)
        manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    }
    private val syncLock = Mutex()
    private var historyJob: Job? = null
    private var refreshJob: Job? = null
    @Volatile private var followCurrentCycle = true
    private var reconnectCache: Pair<AccountData, List<History>>? = null
    private val mutableState = MutableStateFlow(UiState(loading = true))
    val state = mutableState.asStateFlow()
    init {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                try {
                    val cached = store.read("cache")?.let(CacheCodec::decode)
                    val connection = store.credentials()
                    val cycle = cached?.first?.pools?.firstOrNull()?.cycle?.let { Cycle.containing(LocalDate.now(), it.start.dayOfMonth) } ?: Cycle.containing(LocalDate.now())
                    mutableState.update { it.copy(account = cached?.first, histories = cached?.second.orEmpty(), connected = connection != null && !connection.uncertain, loading = false, selectedCycle = cycle, error = if (connection?.uncertain == true) "Reconnect to Vodafone to update your data." else null) }
                    if (connection != null && !connection.uncertain) refresh()
                } catch (_: Exception) { mutableState.update { it.copy(loading = false, error = "Saved data could not be opened. Please reconnect to My Vodafone.") } }
            }
        }
    }
    fun connectionReady() {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                syncLock.withLock {
                    val previous = state.value
                    reconnectCache = previous.account?.let { it to previous.histories }
                    followCurrentCycle = true
                    mutableState.value = UiState(connected = true, loading = true)
                    val staged = store.read("pending-connection") ?: error("Connection was not staged")
                    // Clear old persisted data before activating a possibly different account.
                    store.delete("cache")
                    store.credentials(Credentials(staged.getString("access"), staged.getString("refresh"), staged.getLong("expiresAt")))
                    store.delete("pending-connection")
                }
                refresh()
            } catch (_: Exception) { mutableState.update { it.copy(loading = false, connected = false, error = "Couldn’t finish saving the connection. Please sign in again.") } }
        }
    }
    fun onForeground() { if(needsForegroundRefresh(state.value, System.currentTimeMillis())) refresh() }
    @Synchronized fun refresh() {
        if (state.value.demo) return
        if(refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch(Dispatchers.IO) {
            syncLock.withLock {
                mutableState.update { it.copy(loading = true, error = null) }
                try {
                    val services = api.services()
                    check(services.isNotEmpty()) { "No mobile services were returned by Vodafone." }
                    reconnectCache?.let { (previous, histories) ->
                        if(sameServiceAccount(previous.services, services)) mutableState.update { it.copy(account = previous, histories = histories) }
                        reconnectCache = null
                    }
                    val accounts = services.map { it.accountId }.filter { it.isNotBlank() }.distinct()
                    val (consumptions, billingResult) = supervisorScope {
                        val usage = async { services.parallelReads(networkGate) { api.consumption(it.number) } }
                        val billing = async {
                            try {
                                check(accounts.isNotEmpty()) { "Missing billing account" }
                                val reads = accounts.flatMap { listOf(it to true, it to false) }.parallelReads(networkGate) { (account, current) -> api.bills(account, current) }
                                Result.success(accounts.indices.flatMap { index -> mergeBillingHistory(reads[index * 2], reads[index * 2 + 1]) })
                            } catch (error: CancellationException) { throw error }
                            catch (error: Exception) { Result.failure<List<Bill>>(error) }
                        }
                        usage.await() to billing.await()
                    }
                    currentCoroutineContext().ensureActive()
                    if(debugLogging) android.util.Log.i("VodaLensData", "Consumption schema: " + consumptions.map { response -> response.array("usageConsumption").flatMap { it.array("bucketRefOrValue") }.map { bucket -> org.json.JSONObject().put("type", bucket.text("usageType")).put("counterTypes", org.json.JSONArray(bucket.array("bucketCounter").map { it.text("counterType") })).put("units", org.json.JSONArray(bucket.array("bucketCounter").map { it.optJSONObject("value")?.text("units") })).put("hasDates", bucket.optJSONObject("validFor") != null) } })
                    val pools = VodafoneParser.pools(consumptions)
                    var bills = state.value.account?.bills.orEmpty()
                    var billsUpdatedAt = state.value.account?.billsUpdatedAt ?: 0L
                    var billingError: String? = null
                    billingResult.fold(onSuccess = { returned ->
                        bills = returned.distinctBy { it.id }.filter { it.isCurrent || (it.issued ?: LocalDate.now()) >= LocalDate.now().minusMonths(6) }.sortedByDescending { it.issued }
                        billsUpdatedAt = System.currentTimeMillis()
                    }, onFailure = { error ->
                        if(error is VodafoneFailure && error.status == 401) throw error
                        billingError = if(accounts.isEmpty()) "Vodafone did not return a billing account for these services." else friendlyError(error as Exception)
                    })
                    val data = AccountData(services, pools, VodafoneParser.counters(consumptions), bills, System.currentTimeMillis(), billingError, billsUpdatedAt)
                    val currentCycle = pools.firstOrNull()?.cycle?.let { Cycle.containing(LocalDate.now(), it.start.dayOfMonth) } ?: Cycle.containing(LocalDate.now())
                    mutableState.update { it.copy(account = data, connected = true, loading = false, selectedCycle = if (followCurrentCycle || it.account == null) currentCycle else it.selectedCycle) }
                    if(debugLogging) android.util.Log.i("VodaLensData", "Live account: services=${services.size}; pools=${pools.size}; lineCounters=${data.lineUsed.size}; bills=${bills.size}; billingError=${billingError ?: "none"}")
                    persist()
                    loadHistoryLocked(state.value.selectedCycle, force = true)
                } catch (e: Exception) {
                    if(e is CancellationException) throw e
                    mutableState.update { it.copy(loading = false, error = friendlyError(e), connected = if (e is VodafoneFailure && e.status == 401) false else it.connected) }
                }
            }
        }
    }
    fun selectCycle(cycle: Cycle) {
        val billingDay = state.value.account?.pools?.firstOrNull()?.cycle?.start?.dayOfMonth ?: 15
        followCurrentCycle = cycle.start == Cycle.containing(LocalDate.now(), billingDay).start
        mutableState.update { it.copy(selectedCycle = cycle) }
        historyJob?.cancel()
        if (!state.value.demo) historyJob = viewModelScope.launch(Dispatchers.IO) { syncLock.withLock { loadHistoryLocked(cycle) } }
    }
    fun selectLine(number: String?) { mutableState.update { it.copy(selectedLine = number) } }
    fun selectTab(tab: Int) { mutableState.update { it.copy(tab = tab) } }
    fun retryHistory() {
        if (!state.value.demo) viewModelScope.launch(Dispatchers.IO) { syncLock.withLock { loadHistoryLocked(state.value.selectedCycle, true) } }
    }
    private suspend fun loadHistoryLocked(cycle: Cycle, force: Boolean = false) {
        if (!state.value.connected) return
        mutableState.update { it.copy(historyLoading = true) }
        try {
            val services = state.value.account?.services.orEmpty().filter { service ->
                val cached = state.value.histories.firstOrNull { it.number == service.number && it.cycle == cycle.key }
                force || cached == null || cycle.end > LocalDate.now() && System.currentTimeMillis() - cached.fetchedAt >= 300_000
            }
            val results = services.parallelReads(networkGate) { service ->
                val result = try { Result.success(api.history(service.number, cycle)) }
                catch(error: CancellationException) { throw error }
                catch(error: Exception) { Result.failure<History>(error) }
                service to result
            }
            currentCoroutineContext().ensureActive()
            for((service, result) in results) {
                val key = "${service.number}|${cycle.key}"
                result.fold(onSuccess = { history ->
                    if(debugLogging) android.util.Log.i("VodaLensData", "History: cycle=${cycle.key}; records=${history.sourceRecordCount}; dailyTotals=${history.sessions.size}; complete=${history.complete}")
                    mutableState.update { it.copy(histories = it.histories.filterNot { old -> old.number == service.number && old.cycle == cycle.key } + history, historyErrors = it.historyErrors - key) }
                    persist()
                }, onFailure = { error ->
                    val failure = error as Exception
                    if(debugLogging) android.util.Log.i("VodaLensData", "History unavailable: cycle=${cycle.key}; status=${(failure as? VodafoneFailure)?.status ?: 0}")
                    mutableState.update { it.copy(historyErrors = it.historyErrors + (key to friendlyError(failure)), connected = if(failure is VodafoneFailure && failure.status == 401) false else it.connected, error = if(failure is VodafoneFailure && failure.status == 401) friendlyError(failure) else it.error) }
                })
            }
        } finally { mutableState.update { it.copy(historyLoading = false) } }
    }
    private fun persist() {
        val snapshot = state.value
        val cutoff = LocalDate.now().minusMonths(7).toString()
        store.write("cache", CacheCodec.encode(snapshot.account, snapshot.histories.filter { it.cycle >= cutoff }))
    }
    fun disconnect() {
        historyJob?.cancel()
        refreshJob?.cancel()
        viewModelScope.launch(Dispatchers.IO) {
            syncLock.withLock {
                reconnectCache = null
                mutableState.value = UiState()
                try {
                    val revoked = api.disconnect()
                    mutableState.value = UiState(error = if(revoked) null else "Removed from this phone. Vodafone could not confirm remote revocation; other Vodafone sessions may still be active.")
                } catch(error: CancellationException) { throw error }
                catch(_: Exception) { mutableState.value = UiState(error = "Couldn’t confirm that saved data was cleared. Please try disconnecting again after reopening VodaLens.") }
            }
        }
    }
    fun showPreview() { mutableState.value = PreviewData.state() }
    fun exitPreview() { mutableState.value = UiState() }
    private fun friendlyError(error: Exception): String = when (error) {
        is VodafoneFailure -> error.message ?: "Vodafone is unavailable. Please try again."
        is java.net.UnknownHostException, is java.net.SocketTimeoutException, is java.net.ConnectException -> "Couldn’t reach Vodafone. Your saved data is still available."
        else -> "This Vodafone response could not be read. Please try again."
    }
}

/** Explicitly labelled preview, never mixed with a connected account. */
object PreviewData {
    fun state(): UiState {
        val cycle = Cycle.containing(LocalDate.now())
        val services = listOf(Service("0400000101", "Vodafone Large"), Service("0400000102", "Vodafone Medium"), Service("0400000103", "Mobile broadband"))
        val histories = (0..6).flatMap { offset ->
            val period = Cycle.containing(cycle.start.minusMonths(offset.toLong()))
            services.mapIndexed { line, service ->
                val sessions = period.dates().filter { it <= LocalDate.now() }.mapIndexed { day, date -> Session(date, ((0.6 + (day * 13 + line * 7) % 19 / 4.0) * GIB * (if(line == 0) 1.9 else 0.5)).toLong()) }
                History(service.number, period.key, sessions, System.currentTimeMillis())
            }
        }
        val lineUsed = services.associate { s -> s.number to histories.first { it.number == s.number && it.cycle == cycle.key }.total }
        val used = lineUsed.values.sum()
        val bills = (0..5).map { i -> val issued = cycle.start.minusMonths(i.toLong()); Bill("sample-$i", "Example bill", issued, issued.plusDays(14), 15500L + i * 350, if (i == 0) 15500 else 0, if (i == 0) "Unpaid" else "Paid", issued.minusMonths(1), issued.minusDays(1), isCurrent = i == 0) }
        return UiState(AccountData(services, listOf(Pool("sample", "Shared pool", 1015 * GIB, 1015 * GIB - used, used, cycle)), lineUsed, bills, System.currentTimeMillis(), billsUpdatedAt = System.currentTimeMillis()), histories, true, demo = true, selectedCycle = cycle)
    }
}
