# Scheduled task access: drift, refresh, and failed-access notices

A scheduled task never saves which connector accounts were connected when it
was saved. Every fresh occurrence resolves its owner's current accounts. For
runs that create a chat, the task stores the chat's initial tool selection:

- its connectors (`agentConfig.tools`);
- accounts a person explicitly pinned (`agentConfig.pinnedAccounts`, with
  `pinnedAccountsRequired` to skip a run instead of going without a pinned
  account that can no longer be used). A pin narrows only its own connector;
  every other connector follows the owner's current accounts;
- for a task an agent created, the creating session's Opengeni tools,
  permissions and access policy (the creator policy, migration 0428).

Only a person can pin, through the schedule editor or a human API call; agents,
API keys and services receive 403. A schedule that posts into an existing chat
stores only its message and timing and has no pins: that chat, including a
reusable schedule's chat after its first run, supplies its model, tools and
machine, and each run uses the owner's current accounts. A task can still fall
behind: a connector the workspace now gives every new schedule is missing,
newer Opengeni tools are absent, or an account a person pinned was
disconnected. This page describes how Opengeni shows that, how the owner
refreshes it, and how the owner learns that a run could not use a connector.

## Scheduling a message in a chat

Conversational scheduling defaults to the calling chat. The first-party
`scheduled_tasks_create` tool accepts `name`, `schedule` and `prompt`; its
destination comes from the signed session claim. An explicit `targetSessionId`
chooses another authorized chat. Sessionless callers must choose a destination
or explicitly choose a separate-agent run mode.

HTTP and SDK callers can create an existing-chat schedule with
`{ name, schedule, prompt, targetSessionId }`. No model, tools, machine, Variable
Set or Sandbox Environment is required. The target supplies those execution
settings when an occurrence is admitted. Its accepted snapshot remains fixed
through dispatch recovery. The schedule stores the message and its captured
account choices, rather than a second copy of the chat's execution settings.

A scheduled message enters the ordinary session-turn runtime with scheduled
provenance and the schedule's initiating authority. It does not impersonate a
fresh human interaction or borrow the destination chat creator's credentials.
Account selection, current owner authority, target access and resource
generations are still revalidated before execution.

Separate-agent work is explicit: `reusable_session` creates a chat for the
schedule; `new_session_per_run` creates a fresh chat per occurrence. Those modes
take `agentConfig` creation settings. After a reusable chat exists, change its
execution settings in that chat. The schedule editor and MCP summary identify
those settings as inherited rather than displaying stale creation defaults.

## Editing messages and destinations

`scheduled_tasks_update`, HTTP PATCH and the SDK accept `prompt` for a lossless
message edit. All omitted fields remain unchanged. Use `targetSessionId` to move
a schedule to an existing chat; the server preserves message data and account
choices and removes obsolete creation settings atomically. This also works
after a reusable schedule has created its first chat. Existing runs keep their
accepted snapshots.

Supply `expectedExecutionDigest` from the read result to reject an edit based
on an outdated execution configuration. Merged patches also compare their
server-read digest under the database write lock, so a concurrent edit returns
409 instead of being overwritten.

`pinnedAccounts` on an update replaces the complete set of pins; an empty array
unpins every connector, so all of them follow the owner's current accounts.
Omitting the field keeps the pins. Removing a connector also removes its pins.
Pins supplied by the request must be usable now; retained pins are kept even
when their account is gone, so an unrelated edit never fails on a stale pin.
The old `connectionAccounts` field is rejected on schedule requests.

Scheduler synchronization reads the latest saved task while holding a per-task
lock shared with deletion cleanup. A failed synchronization restores the previous
definition only if the task still matches that exact write; it cannot undo a
newer edit or pause. Compensation commits before releasing the synchronization
lock, so queued writers observe the restored state. Remote timeouts remain errors with potentially unknown
outcomes, not confirmation that Temporal accepted the change.

If a move removes Variable Sets or changes the environment, it returns a
409 with `details.code = scheduled_target_access_change` and the affected
identifiers. Review the destination's attachments, then retry with
`adoptSessionSettings: true` and the reviewed `expectedExecutionDigest` to accept
the change. Nothing changes on the rejected attempt.

