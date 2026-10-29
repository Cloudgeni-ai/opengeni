---
"@opengeni/react": patch
"@opengeni/api-router": patch
---

GitHub status checks that run on their own (when the app loads or its window comes back into focus) no longer show a "GitHub status unavailable" toast when they fail. Where GitHub is used, the failure shows in place instead: the repository picker says GitHub couldn't load and offers **Refresh list** (rather than "No repositories" and setup), and the GitHub card and integration page show it with **Retry**. The check also runs again on its own when the window comes back into focus or the connection returns. A refresh or retry the person starts still shows one toast, and repeated failures replace it rather than stacking. `refreshGitHub` accepts `userInitiated`.

Reading a workspace's GitHub repositories no longer asks GitHub every time: the API reuses GitHub's repository list for a minute, shares one GitHub call between concurrent reads, and keeps answering with the last good list for up to 30 minutes while GitHub has an outage (not when the installation or configuration is gone). A list fetched before the workspace last connected GitHub is never reused, and connecting again reads GitHub's list fresh. Syncing repositories still asks GitHub and reports its failure. Which repositories the workspace may use is still checked on every read.
