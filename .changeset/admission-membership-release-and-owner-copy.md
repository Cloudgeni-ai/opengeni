---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/react": minor
"@opengeni/react-native": patch
---

More access fixes now start a blocked chat's saved message by themselves. These are a reactivated organization member (by an admin or through external identity reactivation), an accepted invitation, an organization admin's workspace access grant, external first-use and stated memberships, explicit external member onboarding, and Slack access approval. A restored organization membership releases saved messages in every workspace of that organization (`releaseMembershipBlocksInOrganization` in `@opengeni/core`, `listOrganizationWorkspaceIds` in `@opengeni/db`). The machine owner's notice now gives a paused chat one consistent line: "Allow it for this chat. Your message starts when the chat is resumed." In a chat shared with the workspace, it also says that people in the workspace will see what the agent does on the machine. `sessionAdmissionMachineAccessCopy` accepts `paused` and `shared` options.
