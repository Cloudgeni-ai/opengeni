---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Chats show who they wait on (`Session.waitingOn`) and their Linked items with live status (`listSessionLinks`, `addSessionLink`, `removeSessionLink`, and the `session.waiting_on.changed` and `session.links.changed` events). The workbench Changes tab now draws its own collapsible header per file for every embedder (an additive visual change; no props change), and accepts optional `pullRequest` and `onOpenPullRequest` props for View on GitHub and Open PR; without them the summary bar is unchanged.
