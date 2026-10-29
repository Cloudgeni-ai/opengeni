---
"@opengeni/react": patch
"@opengeni/api-router": patch
---

GitHub status checks that run on their own (when the app loads or its window comes back into focus) no longer show a "GitHub status unavailable" toast when they fail; the GitHub card and the integration page show the failure with **Retry** instead. A refresh the person starts still shows one toast, and repeated failures replace it rather than stacking. `refreshGitHub` accepts `userInitiated`.

Reading a workspace's GitHub repositories no longer asks GitHub every time: the API reuses GitHub's repository list for a minute, shares one GitHub call between concurrent reads, and keeps answering with the last good list for up to 30 minutes while GitHub fails. Syncing repositories still asks GitHub and reports its failure. Which repositories the workspace may use is still checked on every read.
