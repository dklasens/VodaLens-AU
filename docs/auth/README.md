# Vodafone AU authentication findings

Active decision: use the user's normal My Vodafone session. Do not pursue client registration unless the user changes that decision.

| Check | Result |
| --- | --- |
| Public OIDC discovery | Authorization code, S256 PKCE and refresh-token grants advertised; no registration endpoint advertised |
| Approved empty registration probe | HTTP 400, missing `redirect_uris`; no client created |
| Approved valid development registration | HTTP 400, **dynamic client registration is disabled**; no client created |
| Real session handoff into VodaLens | Verified in the installed Edge bridge on 15 November 2026 |
| API read using that handed-off token | Verified outside the browser: account data, shared consumption and today's history for the signed-in services |
| Expiry and replacement browser token | Verified live: natural expiry after 299 seconds, rejected stale access, then a different browser token and successful API reads |
| Website's normal renewal mechanism | Verified: cookie-free `refresh_token` exchange; a different refresh token and a 300-second access token returned |
| Independent backend renewal | Verified: two renewals after natural expiry, both returning rotated refresh tokens and passing account API checks for the signed-in services |
| Independent Android login / renewal | Verified on the Pixel: official-site handoff, encrypted on-device storage and native rotating refresh after natural expiry |
| Independent iOS login / renewal | Unproven |

