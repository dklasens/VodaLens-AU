# VodaLens Android

Standalone native Android app for a personal Vodafone AU account. Kotlin, Jetpack Compose and Material 3; dynamic wallpaper colours and system light/dark mode. Semantic green/amber states, teal/indigo usage/cycle bars and distinct blue/purple/orange service accents remain visible even with a monochrome wallpaper palette. Android 16 (API 36) minimum, targeting API 37. There is no VodaLens server dependency.

## Experience

- **Usage:** one deduplicated shared pool, remaining/used data, billing-cycle progress and consumption pace. Each service opens its daily usage in one tap.
- **History:** current cycle plus six prior billing cycles, loaded on demand and cached encrypted on the phone. Unknown or failed periods remain unavailable; an empty response does not establish Vodafone's retention or billing finality.
- **Bills:** current amount due and due date when supplied by Vodafone, plus invoices issued within the last six months. The live balance is separate from historical invoice totals: paid invoices retain their original amount without becoming overdue. Bill details show issued/due dates, total, outstanding balance and service period. An unissued future bill is not estimated.
- **Last refreshed:** Usage, daily usage and Bills show the date/time of their last successful update, using the phone's time format. Bills have an independent timestamp; a failed request does not advance it.
- Cached data opens before a network update. The explicitly labelled preview uses sample data and never mixes it with a real connection.

The Vodafone pool response is authoritative for remaining allowance. Per-line values use returned consumption counters when present, otherwise data-session history. They may update at different times. Carrier timestamps retain the day recorded by Vodafone; unknown values are not converted to zero.

## Sign-in and renewal

The app opens the official My Vodafone site in a separate native WebView activity. Passwords and MFA are entered on that site. The web-message bridge is restricted to the exact `https://my.vodafone.com.au` origin and main frame. The user explicitly chooses **Use this Vodafone account** after sign-in. The app stages the session encrypted, removes only its matching browser token-cache entry, unloads the site and then activates the native connection. A changed cache entry aborts the handoff. Each login uses a fresh isolated WebView profile; stale portal storage cannot carry into reconnection, and a delayed page offers a restart action. The installed native app has also renewed successfully after natural access-token expiry.

This continues a session issued to Vodafone's existing public web client; it does not claim a VodaLens OAuth registration or take over the installed Vodafone app's callback. The installed app has a callback scoped to its own package, so it is not a sign-in API for VodaLens. The initial Compose-hosted WebView rendered the carrier form incorrectly on the Pixel; an isolated native View activity resolved the sign-in test.

The native data layer uses a process-wide renewal gate and device-bound Android Keystore AES-GCM storage. A rotating exchange is marked uncertain on disk before sending it, and the replacement is saved before use. A timeout or interrupted exchange is never automatically replayed. A known offline device retains its credential without attempting renewal. Requests use fixed HTTPS hosts and read-only account/usage/billing paths; the token endpoint is the only provider POST. The app never logs credential values, and excludes its data from backup and device transfer. Release sign-in screens block screenshots. Development builds permit visual QA and keep the screen awake while testing.

Reopening the app refreshes data when its account snapshot is more than five minutes old, including when Android retains the existing process. A Pixel check backgrounded that same process for 330 seconds, then verified silent token rotation and an advanced refresh timestamp. The observed access-token lifetime is 300 seconds. Vodafone's refresh-token idle and maximum lifetimes remain unknown, so opening three times a week has not yet been proven to avoid interactive sign-in. There is no background keepalive service.

## Build

Use Android Studio's JDK 17 or later, Android SDK 37 and the checked-in Gradle wrapper:

```sh
cd apps/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`local.properties`, generated build output, signing keys and device captures are ignored. No backend `.env` values or desktop credentials are packaged. For the installed personal build:

```sh
./gradlew :app:assemblePersonal
adb install -r app/build/outputs/apk/personal/app-personal.apk
```

The `personal` variant is non-debuggable, enables R8/resource shrinking and uses the same local development certificate to preserve the existing Pixel installation and its encrypted vault. It is a personal test build, not Play Store distribution signing. The APK is approximately 2 MB. Only core AndroidX UI/lifecycle/WebView and Kotlin coroutines ship; test libraries are confined to the separate test APK. Daily cache compaction preserves exact byte totals and source-record counts. Reconnection restores cached history only after the new service roster and billing-account identifiers match the previous account.

## Verification

The 22 passing native tests cover billing boundaries/leap years, shared-pool deduplication including Vodafone's `Discount` label, recorded session dates, invoice identity and paid/live balances, money precision, cache serialization semantics, foreground refresh decisions, concurrent renewal, restart after an uncertain response and offline credential preservation. Android lint reports no errors. Real reads on the connected Pixel verified the signed-in services, one shared pool, daily history, six recent invoices, native refresh-token rotation and refresh timestamps on all three views. Version `0.1.2-personal` is installed and matches the delivered APK. Detailed verification is in [the evidence record](../../docs/evidence/android-validation.json).

Six previous usage cycles were retrieved during device testing. A transient provider error succeeded on retry; it did not establish a retention boundary. Empty service-period responses do not establish complete carrier retention. Longer refresh-token lifetime and complete pagination/billing-finality behavior remain unknown.

## Platform references

- [Compose BOM](https://developer.android.com/develop/ui/compose/bom) and [Material 3](https://developer.android.com/jetpack/androidx/releases/compose-material3).
- [Origin-scoped WebView messaging](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge).
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore) and [backup rules](https://developer.android.com/identity/data/autobackup).
