# iOS stream

Native implementation follows the Edge end-to-end proof. This directory is the stream boundary; no Xcode app has been created yet.

Use the [VodaLens OpenAPI contract](../../services/api/openapi.json) for session status, per-service history, shared consumption and sync. The backend owns Vodafone credentials and provider-specific parsing. The JavaScript SDK is a reference client; a Swift client can implement the same HTTP contract without copying the Vodafone adapter into the app.

An iPhone cannot reach the Mac's backend through `127.0.0.1`: that address refers to the phone itself. Device builds need an HTTPS backend and a device-specific VodaLens session, stored in Keychain. The single-owner development token is not an app-distribution credential.

The current access source is Edge's signed-in My Vodafone session. A mobile app can consume that backend while its token is valid, but this does **not** prove independent mobile sign-in. A supported way to obtain/renew My Vodafone access on iOS must be investigated before calling the app standalone. Opening a login page alone does not deliver its credentials to VodaLens; no VodaLens callback is registered with Vodafone.

Gate: Edge proof first, then independent login/renewal feasibility and mobile device sessions, then native usage UI.
