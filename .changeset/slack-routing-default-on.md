---
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Turn per-channel and per-DM Slack workspace routing on by default, and stop counting a personal workspace as a routing choice in a channel.

A personal workspace is now a candidate only in that person's own bot DM. It is the wrong destination for a channel - a shared thread routed into one member's private space is invisible to everyone else in the channel - and because managed tenancy provisions a personal workspace for every member, counting it meant nobody ever had exactly one candidate. That defeated the sole-candidate rule, so an organization with a single shared workspace would have been asked to choose in every channel despite having no choice to make.

With that fixed, an organization with one shared workspace sees no change. For an organization with several, an unrouted channel asks the first person who uses it and remembers the answer, and a bot DM goes to that person's own personal workspace. Two things are worth knowing before upgrading: someone who has lost live organization authority in the routed workspace now receives a refusal in their bot DM where the previous code failed silently, and someone whose only workspace is their own personal one is now refused in a channel rather than having channel work land somewhere nobody else can see. Apply migrations through 0342 before running the new image. Set `OPENGENI_SLACK_WORKSPACE_ROUTING_ENABLED=false` to restore the short-circuit to the installation's own workspace.
