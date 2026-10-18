---
"@opengeni/browserd": patch
---

Opening or navigating to a page whose server never answers now fails after 20 seconds with "browser could not load the requested URL: its server did not respond within 20 seconds", and the tab stops loading. Before, the request waited for the generic browser command deadline, so a browser open failed with an unspecific controller error and the result was reported as unknown. A page that cannot load now names Chromium's reason, for example net::ERR_CONNECTION_REFUSED, and a tab opened for an unanswered page is closed instead of left behind.
