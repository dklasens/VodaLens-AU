package au.com.vodalens

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/** Independent reads share a small concurrency budget; results retain input order. */
internal suspend fun <T, R> List<T>.parallelReads(gate: Semaphore, read: suspend (T) -> R): List<R> = coroutineScope {
    map { value -> async(Dispatchers.IO) { gate.withPermit { read(value) } } }.awaitAll()
}