`scheduled_tasks_get` is a bounded projection, not a replacement document.
For exact complete message text, request `promptOffset: 0`, then follow
`prompt.nextOffset` with the returned `executionDigest` as
`expectedExecutionDigest`. Offsets are UTF-16 units and must be used unchanged;
pages preserve whitespace, Unicode and legacy text exactly. Restart the read if
the task changes. Ordinary edits do not require recovering creation history.

## Changing model defaults without replacing configuration

`scheduled_tasks_update`, the scheduled-task HTTP PATCH route and the SDK's
`updateScheduledTask` accept `agentConfigPatch: { prompt?, model?, reasoningEffort? }`.
Supply at least one field. Omitted fields stay unchanged; null, unrelated fields,
and combining the patch with a full `agentConfig` replacement are rejected.
The server merges against the complete stored configuration. Never reconstruct
`agentConfig` from `scheduled_tasks_get`: that tool returns bounded text and
previews, not a lossless replacement document.

The ordinary owner, model-policy, Variable Set and connection-authority checks
still apply. A model-only patch does not refresh tool/account selections, rewrite
prompts or metadata, unpause the task, or change its schedule. A concurrent
execution-config edit returns 409 instead of overwriting it; read the task again
before deciding whether to submit a new update.

These are defaults for newly created sessions. An `existing_session` target or
an already-created `reusable_session` retains its own model and reasoning;
the MCP receipt warns about that. Change that session separately when intended.
Already-admitted occurrences retain their frozen execution settings. Text in a
launcher prompt naming a child model is also unchanged; editing that instruction
is a separate content change, not an effect of changing these defaults.

## Who owns a schedule

A schedule's owner is the person who saved it: a managed human (or a verified
external owning user) whose own accounts its runs resolve. A machine principal
is never an owner. Schedules created by an organization or workspace API key,
the deployment's configured key, a delegated service, or a delegated bearer
are ownerless: the key stays the audited creator (`createdBy` with
`kind: "service"`), runs use service authority with workspace accounts only,
and anyone holding `scheduled_tasks:manage` (including the key) may change or
run them.

Canonical code: `packages/core/src/domain/scheduled-task-access.ts`,
`packages/db/src/scheduled-task-access.ts`, the routes in
`apps/api/src/routes/scheduled-tasks.ts`, and the Schedules pages
(`apps/web/src/components/schedules/`, with the notices in
`schedule-access-notices.tsx`).

## Who can see a schedule

A schedule has an audience, like a chat: **Workspace** (everyone in the
workspace, the default) or **Only me**. The form asks "Who can see it" when the
organization allows Only me chats.

- A Workspace schedule is visible to every member. Only its owner changes or
  runs it (unchanged).
- An Only me schedule is visible only to its owner, through every surface: the
  HTTP API, the agent's schedule tools and Slack all use the one core gate in
  `packages/core/src/domain/scheduled-task-audience.ts`. To anyone else it is
  indistinguishable from a schedule that does not exist.
- Each run of an Only me schedule creates an Only me chat owned by the schedule's
  owner. The run rechecks that the owner is still an active member who may
  create Only me chats; if not, the run fails closed instead of creating a
  shared chat.
- A schedule that posts into an Only me chat, saves to the owner's personal
  knowledge, or runs on the owner's own (personal) Connected Machine is always
  Only me. Widening it is refused while that holds. See
  [Connected Machines](connected-machines.md) for how each run re-proves the
  owner's access to the machine.
- Unless the organization turns it off under Security, workspace admins see
  other people's Only me schedules only as a summary:
  the owner, how often it runs, its status, when it last ran and what its runs
  cost over the last 30 days. Never its name, message, settings or runs. An
  admin can pause one (`POST
  /v1/workspaces/:workspaceId/scheduled-tasks/private-summaries/:taskId/pause`);
  only the owner can resume it. The list is
  `GET /v1/workspaces/:workspaceId/scheduled-tasks/private-summaries`.
  With admin visibility off the list is empty and admins cannot pause them,
  exactly like private chats. A deployment can require it to stay on with
  `OPENGENI_PRIVACY_ADMIN_SCHEDULE_SUMMARIES_REQUIRED=true`.

The audience is not execution configuration: like the name and status it is
left out of the execution digest, so changing it never invalidates accepted
runs. Migration 0720 adds it; schedules that already posted into an Only me
chat or wrote to personal knowledge become Only me, which only narrows who can
see them. Migration 0721 adds the admin summary read and pause.

## One plan, two uses

