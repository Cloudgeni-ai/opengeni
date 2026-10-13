---
"@opengeni/api-router": patch
"@opengeni/config": patch
---

Connected Machines now update to their channel's promoted agent build without anyone clicking "Update now". Each live machine behind its promoted build is asked to update from its next heartbeat. The agent applies the update only at an idle point, so running work is never interrupted. An older agent that postpones because it is busy is asked again every 10 minutes, an unanswered request is re-sent after 10 minutes, and other retryable failures are retried hourly. Non-retryable failures, rollbacks to an older build, and Macs that need the whole-app installer still need an explicit request. Set `OPENGENI_AGENT_AUTO_UPDATE=false` to update only on request. "Update now" no longer re-requests the build a machine already runs after an earlier attempt failed.
