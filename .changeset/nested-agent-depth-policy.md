---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Enforce a configurable absolute nested-agent depth at the transactional session-creation boundary. Roots are depth zero, the inclusive server default is three, workspace/deployment/session policy precedence is persisted on each session, and unauthorized or over-depth creates return typed idempotent denial evidence without creating run, sandbox, workflow, usage, or billing artifacts. HTTP, MCP, SDK, and internal scheduled creation now share the same policy.