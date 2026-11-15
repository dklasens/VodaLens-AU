package au.com.vodalens
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class DomainTest {
    @Test fun billingBoundariesAndLeapYear() {
        val before = Cycle.containing(LocalDate.parse("2026-11-14"))
        assertEquals("2026-10-15", before.key)
        assertEquals(LocalDate.parse("2026-11-15"), before.end)
        assertEquals(31, before.days)
        assertEquals("2026-11-15", Cycle.containing(LocalDate.parse("2026-11-15")).key)
        val leap = Cycle.containing(LocalDate.parse("2028-02-29"))
        assertEquals(29, leap.days)
        assertEquals(0f, leap.progress(leap.start), .001f)
        assertEquals(1f, leap.progress(leap.end), .001f)
    }
    @Test fun monthEndBoundaryClampsWithoutSkippingMonth() {
        val cycle = Cycle.containing(LocalDate.parse("2028-02-29"), 31)
        assertEquals(LocalDate.parse("2028-02-29"), cycle.start)
        assertEquals(LocalDate.parse("2028-03-31"), cycle.end)
    }
    @Test fun cycleProgressIncludesTheCurrentDayAndDaylightSaving() {
        val cycle = Cycle.containing(LocalDate.parse("2026-09-15"))
        val at = java.time.ZonedDateTime.parse("2026-09-15T12:00:00+10:00[Australia/Sydney]")
        assertTrue(cycle.progress(at) > 0f)
        val expected = 12f / (30f * 24f - 1f)
        assertEquals(expected, cycle.progress(at), .00001f)
        assertEquals(1f, cycle.progress(cycle.end.atStartOfDay(at.zone)), .00001f)
    }
    @Test fun rosterUsesCarrierBanAndSkipsNonMobileAssets() {
        val json = JSONObject("""{"accountDetails":{"accountDetail":{"billingAccount":[{"BAN":1001,"asset":[{"msisdn":"61400000101","displayPlanName":"Large"},{"msisdn":"0400000101","displayPlanName":"Large"},{"msisdn":"not-a-phone"}]}]}}}""")
        val services = VodafoneParser.services(json)
        assertEquals(1, services.size)
        assertEquals("0400000101", services.first().number)
        assertEquals("1001", services.first().accountId)
    }
    @Test fun sharedPoolCountedOnceAcrossThreeResponses() {
        val data = JSONObject("""{"usageConsumption":[{"bucketRefOrValue":[{"id":"shared","name":"Shared data","usageType":"Discount","bucketCounter":[{"counterType":"total","value":{"amount":1015,"units":"GB"}},{"counterType":"used","value":{"amount":15,"units":"GB"}}],"remainingValue":{"amount":1000,"units":"GB"},"validFor":{"startDateTime":"2026-10-15T00:00:00","endDateTime":"2026-11-14T23:59:59"}}]}]}""")
        val pools = VodafoneParser.pools(listOf(data, data, data))
        assertEquals(1, pools.size)
        assertEquals(1015 * GIB, pools.sumOf { it.total })
        assertEquals(LocalDate.parse("2026-11-15"), pools.first().cycle.end)
    }
    @Test fun carrierDayPreservedAndInvalidRecordsMarked() {
        val rows = JSONArray("""[{"usageType":"data","usageDate":"2026-11-14T23:59:59","usageCharacteristic":[{"name":"data-BYTES","value":"1234"}]},{"usageType":"data","usageDate":"2026-11-14T23:59:59","usageCharacteristic":[{"name":"data-BYTES","value":"1234"}]},{"usageType":"voice"},{"usageType":"data","usageDate":"2026-11-15T00:00:00","usageCharacteristic":[{"name":"data-BYTES","value":"999"}]}]""")
        val history = VodafoneParser.history(rows, "0400000101", Cycle.containing(LocalDate.parse("2026-11-14")))
        assertEquals(2468L, history.total)
        assertEquals(1, history.sessions.size)
        assertEquals(2, history.sourceRecordCount)
        assertEquals(2468L, history.daily[LocalDate.parse("2026-11-14")])
        assertFalse(history.complete)
        assertNotNull(history.warning)
    }
    @Test fun billingAmountAndOutstandingRemainSeparate() {
        val response = JSONObject("""{"customerBill":[{"id":"b1","billNo":"1001","billDate":"2026-10-15T00:00:00Z","paymentDueDate":"2026-10-29T00:00:00Z","invoiceStatus":"0","taxIncludedAmount":{"unit":"AUD","value":155.35},"remainingAmount":{"unit":"AUD","value":0},"billingPeriod":{"startDateTime":"2026-09-15","endDateTime":"2026-10-14"}}]}""")
        val bill = VodafoneParser.bills(response).single()
        assertEquals(15535L, bill.amountCents)
        assertEquals(0L, bill.outstandingCents)
        assertEquals("Paid", bill.status)
        assertEquals(LocalDate.parse("2026-10-29"), bill.due)
    }
    @Test fun historicalBillsWithTheSameAccountIdStayDistinct() {
        val response = JSONObject("""{"customerBill":[{"id":"same-account","billNo":"invoice-1","billDate":"2026-10-15","taxIncludedAmount":{"unit":"AUD","value":100}},{"id":"same-account","billNo":"invoice-2","billDate":"2026-09-15","taxIncludedAmount":{"unit":"AUD","value":110}}]}""")
        assertEquals(2, VodafoneParser.bills(response).size)
        assertNotEquals(VodafoneParser.bills(response)[0].id, VodafoneParser.bills(response)[1].id)
    }
    @Test fun paidCurrentBillNeverTurnsOriginalInvoiceIntoOverdueBalance() {
        val current = JSONObject("""{"customerBill":[{"id":"account","billNo":"october","billDate":"2026-10-15","paymentDueDate":"2026-11-02","invoiceStatus":"0","state":"new","amountDue":{"unit":"AUD","value":0},"remainingAmount":{"unit":"AUD","value":88}}]}""")
        val previous = JSONObject("""{"customerBill":[{"id":"account","billNo":"october","billDate":"2026-10-15","invoiceStatus":"0","remainingAmount":{"unit":"AUD","value":88},"taxIncludedAmount":{"unit":"AUD","value":88}}]}""")
        val bills = mergeBillingHistory(VodafoneParser.bills(current, true), VodafoneParser.bills(previous))
        assertEquals(1, bills.size)
        assertEquals(0L, currentAmountDue(bills))
        assertEquals(8800L, bills.single().amountCents)
        assertEquals(0L, bills.single().outstandingCents)
        assertEquals("Paid", bills.single().status)
        assertTrue(bills.single().isCurrent)
    }
    @Test fun partialPaymentUsesCurrentAmountDueAndExcludesHistoricalArrears() {
        val current = JSONObject("""{"customerBill":[{"id":"a","billNo":"current","invoiceStatus":"1","amountDue":{"unit":"AUD","value":40},"remainingAmount":{"unit":"AUD","value":88}}]}""")
        val past = JSONObject("""{"customerBill":[{"id":"a","billNo":"past","invoiceStatus":"1","taxIncludedAmount":{"unit":"AUD","value":88},"remainingAmount":{"unit":"AUD","value":88}}]}""")
        val bills = mergeBillingHistory(VodafoneParser.bills(current, true), VodafoneParser.bills(past))
        assertEquals(4000L, currentAmountDue(bills))
        assertEquals("Partially paid", bills.first { it.isCurrent }.status)
        assertNull(currentAmountDue(VodafoneParser.bills(past)))
    }
    @Test fun correctedBillingCacheKeepsIndependentRefreshTimesAndDropsLegacyBalances() {
        val bill = Bill("b1", "b1", LocalDate.parse("2026-10-15"), LocalDate.parse("2026-11-02"), 8800, 0, "Paid", null, null, true)
        val account = AccountData(services=listOf(Service("0400000101", "Large", "a1")), bills=listOf(bill), updatedAt=5000, billsUpdatedAt=3000)
        val encoded = CacheCodec.encode(account, emptyList())
        val restored = CacheCodec.decode(JSONObject(encoded.toString())).first!!
        assertEquals(account, restored)
        assertEquals(0L, currentAmountDue(restored.bills))
        encoded.getJSONObject("account").remove("billingModelVersion")
        val legacy = CacheCodec.decode(encoded).first!!
        assertTrue(legacy.bills.isEmpty())
        assertEquals(account.services, legacy.services)
        assertEquals(0L, legacy.billsUpdatedAt)
        assertNull(currentAmountDue(legacy.bills))
    }
    @Test fun cacheRoundTripsUnknownValues() {
        val cycle = Cycle.containing(LocalDate.parse("2026-11-14"))
        val data = AccountData(listOf(Service("0400000101", "Large", "a1")), listOf(Pool("p1", "Shared", 1015*GIB, null, null, cycle)), updatedAt=1000)
        val history = History("0400000101", cycle.key, listOf(Session(cycle.start, 321)), 1000, false, "Partial")
        val (decoded, histories) = CacheCodec.decode(JSONObject(CacheCodec.encode(data, listOf(history)).toString()))
        assertEquals(data, decoded)
        assertEquals(listOf(history), histories)
        assertNull(decoded!!.pools.single().remaining)
    }
    @Test fun sessionCompactionPreservesEveryByteAndDate() {
        val records = (0..9999).map { Session(LocalDate.parse("2026-10-15").plusDays((it % 31).toLong()), it.toLong() + 123) }
        val compacted = dailyTotals(records)
        assertEquals(31, compacted.size)
        assertEquals(records.sumOf { it.bytes }, compacted.sumOf { it.bytes })
        assertEquals(records.groupBy { it.date }.mapValues { (_, rows) -> rows.sumOf { it.bytes } }, compacted.associate { it.date to it.bytes })
    }
    @Test fun unitsAndNumbersRejectUnexpectedInputs() {
        assertEquals("0400000101", canonicalNumber("+61 400 000 101"))
        assertEquals(GIB, numericBytes(1.0, "GB"))
        assertNull(numericBytes(-1.0, "GB"))
        assertNull(numericBytes(1.0, "bananas"))
        assertNull(parseDate("2026-02-30"))
    }
    @Test fun reconnectCacheRequiresTheSameVerifiedBillingAccountAndServices() {
        val old = listOf(Service("0400000101", "Old plan", "a1"), Service("0400000102", "Second", "a1"))
        assertTrue(sameServiceAccount(old, old.reversed().map { it.copy(plan="New label") }))
        assertFalse(sameServiceAccount(old, old.map { it.copy(accountId="other-account") }))
        assertFalse(sameServiceAccount(old, old.take(1)))
        assertFalse(sameServiceAccount(old.map { it.copy(accountId="") }, old.map { it.copy(accountId="") }))
    }
    @Test fun foregroundRefreshCoversMultiDayGapsWithoutDuplicatingActiveWork() {
        val state = UiState(account=AccountData(updatedAt=1_000), connected=true)
        assertFalse(needsForegroundRefresh(state, 60_000))
        assertTrue(needsForegroundRefresh(state, 301_000))
        assertTrue(needsForegroundRefresh(state, 3L * 86_400_000))
        assertFalse(needsForegroundRefresh(state.copy(loading=true), 3L * 86_400_000))
        assertFalse(needsForegroundRefresh(state.copy(historyLoading=true), 3L * 86_400_000))
        assertFalse(needsForegroundRefresh(state.copy(connected=false), 3L * 86_400_000))
        assertFalse(needsForegroundRefresh(state.copy(demo=true), 3L * 86_400_000))
    }
}
