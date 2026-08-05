# Workspace instruction policies

Workspace instruction policies provide a dedicated, auditable backend control
plane for versioned workspace charters and policies. They are intentionally
separate from `workspace_model_policies`: instruction governance does not choose
models, providers, tools, integrations, or Linear behavior.

The backend remains the sole charter/policy authority. Migration
`0157_session_policy_role_snapshots.sql` adds the runtime delivery layer: an
immutable session policy-role binding, accepted-turn policy snapshots, and
deterministic composition with the existing structured preference registry.
It does not create another policy, preference, memory, document, or skills
store.

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

Migration `0168_workspace_instruction_policy_operation_receipts.sql` adds
immutable request fingerprints for natural-convergence replay. Migration
`0169_workspace_instruction_policy_onboarding_proposals.sql` adds immutable
onboarding evidence that references exactly one inactive authoritative revision.

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

## Draft-only onboarding proposals

An onboarding proposal is evidence for one suggested charter, global policy, or
normalized role policy. It does not create another prompt, Memory, preference,
Documents, or knowledge authority. One transaction:

1. locks the workspace and checks the exact target's active-head baseline;
2. fences the operation ID against every instruction-policy mutation kind;
3. converges the natural `(source id, source version, target)` identity;
4. creates a normal inactive instruction-policy revision with `onboarding`
   provenance and the immutable proposal UUID as its provenance source ID; and
5. appends the immutable proposal evidence with bounded source/version,
   confidence basis points, actor, baseline, request fingerprint, and timestamp.

The caller must supply both the expected current revision ID and activation
version (`null` and `0` when no head exists). A changed head returns
`WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_STALE`. Reusing the same
source version for the same target with different content, confidence, or
baseline returns `WORKSPACE_INSTRUCTION_POLICY_ONBOARDING_PROPOSAL_CONFLICT`.
Empty and oversized content use the typed `..._EMPTY` and `..._OVERSIZED`
responses. Exact operation replay returns the original proposal; changed input
under that operation ID returns `WORKSPACE_INSTRUCTION_POLICY_OPERATION_REUSED`.

The proposal table is append-only, uses `FORCE ROW LEVEL SECURITY`, and receives
only `SELECT`/`INSERT` runtime privileges. PostgreSQL validates that its linked
revision has the same tenant, target, actor, content fingerprint, and exact
`onboarding` provenance. Proposal creation never writes a head or activation
event, and there is intentionally no proposal activation endpoint.

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

They also expose list/create onboarding proposals below
`/v1/workspaces/:workspaceId/instruction-policies/onboarding-proposals`. Listing
requires `workspace:read`; creating an inactive proposal requires
`workspace:admin`.

The routes live below
`/v1/workspaces/:workspaceId/instruction-policies`. List, get, and diff require
`workspace:read`. Draft creation, legacy import, activation, and rollback require
`workspace:admin`.

## Session role binding and accepted-turn snapshots

`CreateSessionRequest.policyRole` binds one normalized policy role to the
session. The value is immutable after creation and is deliberately separate
from human workspace membership roles and hierarchical-memory role selectors.
When the binding is absent, runtime keeps the compatibility fallback to a
normalized `session.metadata.role`. An invalid present fallback fails closed to
no role policy; metadata such as `membershipRole` is never consulted.

Each accepted logical turn has one immutable `created_at` boundary. Every exact
execution attempt for that turn installs or replays one
`workspace_instruction_policy_snapshots` row containing at most:

1. the active workspace charter;
2. the active global policy;
3. the active policy matching the session policy role.

The snapshot is reconstructed from immutable activation events at the accepted
turn boundary and records exact revision IDs, hashes, activation versions,
activation timestamps, bounded provenance, role source, canonical ordering,
and one aggregate hash. A policy activated after a turn was queued cannot move
that turn; a recovery attempt for the same logical turn resolves the same
accepted state. A newly accepted human turn, goal continuation, system turn, or
compaction receives the then-current state.

