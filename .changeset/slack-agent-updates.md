---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Slack agents: occasional update messages. Opengeni can DM linked people about agents they can use, only when something is new: a welcome after linking, one message about new agents, or one reminder after 60 days without using any. At most once per 30 days, on a weekday at 10:00 in their Slack time zone, with "See all agents" and "Mute updates" buttons. Off by default; an organization admin turns it on or limits announcements to channel posts (`/integrations/slack/agent-updates`) and can send themselves a preview. Adds the contracts and SDK methods `getOpenGeniSlackAgentUpdateSettings`, `setOpenGeniSlackAgentUpdateSettings` and `previewOpenGeniSlackAgentUpdate`.
