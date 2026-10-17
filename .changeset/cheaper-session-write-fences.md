---
"@opengeni/db": patch
---

Writes to sessions, turns and their update carriers run less trigger work. The MCP account binding fence no longer converts both row versions to JSON and re-validates unchanged bindings on every update: a trigger condition now runs it only when bindings, delegations or session visibility change, and inserts keep the unconditional check. The session tenancy fence reads the row's workspace column directly instead of converting the whole row to JSON. Behaviour and error messages are unchanged.
