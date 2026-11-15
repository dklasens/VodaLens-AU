# VodaLens AU

<p align="center">
  <img width="32%" alt="3" src="https://github.com/user-attachments/assets/7419ba24-4520-4926-9717-caa2b809816c" />
  <img width="32%" alt="2" src="https://github.com/user-attachments/assets/9bfbce0c-c50e-47d8-b238-24aaadd523b1" />
  <img width="32%" alt="1" src="https://github.com/user-attachments/assets/803c839d-cd16-4c9a-9aa6-b5b7248f324d" />
</p>

A clearer view of your Vodafone Australia data and bills, right on your Android phone.

VodaLens helps answer everyday questions: **How much data is left? Which service used it? Am I on track for the month?** It is an independent companion app, not an official Vodafone product.

## What you can see

- **Your shared data pool:** remaining data and how much each phone or service has used.
- **Daily usage:** tap a service to see its day-by-day chart and choose a day for more detail.
- **Your pace:** compare the percentage of data used with the percentage of your billing cycle that has passed.
- **Earlier months:** explore up to six previous usage cycles, where Vodafone makes them available.
- **Bills:** see the current amount due and recent invoices. Paid invoices keep their original total without being shown as overdue. Future bills show “Not issued yet” until Vodafone issues them.
- **Freshness:** each view shows when its information was last successfully refreshed.

The app follows your wallpaper colours and light/dark setting. Different services have different accent colours, with labelled status indicators for usage pace and connection notices.

## Get started

1. Download **VodaLens-0.1.3.apk** from [Releases](https://github.com/dklasens/VodaLens-AU/releases/latest).
2. Open the APK on an **Android 16 or newer** phone. Android may ask you to allow installation from the app you used to download it.
3. Open VodaLens and choose **Connect My Vodafone**.
4. Sign in on Vodafone's page inside the app, then tap **Use this Vodafone account**.
5. Explore **Usage** and **Bills**. Tap a service to open its daily usage.

Android is the available app today. The repository also contains earlier Edge/browser research and an iOS project outline; an iOS app is not available yet.

## How it works

You sign in directly on Vodafone's website. After you choose to connect, VodaLens uses that signed-in session to read the account's usage and billing information directly from Vodafone. The Android app runs independently: it needs no VodaLens server, desktop computer or browser extension.

Your connection credentials and saved usage stay encrypted on your phone using Android's protected key storage. They are excluded from backup and device transfer. No account credentials or personal account captures ship in the source repository. The app has no advertising or analytics.

Saved information appears first when you open the app. If it is more than five minutes old, the app refreshes it on reopening. You can also use the refresh button. Short-lived access is renewed automatically when possible. If Vodafone rejects renewal, the app asks you to sign in again. **We have not established how many days a Vodafone session can remain usable**, so continuous sign-in cannot be promised. No background keepalive runs.

## Things to know

Vodafone can report data with a delay, and daily records may not update at the same time as the shared-pool balance. Historical coverage depends on what Vodafone returns. VodaLens does not estimate unissued bills. Its connection uses the consumer website's session, so Vodafone website or API changes may require an app update.

**Existing development installations:** the public APK uses a dedicated release certificate. Android cannot install it over a development/personal build signed with another certificate. Keeping the existing personal build is fine; replacing it requires uninstalling it first, which removes its saved connection and history. Future public builds will use the same release key.

## For developers

The Android app uses Kotlin, Jetpack Compose and Material 3. It targets Android API 37, supports API 36+, uses platform networking and has no server dependency. See [Android build instructions](apps/android/README.md), [architecture](docs/architecture.md), [authentication research](docs/auth/README.md) and the [anonymised validation summary](docs/evidence/android-validation.json).

```sh
cd apps/android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Use JDK 17 or later and Android SDK 37. Debug builds use a local development signing key. The tag-triggered [release workflow](.github/workflows/release.yml) tests, builds and signs the public APK, then publishes it with release notes and a SHA-256 checksum. Release signing credentials are stored in GitHub Actions secrets, never in source.

The optional desktop research backend requires Node.js 26+. Run `npm run setup:local`, `npm run bridge:build`, then `npm start`. This generates private local configuration; **do not share the generated extension folder**. The Android app does not use that configuration. Shared tests run with `npm test` and `npm run check`.

The code is available under the [MIT licence](LICENSE). See [SECURITY.md](SECURITY.md) for private vulnerability reporting and credential-handling boundaries. Browser renewal research defaults off and needs explicit local opt-in plus separate one-time arming; it is not required by the Android app.

Before publishing changes, run `python3 scripts/check-publication.py`. Keep `.env`, databases, captures, generated output and signing keys out of commits. The publication check catches common credential formats and forbidden paths; it is an additional check, not a guarantee against every kind of sensitive data.

CI also validates the Gradle wrapper and pinned distribution, runs the scanner regression tests, and scans full Git history with Gitleaks before signing. To repeat the history scan with Gitleaks 8.30.1 installed, run `gitleaks git --redact --no-banner --log-opts=--all .`. Opaque credentials cannot all be detected by shape; never rely on a scanner as the only publication check.
