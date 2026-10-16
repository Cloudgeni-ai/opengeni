# Opt-in model request evidence

`OPENGENI_MODEL_REQUEST_EVIDENCE_ENABLED=true` enables deployment-local audit
capture. It is **off by default**, not a session feature or benchmark activation.
It does not select a model, alter model input, grant provider authority, change
billing, or replace the latest Debug context snapshot.

## Boundary and identity

`packages/runtime/src/model-request-evidence.ts` observes the existing final
fetch seam. Codex supplies its actual logical request ID and physical transport
attempt through an in-process symbol; no evidence fields enter HTTP headers or
model input. The existing WebSocket adapter reports the exact `response.create`
packet before sending it. HTTP bodies and WebSocket packets retain separate
encodings. Other providers currently receive an explicitly unsupported local
identity: they cannot pass strict completeness.

Ordered source Responses SSE events and non-streaming Responses JSON retain
public output, function calls, provider-exposed reasoning summaries, and raw
provider usage. Hidden reasoning text/analysis and encrypted response state are
not exported. Opaque-state markers are not the underlying material. Normalized
committed `agent.model.usage` records link by their actual response/source ID and
committed event ID/sequence, never FIFO or an invented response ordinal. Nullable
usage remains nullable. Raw and normalized usage are provenance, not two charges;
list-equivalent prices are not subscription invoices.

Worker scopes cover main inference, session-title and compaction, including
portable summarizers. Child sessions have their own attempt scopes and must be
enumerated/exported independently through the existing session-tree API. This
does not certify proprietary provider-internal context, cache contents, or hidden
chain of thought. Exact outgoing media references are retained when in bounds;
remote bytes behind a reference are not reconstructed or certified.

## Persistence, fences and bounds

The worker starts a scope only after claim and closes it before ordinary attempt
settlement. Canonical attempt-fenced event publication appends
`agent.model.evidence` manifests. Repetitive content is stored in the existing
session-scoped content blobs, as digest-checked `{text: chunk}` envelopes.
Historical blob/snapshot codecs are unchanged. There is no new table or migration.
Scope ordinals, physical-request counts and closure error counts expose missing
records. A stale writer cannot append current-attempt evidence. A blob persisted
before a rejected event may be orphaned until ordinary session retention, but is
never a successfully exported request.

Each request/response observer is bounded to 4 MiB. Oversize, invalid UTF-8,
unsupported protocols, cancellations, missing terminal/identity/usage and
persistence failures remain unavailable or incomplete, never old snapshots,
empty replacements or zero usage. Persistence waits are bounded to five seconds
per record; timed-out underlying DB work may still settle later, and the closure
records an error regardless. It never triggers a model retry. The canonical
attempt fence still rejects a late publication after settlement.

Only exact known injected provider bearer/API-key and Git/Codemode credentials (including renewals) are
registered for redaction, including nested JSON-escaped occurrences. Buffered
public delta streams are checked as ordered fragments of the same output item,
content/summary index and event type within one physical response. Only exact
matching spans are replaced before the separate events are persisted; fragments
from concurrent responses or separate output items are not concatenated. This
also applies to the available prefix of a failed or cancelled response. No credential-name
heuristics or blanket environment/task-text removal is used. Authorization
headers are never captured. This does not discover unregistered secrets supplied
by arbitrary user content or external tools; those remain deployment/export
custody responsibilities. Source SHA-256 hashes describe pre-redaction captured
UTF-8 bytes; hydrated content can intentionally differ where marked redacted.

## Export and completeness

`GET /v1/workspaces/:workspaceId/sessions/:sessionId/model-evidence` uses the same
`session.read`, `sessions:read`, visibility and RLS checks as the context inspector.
The SDK method is `getSessionModelEvidence`. Parameters are `afterSequence`
(default zero), fixed `throughSequence` (first response's watermark), and `limit`
(1–20, default 10). Pages are also byte bounded; a single in-bounds record travels
alone. Follow `hasMore`/`nextAfterSequence`, not page length, and reuse the original
watermark. Attempt inventory is capped at 4096 with an explicit truncation flag.
Changing inventory during paging is a completeness failure; export after the
attempt has quiesced for a stable audit.

`assessSessionModelEvidencePages` checks page chaining, watermark/inventory
consistency, entire missing attempts and record-local scope/request/response/usage
joins. `assessModelRequestEvidence` alone checks only the supplied record set;
it is not proof that a session tree or a campaign was fully collected. Null
required token totals, invalid integer counts or impossible known cached/cache-write
and reasoning subsets, ambiguous response IDs (including disagreement between
per-event `response_id` and nested `response.id`), a failed physical attempt without
complete usage, or any missing record deny strict completeness. Optional token
classes can remain unknown: a successful record check does not turn them into
known zero or certify an invoice. Child coverage, provider custody/account
receipts, model entitlement and aggregate campaign accounting are separate checks.

## Archive lifecycle

The existing verified full-fidelity archive bundle already exports all session
events and content blobs. The small new manifests remain readable after purge;
their blobs move into the verified bundle alongside historical snapshots. No
archive writer, purge SQL or historical manifest is changed.

The paginated endpoint explicitly returns `availability: archived`, **not** a
complete empty export. Automatic object-store archive hydration is not provided
by this change. An operator must retain/retrieve and verify the existing bundle
by its recorded SHA-256/size, decode the original event/blob rows, and use
`decodeModelEvidenceContent` with those digest-checked chunks for offline audit.
Tests cover actual archive row export and offline hydration; they do not claim a
new public archive-download API. Preserve the live export before archive when
the external harness needs only the API. Session deletion retains its existing
deletion semantics, including deletion of owned archive objects.

This is an offline-tested capture foundation, not full AA/ATIF readiness, live
provider validation, deployment approval, or scored benchmark launch authority.
