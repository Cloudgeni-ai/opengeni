# Scheduled admission diagnostics

Connection-account selection refusals are terminal failed scheduled-run receipts
under the same producer identity. `admissionDiagnostic` contains typed reasons
and selected account identifiers, not credentials or accepted execution. These
rows cannot acquire a session or execution snapshot or become runnable.
Reconnection affects a new occurrence, not an already-refused occurrence.

Migration `0534_scheduled_admission_diagnostics.sql` adds this diagnostic-only
path; ordinary accepted-run checks stay unchanged. Its trigger replacements
require the scheduled authority and owner triggers from migrations 0275 and 0478.
Historical migration fixtures that deliberately withhold those prerequisites
must replay this migration after them, just like an ordered production upgrade.

The worker records a refusal only for the exact active task revision and digest.
An existing receipt wins concurrent delivery: refused occurrences remain refused,
and accepted occurrences retain their existing recovery path. A diagnostic row
does not create a session, consume an execution grant, or authorize mutation replay.

The diagnostic schema accepts only bounded server identifiers, selected connection
UUIDs, and enumerated reasons. It does not copy raw exception text or inspect
accounts outside the caller's authorized inventory. An unavailable account cannot
always be distinguished from an invisible one; the receipt preserves that boundary.

## Authority refusals

Migration `0536_scheduled_authority_refusals.sql` (rolling) lets the same
diagnostic-only receipt record an occurrence whose frozen execution authority
cannot be proven: `error` is `scheduled_authority_unavailable` and
`admissionDiagnostic` is exactly `{ "version": 1, "reason":
"owner_access_unavailable", "accounts": [] }`. The worker records it for the
deterministic authority checks (the immutable owner differs from the revision's
human authorizer, a user-scoped personal resource or xAI authority without a
causal human, or causal humans that disagree) instead of throwing, so the
occurrence is a visible failed run rather than an activity retried to
exhaustion with no run at all. The raw reason is logged by the worker, never
stored.
