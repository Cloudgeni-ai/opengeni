---
"@opengeni/core": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Retain long-running attempt-owned Connected Machine one-offs in the existing command ledger, returning a command ID after a bounded observation without imposing a process deadline or tying cancellation to HTTP lifetime. Preserve terminal result fields and Unix update handover. Distinguish interaction-session update holds, show prolonged waits in Machines, and include installed version and retained update progress in the fleet listing.
