---
"@opengeni/db": patch
---

Database clients retry a refused or reset first connection for up to 15 seconds while a process is starting, so a new pod that is briefly refused while its network policy or DNS settles no longer fails a rollout hook (migrations, catalog import) or restarts a worker. Once a client has reached the server, connection failures surface exactly as before.
