---
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

Your GitHub keeps working past its token's 8-hour lifetime. Opengeni now asks GitHub for a JSON reply when it renews the token. Without that, GitHub answered form-encoded and every renewal failed silently. The connection still showed as connected, while Git and the `github_personal__*` tools failed with "authorization is no longer current" or "credential is unavailable".

When GitHub refuses a renewal, which it reports as a successful response carrying an error, the connection is now marked as needing a reconnect instead of staying "connected". The GitHub settings page shows "needs to reconnect" with a Reconnect button. A Reconnect toast stays until the person acts on it or closes it, and appears once per stale connection. Git and the GitHub tools say the person must reconnect. A repository list that couldn't load no longer reads "0 repos", and a background read that needs nothing from the person no longer shows a toast.
