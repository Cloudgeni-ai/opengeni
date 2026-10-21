---
"@opengeni/agent-host": patch
"@opengeni/desktop": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Leave existing standalone agents untouched when the desktop app opens. Explicit
signed-in setup reuses their service and signed installation, preserving macOS
privacy grants. Service-backed pause/resume persists across logins; quitting the
desktop does not stop the service. Permission guidance uses the running agent's
reported grants rather than probing the desktop app. Existing agents require
the matching native release with structured service inspection before management.
