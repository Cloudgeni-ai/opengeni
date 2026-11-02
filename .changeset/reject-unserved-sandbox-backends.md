---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Creating a session now fails with a clear 422 when it asks for a sandbox backend the deployment does not serve. Previously any `sandboxBackend` value was accepted, so on a cloud deployment an agent's `session_create`, a REST/SDK create or a schedule could ask for `local` and get a box that ran as processes on the worker host. A deployment serves its configured default backend, `none`, `selfhosted` when Connected Machines are enabled, and any provider whose credentials are configured; `local` and `docker` only as the default. Schedules are checked when saved and again when a run is admitted, and `session_create` advertises only the served backends. Shared children, Connected Machine targets and `new` boxes on a served backend are unchanged.
