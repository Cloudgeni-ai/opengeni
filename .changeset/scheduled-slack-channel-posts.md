---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Scheduled tasks can post to one Slack channel as the OpenGeni workspace bot. A person chooses the channel in the schedule editor (new "Post to Slack" section), stored as `agentConfig.slackBotChannelId` next to `slackBotConnectionId`. Choosing or changing it needs a signed-in person with `connections:write`, and the bot must be a member of an active channel that is not shared with another organization. Agents, services and API keys cannot set or change it. `listScheduledTaskSlackChannels` in the SDK lists the eligible channels.

Runs of such a task get two tools, `slack_bot_prepare_message` and `slack_bot_send_prepared_message`, which take no channel. Prepare saves the exact text; send posts it to the task's channel with the saved server-owned id as the Slack post operation id, so a retried send never posts twice. Both re-read the task at every call, so clearing or changing the channel takes effect immediately and never redirects an already prepared message. Rolling migration 0530 adds the private prepared-message table and its two capabilities.
