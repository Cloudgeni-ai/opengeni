# Workspace instruction policies

Workspace instruction policies provide a dedicated, auditable backend control
plane for versioned workspace charters and policies. They are intentionally
separate from `workspace_model_policies`: instruction governance does not choose
models, providers, tools, integrations, or Linear behavior.

This document describes the backend-first slice. It establishes authoritative
storage, contracts, API, and SDK operations. It does **not** compose active
revisions into agent prompts or change session/runtime behavior.

## Targets and normalization

Each immutable revision addresses exactly one target:

- one workspace charter: `kind=charter`, `scope=global`, `roleKey=null`;
- one global workspace policy: `kind=policy`, `scope=global`, `roleKey=null`;
- a role policy: `kind=policy`, `scope=role`, with one normalized role key.

Role keys are identifiers, not display names. Contract ingress applies Unicode
NFKC normalization, trims the value, lowercases it, replaces whitespace runs
with `-`, and collapses repeated `-` characters. PostgreSQL accepts only the
already-normalized `[a-z0-9._-]` identifier form, up to 64 characters. A nullable
role key is valid only for global targets.

## Immutable revisions and provenance

Migration `0130_workspace_instruction_policies.sql` adds dedicated
`workspace_instruction_policy_*` storage:

- `workspace_instruction_policy_revisions` is append-only revision history;
- `workspace_instruction_policy_heads` is the mutable active-head projection;
- `workspace_instruction_policy_activation_events` is append-only audit history.

Revision numbers come from one monotonic PostgreSQL sequence. The server computes
the SHA-256 hash of the exact UTF-8 content, and PostgreSQL independently checks
that the stored hash matches. A revision may identify a superseded revision only
inside the same workspace and exact target. Runtime writers receive only
`SELECT` and `INSERT` on revisions and activation events; PostgreSQL mutation
guards reject updates or deletes even through a privileged application path.

Every revision records its creator, creation time, optional superseded revision,
and one provenance source:

- `human`;
- `onboarding`;
- `knowledge_proposal`;
- `legacy_import`.

The optional provenance source identifier is evidence about where the content
came from. The legacy-import operation does not trust a caller-provided label: it
uses the fixed source `workspaces.agent_instructions`.

## Activation, conflicts, and rollback

At most one head may exist for each charter, global policy, or normalized role
policy target. Partial unique indexes enforce those cardinalities. Head and event
triggers require the workspace, target, revision number, and content hash to
identify the exact immutable revision.

Activation and rollback are one transaction. The transaction locks the
workspace row before reading a head, which serializes both initial activation
when no head exists and later changes. The caller supplies the revision it
expects to be current (`null` for a first activation). A stale expectation
returns the typed `WORKSPACE_INSTRUCTION_POLICY_CONFLICT` response with the
current head; it never silently overwrites another activation.

Each successful change advances the target's activation version and atomically
writes the head plus an immutable event containing:

- activation or rollback type;
- actor subject and bounded reason;
- old revision id, number, and content hash, when a head existed;
- new revision id, number, and content hash;
- activation version and timestamp.

Rollback never mutates history. Its target must be a revision that was previously
active for the same target, and rollback creates a new activation event and a new
head version.

## HTTP and SDK surface

The API and `OpenGeniClient` expose:

- list revision history, active heads, and activation events;
- get one revision;
- create a draft;
- import the stored legacy override as a draft;
- diff two revisions of the same target;
- activate a revision;
- roll back to a previously active revision.

The routes live below
`/v1/workspaces/:workspaceId/instruction-policies`. List, get, and diff require
`workspace:read`. Draft creation, legacy import, activation, and rollback require
`workspace:admin`.

## Legacy compatibility and inactive workspaces

Migration `0129` performs no backfill. Creating or importing a draft does not
create an active head.

When a workspace has no instruction-policy activation head, this backend slice
does not participate in prompt composition at all. Existing runtime behavior is
therefore preserved exactly:

- a stored `workspaces.agent_instructions` override remains the workspace
  instruction source;
- a workspace without that override continues to use the deployment/default
  persona template behavior;
- no default template is copied into revision storage.

Legacy import reads only the stored `agent_instructions` value and creates one
inactive global charter draft with `legacy_import` provenance. It never imports
or materializes a deployment default, never activates the draft, and never
rewrites the legacy field.

## Isolation and deliberate non-goals

All three tables carry account/workspace keys, `FORCE ROW LEVEL SECURITY`, and
the canonical `workspace_isolation` policy. The application role can mutate only
heads; revision and activation evidence are append-only.

This slice deliberately does not implement:

- worker/runtime prompt composition or active-head reads;
- per-session role selection or session behavior changes;
- web UI;
- workspace memory, knowledge ingestion, or automatic proposal ingestion;
- model, tool, integration, or Linear enforcement;
- downstream runtime integration, governance UI, or authoring workflows.

Canonical implementation: `packages/contracts/src/workspace-instruction-policies.ts`,
`packages/db/src/workspace-instruction-policies-schema.ts`,
`packages/db/src/workspace-instruction-policies.ts`,
`packages/db/drizzle/0130_workspace_instruction_policies.sql`,
`apps/api/src/routes/workspace-instruction-policies.ts`, and
`packages/sdk/src/workspace-instruction-policies.ts`.