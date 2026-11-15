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
    @Test fun mainFrameAndDocumentMetadataTakePrecedenceOverResourceHints() {
        assertTrue(LoginNavigationPolicy.documentLike(true, emptyMap()))
        assertTrue(LoginNavigationPolicy.documentLike(true, mapOf("Accept" to "application/json", "Sec-Fetch-Dest" to "empty")))
        assertTrue(LoginNavigationPolicy.documentLike(false, mapOf("sec-fetch-dest" to "iframe", "Accept" to "application/json")))
        assertTrue(LoginNavigationPolicy.documentLike(false, mapOf("Sec-Fetch-Mode" to "navigate", "Sec-Fetch-Dest" to "empty", "Accept" to "application/json")))
        assertTrue(LoginNavigationPolicy.documentLike(false, mapOf("Sec-Fetch-Dest" to "object")))
    }
    @Test fun metadataFreeHtmlFormDocumentsRemainRestricted() {
        assertTrue(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "text/html,application/xhtml+xml")))
        assertTrue(LoginNavigationPolicy.documentLike(false, mapOf("accept" to "application/xhtml+xml;q=0.9,*/*;q=0.8")))
    }
    @Test fun fetchXhrAndStaticResourcesDoNotBecomeDocuments() {
        // Applies equally to GET and POST: method is deliberately not a classifier input.
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "application/json")))
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Content-Type" to "application/problem+json; charset=utf-8")))
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "text/html", "Sec-Fetch-Dest" to "empty")))
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "text/html", "Sec-Fetch-Mode" to "cors")))
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "text/css", "Sec-Fetch-Dest" to "style")))
        assertFalse(LoginNavigationPolicy.documentLike(false, mapOf("Accept" to "*/*", "Sec-Fetch-Dest" to "script")))
        assertFalse(LoginNavigationPolicy.documentLike(false, emptyMap()))
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
