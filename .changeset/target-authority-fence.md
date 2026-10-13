---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Targeted tool resolution, invocation, approvals and Site manifests evaluate one live fence per physical provider request instead of re-running nested caller, Site, registry, account and policy checks. The fence reads only the selected rows in a `statement_timeout`-bounded transaction, re-reads an organization key without a lock or write, and reads a pinned Site once per evaluation however many tools it pins. Authority that cannot be read within 2.5 seconds is answered as 503 `upstream_unavailable` with `details.code: "tool_authority_unavailable"` instead of a silently missing tool (404). `Server-Timing` adds `gw-fence`.
