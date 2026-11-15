# Microsoft Edge stream

The first app to prove the shared backend end to end.

`session-bridge` contains the minimal authentication proof. It observes only bearer headers supplied by My Vodafone to the three known account/usage API paths. Observation is implemented around page `fetch` and XHR calls; it does not intercept login form values or token-endpoint responses. A user must arm **Connect this tab** before a token can leave that tab for the local backend. The arm expires after five minutes and closes after successful verification.

The page script and isolated relay never receive the backend credential. The service worker checks the extension sender, My Vodafone origin, top frame, selected tab and arm deadline before handoff. Provider access tokens are not saved in extension storage. Backend tokens are kept in a non-web-accessible personal build file.

Build with `npm run bridge:build`, then load `output/edge-session-bridge` as an unpacked extension. Permissions are `storage` and host access to My Vodafone plus loopback. There is no broad browsing-history, debugger, webRequest, cookie or identity permission. The addon does not keep a session signed in automatically.

`prototype` preserves the earlier per-line/daily dashboard and DOM collector. After a real session handoff and replacement have been verified, replace the prototype's direct browser collection with the shared backend contract, and prove the dashboard against all three services. Do not include the generated local configuration in a public package.

The installed addon now completes a live handoff in Edge. The backend has verified account data, shared consumption and current/previous-cycle usage for all three services using that session outside the browser page. Natural expiry after 299 seconds and a different replacement token have also been verified. The initial `fetch` binding failure was fixed and covered by a regression test. Opening the popup rechecks backend status instead of trusting a cached success message.

Next stage: full dashboard integration. The observed provider access token lasts about five minutes, and this bridge renews access only when the user chooses Connect. The backend supports `GET /v1/services` so that integration can discover lines directly from Vodafone. Simulated tests do not establish live behavior; the real checks are recorded in `docs/evidence/myvodafone-session.json`.

Browser refresh-token research is disabled in the default backend, bridge and Docker configuration. See [the explicit opt-in boundary](../../docs/auth/README.md#renewal-investigation); normal access-token observation does not require it. Generated private extension output is never distributed.
