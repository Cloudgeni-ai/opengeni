---
"@opengeni/api-router": minor
---

Organization agents: changing "Ask first" on one of the agent's own tool servers after create may only ask first for more unless the caller holds `agents:manage` for the organization (403, `details.code` `agents_manage_required`). A chat's own tool login headers run only for turns its creator or its end user started, or that no person started; another person's turn needs their own login. Without `agents:manage`, an inline `config` matching a saved version runs only when that version is published (any version in the Console test workspace).
