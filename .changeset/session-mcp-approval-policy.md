---
"@opengeni/contracts": minor
"@opengeni/config": patch
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Let embedding hosts read and update an existing session MCP server's approval
policy through the public API, SDK, and React session hook. Each claimed
attempt freezes its policy under the session lock, so updates affect the next
attempt without reinterpreting work already running; model MCP and
Toolspace/Code Mode consume the same exact snapshot. Toolspace tokens and
side-effect receipts bind every proxied call to the exact active attempt, so
Pause, Steer, recovery, and late outputs preserve one authoritative owner.
