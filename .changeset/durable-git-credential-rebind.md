---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Recover authorized Git credentials for resource-less and rematerialized managed sandboxes from
complete secret-free repository identities, install them on the established box before clone,
fail partial token mutation cleanly, and fence every controller action against the full durable
binding-generation set while keeping Connected Machines on their own Git authorization path.