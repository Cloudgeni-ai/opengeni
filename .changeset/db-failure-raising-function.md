---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

When a turn fails because one of Opengeni's own database checks refused it, the failure now records which check refused it: the database function names and line numbers on the call chain, for example `admit_turn_resources:31`. Before, the record kept only the error code. The refusal message and SQL text are still never copied. A one-off permission refusal can now be traced after the fact without server logs.
