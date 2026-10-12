---
"@opengeni/sdk": major
---

Remove protected-fill site authentication. Agents now log in by typing `{{secret:…}}` references with ordinary browser `fill` or `type` actions, so `POST …/auth-runs/:authRunId/protected-fill`, `protectedBrowserAuthFill`, `AuthRunResource.protectedFill`, `ProtectedAuthFillRequest`/`ProtectedAuthFillResponse`, `SiteAuthFieldPurpose`, the `connection_fields` and `human` site-auth authorities, the `awaiting_secret` auth-run state and `pendingFields` are gone. Site-auth connections keep `external_provider` authorities. This removal ships in SDK 2.0.0 without the usual 90-day deprecation window, as an explicit exception to the API compatibility policy.
