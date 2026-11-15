package au.com.vodalens

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.ReportDrawnWhen
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        setContent {
            val context = LocalContext.current
            val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            MaterialTheme(colorScheme = colors) { Surface(Modifier.fillMaxSize()) { VodaLensApp() } }
        }
    }
}
private val shortDate = DateTimeFormatter.ofPattern("d MMM")
private val fullDate = DateTimeFormatter.ofPattern("d MMM yyyy")
private val dayDate = DateTimeFormatter.ofPattern("EEE, d MMM")
private val monthDate = DateTimeFormatter.ofPattern("MMM yyyy")
private fun Cycle.label() = "${start.format(shortDate)} – ${end.minusDays(1).format(shortDate)}"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VodaLensApp(model: LensViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_START) { model.onForeground() }
    ReportDrawnWhen { state.account != null || !state.loading }
    var login by rememberSaveable { mutableStateOf(false) }
    val loginLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) model.connectionReady()
    }
    var accountSheet by remember { mutableStateOf(false) }
    var disconnectDialog by remember { mutableStateOf(false) }
    var selectedBill by remember { mutableStateOf<Bill?>(null) }
    var selectedDay by remember { mutableStateOf<LocalDate?>(null) }
    LaunchedEffect(login) { if(login) { login = false; loginLauncher.launch(android.content.Intent(model.getApplication(), VodafoneLoginActivity::class.java)) } }
    BackHandler(state.selectedLine != null) { model.selectLine(null) }
    if (state.account == null && !state.loading) {
        WelcomeScreen(onConnect = { login = true }, onPreview = model::showPreview, error = state.error)
        return
    }
    Scaffold(
        topBar = {
            TopAppBar(title = {
                Column {
                    Text(if (state.selectedLine != null) "Daily usage" else "VodaLens", fontWeight = FontWeight.SemiBold)
                    if (state.demo) Text("Preview · sample data", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary)
                }
            }, navigationIcon = { if (state.selectedLine != null) IconButton(onClick = { model.selectLine(null) }) { LensIcon("back", "Back to shared usage") } }, actions = {
                if (state.loading || state.historyLoading) Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(21.dp), strokeWidth = 2.dp) }
                else IconButton(onClick = model::refresh, enabled = !state.demo) { LensIcon("refresh", "Refresh Vodafone data") }
                IconButton(onClick = { accountSheet = true }) { LensIcon("account", "Connection and privacy") }
            })
        },
        bottomBar = {
            if (state.selectedLine == null) NavigationBar {
                NavigationBarItem(selected = state.tab == 0, onClick = { model.selectTab(0) }, icon = { LensIcon("usage", "") }, label = { Text("Usage") })
                NavigationBarItem(selected = state.tab == 1, onClick = { model.selectTab(1) }, icon = { LensIcon("bill", "") }, label = { Text("Bills") })
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            if (state.account == null) {
                Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) { CircularProgressIndicator(); Spacer(Modifier.height(20.dp)); Text("Getting your Vodafone account…") }
            } else if (state.selectedLine != null) {
                DailyScreen(state, model, selectedDay = { selectedDay = it })
            } else if (state.tab == 0) UsageScreen(state, model, onConnect = { login = true }, selectedDay = { selectedDay = it })
            else BillsScreen(state, onBill = { selectedBill = it }, onRetry = model::refresh)
        }
    }
    if (accountSheet) ModalBottomSheet(onDismissRequest = { accountSheet = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Your connection", style = MaterialTheme.typography.headlineSmall)
            Text(if (state.demo) "You’re viewing sample data." else if (state.connected) "Connected to My Vodafone" else "Vodafone sign-in required", style = MaterialTheme.typography.titleMedium)
            Text("Your connection and usage history are encrypted on this phone. VodaLens has no account server, advertising or analytics.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            state.account?.updatedAt?.takeIf { it > 0 }?.let { Text("Last updated ${Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM, h:mm a"))}", style = MaterialTheme.typography.bodySmall) }
            if (state.demo) Button(onClick = { accountSheet = false; model.exitPreview() }, modifier = Modifier.fillMaxWidth()) { Text("Leave preview") }
            else {
                if (!state.connected) Button(onClick = { accountSheet = false; login = true }, modifier = Modifier.fillMaxWidth()) { Text("Reconnect Vodafone") }
                OutlinedButton(onClick = { accountSheet = false; disconnectDialog = true }, modifier = Modifier.fillMaxWidth()) { Text("Disconnect and clear local data") }
            }
            Text("Unofficial personal companion for Vodafone AU.", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (disconnectDialog) AlertDialog(onDismissRequest = { disconnectDialog = false }, title = { Text("Disconnect Vodafone?") }, text = { Text("This removes the saved connection and usage history from this phone. Your Vodafone account stays unchanged.") }, confirmButton = { TextButton(onClick = { disconnectDialog = false; model.disconnect() }) { Text("Disconnect") } }, dismissButton = { TextButton(onClick = { disconnectDialog = false }) { Text("Keep connected") } })
    selectedBill?.let { bill -> ModalBottomSheet(onDismissRequest = { selectedBill = null }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(bill.issued?.format(DateTimeFormatter.ofPattern("MMMM yyyy")) ?: "Bill details", style = MaterialTheme.typography.headlineSmall)
            Text(money(bill.amountCents), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
            DetailRow("Status", bill.status.replaceFirstChar { it.titlecase() })
            DetailRow("Bill number", bill.number.ifEmpty { "Unavailable" })
            DetailRow("Issued", bill.issued?.format(fullDate) ?: "Unavailable")
            DetailRow("Due", bill.due?.format(fullDate) ?: "Unavailable")
            DetailRow("Outstanding", money(bill.outstandingCents))
            if (bill.periodStart != null && bill.periodEnd != null) DetailRow("Period", "${bill.periodStart.format(shortDate)} – ${bill.periodEnd.format(fullDate)}")
        }
    } }
    selectedDay?.let { date -> ModalBottomSheet(onDismissRequest = { selectedDay = null }) {
        val histories = state.histories.filter { it.cycle == state.selectedCycle.key }
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(date.format(DateTimeFormatter.ofPattern("EEEE, d MMMM")), style = MaterialTheme.typography.headlineSmall)
            state.account?.services.orEmpty().filter { state.selectedLine == null || state.selectedLine == "all" || it.number == state.selectedLine }.forEachIndexed { index, service ->
                val history = histories.firstOrNull { it.number == service.number }
                ServiceUsageRow(service, state.account!!.services.indexOf(service), history?.daily?.get(date) ?: if(history != null) 0 else null, null)
            }
            Text("Sessions use Vodafone’s recorded day. Recent usage may arrive later.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } }
}

@Composable
private fun WelcomeScreen(onConnect: () -> Unit, onPreview: () -> Unit, error: String?) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val scrolling = if(maxHeight < 680.dp || LocalDensity.current.fontScale > 1.3f) Modifier.verticalScroll(rememberScrollState()) else Modifier
    Column(Modifier.fillMaxSize().safeDrawingPadding().then(scrolling).padding(28.dp), verticalArrangement = Arrangement.SpaceBetween) {
        Text("VodaLens", Modifier.padding(top = 16.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Box(Modifier.size(80.dp).clip(RoundedCornerShape(26.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) { LensIcon("usage", "", Modifier.size(40.dp), MaterialTheme.colorScheme.onPrimaryContainer) }
            Text("Your data.\nA clearer view.", style = MaterialTheme.typography.displayMedium, fontWeight = FontWeight.SemiBold)
            Text("One shared pool. Every line. Every day.\nSee your usage and bills, simply.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Private on your phone · Vodafone AU", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Button(onClick = onConnect, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Connect My Vodafone", style = MaterialTheme.typography.titleSmall) }
            TextButton(onClick = onPreview) { Text("Preview with sample data") }
            Text("Sign in securely on Vodafone’s own page.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    }
}

@Composable
private fun UsageScreen(state: UiState, model: LensViewModel, onConnect: () -> Unit, selectedDay: (LocalDate) -> Unit) {
    val account = state.account ?: return
    val current = currentCycle(account)
    val isCurrent = state.selectedCycle.start == current.start
    val histories = state.histories.filter { it.cycle == state.selectedCycle.key }
    val allFetched = account.services.all { s -> histories.any { it.number == s.number && it.complete } }
    val totals = histories.flatMap { it.sessions }.groupBy { it.date }.mapValues { (_, records) -> records.sumOf { it.bytes } }
    LazyColumn(Modifier.fillMaxSize().widthIn(max = 680.dp), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { CycleSelector(current, state.selectedCycle, model::selectCycle, if(isCurrent) account.updatedAt else histories.minOfOrNull { it.fetchedAt } ?: 0) }
        if (state.error != null || !state.connected && !state.demo) item { Notice(state.error ?: "Reconnect to update your saved data.", if (!state.connected) "Reconnect" else "Try again", if (!state.connected) onConnect else model::refresh, attention = true, heading = if(!state.connected) "Sign-in required" else "Couldn’t refresh") }
        item {
            if (isCurrent) PoolCard(account, current)
            else Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${state.selectedCycle.label()} · usage", style = MaterialTheme.typography.labelLarge)
                    Text(if(histories.isEmpty()) "—" else dataSize(histories.sumOf { it.total }), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
                    Text(if(allFetched) "Reported across ${account.services.size} services" else "${histories.size} of ${account.services.size} services loaded", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        item { SectionHeading("Your services", "${account.services.size} sharing the pool") }
        items(account.services, key = { it.number }) { service ->
            val index = account.services.indexOf(service)
            val history = histories.firstOrNull { it.number == service.number }
            val amount = if (isCurrent) account.lineUsed[service.number] ?: history?.total else history?.total
            Surface(onClick = { model.selectLine(service.number) }, shape = RoundedCornerShape(22.dp), color = lineColor(index).copy(alpha = .075f).compositeOver(MaterialTheme.colorScheme.surfaceContainerLow)) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ServiceUsageRow(service, index, amount) { LensIcon("chevron", "View daily usage", Modifier.size(20.dp)) }
                    val total = if (isCurrent) account.pools.sumOf { it.total } else histories.sumOf { it.total }
                    if (amount != null && total > 0) LinearProgressIndicator(progress = { (amount.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(4.dp), color = lineColor(index), trackColor = lineColor(index).copy(alpha = .18f), drawStopIndicator = {})
                    state.historyErrors["${service.number}|${state.selectedCycle.key}"]?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    history?.warning?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
        item { SectionHeading("By day", if (isCurrent) "This billing cycle" else state.selectedCycle.start.format(monthDate)) }
        item { DailyChart(state.selectedCycle, totals, allFetched, selectedDay) }
        if (histories.isNotEmpty()) {
            val dates = state.selectedCycle.dates().filter { it <= LocalDate.now() }.takeLast(7).reversed()
            items(dates) { date -> DayRow(date, if(allFetched || totals.containsKey(date)) totals[date] ?: 0 else null, onClick = { selectedDay(date) }) }
            item { TextButton(onClick = { model.selectLine("all") }, modifier = Modifier.fillMaxWidth()) { Text("View every day") } }
        } else item { Notice(if(state.historyLoading) "Loading daily usage…" else "No history is cached for this cycle.", if(state.historyLoading) null else "Load history", model::retryHistory) }
        item { Text("Vodafone may delay recent usage or limit older history. Loaded periods show returned records; missing periods are never treated as zero usage.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun PoolCard(account: AccountData, cycle: Cycle) {
    val pools = account.pools.filter { it.cycle == cycle }
    val total = pools.sumOf { it.total }
    val remaining = if(pools.isNotEmpty() && pools.all { it.remaining != null }) pools.sumOf { it.remaining!! } else null
    val used = if(remaining != null) (total - remaining).coerceAtLeast(0) else if(pools.isNotEmpty() && pools.all { it.used != null }) pools.sumOf { it.used!! } else null
    val useFraction = if(total > 0 && used != null) used.toFloat() / total else 0f
    val elapsed = cycle.progress(java.time.ZonedDateTime.now())
    val remainingDays = ChronoUnit.DAYS.between(LocalDate.now(), cycle.end).coerceAtLeast(0)
    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.primaryContainer, contentColor = MaterialTheme.colorScheme.onPrimaryContainer) {
        Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Shared data remaining", style = MaterialTheme.typography.labelLarge)
                Text(remaining?.let(::dataSize) ?: "Unavailable", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
                Text(if(total > 0) "of ${dataSize(total)} · ${account.services.size} services" else "Vodafone hasn’t returned the pool allowance.", style = MaterialTheme.typography.bodyMedium)
            }
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                ProgressRow("Data used", if(used != null) "${dataSize(used)} · ${percent(useFraction)}" else "Unavailable", useFraction, LensAccents.data(MaterialTheme.colorScheme.primaryContainer.luminance() > .5f))
                ProgressRow("Cycle elapsed", percent(elapsed), elapsed, LensAccents.cycle(MaterialTheme.colorScheme.primaryContainer.luminance() > .5f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column { Text(cycle.label(), style = MaterialTheme.typography.labelLarge); Text("$remainingDays days until reset", style = MaterialTheme.typography.bodySmall) }
                if (used != null && total > 0 && elapsed > 0) PaceBadge(useFraction <= elapsed)
            }
        }
    }
}
@Composable
private fun ProgressRow(label: String, value: String, fraction: Float, color: Color) {
    val accent = LensAccents.readable(color, MaterialTheme.colorScheme.primaryContainer)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(label, style = MaterialTheme.typography.bodyMedium); Text(value, style = MaterialTheme.typography.labelLarge, color = accent) }
        LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(7.dp), color = accent, trackColor = accent.copy(alpha = .18f), drawStopIndicator = {})
    }
}
@Composable
private fun CycleSelector(current: Cycle, selected: Cycle, onSelect: (Cycle) -> Unit, refreshedAt: Long = 0) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (0..6).forEach { offset -> val cycle = Cycle.containing(current.start.minusMonths(offset.toLong()), current.start.dayOfMonth)
                FilterChip(selected = selected.start == cycle.start, onClick = { onSelect(cycle) }, label = { Text(if(offset == 0) "This cycle" else cycle.start.format(monthDate)) })
            }
        }
        Text(selected.label(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        RefreshTimestamp(refreshedAt)
    }
}
@Composable
private fun DailyScreen(state: UiState, model: LensViewModel, selectedDay: (LocalDate) -> Unit) {
    val account = state.account ?: return
    val service = account.services.firstOrNull { it.number == state.selectedLine }
    val accent = if(service != null) lineColor(account.services.indexOf(service)) else LensAccents.data(MaterialTheme.colorScheme.surface.luminance() > .5f)
    val histories = state.histories.filter { it.cycle == state.selectedCycle.key && (state.selectedLine == "all" || it.number == state.selectedLine) }
    val allFetched = if(service != null) histories.any { it.complete } else account.services.all { s -> histories.any { it.number == s.number && it.complete } }
    val totals = histories.flatMap { it.sessions }.groupBy { it.date }.mapValues { (_, rows) -> rows.sumOf { it.bytes } }
    LazyColumn(Modifier.fillMaxSize().widthIn(max = 680.dp), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item { Text(service?.formatted ?: "All services", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = accent); service?.let { Text(it.plan, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        item { CycleSelector(currentCycle(account), state.selectedCycle, model::selectCycle, histories.minOfOrNull { it.fetchedAt } ?: 0) }
        item { Text(if(histories.isEmpty()) "—" else dataSize(histories.sumOf { it.total }), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold); Text("Reported this cycle", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { DailyChart(state.selectedCycle, totals, allFetched, selectedDay, accent) }
        if(!allFetched) item { Notice(if(state.historyLoading) "Loading Vodafone history…" else "Some daily history is unavailable.", if(state.historyLoading) null else "Try again", model::retryHistory) }
        histories.mapNotNull { it.warning }.distinct().forEach { warning -> item { Notice(warning) } }
        items(state.selectedCycle.dates().filter { it <= LocalDate.now() }.reversed()) { date -> DayRow(date, if(allFetched || totals.containsKey(date)) totals[date] ?: 0 else null, onClick = { selectedDay(date) }) }
        item { Text("A day with no returned sessions is shown as 0 B only after Vodafone returns that period. Older empty periods may reflect Vodafone’s retention limit. Recent sessions may arrive later.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
@Composable
private fun DailyChart(cycle: Cycle, totals: Map<LocalDate, Long>, allFetched: Boolean, onDay: (LocalDate) -> Unit, accent: Color? = null) {
    val color = accent ?: LensAccents.data(MaterialTheme.colorScheme.surface.luminance() > .5f)
    val muted = MaterialTheme.colorScheme.surfaceContainerHighest
    val dates = cycle.dates()
    val maximum = (totals.values.maxOrNull() ?: 1L).coerceAtLeast(1).toFloat()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Canvas(Modifier.fillMaxWidth().height(124.dp).semantics { contentDescription = "Daily usage chart for ${cycle.label()}. Daily values are listed below." }.pointerInput(cycle, totals) { detectTapGestures { offset -> val index = (offset.x / size.width * dates.size).toInt().coerceIn(0, dates.lastIndex); if(dates[index] <= LocalDate.now()) onDay(dates[index]) } }) {
            val step = size.width / dates.size
            dates.forEachIndexed { index, date ->
                val bytes = totals[date]
                val future = date > LocalDate.now()
                val height = if(bytes != null && bytes > 0) (bytes / maximum * (size.height - 6.dp.toPx())).coerceAtLeast(4.dp.toPx()) else 3.dp.toPx()
                drawRoundRect(if(future || bytes == null && !allFetched) muted.copy(alpha = .5f) else if(bytes == null || bytes == 0L) muted else color, Offset(index * step + 2.dp.toPx(), size.height - height), Size((step - 4.dp.toPx()).coerceAtLeast(2f), height), androidx.compose.ui.geometry.CornerRadius(3.dp.toPx()))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(cycle.start.format(shortDate), style = MaterialTheme.typography.labelSmall); Text(cycle.end.minusDays(1).format(shortDate), style = MaterialTheme.typography.labelSmall) }
    }
}
@Composable
private fun BillsScreen(state: UiState, onBill: (Bill) -> Unit, onRetry: () -> Unit) {
    val account = state.account ?: return
    val bills = account.bills.sortedByDescending { it.issued }
    val amountDue = currentAmountDue(bills)
    val currentBills = bills.filter { it.isCurrent }
    val unpaid = currentBills.filter { (it.outstandingCents ?: 0) > 0 }.minByOrNull { it.due ?: LocalDate.MAX }
    val overdue = unpaid?.due?.let { it < LocalDate.now() } == true
    val upcoming = currentBills.filter { it.due != null && it.due >= LocalDate.now() && (it.outstandingCents ?: 0) > 0 }.minByOrNull { it.due!! }
    LazyColumn(Modifier.fillMaxSize().widthIn(max = 680.dp), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item { Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { Text("Bills, at a glance.", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold); RefreshTimestamp(account.billsUpdatedAt) } }
        item { Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
            Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if(overdue) "Overdue amount" else if(amountDue != null && amountDue < 0) "Account credit" else if(amountDue == 0L) "You’re up to date" else "Amount due", style = MaterialTheme.typography.labelLarge)
                Text(money(amountDue?.let { if(it < 0) -it else it }), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold)
                Text(if(amountDue == null) "Vodafone hasn’t returned the current account balance." else if(amountDue < 0) "Credit reported by Vodafone." else if(unpaid != null) unpaid.due?.let { "${if(overdue) "Was due" else "Due"} ${it.format(fullDate)}" } ?: "Due date unavailable" else "No outstanding amount reported.", style = MaterialTheme.typography.bodyMedium)
                if(unpaid != null) TextButton(onClick = { onBill(unpaid) }, contentPadding = PaddingValues(0.dp)) { Text("View bill details") }
            }
        } }
        if(overdue || unpaid == null) item {
            Surface(shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Your next bill", style = MaterialTheme.typography.titleSmall)
                    Text(upcoming?.let { "${money(it.amountCents)} · due ${it.due!!.format(shortDate)}" } ?: "Not issued yet", style = MaterialTheme.typography.bodyLarge)
                    if(upcoming == null) Text("The amount and due date will appear when Vodafone issues it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        account.billingError?.let { item { Notice("Billing couldn’t be updated. $it", "Try again", onRetry) } }
        item { SectionHeading("Bill history", "Up to 6 months") }
        items(bills, key = { it.id }) { bill ->
            Surface(onClick = { onBill(bill) }, shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) { LensIcon("bill", "", Modifier.size(22.dp)) }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(bill.issued?.format(DateTimeFormatter.ofPattern("MMMM yyyy")) ?: "Vodafone bill", style = MaterialTheme.typography.titleSmall)
                        Text(bill.status.replaceFirstChar { it.titlecase() }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(money(bill.amountCents), style = MaterialTheme.typography.titleMedium)
                    LensIcon("chevron", "View bill", Modifier.size(16.dp))
                }
            }
        }
        if(bills.isEmpty() && account.billingError == null) item { Text("Vodafone hasn’t returned any bills for the last six months.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        item { Text("Amounts and dates come from Vodafone. Future bills are shown only after they are issued.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
@Composable
private fun RefreshTimestamp(timestamp: Long) {
    val use24Hour = android.text.format.DateFormat.is24HourFormat(LocalContext.current)
    val pattern = if(use24Hour) "d MMM yyyy, HH:mm" else "d MMM yyyy, h:mm a"
    val text = if(timestamp > 0) "Last refreshed ${Instant.ofEpochMilli(timestamp).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern(pattern))}" else "Not yet refreshed"
    Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
@Composable
private fun SectionHeading(title: String, subtitle: String) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
@Composable
private fun ServiceUsageRow(service: Service, index: Int, bytes: Long?, trailing: (@Composable () -> Unit)?) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(lineColor(index).copy(alpha = .15f)), contentAlignment = Alignment.Center) { Text("${index + 1}", color = lineColor(index), style = MaterialTheme.typography.titleSmall) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(service.formatted, style = MaterialTheme.typography.titleSmall)
            Text(service.plan, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(bytes?.let(::dataSize) ?: "—", style = MaterialTheme.typography.titleMedium)
        trailing?.invoke()
    }
}
@Composable
private fun DayRow(date: LocalDate, bytes: Long?, onClick: () -> Unit) { Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(vertical = 14.dp, horizontal = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { Text(if(date == LocalDate.now()) "Today · ${date.format(shortDate)}" else date.format(dayDate), style = MaterialTheme.typography.bodyLarge); Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { Text(bytes?.let(::dataSize) ?: "Unavailable", style = MaterialTheme.typography.titleSmall); LensIcon("chevron", "View usage breakdown", Modifier.size(16.dp)) } } }
@Composable
private fun DetailRow(label: String, value: String) { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) { Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, Modifier.weight(1f), fontWeight = FontWeight.Medium) } }
@Composable
private fun Notice(message: String, action: String? = null, onAction: () -> Unit = {}, attention: Boolean = false, heading: String? = null) {
    val dark = MaterialTheme.colorScheme.surface.luminance() < .5f
    val background = if(attention) LensAccents.noticeContainer(dark) else MaterialTheme.colorScheme.surfaceContainerHigh
    val foreground = if(attention) LensAccents.noticeText(dark) else MaterialTheme.colorScheme.onSurface
    Surface(shape = RoundedCornerShape(18.dp), color = background, contentColor = foreground) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if(heading != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { LensIcon("warning", "", Modifier.size(18.dp)); Text(heading, style = MaterialTheme.typography.titleSmall) }
            Text(message, style = MaterialTheme.typography.bodyMedium)
            if(action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(0.dp), colors = ButtonDefaults.textButtonColors(contentColor = foreground)) { Text(action) }
        }
    }
}
@Composable
private fun PaceBadge(within: Boolean) {
    val dark = MaterialTheme.colorScheme.surface.luminance() < .5f
    Surface(shape = CircleShape, color = if(within) LensAccents.successContainer(dark) else LensAccents.cautionContainer(dark), contentColor = if(within) LensAccents.successText(dark) else LensAccents.cautionText(dark)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { LensIcon(if(within) "check" else "warning", "", Modifier.size(16.dp)); Text(if(within) "Within pace" else "Above pace", style = MaterialTheme.typography.labelMedium) }
    }
}
@Composable
private fun lineColor(index: Int): Color = LensAccents.service(index, MaterialTheme.colorScheme.surfaceContainerLow.luminance() > .5f)
private fun currentCycle(account: AccountData): Cycle = account.pools.firstOrNull()?.cycle?.let { Cycle.containing(LocalDate.now(), it.start.dayOfMonth) } ?: Cycle.containing(LocalDate.now())

@Composable
private fun LensIcon(kind: String, description: String, modifier: Modifier = Modifier.size(24.dp), color: Color = LocalContentColor.current) {
    Canvas(modifier.semantics { if(description.isNotEmpty()) contentDescription = description }) {
        val u = size.width / 24f
        val stroke = Stroke(1.8f * u, cap = StrokeCap.Round)
        fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(color, Offset(x1*u,y1*u), Offset(x2*u,y2*u), 1.8f*u, StrokeCap.Round)
        when(kind) {
            "usage" -> { drawRoundRect(color, Offset(3*u,3*u), Size(18*u,18*u), androidx.compose.ui.geometry.CornerRadius(4*u), style = stroke); line(7f,16f,7f,12f); line(12f,16f,12f,7f); line(17f,16f,17f,10f) }
            "bill" -> { val p=Path().apply { moveTo(6*u,3*u); lineTo(18*u,3*u); lineTo(18*u,21*u); lineTo(15*u,19*u); lineTo(12*u,21*u); lineTo(9*u,19*u); lineTo(6*u,21*u); close() }; drawPath(p,color,style=stroke); line(9f,8f,15f,8f); line(9f,12f,15f,12f) }
            "refresh" -> { drawArc(color, 40f, 285f, false, Offset(4*u,4*u), Size(16*u,16*u), style = stroke); line(20f,4f,20f,9f); line(20f,9f,15f,9f) }
            "account" -> { drawCircle(color, 9*u, Offset(12*u,12*u), style=stroke); drawCircle(color, 2.4f*u, Offset(12*u,9*u), style=stroke); drawArc(color, 200f, 140f, false, Offset(6*u,13*u), Size(12*u,9*u), style=stroke) }
            "back" -> { line(19f,12f,5f,12f); line(5f,12f,11f,6f); line(5f,12f,11f,18f) }
            "check" -> { line(5f,12f,10f,17f); line(10f,17f,19f,7f) }
            "warning" -> { val p=Path().apply { moveTo(12*u,3*u); lineTo(22*u,21*u); lineTo(2*u,21*u); close() }; drawPath(p,color,style=stroke); line(12f,9f,12f,14f); drawCircle(color, 1f*u, Offset(12*u,17*u)) }
            else -> { line(9f,6f,15f,12f); line(15f,12f,9f,18f) }
        }
    }
}
