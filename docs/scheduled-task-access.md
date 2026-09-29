# Scheduled task access: drift, refresh, and failed-access notices

A scheduled task freezes what its runs may use when it is saved:

- its connectors (`agentConfig.tools`);
- the connector accounts it uses (`agentConfig.connectionAccounts`, frozen with
  `connectionAccountsFrozen`), resolved against its immutable owner at each
  fresh occurrence;
- for a task an agent created, the creating session's OpenGeni tools,
  permissions and access policy (the creator policy, migration 0428).

Later workspace changes never reach a task on their own. That is deliberate:
a schedule must not widen itself, and an agent must not widen a narrowed
session through a schedule. The cost is that a task quietly falls behind: a
connector the workspace now gives every new schedule is missing, newer OpenGeni
tools are absent, or the account it chose was disconnected. This page describes
how OpenGeni shows that, how the owner refreshes it, and how the owner learns
that a run could not use a connector.

## Who owns a schedule

A schedule's owner is the person who saved it: a managed human (or a verified
external owning user) whose own accounts its runs resolve. A machine principal
is never an owner. Schedules created by an organization or workspace API key,
the deployment's configured key, a delegated service, or a delegated bearer
are ownerless: the key stays the audited creator (`createdBy` with
`kind: "service"`), runs use service authority with workspace accounts only,
and anyone holding `scheduled_tasks:manage` (including the key) may change or
run them. Before this rule, a schedule created by an API key froze the key's
own subject as its immutable owner; such a schedule has no human revision
authority and every occurrence is refused as a visible failed run
(`scheduled_authority_unavailable`, see
[`scheduled-admission-diagnostics.md`](scheduled-admission-diagnostics.md)).
The same key may still pause, edit, or delete it; recreate it to run it.

Canonical code: `packages/core/src/domain/scheduled-task-access.ts`,
`packages/db/src/scheduled-task-access.ts`, the routes in
`apps/api/src/routes/scheduled-tasks.ts`, and the Schedules pages
(`apps/web/src/components/schedules/`, with the notices in
`schedule-access-notices.tsx`).

## One plan, two uses

`computeScheduledTaskAccessPlan` answers one question: what would this task's
owner get by saving it again now? The drift projection is that plan's
difference from the stored task, and the refresh writes exactly that plan. They
cannot disagree.

The plan, for an agent-turn task (connector-source tasks are excluded):

- **Connectors** (only when runs create sessions from the task's own tools:
  `new_session_per_run`, or `reusable_session` before its session exists).
  Connectors the task already has are kept. Connectors the workspace no longer
  sets up are dropped (`unavailableConnectors`). The workspace defaults a new
  schedule gets (`sessionToolDefaults`, or the enabled capability default) are
  added (`missingConnectors`). A refresh never removes a connector the owner
  deliberately kept.
- **Connector accounts**, per account-backed connector. Chosen accounts that are
  still usable are kept exactly. When a chosen account can no longer be used
  (`unavailableAccounts`), a fresh occurrence of the task is blocked before it
  creates a run, so the refresh attaches every account the owner can use now.
  A frozen connector with no account while one is now available is reported as
  `attachableAccounts`. The Google Drive publication and personal GitHub
  surfaces keep their own account contract and pass through unchanged; a
  blocked occurrence caused by one of them is not reported yet.
- **OpenGeni tools** (agent-created tasks only). A human- or API-created task
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
that session's tools, so only their accounts are part of the plan.

## Who sees drift

`GET /v1/workspaces/:workspaceId/scheduled-tasks` and `.../:taskId` add a
read-only `policyDrift` object for a viewer who can act on the task: its owner
(an entitled authenticated subject, never a delegated bearer or agent attempt),
or anyone with `scheduled_tasks:manage` for a task without an owner. Other
viewers receive the task unchanged. `policyDrift` is `null` when nothing would
change. It is advisory: a failure to compute it omits the field and never fails
the read. `canRefresh` is true only for a signed-in person holding
`scheduled_tasks:manage`.

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
create. Auto-following workspace defaults at each run was considered and
rejected: it would conflict with the creator-policy freeze.

The optional `leaveOut` (`{ connectors?, openGeniTools? }`) names workspace
default connectors and OpenGeni tools the person wants kept off this schedule.
The plan then neither adds them nor, for an OpenGeni tool, the permissions it
would need. It only narrows what the refresh adds; it never removes anything
the task already has, and an unknown tool name is refused (400).

## Keeping defaults off

A person may deliberately leave a default connector or OpenGeni tool off a
schedule, and drift would otherwise name it forever. The schedule's page offers
"Keep without these" next to missing defaults. It records, in that browser, the
missing connectors and OpenGeni tools for the task head the person looked at
(its `executionDigest`); the page then hides them, and "Refresh access" sends
them as `leaveOut`, carrying the choice to the refreshed head. A new default
that appears later is shown again, and editing the task any other way (a new
head) is a fresh look. A chosen account that can no longer be used, a connector
the workspace removed, and a connector without an account are never hidden.

The choice is a display preference: the server keeps reporting the drift and
nothing about what a run may use changes. It is per browser because OpenGeni has
no per-person preference store for it; a durable per-person choice would need
its own column and is left for later.

## Failed-access notice

OpenGeni has no general notification channel for this. Product email is
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
- **Blocked before a run.** When a chosen connector account can no longer be
  used (for example the owner revoked their personal connection), the
  scheduler refuses every fresh occurrence before it creates a run, so there is
  no run and no turn to carry a fact. The same happens to a schedule with an
  owner whose chosen account belongs to a connector the workspace no longer
  sets up. The attention list therefore also checks each active agent task
  that chose accounts with the same account plan the drift uses, and lists it
  with `unavailableAccounts` (the connectors) and a null `runId`/`firedAt`. It
  clears once the account is usable again or the owner refreshes or edits the
  accounts. This is read-time only: no migration, no stored notice. Not
  reported yet: a reusable-session schedule whose live session no longer uses
  a connector the schedule chose an account for (for example, someone turned
  that connector off in the session). The scheduler resolves the reusable
  session's own tool policy and refuses the leftover choice, while the plan
  follows the task's frozen tools, so a refresh does not fix it either; turning
  the connector back on in that session does.
- **Attention list.** `GET .../scheduled-tasks/attention` lists the active
  schedules that need attention, one item per schedule: the latest run with a
  turn failed closed on access (`runId`, `failures`), a chosen account can no
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