`computeScheduledTaskAccessPlan` answers one question: what would this task's
owner get by saving it again now? The drift projection is that plan's
difference from the stored task, and the refresh writes exactly that plan. They
cannot disagree.

The plan, for an agent-turn task (connector-source tasks are excluded):

- **Connectors** (only when runs create sessions from the task's own tools:
  `new_session_per_run`, or `reusable_session` before its session exists).
  A task that follows the workspace defaults (`agentConfig.toolPolicy` with
  mode `workspace_default`) never lacks one: each run gets them as they are
  then, so it reports no `missingConnectors` and a refresh adds none. For a
  task with a fixed list, connectors the task already has are kept,
  connectors the workspace no longer sets up are dropped
  (`unavailableConnectors`), and the workspace defaults a new schedule gets
  (`sessionToolDefaults`, or the enabled capability default) are added
  (`missingConnectors`). A refresh never removes a connector the owner
  deliberately kept.
- **Pinned accounts** are reported, never changed. A pin whose account can no
  longer be used is listed in `unavailableAccounts`; runs go ahead without that
  connector (or are skipped when the task sets `pinnedAccountsRequired`) until
  a person pins another account or unpins it. A refresh never adds, replaces or
  removes pins, because a pin is a person's explicit choice. Unpinned connectors
  need nothing: each run already uses the owner's current accounts.
- **Opengeni tools** (agent-created tasks only). A human- or API-created task
  has no creator policy and already follows the deployment default at each run.
  For a frozen creator policy, the default tools it lacks are reported
  (`missingOpenGeniTools`) and added. Permissions stay least-privilege: a
  frozen permission is kept only while the refreshing person holds it, and the
  only permissions added are the ones the newly added tools need
  (`FIRST_PARTY_TOOL_AUTHORIZATION` in `apps/api/src/mcp/first-party-tool-permissions.ts`),
  within the default worker set and that person's grant. A refresh therefore
  never lifts a deliberately narrowed permission boundary (for example a
  read-only operator session that created the task) for tools the task already
  had, and every added permission follows a tool the drift report names. The
  creator session policy (agent access, scope, memory) is never rewritten.

Existing-session tasks, and reusable tasks whose session already exists, follow
that session's tools, so only a reusable task's pins are part of the plan.

## Who sees drift

`GET /v1/workspaces/:workspaceId/scheduled-tasks` and `.../:taskId` add a
read-only `policyDrift` object for a viewer who can act on the task: its owner
(an entitled authenticated subject, never a delegated bearer or agent attempt),
or anyone with `scheduled_tasks:manage` for a task without an owner. Other
viewers receive the task unchanged. `policyDrift` is `null` when nothing would
change. It is advisory: a failure to compute it omits the field and never fails
the read. `canRefresh` is true only for a signed-in person holding
`scheduled_tasks:manage`.

## Which accounts a run would use

The same reads add a read-only `accountPlan` for the same viewers, so nobody
else sees the owner's account labels. For each connector that takes a
connected account (host-supplied connectors and the special first-party
surfaces are not listed), it says:

