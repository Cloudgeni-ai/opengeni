---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Opening a new browser makes two fewer API round trips. A create that launches the browser now returns `initialView` with the tab inventory and the opened tab's observation exactly as the controller produced them, so an agent's browser_open no longer lists targets and observes again. Replayed, failed and older-controller creates omit it, and callers fall back to reading as before. The tool result the model sees is unchanged.
