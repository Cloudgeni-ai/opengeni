---
"@opengeni/browserd": patch
---

A browser restored from its checkpoint no longer fails to resume when one of its saved tabs can't load, for example because the site is down or its address no longer resolves. Before, the first tab whose page failed to load aborted the whole restore with "browser could not navigate to the requested URL", so the browser could never be resumed. Restored tabs now reopen on the browser's error page, as the browser's own session restore does. A tab showing an error page is also saved under the page it was trying to load instead of the error page, so a later restore retries it. Opening or navigating a tab outside restore still reports a page that can't load, and navigation policy refusals and invalid addresses still fail restore.
