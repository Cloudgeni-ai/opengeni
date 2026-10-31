---
"@opengeni/react": patch
---

Deleting a workspace no longer shows a false "Failed to delete workspace" error when the browser loses the server's response while the delete is still committing. The app now confirms the outcome for about half a minute, and reports the original error only if the workspace is still there.
