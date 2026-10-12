---
"@opengeni/db": patch
---

A drained maintenance migration (0743) retires the legacy subscription pool runtime after the SuperGrok and Claude cutovers. It drops the legacy SuperGrok and Claude pool routines, the triggers and row policies that call them, and the Codex-named twins of the shared subscription routines, each by exact name and never by cascade. It refuses with nothing changed unless the application sessions are drained, every provider's cutover receipt is committed and nothing that stays depends on a retired object. The organization reach rows take provider-free names, must name a connection of their own provider and lose their Codex default. Legacy tables, receipts and the read-only restrictions stay. A binary that includes 0743 refuses to start until it has run, and older binaries refuse a retired database.

The retained Codex session-account endpoint delegates to the shared account-choice transaction, preserving its response and event shape. Automatic resets only Codex, and an unchanged choice acknowledges success without rewriting the binding.
