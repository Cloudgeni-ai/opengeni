---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
---

Open Slack agents take only linked members of the organization: `SLACK_AGENT_OPEN_LABEL` and `slackAgentOpenDisclosure` describe the narrowed access, and the new `SLACK_AGENT_OPEN_NARROWED_NOTICE` is shown next to an open agent's switch. An active organization member can link their Slack account without workspace access after confirming it: `SlackUserLinkAccessRequest.organizationMemberLink` offers it, and `linkSlackUserAsOrganizationMember` (`POST …/user-link-intents/:requestId/link`) completes it. `@opengeni/db` adds `namedSubjectIsActiveOrganizationMember` and `slackUserLinkOrganizationMemberMayLink`.
