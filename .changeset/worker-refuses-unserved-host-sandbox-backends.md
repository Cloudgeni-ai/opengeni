---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Opengeni now refuses to build a sandbox on the worker or API host (`local` or `docker`) when that is not the deployment's configured default, for existing sessions too. Creating such sessions is already rejected, but sessions stored before that check, and shared-box children inheriting a parent's backend, could still name one. A turn on such a session now fails before any box, repository clone, setup, Rig or hydration hook or credential is prepared, with the terminal, non-retryable code `sandbox_backend_not_served` and a message telling the person to start a new chat. Terminal, files, browser, computer and viewer requests for it get a 409 with the same message. The deployment default is kept in `Settings.deploymentSandboxBackend`, which per-session settings rebinds preserve, so the sandbox client builder applies the same rule to every other caller, whatever is installed on the host. Remote providers and the default backend are unchanged.
