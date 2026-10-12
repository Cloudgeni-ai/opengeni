---
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Schedules can now be Only me, like chats. An Only me schedule is visible only to its owner through the API, the agent's schedule tools and Slack, and each run creates an Only me chat owned by that person after rechecking that they may still create one. A schedule that posts into an Only me chat or saves to personal knowledge is always Only me; existing ones become Only me. Workspace admins see other people's Only me schedules only as a summary (owner, cadence, status, last run and 30-day cost) and can pause them, but never see their name, message or runs. `ScheduledTask.visibility` reports the audience, create and update requests accept `visibility`, and `GET .../scheduled-tasks/private-summaries` and `POST .../scheduled-tasks/private-summaries/:taskId/pause` serve the admin summary. The schedule form asks who can see it, and the Schedules list marks Only me schedules.
