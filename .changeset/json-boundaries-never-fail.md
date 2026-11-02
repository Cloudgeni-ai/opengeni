---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

A value that JSON cannot carry (a symbol key, a function, a bigint, a cycle, a class instance such as a Response, Headers, AbortSignal or Error) no longer fails a turn where it is stored or sent. Every protocol JSON boundary (history, tool receipts, run events, approvals, MCP results and custom data, the sandbox envelope) and the database's canonical JSON encoder now convert or drop such a value as `JSON.stringify` would and log the paths and kinds they changed, never the values. A `JSON.stringify` refusal from any other serializer ends the turn with the same clear, recoverable failure instead of stopping the chat.
