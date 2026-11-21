---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Linked items show live status for Linear issues (state, assignee, title) and Slack threads (first message, replies, last reply), read through the viewer's own connections; links the viewer can't read carry an optional `connect` (`SessionLinkConnect`), and `SessionLinkLiveStatus` gains optional `assignee`, `replies` and `lastReplyAt`. `LinkedList` and `SessionLinkedPanel` accept an optional `connectHref`. The built-in sidebar default is a Pinned apps live list, shown only when the workspace has pinned apps. The agent page's Can use has a GitHub row for Opengeni's own GitHub tools, and `gh` reads are refused when the agent blocks every built-in GitHub read.
