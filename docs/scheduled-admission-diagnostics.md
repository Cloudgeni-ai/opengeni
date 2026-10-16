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
| `variable_set_unavailable` | no | `failed` | Legacy only: a task created before the vault migration still names a Variable Set that is no longer visible to its authority. Clear the task's set (vaults need no attachment). |
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

## Blocked schedules

A schedule never stays stuck without its owner knowing. The API's scheduled-task
lifecycle pump reviews each schedule's newest settled scheduled run once
(migration `0792_scheduled_task_blocker_reviews.sql`, rolling; manual runs and
runs from before the last edit or resume do not count):

- When no later run can start until a person acts, the schedule pauses itself
  in the same pass (Temporal follows through the schedule outbox) and its owner
  gets one inbox/phone notice naming the schedule, the reason and what would
  unblock it. That covers a pinned connected account that can no longer be used
  (`admissionDiagnostic`), any non-retryable refusal above, a paused chat
  (`scheduled_session_paused`), a chat that ended or no longer exists
  (`session_cancelled` outside new-chat-per-run mode,
  `scheduled_target_session_unavailable`) and an unavailable model.
- When runs fail or are skipped for a reason that may clear by itself (a busy
  chat, a retryable refusal, a failed turn), the owner is told once after three
  in a row. The schedule keeps running; a single skip or failure stays quiet.

The notice is a `session.notification.posted` event with key
`schedule-<task id>` on the blocked run's chat, else the chat the schedule runs
in, else its most recent run's chat. It is withdrawn when a later run succeeds or
a person resumes, pauses or deletes the schedule. `GET /scheduled-tasks` and
`GET /scheduled-tasks/:id` return the current `blocker` (`state` `paused` or
`notified`, `reason`, `message`, `runId`, `since`), and the schedule page shows it.

Agents cover what the platform cannot see, a run that starts but cannot do its
job: each new scheduled occurrence tells the agent to try to fix a blocker,
otherwise notify the owner once under the same `schedule-<task id>` key, and
pause the schedule when no later occurrence can succeed. Already delivered
occurrences keep their original text.
