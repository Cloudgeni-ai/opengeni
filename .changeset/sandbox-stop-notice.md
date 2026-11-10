---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Agents are told when their managed sandbox was stopped. A stopped sandbox is restored from its saved `/workspace`, so files elsewhere (such as `/tmp`) and running programs may be gone, and agents used to find out only from failing commands. The first turn attempt after a stop the agent hasn't acted since now carries one sentence with the time and what may be gone. With the short idle grace, this appears on most turns that follow a pause after sandbox use. A box found lost during a turn is not covered. The reaper's stop event now records `providerStopped`, so a Connected Machine's drain, which stops nothing, is not reported.
