---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

The chat's side panel is quieter and faster. Tabs run across the top; in the app only the relevant ones show (the PR when one is linked, Changes when there are changes, and anything the person opened), with the rest under **+**. A linked pull request gets a PR tab with its state, branches, counts, a Merge action that asks the agent, and Changes, Description, Discussion, Commits and Checks sub-tabs, read from the new `GET .../sessions/:id/links/:linkId/pull-request` route (`client.getSessionPullRequest`). The Linked tab shows only when something else is linked.

Changes has one quiet header per file and a single summary row, and switching files no longer stalls: diff highlighting can run in web workers (`enablePierreDiffs({ worker })` or `enableWorkbench({ diffsWorker })`), and file rows and sections no longer re-render on every scroll or stream update. `WorkspaceTab.optional`, the `tabScope` dock prop and `SandboxWorkspace` `tabVisibility` are new and additive; embedders passing their own tabs keep today's tabs.

Opening an app or artifact shows one way back (the window-bar breadcrumb) and restores the list's scroll position on return. The Agents page has one **Add agent** menu at the top with the ready-made agents, a blank agent and import.
