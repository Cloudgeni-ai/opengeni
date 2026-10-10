---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
---

Saving a browser download to a workspace path now creates missing folders on that path, instead of failing with "mutation path not found". Every existing folder on the path must still be inside the workspace.
