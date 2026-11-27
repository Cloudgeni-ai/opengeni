---
"@opengeni/runtime": patch
"@opengeni/worker": patch
---

A chat created on a Connected Machine keeps its system prompt when it moves to the deployment's managed sandbox and back. The worker rewrites the turn's settings to the route it runs on, and the system prompt followed that rewrite, so every such move started a new cached prefix. The prompt now follows the session's own backend (`homeSandboxBackend`); on the managed sandbox, the workspace layout item says what working there means.
