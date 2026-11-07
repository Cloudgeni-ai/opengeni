---
"@opengeni/api-router": minor
"@opengeni/config": patch
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": patch
"@opengeni/sdk": minor
"@opengeni/worker-bundle": patch
---

An agent can now ask to attach a repository the workspace GitHub App offers to its own chat with the new first-party `github_repository_attach` tool. Every call waits for a person's approval through the ordinary tool approval card, in the app and in the Slack thread of a chat started from Slack. The card names the repository, the branch and the access, and says when a person removed the repository from the chat earlier. Where nobody can answer, such as a scheduled or unattended run, the call is refused.

The API attaches only a call a person approved for exactly that repository and branch, from the same workspace GitHub App catalog and `github:use` permission as the repository picker, and never an archived or empty repository. The repository joins the chat's repositories as best effort (`optional`), ends any earlier removal record, and is cloned when the next turn starts. A new `session.resources.added` event records it.

`@opengeni/core` adds `attachSessionRepositoryResource`, `@opengeni/db` adds `listPersonApprovedFirstPartyToolCalls`, and the timeline shows the call as "Attaching a code repository".
