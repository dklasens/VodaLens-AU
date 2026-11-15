# Security

## Report a vulnerability privately

Use [GitHub's private vulnerability report form](https://github.com/dklasens/VodaLens-AU/security/advisories/new). Include the affected version, a description and reproduction steps using made-up account data. Never include passwords, one-time codes, Vodafone tokens, account numbers or unredacted screenshots in public issues.

Security fixes target the latest release. Older versions may require an update.

## Credentials and local data

Android credentials and cached account data stay in backup-excluded app-private storage encrypted with Android Keystore. Release signing keys are private local material and GitHub Actions secrets. They are not Vodafone credentials and are never committed. Signing secrets are exposed only to the release build step after checks.

Release `v*` tags may be created only by the repository owner and cannot be updated or deleted under the active repository rulesets. The workflow requires a version-matching stable release tag whose commit belongs to `main`. Gradle wrapper validation and a pinned distribution checksum run before signing credentials are restored. These controls do not protect against a compromised repository owner or an administrator changing the rules themselves.

Before committing, run `python3 scripts/check-publication.py` and the redacted history scan described in the developer documentation. Do not commit local environment files, databases (including WAL/SHM sidecars), browser captures, signing material, generated extension configuration or APKs. Release APKs belong in GitHub Releases.

## Vodafone session limitations

VodaLens is an independent companion and has no registered Vodafone OAuth client. Android continues a session obtained by signing in to the official consumer website. Carrier website/API changes or account policies can stop access. The software licence grants rights to this code; it grants no rights to Vodafone services or trademarks.

Experimental browser-to-backend renewal research is disabled by default and requires deliberate local opt-in plus a separately armed, bounded experiment. Do not enable it without understanding the credential handling and applicable Vodafone service terms. Normal Android renewal remains part of its on-device connection.

A rotating refresh exchange with an uncertain outcome is never replayed automatically. Reconnection can be required after a timeout, malformed success response or ambiguous server error. Rate limits are treated separately from invalid credentials. Local disconnect erases app data even if remote revocation cannot be confirmed.
