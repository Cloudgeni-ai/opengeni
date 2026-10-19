---
"@opengeni/runtime": patch
---

Browser tools now resume a browser that stopped between calls, the way browser_open already does. A browser is suspended while idle when its machine needs room for another one, and is lost when its controller restarts, for example after an agent update. Before, the agent's next browser_observe, browser_act or browser_tabs call failed with "BrowserSession is not active", and an agent that did not think to call browser_open again opened a fresh browser and lost its signed-in state.

Now the call resumes the same browser from its saved working copy. Reads of the current tab (observe, read, screenshot) and listing or opening tabs then run on the restored browser. Calls that name a tab from before the resume, actions, and diagnostics do not run, because tab IDs changed and unsaved page input may be gone: they return a `browser_resumed` error with the restored tabs and the selected tab's outline, so the next call can continue directly. A refused resume returns its reason, and any other refusal is unchanged.
