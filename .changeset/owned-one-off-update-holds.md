---
"@opengeni/core": patch
"@opengeni/runtime": patch
---

Retain long-running attempt-owned Connected Machine one-offs in the existing command ledger, returning a command ID after a bounded observation without imposing a process deadline or tying cancellation to HTTP lifetime. Preserve terminal result fields, Unix update handover, existing update diagnostics and the Windows exec_command shell default.
