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

## Admission refusals

Every other occurrence the scheduler refuses before accepting execution is a
run receipt too (migration `0539_scheduled_admission_refusals.sql`, rolling),
never an activity retried to exhaustion with no run and never a silently
dropped occurrence. The run carries `admissionRefusal`
(`{ "version": 1, "reason", "retryable" }`) with `error` equal to `reason`:

| Reason | Retryable | Run status | Meaning |
| --- | --- | --- | --- |
| `scheduled_authority_unavailable` | no | `failed` | The frozen owner/causal-human authority cannot be proven (owner without revision authority, user-scoped personal resource or xAI without a causal human, disagreeing humans, source schedule without its owner). |
| `machine_target_unavailable` | no | `failed` | The Connected Machine target or its enrollment is gone, or a self-hosted task names no machine. |
| `variable_set_unavailable` | no | `failed` | The task's (or its Sandbox Environment's default) Variable Set is not visible to the task's authority. |
| `rig_version_unavailable` | no | `failed` | The Sandbox Environment has no active version. |
| `machine_enrollment_inactive` | yes | `skipped` | The machine's enrollment is not active right now. |
| `insufficient_credits`, `monthly_model_cost_limit`, `monthly_agent_run_limit` | yes | `skipped` | Billing admission refused this occurrence. |

A terminal refusal repeats for every occurrence until the task or the resource
it names changes. A retryable one skips only this occurrence; a later
occurrence (or a manual trigger) is admitted normally once the condition
clears. The receipt is keyed by the occurrence's producer identity, so a
redelivered activity replays it and an occurrence never gets two runs. It
carries no accepted execution, session, or raw exception text (the worker only
logs the detail). A paused or deleted task still refuses without a run, since
no occurrence is due.
