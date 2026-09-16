# Sender-owned connections

Implementation candidate. This document describes the intended change, not
behavior already available in a release.

## Product contract

An authenticated user's message authorizes the resulting work to use that
user's connected accounts, subject to tool selection and existing deployment
restrictions. No additional conversation consent or shared-results
acknowledgment is required. Conversation visibility controls who can see the
conversation; it does not delegate account access to participants.

The initiating user remains attached to their work through continuations,
retries, and child work. A different participant's message starts work under
that participant's identity. Existing connection resolution and revocation
remain authoritative; do not add a parallel credential or revocation system.

A personal schedule runs as its owner. Only that owner and agents verifiably
acting for the owner may change its executable instructions or configuration.
The owner is derived from authenticated authority, never an arbitrary user id
supplied to a tool. Existing service-owned schedules keep their current behavior.
External-trigger impersonation is outside this change.

Connection setup offers Personal and Workspace ownership. Mail, calendars,
drives and contacts default to Personal; other ordinary integrations default to
Workspace. These are setup preferences, never provider-specific restrictions.
Explicit choices win, and reconnecting preserves the existing ownership.

All connected tools is the default selection policy. Users can explicitly
choose a fixed subset. The interface must distinguish these modes and show
only executable integrations. Built-in tools are labeled separately; their
selection does not imply an account connection.

## Existing implementation to reuse

- `packages/core/src/domain/personal-connection-delegations.ts`: authenticated
  subject and exact-parent-turn derivation, provider matching, and inherited
  work identity.
- `packages/db/src/connection-authority.ts` and the existing accepted-turn
  connection resolver: database ownership, membership, and live-use checks.
- `packages/core/src/domain/scheduled-tasks.ts`: causal creator identity and
  material-update checks. Personal schedule ownership must also cover every
  mutation entry point, rather than only edits that preserve captured grants.
- `inheritConnectedMcpServers` and the workspace default editor: automatic
  versus fixed tool selection already exists on current main.

## Required changes

Replace the mandatory conversation-grant path for ordinary sender-owned
connection use at both admission and runtime. Removing the frontend check
alone cannot work: the database also requires an explicit grant. Retain
existing guarantees for other personal resource kinds. Do not activate the
private-conversation product as a workaround.

Replace composer grant restoration and conversation consent cards with normal
connection setup/status. Avoid introducing a second session visibility object.
Connection setup must remain possible when private conversations are disabled.

Personal schedules need explicit owner semantics and owner-only editing before
they can acquire their owner's connections automatically. Reuse existing task
revision and causal-user fields where their invariants fit. Resolve account
availability for each scheduled execution through the existing resolver.

Review the current catalog projection against the runtime server registry so
unavailable legacy installations cannot be submitted as selected tools.

## Acceptance

- A connected personal account works on its owner's message without consent
  cards, including when private conversations are disabled.
- Two participants cannot use each other's accounts, including forged client
  selection payloads and messages arriving during unfinished work.
- Retries and child work retain the original initiating user.
- Personal schedules can be created by the owner or their active agent;
  another participant cannot change their executable configuration.
- Disconnection prevents subsequent credential resolution using existing checks.
- Automatic tool selection includes newly connected integrations; a deliberate
  fixed subset remains fixed and visibly labeled.
- Unavailable integrations do not appear as runnable choices.
- Ownership defaults never prevent an explicit Personal or Workspace choice;
  reconnecting cannot transfer an existing connection to another owner.
- Actual provider calls are verified separately from simulated authority tests.

## Implementation sequence and cleanup

Deliver one replacement PR with reviewable commits. Use a maintenance cutover,
not permanent old/new authorization lanes. Supersede PRs #2485 and #2508 once
the replacement is reviewable, carrying over useful regressions rather than
their consent implementation.

### 1. Contracts and authenticated execution identity

Make the authenticated initiating user the single source of personal connection
authority for interactive work. Preserve verified embedding identity contracts;
an arbitrary supplied subject id or service attribution is never authentication.
Service work without a verified user receives workspace connections only.

Update REST, SDK, agent tool inputs and runtime contracts together. Remove
ordinary chat and personal schedule `connectionAuthorities` grant payloads.
Reject obsolete fields with a useful client-update error rather than silently
reinterpreting them. Retain account selection where multiple accounts exist;
selection narrows the authenticated user's eligible accounts and grants nothing.
Do not silently choose the newest account when a provider has multiple matches.

