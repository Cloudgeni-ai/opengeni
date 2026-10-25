---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
---

A new chat that starts with a file attached now reuses the cached prompt of a chat without one. Before, a turn with a file added an "Attached files" section to the system instructions and the sandbox's mount policy and filesystem layout listed the file, so the whole request missed the provider's prompt cache. The instructions no longer depend on the turn's files; that guidance now ends the turn's attachment notice, after history. Uploads completed without a client sha256 now get one computed from the stored bytes (files up to 20 MiB), so an image uploaded through the plain REST flow reaches the model inline like an SDK upload instead of only as a mounted file.
