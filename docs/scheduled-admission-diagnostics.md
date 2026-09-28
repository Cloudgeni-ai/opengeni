# Scheduled admission diagnostics

Connection-account selection refusals are terminal failed scheduled-run receipts
under the same producer identity. `admissionDiagnostic` contains typed reasons
and selected account identifiers, not credentials or accepted execution. These
rows cannot acquire a session or execution snapshot or become runnable.
Reconnection affects a new occurrence, not an already-refused occurrence.

Migration `0531_scheduled_admission_diagnostics.sql` adds this diagnostic-only
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