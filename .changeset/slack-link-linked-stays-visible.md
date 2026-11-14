---
"@opengeni/react": minor
---

Linking a Slack account from a Slack link now ends on a page that stays put: "Linked. Go back to Slack and ask again." Before, the app revalidated access right after linking and someone without access to the link's workspace (an organization member, for example) was sent silently to their own workspace. Someone in the workspace sees the same words in a dialog they close. `AppContextValue` gains optional `slackLinkLinkedWorkspaceId` and `completeSlackLinkContinuation`.
