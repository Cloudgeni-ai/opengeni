---
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

Every finished agent turn now gets a timing profile that says where its wall time went: queue, startup, dispatch, model inference, provider overhead, network, model requests without provider timing, stalled requests, hosted web search, remote MCP tools, sandbox tools, Opengeni's own tools, sandbox setup, human and capacity waits, the gaps after model requests and tool calls, recovery and turn end. The control maintenance schedule computes it from the turn's session event log after the turn settles, so nothing is added to the turn itself, and stores it in the new `turn_timing_profiles` table (migration 1351) with the turn's model, reasoning effort, status and the steps of every model request and tool call, including each remote MCP call's id, tool name, start, end and outcome. Profiles are kept as long as the turn and are visible under the same workspace and chat rules as the event log.

New metrics `opengeni_turn_timing_seconds_total` and `opengeni_turn_wall_seconds` feed dashboards, and `bun run db:backfill-turn-timing-profiles` profiles existing history. Migration 1352 adds a finished-turn index concurrently. `@opengeni/db` adds `computeTurnTimingProfile`, `recordTurnTimingProfile` and `recordMissingTurnTimingProfiles`. See `docs/turn-timing-profiles.md`.
