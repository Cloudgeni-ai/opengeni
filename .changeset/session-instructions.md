---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Add an optional per-session `instructions` field to `CreateSessionRequest`: a first-class, system-level agent persona lever composed AFTER the per-workspace `agentInstructions` (session-specific last, non-bypassable CORE preserved). It is org-visible session metadata (returned on the session record) but is never emitted as a timeline event, so hosts can deliver per-agent-type prompts without leaking prompt content into the user-visible timeline or weakening instruction authority. Absent ⇒ byte-identical to today's composition.
