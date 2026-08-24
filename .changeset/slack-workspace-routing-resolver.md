---
"@opengeni/db": patch
---

Add per-channel and per-DM Slack workspace routing behind `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED` (default off). Migration 0337 adds a private ids-only action-handle tenancy mapping so a routed button click can find its handle, and gives a shared-task origin its own tenancy pair for the frozen Slack task policy revision, which stays a home fact while the origin follows the routed task.
