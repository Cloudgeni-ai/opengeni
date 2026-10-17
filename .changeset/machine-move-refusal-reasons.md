---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A refused move to another machine now says why. Moving a running chat onto a personal (Only me) machine is refused with the new `chat_busy` code, a machine the person may not use with `personal_machine_not_permitted`, and a machine that is gone with `stale_pointer`; only a real simultaneous move is reported as `concurrent_swap`. Previously every refusal was reported as a concurrent swap. `useMachines` now shows plain copy chosen by the code and never the server's `reason` text, which is written for agents and logs.
