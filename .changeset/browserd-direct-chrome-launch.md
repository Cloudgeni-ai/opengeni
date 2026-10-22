---
"@opengeni/browserd": patch
"@opengeni/api-router": patch
---

Managed browsers are now started by the browser controller itself instead of through the separate agent-browser daemon, so the controller is the browser's only DevTools client. This removes launch settings that set managed browsers apart from an ordinary Chrome (hidden scrollbars in headless mode and disabled popup blocking), a second DevTools client attached to every page, one extra process per browser with its launch overhead, and the agent-browser companion from sandbox images and agent installs. It also fixes problems the daemon had been hiding: dedicated web workers on headless pages stayed paused and never ran, a click that opened a JavaScript dialog from an upload control was reported as a completed upload, a network-idle wait could hang on unfinished requests of the page that was replaced, and a full-page overlay was mistaken for a sticky bar when the page showed scrollbars.
