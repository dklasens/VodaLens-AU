# VodaLens AU 0.1.3 hardening plan

| Area | Planned change | Verification |
| --- | --- | --- |
| Android login | Origin-scoped, token-free commit reply; closure compares its own staged token; invalidate handoffs on navigation | Policy and actual observer JavaScript race tests; Pixel official-site sign-in |
| Navigation/lifecycle | Validate main/subframe navigations and POST documents, recheck page starts; retain WebView through fold, multi-window and theme changes | Policy tests and configuration checks |
| Renewal/disconnect | Distinguish rate limits from rejected grants; retain uncertainty where rotation may have happened; best-effort supported revocation before local erase | Concurrent/error-path tests; no live destructive revocation test |
| Storage/privacy | Explicit AES-256 for new keys; disable sensitive recent-app previews; avoid constructing release debug logs | Build review and device checks; preserve existing encrypted data |
| Performance | Bounded concurrent independent reads; remember history derivations and reusable formatters | Concurrency tests, regression tests and Pixel refresh/drill-down checks |
| Build integrity | Official Gradle distribution checksum and SHA-pinned wrapper validation before signing | Local tests/build and Actions validation |
| Release access | Owner-only creation and immutable release tags; stable tag/version/main-ancestry checks; Dependabot alerts | Read back GitHub rules and feature settings |
| Research | Explicit opt-in at backend, CLI and extension; Docker defaults off; private research outputs | Default-off and end-to-end research-gate tests |
| Publication | Scan tracked and nonignored untracked files; deny private/generated formats; portable credential checks; redacted Gitleaks history scan | Scanner regressions and full-history scan |
| Distribution | MIT licence, private reporting guidance, pinned and trimmed Docker image | File/image definition review |

## Integration and delivery

Review the agents' diffs together, run shared and native tests, lint, publication and history scans, and build both personal and public release variants. Compare signing certificates before updating the Pixel so saved data is retained. Test cached startup, account refresh, daily history, billing, recent-app protection and login changes. Keep any real account observations only in ignored local evidence. Record untested live cases explicitly.

## Security decisions

An HTTP 5xx alone does not establish that a rotating credential was unused. Only definite non-consuming errors can restore retry eligibility; ambiguous outcomes continue to require reconnection. Remote revocation is tested with mocks, not against the user's active session. Requiring an unlocked device for every Keystore operation is considered separately from explicit AES-256, because it can change lock-state/restart behavior and existing key compatibility.
