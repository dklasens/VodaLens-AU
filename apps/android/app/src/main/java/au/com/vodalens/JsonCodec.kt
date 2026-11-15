package au.com.vodalens

import org.json.JSONArray
import org.json.JSONObject

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.text(key: String): String = if (isNull(key)) "" else optString(key).trim()
internal fun JSONObject.array(key: String): List<JSONObject> = optJSONArray(key)?.objects().orEmpty()
internal fun JSONObject.bytes(): Long? = if (isNull("amount")) null else numericBytes(optDouble("amount", Double.NaN), text("units"))
internal fun JSONObject.cents(): Long? { val amount = optDouble("value", Double.NaN); return if (amount.isFinite()) java.math.BigDecimal.valueOf(amount).movePointRight(2).setScale(0, java.math.RoundingMode.HALF_UP).longValueExact() else null }

object VodafoneParser {
    fun services(json: JSONObject): List<Service> {
        val detail = json.optJSONObject("accountDetails")?.optJSONObject("accountDetail") ?: error("Vodafone returned an unfamiliar account response.")
        val accounts = detail.optJSONArray("billingAccount") ?: error("Vodafone did not return a service list.")
        return accounts.objects().flatMap { account ->
            val accountId = account.text("BAN").ifEmpty { account.text("ban") }.ifEmpty { account.text("id") }.ifEmpty { account.text("billingAccountId") }
            account.array("asset").mapNotNull { asset ->
                runCatching { Service(canonicalNumber(asset.text("msisdn")), asset.text("displayPlanName").ifEmpty { "Mobile service" }, accountId) }.getOrNull()
            }
        }.distinctBy { it.number }
    }
    fun pools(responses: List<JSONObject>): List<Pool> {
        val pools = linkedMapOf<String, Pool>()
        for (response in responses) for (item in response.array("usageConsumption")) for (bucket in item.array("bucketRefOrValue")) {
            if (bucket.text("usageType") == "Data Consumption Counter") continue
            val counters = bucket.array("bucketCounter")
            fun counter(type: String) = counters.firstOrNull { it.text("counterType") == type }?.optJSONObject("value")?.bytes()
            val total = counter("total") ?: continue
            val valid = bucket.optJSONObject("validFor") ?: continue
            val start = parseDate(valid.text("startDateTime")) ?: continue
            val end = parseDate(valid.text("endDateTime"))?.plusDays(1) ?: continue
            // Vodafone labels allowance buckets by product, not necessarily "Data".
            // Recognized byte units distinguish them from voice/SMS allowances.
            if (end <= start) continue
            val pool = Pool(bucket.text("id"), bucket.text("name").ifEmpty { "Shared data" }, total, bucket.optJSONObject("remainingValue")?.bytes(), counter("used"), Cycle(start, end))
            val key = "${pool.id}|$start|$end"
            val existing = pools[key]
            check(existing == null || existing == pool) { "Vodafone returned changing pool totals. Please refresh again." }
            pools[key] = pool
        }
        return pools.values.toList()
    }
    fun counters(responses: List<JSONObject>): Map<String, Long> = buildMap {
        for (response in responses) for (item in response.array("usageConsumption")) for (bucket in item.array("bucketRefOrValue")) {
            if (bucket.text("usageType") != "Data Consumption Counter") continue
            val phone = runCatching { canonicalNumber(bucket.text("id")) }.getOrNull() ?: continue
            val used = bucket.array("bucketCounter").firstOrNull { it.text("counterType") == "used" }?.optJSONObject("value")?.bytes() ?: continue
            put(phone, used)
        }
    }
    fun history(array: JSONArray, number: String, cycle: Cycle, complete: Boolean = true): History {
        var skipped = 0
        val sessions = array.objects().mapNotNull { row ->
            if (!row.text("usageType").equals("data", true)) return@mapNotNull null
            val date = parseDate(row.text("usageDate"))
            val amount = row.array("usageCharacteristic").firstOrNull { it.text("name") == "data-BYTES" }?.text("value")
            val bytes = amount?.toLongOrNull()
            if (date == null || date < cycle.start || date >= cycle.end || bytes == null || bytes < 0) { skipped++; null } else Session(date, bytes)
        }
        return History(number, cycle.key, dailyTotals(sessions), System.currentTimeMillis(), complete && skipped == 0, if (skipped > 0) "Some Vodafone records could not be read." else if (!complete) "Vodafone may have returned only part of this period." else null, sessions.size)
    }
    fun bills(json: JSONObject, current: Boolean = false): List<Bill> {
        val rows = json.optJSONArray("customerBill") ?: error("Vodafone billing information is not available through this response.")
        return rows.objects().mapNotNull { row ->
            val period = row.optJSONObject("billingPeriod")
            // Real responses repeat the account-level id across invoices.
            // Bill number identifies a document; account id does not.
            val id = row.text("billNo").ifEmpty { row.text("id") + "|" + row.text("billDate") }
            if (id == "|") return@mapNotNull null
            val liveDue = row.optJSONObject("amountDue")?.cents()
            val remaining = row.optJSONObject("remainingAmount")?.cents()
            val total = row.optJSONObject("taxIncludedAmount")?.cents() ?: if(current) remaining ?: liveDue else liveDue
            val invoiceStatus = row.text("invoiceStatus")
            val paid = invoiceStatus == "0" || row.text("state").lowercase() in setOf("paid", "settled")
            val credit = invoiceStatus == "2"
            // For bill=current, amountDue is the live balance. remainingAmount can
            // still contain the original invoice total even after payment.
            val outstanding = when { paid -> 0L; credit -> minOf(liveDue ?: 0, 0); current -> liveDue; else -> remaining ?: liveDue }
            val status = when {
                paid -> "Paid"
                credit -> "In credit"
                outstanding == 0L -> "Paid"
                outstanding != null && total != null && outstanding > 0 && outstanding < total -> "Partially paid"
                invoiceStatus == "1" -> "Unpaid"
                else -> row.text("state").ifEmpty { "Issued" }
            }
            Bill(id, row.text("billNo"), parseDate(row.text("billDate")), parseDate(row.text("paymentDueDate")), total, outstanding, status, parseDate(period?.text("startDateTime")), parseDate(period?.text("endDateTime")), current)
        }.distinctBy { it.id }.sortedByDescending { it.issued }
    }
}

