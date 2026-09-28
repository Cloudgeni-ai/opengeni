---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/sdk": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Every accepted turn now records the product surface its request entered through: `web`, `slack`, `api_key`, `embedded`, `scheduled`, `agent`, `voice`, `site`, `automation`, `mcp`, or `system`. Slack, realtime voice, automations and maintenance name their surface; other requests derive it once from the verified access path (a managed or local browser session is `web`, an API or configured key is `api_key`, signed delegation or an external actor is `embedded`, workspace MCP OAuth is `mcp`, an agent attempt is `agent`, and a validated Site origin is `site`, including follow-up Send and Steer from the Site bridge). A scheduled occurrence records `scheduled` and another agent's message records `agent`, so scheduled runs no longer look like generic system work; other machine turns inherit the session's latest surface. `origin` is unchanged. Embedding hosts that call core directly can pass `surface` to `createSessionForRequest` and `acceptSessionUserMessage`.

The durable host export carries `surface` and `modelProvider` (the provider family from the turn's execution policy, with operator-configured providers reported as `registry`) on session events and usage facts, and `toolFamily` on `agent.toolCall.created` (a first-party tool name, `integration:<reviewed domain>`, or `custom`). The worker stamps `toolFamily` on the tool-call event payload. All values come from fixed lists and carry no content. Rolling migration 0532 adds the immutable, checked `session_turns.surface` column, the three export columns, and the `host_export_claim_analytics_sidecars` companion, which inherits the claim function's exporter grants. Published export function signatures are unchanged.
