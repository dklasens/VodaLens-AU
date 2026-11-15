package au.com.vodalens

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import org.junit.Assert.*
import org.junit.Test

class SessionRenewalTest {
    @Test fun concurrentCallersRotateOnceAndPersistBeforeReceivingAccess() = runBlocking {
        var stored = Credentials("old-access", "old-refresh", 900)
        var exchanges = 0
        val renewal = SessionRenewal(load = { stored }, save = { stored = it }, exchange = {
            exchanges++
            assertTrue(stored.uncertain)
            delay(20)
            RenewalResponse("new-access", "new-refresh", 300, "Bearer")
        }, now = { 1000 })
        val results = (1..30).map { async { renewal.access().also { assertEquals("new-refresh", stored.refresh); assertFalse(stored.uncertain) } } }.awaitAll()
        assertEquals(1, exchanges)
        assertTrue(results.all { it == "new-access" })
    }
    @Test fun separateApiInstancesCanShareOneRotationGate() = runBlocking {
        var stored = Credentials("old-access", "old-refresh", 900)
        var exchanges = 0
        val gate = Mutex()
        fun coordinator() = SessionRenewal({ stored }, { stored = it }, { exchanges++; delay(20); RenewalResponse("new-access", "new-refresh", 300, "Bearer") }, now={1000}, gate=gate)
        val one = coordinator(); val two = coordinator()
        listOf(async { one.access() }, async { two.access() }).awaitAll()
        assertEquals(1, exchanges)
    }
    @Test fun interruptedExchangeCannotReplayAfterRestart() = runBlocking {
        var stored = Credentials("old-access", "old-refresh", 900)
        var exchanges = 0
        fun coordinator() = SessionRenewal({ stored }, { stored = it }, { exchanges++; throw java.net.SocketTimeoutException() }, now={1000})
        try { coordinator().access(); fail("Must require reconnection") } catch(e: VodafoneFailure) { assertEquals(401, e.status) }
        assertTrue(stored.uncertain)
        try { coordinator().access(); fail("Must not replay an uncertain refresh token") } catch(e: VodafoneFailure) { assertEquals(401, e.status) }
        assertEquals(1, exchanges)
    }
    @Test fun offlineOpenKeepsCredentialUsableForLater() = runBlocking {
        val original = Credentials("old-access", "old-refresh", 900)
        var stored = original
        var exchanges = 0
        val renewal = SessionRenewal({ stored }, { stored=it }, { exchanges++; error("Unexpected request") }, online={false}, now={1000})
        try { renewal.access(); fail("Offline") } catch(_: java.net.UnknownHostException) { }
        assertEquals(original, stored)
        assertEquals(0, exchanges)
    }
    @Test fun rejectedOldTokenDoesNotForceAnotherRotationForWaitingCallers() = runBlocking {
        var stored = Credentials("new-access", "new-refresh", 301_000)
        var exchanges = 0
        val renewal = SessionRenewal({ stored }, { stored=it }, { exchanges++; error("Unexpected rotation") }, now={1000})
        assertEquals("new-access", renewal.access("old-access"))
        assertEquals(0, exchanges)
    }
    @Test fun malformedSuccessCannotInstallAnUnusableCredential() = runBlocking {
        var stored = Credentials("old-access", "old-refresh", 900)
        val renewal = SessionRenewal({ stored }, { stored=it }, { RenewalResponse("new-access", "", 300, "Bearer") }, now={1000})
        try { renewal.access(); fail("Missing replacement refresh token") } catch(e: VodafoneFailure) { assertEquals(401, e.status) }
        assertTrue(stored.uncertain)
        assertEquals("old-refresh", stored.refresh)
    }
}
