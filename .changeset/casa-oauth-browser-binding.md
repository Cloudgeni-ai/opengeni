---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/react": patch
---

Integration OAuth (MCP connectors such as Gmail, and built-in provider integrations) now finishes only in the browser that started it. A start from a signed-in browser sets a short-lived HttpOnly binding cookie whose hash is signed into the state. A desktop-app start finishes only where the same person is signed in. Any other callback is refused as `browser_mismatch` before anything is exchanged or saved, so a consent link sent to someone else can no longer connect their account to the sender's workspace. Connect attempts started from the Opengeni browser session may return only to this deployment's own origins. Host products using their own keys or delegated tokens are unchanged.
