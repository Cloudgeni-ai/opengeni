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

Canonical code: `packages/core/src/domain/scheduled-task-access.ts`,
`packages/db/src/scheduled-task-access.ts`, the routes in
`apps/api/src/routes/scheduled-tasks.ts`, and the Schedules page
(`apps/web/src/routes/schedules.tsx`).

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
  surfaces keep their own account contract and pass through unchanged.
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
- **Attention list.** `GET .../scheduled-tasks/attention` lists the active
  schedules whose latest run with a turn failed closed on access: for a person,
  the schedules they own; for an organization key, configured key or service
  that manages schedules, the schedules without an owner (nobody else is told
  about those, so members are not notified for every service task). A later run
  that could use every connector clears it; pausing the schedule removes it.
- **Where the owner sees it.** A dot on the Schedules item in the navigation
  rail, shown until the owner opens Schedules (the "seen" marker is per
  browser; the durable truth stays on the server), a "Needs attention" chip and
  notice on the task card, and the failure text on each run row. The card
  offers "Refresh access" when the plan would change something.

A proactive channel (email or a Slack message from the bot) would need its own
durable delivery outbox and is not part of this change.
