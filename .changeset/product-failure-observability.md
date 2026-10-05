---
"@opengeni/observability": patch
---

Make product-level failures visible and alertable: every rejected API request is counted and logged with a bounded error code, missing-permission/domain reason, and content-free message fingerprint; Browser/Computer operations (including observe, tabs, and handoff attach) report outcome and failure reason; agent-opened handoffs and their expiry are counted; Connect attempts, provider OAuth callbacks, MCP OAuth starts, Connected Machine connects/enrollment, attached-browser reachability, and agent tool calls by closed tool family get low-cardinality metrics; new PrometheusRule alerts cover abnormal per-route refusals, missing-permission spikes, refused handoffs, and each product surface.
