---
"@opengeni/browserd": patch
---

A browser action after which the page closes its own tab, as a finished sign-in or payment popup does, now completes within moments. Before, it waited out the navigation and request settle bounds for a tab that no longer existed and then returned `outcome_unknown`, which invited the agent to check before continuing (or, on a slow machine, ran into the action deadline). The settle waits now end once the tab's attachment is gone. When the tab was not closed by a close-tab call, the receipt is `completed` with no observation and an `observation_unavailable` note saying the tab closed afterwards and to list the current tabs.
