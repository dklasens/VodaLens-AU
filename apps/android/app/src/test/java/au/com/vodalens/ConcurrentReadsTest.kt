package au.com.vodalens

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class ConcurrentReadsTest {
    @Test fun readsOverlapWithinSharedBudgetAndPreserveInputOrder() = runBlocking {
        val active = AtomicInteger(); val maximum = AtomicInteger()
        val gate = Semaphore(3)
        val results = (1..15).toList().parallelReads(gate) { value ->
            val count = active.incrementAndGet(); maximum.updateAndGet { maxOf(it,count) }
            try { delay((16-value).toLong()); value * 2 } finally { active.decrementAndGet() }
        }
        assertEquals((1..15).map { it*2 },results)
        assertTrue(maximum.get()>1); assertTrue(maximum.get()<=3); assertEquals(0,active.get())
    }
    @Test fun failedReadCancelsSiblingsAndReleasesPermits() = runBlocking {
        val gate = Semaphore(2)
        val started = CompletableDeferred<Unit>(); var cancelled = false
        try {
            listOf(1,2).parallelReads(gate) { value ->
                if(value == 1) { started.await(); throw IllegalStateException("Provider failure") }
                else { started.complete(Unit); try { awaitCancellation() } finally { cancelled=true } }
            }
            fail("Must propagate failure")
        } catch(_: IllegalStateException) { }
        assertTrue(cancelled); assertEquals(2,gate.availablePermits)
    }
    @Test fun independentBatchesShareTheSameLimit() = runBlocking {
        val gate=Semaphore(2); val active=AtomicInteger(); val maximum=AtomicInteger()
        coroutineScope {
            repeat(3) { launch { (1..5).toList().parallelReads(gate) {
                val n=active.incrementAndGet(); maximum.updateAndGet { maxOf(it,n) }
                try { delay(5) } finally { active.decrementAndGet() }
            } } }
        }
        assertEquals(2,maximum.get())
    }
}
