---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": patch
"@opengeni/react": minor
---

A connected machine can switch between This workspace and Only me in place, keeping its enrollment, sandbox id, credentials and live connection, so chats, schedules and the installed agent are not registered again. The Machines page gains **Who can use it?**, a dialog that summarizes what one confirmation does, backed by `POST .../machines/:enrollmentId/audience/preview` and `PUT .../machines/:enrollmentId/audience` (`previewMachineAudience` and `changeMachineAudience` in the SDK). Narrowing applies everything in one transaction: the owner's chats stay (shared ones stay shared, usable only by the owner) and their running attempts are re-authorized; other people's chats move off; turns that may no longer use the machine end as cancelled through the terminal `authority_change` interruption; the owner's Workspace schedules on it become Only me (or pause) and other schedules pause; and each affected person gets one inbox notice. Only a second live connection of the same computer blocks the switch. The worker reads the machine's current audience on every operation, so running sessions follow the change without a rebuild and the agent needs no restart or upgrade.
