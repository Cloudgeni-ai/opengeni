---
"@opengeni/api-router": patch
---

Signed setup state now verifies on every API replica. Without an explicit `OPENGENI_GITHUB_APP_MANIFEST_STATE_SECRET`, each process used its own random key, so a Codex sign-in (or GitHub App setup) whose next request reached another replica failed with "state is invalid or expired". The key is now derived from an existing stable deployment secret, and a per-process key is used, with a startup warning, only when none is configured.