Snapshots use `FORCE ROW LEVEL SECURITY`, ownership-parent foreign keys that
cascade only with account/workspace/session/turn/attempt lifecycle deletion,
immutable-history triggers, and SELECT-only application table privileges. One
target-schema-local security-definer function validates the exact active
session/turn/attempt/generation and is the only runtime insert path.

## Runtime composition and precedence

For an exact attempt, the worker combines the policy snapshot with the existing
preference-registry descriptor snapshot. Automatic model context follows this
order after the non-bypassable platform CORE:

1. organization preference descriptors;
2. workspace charter;
3. workspace global policy;
4. workspace preference descriptors;
5. immutable initiating-user preference descriptors;
6. matching session role policy;
7. session and exact-turn instructions;
8. selected skills and repository/tool substrate;
9. bounded retrieved memory/knowledge.

Preference entries are sanitized descriptors only. Full content remains behind
the exact attempt's authorized retrieval handle. Documents, imports, Slack
messages, transcripts, connectors, knowledge results, RAG evidence, and memory
proposals are not prompt-policy authorities and never enter this block unless an
authorized activation first creates an immutable policy or preference revision.

The complete governance block is deterministic and fails closed above 131,072
UTF-8 bytes. Evidence includes snapshot IDs/hashes, revision IDs/hashes,
ordering, role source, descriptor counts, truncation, provenance, and retrieval
handles without copying private full preference content.

## Legacy compatibility and inactive workspaces

Migration `0130_workspace_instruction_policies.sql` performs no backfill.
Creating or importing a draft does not create an active head.

When an exact attempt has no active policy revision and no active preference
descriptor, structured governance does not participate in prompt composition.
Existing runtime behavior is therefore preserved byte-for-byte:

- a stored `workspaces.agent_instructions` override remains the workspace
  instruction source;
- a workspace without that override continues to use the deployment/default
  persona template behavior;
- no default template is copied into revision storage.

If preference descriptors are active but no charter/policy is active, the
legacy workspace/deployment persona remains the instruction template and the
descriptor block is appended after CORE. Once any charter or policy is active,
the structured policy authority replaces the legacy workspace
`agent_instructions` override for that attempt; the deployment persona still
supplies the generic runtime substrate beneath CORE.

Legacy import reads only the stored `agent_instructions` value and creates one
inactive global charter draft with `legacy_import` provenance. It never imports
or materializes a deployment default, never activates the draft, and never
rewrites the legacy field.

## Isolation and deliberate non-goals

All instruction-policy tables carry account/workspace keys, `FORCE ROW LEVEL
SECURITY`, and the canonical `workspace_isolation` policy. The application role
can mutate only heads; revision, activation, receipt, snapshot, and onboarding
proposal evidence is immutable or append-only according to its exact privilege
class.

This slice deliberately does not implement:

- automatic proposal ingestion or source connectors;
- workspace memory or knowledge ingestion;
- model, tool, integration, or Linear enforcement;
- proposal review/approval state or proposal-specific activation authority;
- broader Workspace State source inventory, export, or governance authoring
  workflows beyond the existing policy backend.

Canonical implementation: `packages/contracts/src/workspace-instruction-policies.ts`,
`packages/db/src/workspace-instruction-policies-schema.ts`,
`packages/db/src/workspace-instruction-policies.ts`,
`packages/db/drizzle/0130_workspace_instruction_policies.sql`,
`packages/db/drizzle/0157_session_policy_role_snapshots.sql`,
`packages/db/drizzle/0168_workspace_instruction_policy_operation_receipts.sql`,
`packages/db/drizzle/0169_workspace_instruction_policy_onboarding_proposals.sql`,
`apps/api/src/routes/workspace-instruction-policies.ts`, and
`packages/sdk/src/workspace-instruction-policies.ts`, with the bounded admin
composer in `apps/web/src/routes/workspace-state.tsx`, plus runtime composition in
`packages/runtime/src/workspace-governance.ts` and
`apps/worker/src/activities/agent-turn.ts`.
