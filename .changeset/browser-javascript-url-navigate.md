---
"@opengeni/browserd": patch
---

Navigating a managed browser tab to a `javascript:` URL now completes when the script runs, instead of failing with "browser could not navigate to the requested URL (net::ERR_ABORTED)" and an unknown outcome. Chromium answers such a URL as an aborted load because it runs in the current document rather than loading a new one. The tab keeps its page, or shows the document the script returned, and later actions in a batch go on from there.
