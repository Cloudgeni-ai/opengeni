---
"@opengeni/config": minor
---

Turn per-channel and per-DM Slack workspace routing on by default. An installation whose organization has a single workspace resolves it as the sole candidate and never asks, so nothing changes there. Two things do change for an organization with several: an unrouted channel asks the first person who uses it, and a bot DM goes to that person's own personal workspace. One case is worth knowing before upgrading - someone who has lost live authority in the routed workspace now receives a refusal in their bot DM where the previous code failed silently. Set `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED=false` to restore the short-circuit to the installation's own workspace.
