# Workspace pause timers

Workspace settings → General retains the immediate Pause/Resume button. The
adjacent chevron opens Pause in (Now or duration) and Pause for (Until I resume
or duration). Already paused: Resume in. Presets: 15/30 minutes, 1/2 hours.
Custom: whole minutes/hours, one minute–30 days. Click the countdown to edit.

One timer per workspace. Cancel timer preserves runtime state. Manual
Pause/Resume cancels automation, even a desired-state no-op. Exact retries do
not modify newer timers. A combined timer measures Pause for from the actual
admission pause. After downtime, an overdue pause starts its full duration;
an overdue resume runs on recovery. Independent session pauses retain their
existing semantics; cancelled work is never revived.

`POST /v1/workspaces/:workspaceId/pause-timer` requires workspace admin:
`action: set | cancel`, `clientEventId`, `expectedRevision`, optional
`pauseInSeconds` and nullable `pauseForSeconds`. Already paused requires zero
Pause in and a resume duration. Invalid input/state: 400. Stale revision: 409.
SDK: `setWorkspacePauseTimer`. Workspace projection includes
`inferenceControl.timer` and `serverTime` for relative countdowns.

Postgres owns deadlines on `workspace_inference_controls`. The existing control
fence serializes edits, manual actions and execution. Timer/phase receipt keys
make retries idempotent; automatic resume checks its original pause revision.
The control-worker wake dispatcher processes up to 100 due timers per sweep,
normally every ten seconds, then drains normal durable wakes. No browser or
agent inference is required. Workspace events refresh clients; the settings
view also refreshes every ten seconds while a timer exists. Execution occurs
on the next available sweep, not as a precise alarm.

Migration 0420 is **maintenance-only**. Drain old API, control and turn workers
before migration; deploy the matching version everywhere. Older writers do not
cancel timers and older clients reject timer event actions. Do not restart old
writers after activation.

Verification:

- `bun test packages/db/test/workspace-pause-timers.test.ts`
- `bun test apps/api/test/workspace-control-events.test.ts`
- `bun scripts/run-browser-e2e.ts ./test/e2e/workspace-pause-timers.browser.e2e.ts`

The browser suite uses the real API, non-superuser PostgreSQL and actual worker
sweep. It advances test-database deadlines to verify transitions quickly and
captures runtime, editor, saving, validation, transition, conflict and mobile
states to `OPENGENI_TIMER_SCREENSHOTS` (default `/tmp/opengeni-pause-timer-screenshots`).
