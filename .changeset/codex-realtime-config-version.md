---
"@opengeni/codex": patch
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

Subscription voice no longer refuses to start when the Codex realtime remote configuration advertises a protocol version other than V3. That version is the desktop client's preference, not a requirement of the call endpoint, so the call now uses the pinned V3 model and architecture (as the Codex CLI does). A refused realtime negotiation now writes one server log line with the provider status, the failing stage, identifier-shaped provider error fields, and the call parameters with their source; the client still gets only the safe message.
