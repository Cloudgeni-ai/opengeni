<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Preserve temporary capabilities in private agent state

**Date:** 2026-08-04  
**Status:** Accepted

## Context

The generic secret sanitizer treated signed URL query parameters and credential-shaped fields as unsafe everywhere. A file-upload MCP tool could successfully create a pending upload, but the model received literal redaction markers in place of the signed PUT credential and signature. The upload therefore could not be completed, and equivalent short-lived capability workflows were vulnerable to the same failure.

OpenGeni's private model history is an access-controlled execution surface, not a public diagnostic log. Some tool results intentionally contain short-lived authority that the agent must exercise to complete the requested operation.

## Decision

Split redaction by surface:

- Private model input, conversation history, pending tool receipts, and resumable run state preserve intentionally returned temporary capabilities.
- Exact host-known secrets remain redacted there using registered provenance.
- Human/audit events, logs, diagnostics, errors, and final public projections retain strict heuristic redaction.

Temporary capability material is acceptable in private model history. A signed URL or upload header is not removed from private state merely because its name or shape resembles a credential.

## Consequences

- Multi-step upload/download and delegated-capability tools remain functional across model calls and legitimate turn resume.
- Private history may contain short-lived tool-returned capabilities and must continue to be protected by its existing tenant authorization, RLS, and retention controls.
- Tool authors must keep capability lifetimes and scopes narrow and must not mirror them into public events or logs.
- Exact credential provenance registration remains load-bearing; a host-resolved secret echoed by a tool is still removed.
- Regression tests must assert capability preservation and exact-secret removal together.

## Rejected alternatives

- **Redact every credential-shaped value everywhere.** Rejected because it silently destroys executable tool results.
- **Add one-off exceptions for each storage provider or MCP tool.** Rejected because equivalent capability shapes will recur and provider-specific allowlists drift.
- **Move every byte transfer behind a server-side import endpoint.** Rejected as a workaround for a broken runtime boundary; it duplicates domain behavior and does not solve other temporary-capability tools.
- **Disable redaction for all private state.** Rejected because exact host-known secrets can be identified reliably by provenance and should still be removed.
