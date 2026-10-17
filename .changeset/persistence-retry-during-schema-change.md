---
"@opengeni/db": patch
---

Idempotent persistence transactions now retry briefly (after 250 ms, then 1 s) when Postgres reports a schema-change error such as an undefined operator or a changed column type. A migration that alters a column used inside a routine could otherwise fail turns that were saving events at that moment; those writes now succeed on the next attempt instead of failing the turn.