- `mode`: `default` (each run uses the owner's current accounts) or `pinned`
  (a person chose the accounts; runs use only those).
- `accounts`: the accounts a run would use if it started now, with their label
  and whether each is the owner's own (`personal`) or a workspace account
  (`shared`). Empty when none can be used; the run then goes without that
  connector.
- `unavailablePins`: pinned accounts that can no longer be used.

It is computed at read time from the owner's live connections with the same
resolution a run uses, so what it shows is what the next run gets. For a
schedule that posts into an existing chat it follows that chat's connectors
and is always `default`. Nothing in it is stored. Like `policyDrift` it is
advisory: a failure omits the field and never fails the read.

The schedule page shows it as an Accounts section. A pin that can no longer
be used offers "Use current accounts", which sends the remaining pins with the
page's `expectedExecutionDigest`; a working pin changes only in the editor.

## The refresh is a new explicit human action

`POST /v1/workspaces/:workspaceId/scheduled-tasks/:taskId/refresh-access` with
`{ "executionDigest": "<the task head the person reviewed>" }`:

- Only a signed-in person may call it: the canonical managed cookie session (or
  a verified external owning user) or the exact built-in local human. The check
  is on the request's provenance stamp, not the grant's shape. API keys,
  services, delegated bearers and agent attempts receive 403. There is no MCP
  tool for it; an agent cannot refresh a schedule.
- Only the task owner may refresh an owned task, exactly as for any edit (403).
- A task whose execution digest no longer matches returns 409, checked again
  under the row lock, so a person never re-freezes something they did not
  review.
- The refresh goes through the ordinary owner update path: Variable Set
  permission, model policy, target validation, the owner's current accounts,
  personal-resource re-authorization under that person, and a new authority
  revision and execution digest. It therefore never grants more than the same
  person could by editing the task.
- It changes neither the schedule nor its status, so the Temporal schedule is
  untouched. An up-to-date task returns unchanged without a new revision.
- Runs already admitted keep their accepted execution. Recovery re-reads only
  the creator session policy, which the refresh never changes.

This is the one writer of the creator policy's tools and permissions after
create. Opengeni tools do not follow the workspace defaults at each run: that
would conflict with the creator-policy freeze. Connectors do (see below); they
carry no permissions of their own and each run resolves the owner's accounts.

The optional `leaveOut` (`{ connectors?, openGeniTools? }`) names workspace
default connectors and Opengeni tools the person wants kept off this schedule.
The plan then neither adds them nor, for an Opengeni tool, the permissions it
would need. It only narrows what the refresh adds; it never removes anything
the task already has, and an unknown tool name is refused (400).

## Which connectors a run gets

A schedule that posts into an existing chat has no connectors of its own: each
run uses the chat's connectors and the owner's current accounts. A reusable
schedule whose session exists likewise follows that session.

A schedule that starts its own session follows the workspace's default
connectors at each run, the way a new chat does, when it is created without
choosing tools. It stores `agentConfig.toolPolicy`:

```json
{ "mode": "workspace_default", "excludedMcpServerIds": ["notion"] }
```

Each run gets the defaults as they are when it starts, minus
`excludedMcpServerIds`, plus the connectors listed in `agentConfig.tools`.
Nothing about the defaults is copied into the schedule, so a connector the
workspace makes a default later reaches the next run, and one it removes stops
being used. The schedule editor saves a person's choices this way: defaults
they turn off become exclusions, and connectors outside the defaults become
`tools`.

Creating a schedule with a list of `tools` and no `toolPolicy` gives it exactly
that list. An edit that does not name a `toolPolicy` keeps the one the
schedule has, so replacing `agentConfig` (for example with the tools a read
returned) never turns the defaults into a fixed list. Agents cannot set
`toolPolicy`; they omit `tools` to follow the defaults or list them to fix
them. Knowledge syncs never follow the defaults.

Migration 0740 moved schedules whose list nobody chose to follow the defaults:
those an agent or a service created, which start their own session. Their
saved tools stayed as additions, so no run lost a connector. A list a person
created directly was kept exactly.

## Auditing account and connector choices

Every create, edit or access refresh that changes a schedule's pinned
accounts, `pinnedAccountsRequired` or connector choices (whether it follows
the workspace defaults, which defaults it excludes, and its listed connectors)
writes one `audit_events` row in the same transaction: action
`scheduled_task.account_choices_changed`, target `scheduled_task`, the acting
subject, and metadata with the `operation` (`create` or `update`), the
caller's `principalKind` (a person, an agent, an API key or a service) and,
for each changed choice, its value before and after. Only server and
connection ids are recorded, never credentials or account labels. Edits that
change no choice record nothing.

## Keeping defaults off in the drift view

A person may deliberately leave a default connector or Opengeni tool off a
schedule, and drift would otherwise name it forever. The schedule's page offers
"Keep without these" next to missing defaults. It records, in that browser, the
missing connectors and Opengeni tools for the task head the person looked at
(its `executionDigest`); the page then hides them, and "Refresh access" sends
them as `leaveOut`, carrying the choice to the refreshed head. A new default
that appears later is shown again, and editing the task any other way (a new
head) is a fresh look. A pinned account that can no longer be used, a connector
the workspace removed, and a connector without an account are never hidden.

The choice is a display preference: the server keeps reporting the drift and
nothing about what a run may use changes. It is per browser because Opengeni has
no per-person preference store for it; a durable per-person choice would need
its own column and is left for later.

## Failed-access notice

Opengeni has no general notification channel for this. Product email is
reserved for sign-in, recovery and invitation lifecycles, and the Slack bot can
only message people who linked their Slack identity. So the owner's signal is
in-app:

- **Durable fact.** When a run's own scheduled turn
  (`session_turns.scheduled_task_run_id`) records `tool.auth_needed` (for
  example `personal_authority_unavailable` or `missing_connection`), that is
  the failure. A person's later follow-up in the same session, goal
  continuations and other runs of a reusable session are not attributed to the
  run. An agent's suggestion to set up a new capability or custom connector is
  not a failure and is left out.
- **Per run.** `GET .../scheduled-tasks/:taskId/runs` adds `accessFailures`
  (connector, reason and count) for a viewer who can act on the task.
- **A pinned account is gone.** When an account a person pinned can no longer
  be used (for example the owner revoked that connection, or the workspace no
  longer sets up its connector), the run goes ahead without that connector and
  never substitutes another account. The run records the dropped pins in
  `degradedAccounts`. A personal GitHub repository pin cannot be dropped
  without changing the task's repositories, so that occurrence is refused, as
  is every occurrence of a task with `pinnedAccountsRequired`; a refused
  occurrence creates no run. The attention list checks each active task with
  pins using the same account plan the drift uses and lists it with
  `unavailableAccounts` (the connectors) and a null `runId`/`firedAt`. It
  clears once the account is usable again or a person pins another account or
  unpins it. This is read-time only: no stored notice.
- **Attention list.** `GET .../scheduled-tasks/attention` lists the active
  schedules that need attention, one item per schedule: the latest run with a
  turn failed closed on access (`runId`, `failures`), a pinned account can no
  longer be used (`unavailableAccounts`), or both. Schedules that cannot start
  are listed first. For a person, it lists the schedules they own; for an
  organization key, configured key or service that manages schedules, the
  schedules without an owner (nobody else is told about those, so members are
  not notified for every service task). A later run that could use every
  connector clears a run failure; pausing the schedule removes it. Each item
  carries the task's `executionDigest`, so the web can tell a new blocked
  notice (after a refresh or edit) from one the owner has already seen.
- **Where the owner sees it.** A dot on the Schedules item in the navigation
  rail, shown until the owner opens Schedules (the "seen" marker is per
  browser; the durable truth stays on the server). A new failed run is a new
  notice; so is a blocked account on a new task head. The schedule's row in
  the list shows a "Needs attention" badge (or, for its owner, "Access out of
  date" when only drift remains). The schedule's own page shows the notice
  ("New runs of this schedule cannot start" or "The last run could not use a
  connector"), and each run row shows its failure text. The page offers
  "Refresh access" when the plan would change something.

A proactive channel (email or a Slack message from the bot) would need its own
durable delivery outbox and is not part of this change.

## Runs waiting on a person

A dispatched run whose own turn stops for a tool approval or a structured
question stays `dispatched` (its lifecycle settles only when the turn
finishes), but it is no longer indistinguishable from a running one:

- `listScheduledTaskRuns` (`GET .../scheduled-tasks/:taskId/runs`, the SDK and
  the `scheduled_task_runs_list` tool) adds `awaitingHuman: { since, expiresAt }`
  to such a run. It is a read-time projection of the run's turn; nothing is
  stored.
- The attention list includes an active schedule whose latest run waits on a
  person, with the same `awaitingHuman`, for the same viewers as the other
  notices (the owner, or schedule managers for an ownerless schedule). The web
  shows it on the Schedules item and on the schedule's page. The session itself
  carries the usual `session.requiresAction` event.
- `since` is when the current unanswered wait began. A person's decision
  restarts it; the scheduler's own timeout decisions do not.

`agentConfig.approvalTimeoutSeconds` (60 s to 30 days; default none: wait
indefinitely) bounds that wait. It is frozen in each run's accepted execution.
The session workflow sleeps on a durable Temporal timer until `expiresAt`
(behind the `session-scheduled-human-wait-timeout-v1` patch; no polling), then
the scheduler answers through the same acceptance boundary a person uses: the
first pending tool approval is rejected (never approved) with the message
"Rejected automatically by the scheduler: ...", or the first pending structured
question is skipped, as a `system` decision with a deterministic
`system:scheduled-approval-timeout:` client event id. It re-derives the deadline
from durable facts and never acts early; a person answering first wins.
Further pending approvals of the same wait are rejected one by one as they
surface, since their deadline has already passed. Skill-review questions need a
person and are never timed out. An agent still can never decide an approval.