object CacheCodec {
    fun encode(account: AccountData?, histories: List<History>): JSONObject = JSONObject().apply {
        if (account != null) put("account", JSONObject().apply {
            put("updatedAt", account.updatedAt); put("billingError", account.billingError); put("billsUpdatedAt", account.billsUpdatedAt); put("billingModelVersion", 2)
            put("services", JSONArray(account.services.map { JSONObject().put("number", it.number).put("plan", it.plan).put("account", it.accountId) }))
            put("pools", JSONArray(account.pools.map { JSONObject().put("id", it.id).put("name", it.name).put("total", it.total).put("remaining", it.remaining).put("used", it.used).put("start", it.cycle.start).put("end", it.cycle.end) }))
            put("lineUsed", JSONObject(account.lineUsed))
            put("bills", JSONArray(account.bills.map { JSONObject().put("id", it.id).put("number", it.number).put("issued", it.issued).put("due", it.due).put("amount", it.amountCents).put("outstanding", it.outstandingCents).put("status", it.status).put("start", it.periodStart).put("end", it.periodEnd).put("current", it.isCurrent) }))
        })
        put("histories", JSONArray(histories.map { h -> JSONObject().put("number", h.number).put("cycle", h.cycle).put("fetchedAt", h.fetchedAt).put("complete", h.complete).put("warning", h.warning).put("sourceRecordCount", h.sourceRecordCount).put("sessions", JSONArray(dailyTotals(h.sessions).map { JSONObject().put("date", it.date).put("bytes", it.bytes) })) }))
    }
    fun decode(json: JSONObject): Pair<AccountData?, List<History>> {
        val account = json.optJSONObject("account")?.let { a ->
            fun JSONObject.optionalLong(key: String): Long? = if (isNull(key)) null else getLong(key)
            AccountData(a.array("services").map { Service(it.text("number"), it.text("plan"), it.text("account")) }, a.array("pools").map { Pool(it.text("id"), it.text("name"), it.getLong("total"), it.optionalLong("remaining"), it.optionalLong("used"), Cycle(java.time.LocalDate.parse(it.text("start")), java.time.LocalDate.parse(it.text("end")))) }, a.optJSONObject("lineUsed")?.let { values -> values.keys().asSequence().associateWith { values.getLong(it) } }.orEmpty(), (if(a.optInt("billingModelVersion") == 2) a.array("bills") else emptyList()).map { Bill(it.text("id"), it.text("number"), parseDate(it.text("issued")), parseDate(it.text("due")), it.optionalLong("amount"), it.optionalLong("outstanding"), it.text("status"), parseDate(it.text("start")), parseDate(it.text("end")), it.optBoolean("current", false)) }, a.optLong("updatedAt"), a.text("billingError").ifEmpty { null }, if(a.optInt("billingModelVersion") == 2) a.optLong("billsUpdatedAt") else 0)
        }
        val histories = json.array("histories").map { h ->
            val records = h.array("sessions").map { Session(java.time.LocalDate.parse(it.text("date")), it.getLong("bytes")) }
            History(h.text("number"), h.text("cycle"), dailyTotals(records), h.getLong("fetchedAt"), h.optBoolean("complete", false), h.text("warning").ifEmpty { null }, h.optInt("sourceRecordCount", records.size))
        }
        return account to histories
    }
}
