---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The worker now refuses to run a chat whose sandbox would run on the worker host (`local` or `docker`) when that is not the deployment's configured default. Creating such sessions is already rejected, but sessions stored before that check, and shared-box children inheriting a parent's backend, could still name one. The turn now fails before any box, repository clone, setup, Rig or hydration hook or credential is prepared, with the terminal, non-retryable code `sandbox_backend_not_served` and a message telling the person to start a new chat. The sandbox client builder applies the same rule, so no caller (including lease and rematerialization paths) can build a host box on a deployment that does not serve it, whatever is installed on the host. Remote providers and the default backend are unchanged.
