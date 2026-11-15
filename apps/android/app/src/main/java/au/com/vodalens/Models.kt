package au.com.vodalens

import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.roundToLong

const val GIB = 1_073_741_824L

data class Cycle(val start: LocalDate, val end: LocalDate) {
    val key: String get() = start.toString()
    val days: Int get() = ChronoUnit.DAYS.between(start, end).toInt()
    fun progress(today: LocalDate): Float = (ChronoUnit.DAYS.between(start, today).toFloat() / days).coerceIn(0f, 1f)
    fun progress(at: java.time.ZonedDateTime): Float {
        val from = start.atStartOfDay(at.zone).toInstant()
        val until = end.atStartOfDay(at.zone).toInstant()
        val elapsed = java.time.Duration.between(from, at.toInstant()).seconds.toDouble()
        val duration = java.time.Duration.between(from, until).seconds.toDouble()
        return (elapsed / duration).toFloat().coerceIn(0f, 1f)
    }
    fun dates(): List<LocalDate> = (0 until days).map { start.plusDays(it.toLong()) }
    fun previous(): Cycle = containing(start.minusDays(1), start.dayOfMonth)
    companion object {
        fun containing(date: LocalDate, billingDay: Int = 15): Cycle {
            require(billingDay in 1..31)
            fun boundary(month: YearMonth) = month.atDay(billingDay.coerceAtMost(month.lengthOfMonth()))
            val month = YearMonth.from(date)
            val start = boundary(if (date < boundary(month)) month.minusMonths(1) else month)
            return Cycle(start, boundary(YearMonth.from(start).plusMonths(1)))
        }
    }
}
data class Service(val number: String, val plan: String, val accountId: String = "") {
    val formatted: String get() = if (number.length == 10) "${number.take(4)} ${number.substring(4, 7)} ${number.takeLast(3)}" else number
}
data class Pool(val id: String, val name: String, val total: Long, val remaining: Long?, val used: Long?, val cycle: Cycle)
data class Session(val date: LocalDate, val bytes: Long)
data class History(val number: String, val cycle: String, val sessions: List<Session>, val fetchedAt: Long, val complete: Boolean = true, val warning: String? = null, val sourceRecordCount: Int = sessions.size) {
    val total: Long get() = sessions.sumOf { it.bytes }
    val daily: Map<LocalDate, Long> get() = sessions.groupBy { it.date }.mapValues { (_, rows) -> rows.sumOf { it.bytes } }
}
fun dailyTotals(records: List<Session>): List<Session> = records.groupBy { it.date }.toSortedMap().map { (date, rows) -> Session(date, rows.fold(0L) { total, row -> Math.addExact(total, row.bytes) }) }
data class Bill(val id: String, val number: String, val issued: LocalDate?, val due: LocalDate?, val amountCents: Long?, val outstandingCents: Long?, val status: String, val periodStart: LocalDate?, val periodEnd: LocalDate?, val isCurrent: Boolean = false)
data class AccountData(val services: List<Service> = emptyList(), val pools: List<Pool> = emptyList(), val lineUsed: Map<String, Long> = emptyMap(), val bills: List<Bill> = emptyList(), val updatedAt: Long = 0, val billingError: String? = null, val billsUpdatedAt: Long = 0)
data class Credentials(val access: String, val refresh: String, val expiresAt: Long, val uncertain: Boolean = false)
data class UiState(val account: AccountData? = null, val histories: List<History> = emptyList(), val connected: Boolean = false, val loading: Boolean = false, val historyLoading: Boolean = false, val error: String? = null, val historyErrors: Map<String, String> = emptyMap(), val selectedCycle: Cycle = Cycle.containing(LocalDate.now()), val selectedLine: String? = null, val tab: Int = 0, val demo: Boolean = false)
fun needsForegroundRefresh(state: UiState, now: Long): Boolean = state.connected && !state.demo && !state.loading && !state.historyLoading && now - (state.account?.updatedAt ?: 0) >= 300_000
fun currentAmountDue(bills: List<Bill>): Long? {
    val current = bills.filter { it.isCurrent }
    return if(current.isEmpty() || current.any { it.outstandingCents == null }) null else current.sumOf { it.outstandingCents!! }
}
fun mergeBillingHistory(current: List<Bill>, previous: List<Bill>): List<Bill> {
    val merged = previous.associateBy { it.id }.toMutableMap()
    for(bill in current) {
        val historical = merged[bill.id]
        merged[bill.id] = bill.copy(amountCents = historical?.amountCents ?: bill.amountCents, isCurrent = true)
    }
    return merged.values.sortedByDescending { it.issued }
}

fun dataSize(bytes: Long): String {
    val value = bytes.coerceAtLeast(0)
    return when {
        value >= GIB -> String.format(Locale.getDefault(), "%,.1f GB", value.toDouble() / GIB)
        value >= 1_048_576 -> String.format(Locale.getDefault(), "%,.0f MB", value.toDouble() / 1_048_576)
        value >= 1024 -> String.format(Locale.getDefault(), "%,.0f KB", value.toDouble() / 1024)
        else -> "$value B"
    }
}
fun money(cents: Long?): String = if (cents == null) "Not available" else NumberFormat.getCurrencyInstance(Locale.forLanguageTag("en-AU")).format(cents / 100.0)
fun parseDate(value: String?): LocalDate? = runCatching { LocalDate.parse(value?.take(10)) }.getOrNull()
fun canonicalNumber(raw: String): String {
    val value = raw.replace(Regex("[\\s+()-]"), "")
    val local = if (value.startsWith("614") && value.length == 11) "0" + value.drop(2) else value
    require(Regex("04\\d{8}").matches(local))
    return local
}
fun sameServiceAccount(old: List<Service>, fresh: List<Service>): Boolean = old.isNotEmpty() && fresh.isNotEmpty() && (old + fresh).all { it.accountId.isNotBlank() } && old.map { it.number to it.accountId }.toSet() == fresh.map { it.number to it.accountId }.toSet()
fun percent(fraction: Float): String = java.text.NumberFormat.getPercentInstance().apply { minimumFractionDigits = 1; maximumFractionDigits = 1 }.format(fraction)
fun numericBytes(amount: Double, unit: String): Long? {
    if (!amount.isFinite() || amount < 0) return null
    val scale = when (unit.uppercase(Locale.ROOT)) { "B", "BYTE", "BYTES" -> 1.0; "KB", "KBYTES" -> 1024.0; "MB", "MBYTES" -> 1_048_576.0; "GB", "GBYTES" -> GIB.toDouble(); "TB" -> GIB * 1024.0; else -> return null }
    val result = amount * scale
    return if (result.isFinite() && result <= Long.MAX_VALUE) result.roundToLong() else null
}
