---
"@opengeni/runtime": patch
---

Add bounded tool listing and exact-name schema disclosure as a recovery path for keyword-search misses across native and generic transports. Backfill search results after schema-budget exclusions without changing authorization, approvals, or eager-tool policy.

Prefer the connection-bound native Codemode client when available so an older installed CLI does not mask the supported Connected Machine path.

The native Connected Machine client now sends the compiled API contract acknowledgement, with a cross-language parity test, and reports flat contract-mismatch errors rather than hiding their explanation.

Native Codemode errors retain operation identity, observed outcome, and error details as JSON on stderr. A read-only journal command supports inspection without resubmitting tools. Packaged-client fixture verification covers JavaScript imports, CLI calls, and native recovery without probing customer tools.