Public evidence: [discovery and empty probe](../evidence/vodafone-auth.json), [valid request response](../evidence/client-registration.json). Both POSTs were separately approved and executed once. Scripts refuse accidental repeats. Auth0 documents that dynamic registration is disabled by default and that registering a client alone does not grant API access ([official documentation](https://auth0.com/docs/get-started/applications/dynamic-client-registration)).

Live proof: [session handoff and replacement](../evidence/myvodafone-session.json), [natural expiry](../evidence/session-expiry.json). The backend discovered the signed-in services from Vodafone and read current-day and previous-cycle history plus shared consumption for each. These records contain no credentials, phone numbers or account identifiers. Provider pagination and longer retention remain unverified.

The first installed-bridge attempt exposed a browser-specific bug: an unbound `WorkerGlobalScope.fetch` was called as a client object method and threw `Illegal invocation`. The SDK now binds the default fetch to its global scope. A regression test checks the receiver, and connection errors give specific recovery steps without copying exception text or credentials.

The real token's expiry was about five minutes after capture. This is separate from the user's reported ten-minute website inactivity timeout. The baseline access-token-only bridge requires another handoff after expiry. Further investigation has now confirmed that the website itself uses a refresh credential; the baseline bridge deliberately did not capture that longer-lived credential.

## Renewal investigation

The published application explicitly configures Auth0 with `useRefreshTokens: true`, local-storage caching and the `offline_access` scope. Its source also reads the cached refresh credential for an MFA journey. The configured public web client is `TE6munQ7o6txJRqZeSzLBzDECX1yVBJO`; this is the original client for that session, not a VodaLens registration.

The browser's normal successful POST to `https://authn.vodafone.com.au/oauth/token` contains exactly `client_id`, `grant_type=refresh_token`, `refresh_token` and `redirect_uri=https://my.vodafone.com.au`. It sends no Cookie or Authorization header, and its response includes a 300-second access token plus a refresh token that differs from the one sent. No credential values were recorded. [Source and live metadata](../evidence/renewal-code-analysis.json).

Independent backend renewal succeeded twice. Node exchanged the current refresh credential after the previous access token expired. Both responses were HTTP 200, issued a 300-second access token and rotated the refresh token. Each access token passed an account API read covering the signed-in services. The browser credential copy had been retired and the donor website unloaded; neither renewal sent cookies or a client secret. [Completed experiment evidence](../evidence/renewal-backend-probe.json).

The approved experiment is defined in [the reviewable request plan](renewal-probe-plan.json). It staged the credential encrypted, retired only the matching browser cache entry and stopped automatically after its two exchanges. It never automatically retries an uncertain or rejected grant. The user performed the final handoff click after automatic approval review required action-time confirmation. The latest refresh credential remains encrypted locally; production automatic renewal is not enabled.

This supports one backend connection serving Edge, iOS and Android without keeping the My Vodafone page open for each renewal. Give each device its own revocable VodaLens session, keep the provider refresh credential solely in the backend and serialize rotation across every backend worker. This proof used Node on the same Mac and network as Edge. Renewal from a hosted server, longer endurance, refresh-token expiry and standalone phone sign-in/re-authentication remain unverified.

Ownership matters because reusing an old refresh token can invalidate its whole token family. The browser and backend must not independently rotate copies of the same credential ([Auth0 rotation and reuse detection](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)). The one-time handoff may require signing in to My Vodafone again afterward. Cookies, passwords and unrelated browser/account data are not transferred or cleared.

`npm run auth:renewal-plan` prints the proposal without any network action. After explicit approval, the operator can arm it with `node scripts/arm-renewal-research.cjs --arm`; the popup's research action then performs the handoff. `npm run auth:renewal-status` prints only safe progress metadata. The encrypted research vault stays in ignored `local-data/renewal-research`; no production background renewal is enabled by this experiment.

The five-minute access-token lifetime does not reveal the refresh credential's lifetime. Auth0 supports separate maximum and idle expiration settings; Vodafone's values have not been established. The two successful active renewal cycles prove the tested flow; longer endurance and inactivity behavior still require separate measurements ([Auth0 expiration settings](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)).

## Active local proof

Run `npm run setup:local`, `npm run bridge:build`, then `npm start`. Load the generated personal bridge into Edge, open the signed-in My Vodafone tab and choose **Connect this tab**. Check `npm run auth:status`; successful status requires a real `planDetails` API response. The local tests mock Vodafone and cannot populate live proof.

`POST /v1/auth/vodafone/session` accepts only `{ "source": "myvodafone-browser", "accessToken": "…" }` with backend authentication. It does not accept cookies or refresh tokens, and never returns the access token. An invalid replacement leaves the previous verified connection intact. `POST /v1/auth/vodafone/verify-session` checks another account read. `POST /v1/auth/vodafone/disconnect` deletes the provider connection.

To establish baseline access-token replacement, connect once, let the provider issue a different access token through normal My Vodafone activity/sign-in, reconnect and verify `sessionReplacementVerified`. The normal connection path never sends a refresh grant to Vodafone's token endpoint; only the separately armed research path performed the two approved exchanges above. A browser session and an access token can have different lifetimes; both must be measured rather than inferred from the website's inactivity timeout.

Keep live credentials in ignored local files or the encrypted vault, never in evidence, logs, source control or chat. The generated unpacked bridge contains a local backend credential and is a personal development artifact.

## Archived registered-client path

`services/api/src/oauth.cjs` retains tested authorization-code/PKCE and refresh-rotation logic for a client registered specifically to VodaLens. It is selected only with `VODAFONE_AUTH_METHOD=registered-oauth`. The default is `myvodafone-session`. Its tests establish local protocol handling, not Vodafone permission. No Vodafone web-app client is reused as a VodaLens OAuth registration.

Android now has an independently verified session handoff through the official My Vodafone site in a restricted native WebView, followed by native API reads and renewal. Credentials remain solely on the phone; the desktop refresh family was not copied to it. A retained-process check backgrounded the app for 330 seconds, then confirmed renewal after access-token expiry and an advanced last-refresh timestamp on reopening. This verifies a short background interval, not multi-day inactivity or a maximum refresh-token lifetime. See [Android implementation](../../apps/android/README.md) and [device evidence](../evidence/android-validation.json). RFC 8252 recommends an external user-agent for native OAuth ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)), but VodaLens has no registered callback. This personal companion continues the website's session rather than claiming a registered native OAuth flow. iOS sign-in and renewal remain separate proof requirements.
