---
"@opengeni/desktop": patch
---

The desktop app reopens any page the product's `webPaths.match` recognizes, including pages whose address names no workspace (`match` returns `{ workspaceId: null, sessionId: null }`); the account keeps its last known workspace. Links to such pages still open in the browser.
