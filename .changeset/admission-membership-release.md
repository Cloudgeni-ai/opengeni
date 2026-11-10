---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

More access fixes now start a blocked chat's saved message by themselves. These are a reactivated organization member (by an admin or through external identity reactivation), an accepted invitation, an organization admin's workspace access grant, external first-use and stated memberships, explicit external member onboarding, and Slack access approval. A restored organization membership releases saved messages in every workspace of that organization (`releaseMembershipBlocksInOrganization` in `@opengeni/core`, `listOrganizationWorkspaceIds` in `@opengeni/db`). As before, each message starts exactly once, and a paused chat waits until it is resumed.
