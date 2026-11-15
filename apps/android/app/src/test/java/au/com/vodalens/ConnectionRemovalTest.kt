package au.com.vodalens

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ConnectionRemovalTest {
    @Test fun forgetsBeforeSendingRevocationAndKeepsNothingAfterFailure() = runBlocking {
        var stored: Credentials?=Credentials("access","refresh",1)
        var requested=false
        val result=removeConnection({stored},{stored=null}) { token ->
            assertNull(stored); assertEquals("refresh",token); requested=true
            throw java.net.UnknownHostException("Offline")
        }
        assertFalse(result); assertTrue(requested); assertNull(stored)
    }
    @Test fun unreadableCredentialStillClearsLocalFiles() = runBlocking {
        var cleared=false
        val result=removeConnection({error("Unreadable")},{cleared=true}) { error("Must not send") }
        assertFalse(result); assertTrue(cleared)
    }
    @Test fun absentCredentialNeedsNoIssuerRequest() = runBlocking {
        var cleared=false
        assertTrue(removeConnection({null},{cleared=true}) { error("Must not send") })
        assertTrue(cleared)
    }
}
