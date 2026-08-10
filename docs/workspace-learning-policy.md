# Workspace Learning Policy

The workspace learning-policy domain controls whether evidence from one source may produce a durable **derived change**. It does not decide which durable authority receives a write and it never turns source evidence into prompt authority by itself.

## Modes

Each active revision has one workspace mode:

- `off`: evidence may still be ingested and retrieved, but no durable derived change is authorized.
- `suggest`: downstream evaluation may create an auditable inactive draft for review.
- `automatic`: downstream evaluation may request activation through the destination authority's existing governed lifecycle.

An exact source may override the workspace mode with `off`, `suggest`, or `automatic`. `inherit` exists only at request boundaries: canonical revisions omit inherited entries, so persisted override arrays are sparse, unique, bounded, and byte-ordered by `{kind,id}`.

Source references are provider-neutral `{kind,id}` identities. They may identify a scoped-knowledge source, a connector source, a session-derived evidence lane, or another future source without coupling the policy to one connector table. Current ACL, lifecycle, deletion, revocation, initiating-human, and destination-scope checks remain the responsibility of the evidence and destination authorities.

## Durable lifecycle

Migration `0199_workspace_learning_policy.sql` adds four FORCE-RLS tables:

- `workspace_learning_policy_revisions`: immutable workspace mode plus sparse source overrides and a canonical policy hash.
- `workspace_learning_policy_heads`: one current revision per workspace. The ordinary runtime role has read-only access; a trigger rejects inserts, updates, and deletes outside the lifecycle function.
- `workspace_learning_policy_activation_events`: immutable, idempotent activation/rollback evidence with exact old/new revision identities, actor, reason, activation version, and timestamp.
- `workspace_learning_policy_snapshots`: immutable accepted-attempt policy state, reconstructed from activation events at the logical turn's immutable `created_at`.

Revision creation does not activate a policy. Activation and rollback require an exact authenticated human actor, expected current revision, expected activation version, and operation fingerprint. A rollback target must have been active previously. Direct head/event writes are not a supported or authorized activation path.

Workspaces without an active revision snapshot deterministically as `off`, with no revision and no source overrides. This default applies only to the future governed derived-learning path; it does not disable existing Memory injection, `memory_search`, `memory_save`, or `memory_correct` behavior.

## Effective resolution and the durable-learning router interface

`resolveWorkspaceLearningPolicyEffectiveMode(snapshot, source)` is the stable routing seam:

1. It accepts an immutable `WorkspaceLearningPolicySnapshot`, never a mutable current head.
2. It matches one exact `{kind,id}` override.
3. It returns the override mode when present; otherwise it returns the workspace mode with `inherited: true`.
4. Its receipt retains the snapshot id/hash, policy revision identity, activation version, and source reference.
5. `workspaceLearningPolicyRouterContext(effectiveMode)` projects the exact immutable `{mode,snapshotId,revisionId}` object consumed by the canonical router. A snapshot with no active revision uses the explicit stable `workspace-learning-policy:default-off:v1` revision sentinel, preserving the deterministic `off` policy instead of misrepresenting it as a missing snapshot.

The canonical durable-learning router may consume this result, but this policy domain does not implement routing. Destination ownership remains:

- Documents/RAG: evidence and retrieval only.
- Memory: facts, decisions, observations, and history.
- Preference Registry: procedures, preferences, working methods, and skill-like guidance; descriptors are bounded and full content is retrieved only on demand.
- Charter/instruction policy: bounded always-composed mandatory context.

## Explicit non-goals

This slice does not implement:

- the canonical durable-learning write router;
- derived-change evaluation or automatic activation control;
- destination Memory, Preference Registry, charter, or policy mutation;
- explicit session command/tool integration;
- runtime prompt composition or automatic snapshot installation;
- Workspace State/API/SDK/UI administration;
- Slack notification delivery.

Canonical code: `packages/contracts/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy-schema.ts`, and migration `0199_workspace_learning_policy.sql`.