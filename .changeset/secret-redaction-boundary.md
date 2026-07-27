---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Redact known runtime credentials and recognized authorization, cookie, signed
URL, assignment, and provider-token shapes before model calls, durable session
history, events, logs, and telemetry. Disable credential-bearing shell xtrace
and raw Agents SDK model, tool, and MCP transport payload logging.