---
"@opengeni/agent-proto": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/runtime": patch
---

Turn screen control on for an already-connected machine, in place, with no reconnect, token or human click. `POST /v1/workspaces/:ws/machines/:enrollmentId/screen-control` (SDK `enableMachineScreenControl`; agent tool `connected_machine_enable_screen_control`) records the consent on the enrollment without a new credential generation. It then sends the live agent the new `credential_renew` control op, and the agent renews its credentials with its install-key proof. The response is `active`, or `pending` with `offline`, `agent_update_required`, `renewal_failed` or `reconnect_required`. Pending consent applies automatically on the machine's next Hello. Each change records a `connected_machine.screen_control.allowed` audit event with the actor.

Agents advertise `Capabilities.credential_renew`. Mac agents report Screen Recording, Accessibility and Input Monitoring (`MacDesktopPermissions`) on Hello and desktop heartbeats, which surface as `runtime.macPermissions`. `runtime.capabilities.screenControl` says whether the live agent holds the consent. `POST /v1/workspaces/:ws/machines/:enrollmentId/privacy-settings` (SDK `openMachinePrivacySettings`) opens one of those System Settings panes on the Mac. The Connected Machine card shows **Turn on**, then walks the missing Mac permissions from what the machine reports.
