---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

SuperGrok account routes, access settings and connection writers can now run on the shared subscription core, the same runtime Codex uses, once a deployment records the SuperGrok cutover. Until then every SuperGrok and Codex route answers exactly as before. Accepted work also writes the newer authority record for every registered provider and copies its compatibility record on every path that carries authority forward, and a personal connection can record its credential format.
