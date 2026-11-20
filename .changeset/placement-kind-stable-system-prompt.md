---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Moving a configured agent's session between a managed sandbox and a Connected Machine no longer rewrites its system prompt. The prompt describes the deployment's own kind of compute; a session on a Connected Machine of a managed-sandbox deployment gets the Connected Machine guidance in its workspace filesystem layout item, which is appended only when the layout changes.
