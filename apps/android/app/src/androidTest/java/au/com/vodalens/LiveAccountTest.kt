package au.com.vodalens

import android.content.pm.ApplicationInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/** Read-only device evidence. Requires explicit opt-in and an already connected account. */
@RunWith(AndroidJUnit4::class)
class LiveAccountTest {
    @Test fun encryptedLiveSnapshotIsUsableWithoutADesktopBackend() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveAccount") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue(context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        val store = SecureStore(context)
        val saved = store.read("cache")
        assertNotNull("Sign in to Vodafone on the device before this read-only test.", saved)
        val (account, histories) = CacheCodec.decode(saved!!)
        assertNotNull(account)
        account!!
        assertEquals(3, account.services.size)
        assertEquals(1, account.pools.size)
        assertEquals(1015 * GIB, account.pools.sumOf { it.total })
        assertTrue(account.pools.all { it.remaining != null })
        assertTrue("Six recent invoices must be present", account.bills.size >= 6)
        assertTrue(account.bills.all { it.amountCents != null && it.due != null && it.issued != null })
        assertEquals(account.bills.size, account.bills.map { it.id }.distinct().size)
        val connection = store.credentials()
        assertNotNull(connection)
        assertFalse(connection!!.uncertain)
        val encrypted = File(context.noBackupFilesDir, "vodalens/connection").readBytes()
        assertEquals(1, encrypted[0].toInt())
        val bytesAsText = encrypted.toString(Charsets.ISO_8859_1)
        assertFalse("Access credential must remain encrypted", bytesAsText.contains(connection.access))
        assertFalse("Refresh credential must remain encrypted", bytesAsText.contains(connection.refresh))
        val snapshot = JSONObject().put("verifiedAt", Instant.now().toString()).put("source", "On-device Android Keystore decryption and normalized cache inspection").put("serviceCount", account.services.size).put("sharedPoolCount", account.pools.size).put("sharedAllowanceMatches1015GB", true).put("billCount", account.bills.size).put("billMonths", JSONArray(account.bills.mapNotNull { it.issued?.toString()?.take(7) }.distinct())).put("billAmountsAndDueDatesPresent", true).put("credentialEncryptedAtRest", true).put("credentialUncertain", false).put("backendRequired", false)
        snapshot.put("cachedHistory", JSONArray(histories.groupBy { it.cycle }.toSortedMap().map { (cycle, rows) -> JSONObject().put("cycle", cycle).put("servicesFetched", rows.size).put("recordCounts", JSONArray(rows.map { it.sourceRecordCount })).put("cachedDailyTotals", rows.sumOf { it.sessions.size }).put("validRecordsParsed", rows.all { it.complete }) }))
        snapshot.put("cacheBytes", File(context.noBackupFilesDir, "vodalens/cache").length())
        File(context.filesDir, "verification.json").writeText(snapshot.toString(2))
    }
}
