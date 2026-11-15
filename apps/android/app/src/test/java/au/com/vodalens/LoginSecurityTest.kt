package au.com.vodalens

import org.junit.Assert.*
import org.junit.Test

class LoginSecurityTest {
    @Test fun exactHttpsHostsOnly() {
        assertTrue(LoginNavigationPolicy.allowedDocument("https://authn.vodafone.com.au/login"))
        assertTrue(LoginNavigationPolicy.portal("https://my.vodafone.com.au:443/home"))
        listOf("http://my.vodafone.com.au", "https://my.vodafone.com.au.attacker.example", "https://my.vodafone.com.au@attacker.example", "https://attacker@my.vodafone.com.au", "https://my.vodafone.com.au:8443", "file:///login.html", "javascript:alert(1)", "about:blank", "not a url").forEach { assertFalse(it, LoginNavigationPolicy.allowedDocument(it)) }
        assertFalse(LoginNavigationPolicy.portal("https://authn.vodafone.com.au/login"))
    }
    @Test fun interceptionRecognizesPostAndSubframeDocumentsButAllowsStaticGetResources() {
        assertTrue(LoginNavigationPolicy.documentLike(true, "GET", emptyMap()))
        assertTrue(LoginNavigationPolicy.documentLike(false, "POST", emptyMap()))
        assertTrue(LoginNavigationPolicy.documentLike(false, "GET", mapOf("sec-fetch-dest" to "iframe")))
        assertTrue(LoginNavigationPolicy.documentLike(false, "GET", mapOf("Accept" to "text/html,application/xhtml+xml")))
        assertFalse(LoginNavigationPolicy.documentLike(false, "GET", mapOf("Accept" to "text/css", "Sec-Fetch-Dest" to "style")))
        assertFalse(LoginNavigationPolicy.documentLike(false, "GET", mapOf("Accept" to "*/*", "Sec-Fetch-Dest" to "script")))
    }
    @Test fun storageCompletionFromNavigatedPageCannotCommit() {
        val gate = LoginHandoffGate()
        gate.request()
        val generation = gate.accept("test-transaction-0001")!!
        assertTrue(gate.current("test-transaction-0001", generation))
        gate.navigate()
        assertFalse(gate.current("test-transaction-0001", generation))
        assertFalse(gate.current("test-transaction-0001"))
        assertNull(gate.accept("test-transaction-0002"))
    }
    @Test fun requiresFreshUserActionAndRejectsDuplicateOrStaleTransaction() {
        val gate = LoginHandoffGate()
        assertNull(gate.accept("test-transaction-0001"))
        gate.request()
        assertNotNull(gate.accept("test-transaction-0001"))
        assertNull(gate.accept("test-transaction-0002"))
        gate.cancel()
        assertFalse(gate.current("test-transaction-0001"))
        gate.request()
        assertNotNull(gate.accept("test-transaction-0002"))
        assertFalse(gate.current("test-transaction-0001"))
        assertTrue(gate.current("test-transaction-0002"))
    }
    @Test fun slowPageCanRecoverWhenSignInFinishesAfterDelay() {
        val recovery = LoginRecoveryGate()
        assertTrue(recovery.shouldOfferDelay(false, true, false, false, false))
        recovery.fail(pageDelay = true)
        assertTrue(recovery.restartRequired)
        assertFalse(recovery.acceptReady(false))
        // A verified ready packet after a user takes more than 30 seconds to sign in.
        assertTrue(recovery.acceptReady(true))
        assertFalse(recovery.restartRequired)
    }
    @Test fun visibleFormAndAuthPageAreNotHungDocuments() {
        val recovery = LoginRecoveryGate()
        assertFalse(recovery.shouldOfferDelay(true, true, false, false, false))
        assertFalse(recovery.shouldOfferDelay(false, false, false, false, false))
        assertFalse(recovery.shouldOfferDelay(false, true, true, false, false))
        assertFalse(recovery.shouldOfferDelay(false, true, false, false, true))
    }
    @Test fun readyCannotRecoverFatalNavigationOrHandoffFailure() {
        val recovery = LoginRecoveryGate()
        recovery.fail()
        recovery.fail(pageDelay = true)
        assertFalse(recovery.acceptReady(true))
        assertTrue(recovery.restartRequired)
        assertFalse(recovery.shouldOfferDelay(false, true, false, false, false))
    }

}
