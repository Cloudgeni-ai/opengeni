---
"@opengeni/db": patch
---

Prepare SuperGrok refusals and capacity waits for the shared subscription core. The shared core's capacity waiter, its wakes and its Steer and Cancel cleanup now serve any provider, with each provider's own session events, and a SuperGrok turn on the core records a refusal against its account, moves to another account within the shared limit or waits durably for capacity. Nothing changes today: no organization has the SuperGrok cutover, and Codex keeps its events, names and metrics exactly.
