---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Claude account routes, setup-token and browser sign-in, and Claude access settings can now run on the shared subscription core once a deployment records the Claude cutover. Until then every Claude, SuperGrok and Codex route answers exactly as before. A reconnect on the core replaces exactly the account and version it names.

