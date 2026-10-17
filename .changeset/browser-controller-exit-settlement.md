---
"@opengeni/agent-proto": patch
---

A browser controller on a Connected Machine that crashed, was stopped uncleanly or failed to start no longer blocks agent updates for the rest of the agent's life. On Linux and macOS the update now waits only until nothing remains of that controller's own process group, then proceeds. Previously the machine refused every managed update with "could not check whether the machine was idle" until the agent was restarted by hand.
