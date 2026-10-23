---
"@opengeni/browserd": patch
---

An attached Chrome session that is open but unused no longer polls the browser extension twenty times a second. After two quiet seconds it polls once a second, polling stays fast while a command is running, and the next command switches it straight back to fast polling, so actions and the events they cause are not delayed. A machine with many open attached sessions no longer keeps the person's browser and the agent busy with constant event reads.