Retain immutable accepted-work identity and existing execution receipts. Remove
the requirement for a separate connection-use grant from those records and
their database validators. Replace the historical connection trigger/wrapper
chain with the canonical current implementation in a new migration. Runtime
credential resolution uses that same identity and existing live connection checks.

Trace every admission path: initial message, follow-up, steering, queued inputs,
realtime, retries, parent-to-child work and scheduled occurrences. A foreign
participant's instructions must not be appended to another user's authorized
turn; they become work under their own identity. Approval responses remain
responses to existing work, not identity reassignment.

### 2. Personal schedule ownership

Represent personal versus workspace/service execution explicitly. New schedules
created by a verified human or their current agent default to personal ownership.
Do not overload mutable creator attribution as the owner. The personal owner
cannot change through an ordinary update; copying creates work for the copier.

Use one ownership check across HTTP and agent entry points for update, pause,
resume, delete and manual run. System execution verifies the recorded owner and
uses current eligible connections when each occurrence starts. Editing the target
conversation, tools, prompt or schedule cannot retain a different user's access.
An empty connection selection cannot erase the schedule's ownership rules.

Others may see a shared schedule's existence/results according to existing
visibility rules, but cannot run or edit it as its owner. No new arbitrary
"act as user" parameter or generic impersonation API is introduced.

### 3. Tool selection and account setup

Use one explicit automatic-versus-custom default policy, based on the current
`inheritConnectedMcpServers` implementation. Display "All connected tools" or
"Selected connected tools". Automatic selections follow eligible connections;
custom selections remain a deliberate narrowing. Existing saved subsets migrate
to explicit custom mode rather than silently widening access. Make returning to
automatic mode a normal visible setting.

Use the execution registry for catalog eligibility. Unavailable installations
retain repair/disconnect controls but are excluded from runnable choices.
Refresh and reconcile stale draft selections; preserve the draft and explain
unavailable selections instead of losing the message or submitting stale ids.
Do not weaken API validation to accept arbitrary unknown tool identifiers.

Delete ordinary-chat grant restoration, Use-in-this-conversation controls,
shared-output acknowledgments and their Send blockers. Keep account connection,
reconnection and account selection. Separate built-in tools from connected tools
and remove misleading "actions" terminology from these surfaces. Keep existing
tool approval policy and specialized GitHub repository/Drive destination limits.

### 4. Database cutover and removal

Inventory connection-only grant routes, SQL functions, constraints, columns,
SDK methods, receipt dependencies and clients before migration. Remove obsolete
connection consent entries from common resource-grant routines without changing
document, variable-set, rig or machine authorization. Drop connection-specific
grant structures only after their current consumers are replaced. Preserve
historical audit facts without allowing them to authorize new work.

Stop old API and worker writers before the maintenance migration. Classify the
migration and update schema/release contracts. Migrate active executable records
only where their verified initiating owner is unambiguous; pause unresolved
personal work with an actionable explanation rather than inventing ownership.
Existing workspace/service schedules retain workspace/service semantics, not a
legacy personal-connection bypass. Do not automatically grant historical service
schedules personal credentials.

Resume only the new runtime. Old clients must refresh; obsolete grant requests
fail clearly. Historical migration files remain immutable deployment history,
but retired functions and runtime branches are removed from the resulting schema
and code. No permanent compatibility feature flag or consent fallback remains.

### 5. Verification and delivery

Run authority tests against real PostgreSQL with the restricted application role,
including migration from the prior schema. Exercise HTTP, SDK and agent schedule
mutations, not just helpers. Cover forged ownership, two concurrent participants,
steering, child work, realtime, disconnect, multiple accounts, schedules with zero
initial connections, and attempts to bypass ownership with an empty selection.

Exercise the complete UI: connect, send, tool execution, schedule creation/editing,
automatic defaults, custom defaults, unavailable integrations and preserved drafts.
Use synthetic fixtures in public tests. Validate actual provider calls separately
using private operator configuration; no private account or deployment information
belongs in source, test fixtures, docs, commit messages or PR material.

Keep the native development-launcher repairs in a separate prerequisite commit
so reviewers can distinguish environment repairs from the product change. Run
an authorization/migration and UI review, relevant
tests, typechecks and required repository checks. Publish one generic replacement
PR, then close the superseded PRs with a link to it. Do not claim completion until
the migrated implementation and real tool flow have been verified.
