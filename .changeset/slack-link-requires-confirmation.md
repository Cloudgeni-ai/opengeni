---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Opening a Slack identity link no longer links the Slack account on its own, for anyone. Preparing a link (`POST …/integrations/slack/user-link-intents`) now always returns the prepared request with `slackAccountLabel`, naming the Slack account, and `canLink`; the link completes only when the person confirms it with `POST …/user-link-intents/:requestId/link` (`linkSlackUserAsOrganizationMember` in the SDK) at the request's `version`. This applies to people who can already use the workspace as well as to organization members without workspace access, and the web app now asks them to confirm which Slack account they are linking. `organizationMemberLink` is deprecated in favour of `canLink` and `slackAccountLabel`. The unused `POST …/integrations/slack/user-links` route, which linked on first use, is removed.
