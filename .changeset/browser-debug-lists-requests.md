---
"@opengeni/browserd": minor
"@opengeni/contracts": minor
"@opengeni/runtime": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Browser diagnostics can now list a tab's finished requests, successful ones included. Ask `browser_debug` (or the diagnostics endpoint) for the new kind `request` to get the tab's page loads, fetch and XHR calls, each with its method, URL and HTTP status, in the order they ended. A request whose response arrived keeps its status even when the page stopped reading the body. Images, fonts, styles, scripts and the browser's own icon fetches are left out, and a failed one is still reported as a failed request. Requests are kept apart from errors and downloads (up to 500 per tab), so a busy page cannot push those out, and they are never returned unless asked for, so existing diagnostics read exactly as before.
