---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

Schedules that start their own session now follow the workspace's default connectors at each run, the way a new chat does. A schedule created without choosing tools stores `agentConfig.toolPolicy` (`{ mode: "workspace_default", excludedMcpServerIds }`) instead of a copy of the defaults, so a connector the workspace adds later reaches its next run. Its `tools` list only connectors added on top, and an edit that does not name a policy keeps the existing one. Creating a schedule with an explicit `tools` list and no policy still gives it exactly that list.

The schedule editor shows what the next run gets and saves defaults a person turns off as exclusions. Agent schedule tools cannot set `toolPolicy`; their reads report where a run's connectors come from (`configuration.connectors`).

Migration 0754 moves agent- and service-created schedules that start their own session to follow the defaults, keeping their saved tools as additions. A list a person created directly is kept exactly.
