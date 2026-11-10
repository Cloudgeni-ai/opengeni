---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Agents are told when their managed sandbox was stopped. After an idle stop (or a lost box), a sandbox is restored from its saved `/workspace` alone, so files in `/tmp`, tools installed outside `/workspace` and running programs are gone. Agents used to find this out only from failing commands. The next inference after such a stop now carries a one-time note with the time and what was not kept. It is derived from the durable stop event, so it appears whether or not the replacement box already exists. The managed-sandbox prompt also says that only `/workspace` survives an idle stop, so tools needed again belong there.
