---
"@opengeni/api-router": patch
---

The verified owner of a Personal workspace, acting as themselves, can now rename it and share a machine with the workspace (still only them) without `workspace:admin`, the same check as its other settings. Shared workspaces keep their rules: only a workspace admin shares a machine with everyone, and making a machine Only me for someone else still needs `workspace:admin`. The web app shows Rename and Share with workspace to the Personal owner exactly when the server allows them.
