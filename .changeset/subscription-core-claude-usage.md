---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/subscriptions": patch
---

Claude account usage, model readiness and organization custom-model admission can now run on the shared subscription core, the same runtime Codex uses, once a deployment records the Claude cutover. Until then every Claude and Codex route, model listing and admission answers exactly as before. Usage decoding can now receive the models a connection serves.
