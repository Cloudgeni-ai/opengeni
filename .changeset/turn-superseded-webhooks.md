---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Webhooks can carry `turn.superseded`, sent when a new message (a Steer) takes over a turn before it finishes. Until now that turn settled without any terminal webhook, so a host listening for `turn.completed`, `turn.failed` and `turn.cancelled` only learned about it by polling. Workspace and organization endpoints can subscribe to it; it carries `initiatingHuman` like the other turn types, and existing registrations are unchanged until they add it. Subscribe to all four turn types to get exactly one terminal webhook for every turn.
