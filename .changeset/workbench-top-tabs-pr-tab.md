---
"@opengeni/react": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

The chat's side panel shows only the essentials. Tabs run across the top; in the app the strip shows the PR when one is linked, Changes when there are changes and Artifacts when the chat has some; a "+" menu holds everything else (Files, Terminal, Browser, Desktop, Linked, expand and hide), and a tab opened from it stays on the strip for that chat until closed. Switching tabs keeps each panel's scroll and selection and no longer re-renders every panel. A linked GitHub pull request gets a PR tab: title, one status line, one action (Merge, which asks the agent, or View on GitHub) and a menu for Description, Discussion, Commits and Checks, read from the new `GET .../sessions/:id/links/:linkId/pull-request` route (`client.getSessionPullRequest`). Linked shows only when something else is linked. A chat with nothing to show starts with the panel closed; new content puts a small dot on the panel toggle, and an opened empty panel offers Files, Terminal and Browser (`WorkspaceDock` `landing`/`onStripEmptied`/`headerAccessoryPinned`, `openTabRequest.expand`).

Changes has one quiet header per file, a folder tree with +/− change bars in the app (`WorkbenchChanges` `navigation="tree"`), and one view menu (comparison and unified/split), and switching files no longer stalls: diff highlighting can run in web workers (`enablePierreDiffs({ worker })` or `enableWorkbench({ diffsWorker })`), and file rows and sections no longer re-render on every scroll or stream update. `WorkspaceTab.optional`, the `essentials` and `tabScope` dock props, `WorkbenchChanges` `comparison`/`hideSummary`/`navigation` and `SandboxWorkspace` `tabVisibility` are new and additive; embedders keep today's tabs by default.

Opening an app or artifact shows one way back (the window-bar breadcrumb) and restores the list's scroll position on return. The Agents page has one **Add agent** menu at the top with the ready-made agents, a blank agent and import.
