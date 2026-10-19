---
"@opengeni/runtime": patch
---

browser_open now returns and observes the tab it opened. Before, it picked the first tab in the profile showing the requested URL, so on a person's own Chrome an older tab, or another session's tab on the same URL, could be handed to the agent. Parallel sessions then acted on one shared tab and failed.
