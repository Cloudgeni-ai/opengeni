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

## Effective resolution and governed evaluation

`resolveWorkspaceLearningPolicyEffectiveMode(snapshot, source)` is the stable routing seam:

1. It accepts an immutable `WorkspaceLearningPolicySnapshot`, never a mutable current head.
2. It matches one exact `{kind,id}` override.
3. It returns the override mode when present; otherwise it returns the workspace mode with `inherited: true`.
4. Its receipt retains the snapshot id/hash, policy revision identity, activation version, and source reference.
5. `workspaceLearningPolicyRouterContext(effectiveMode)` projects the exact immutable `{mode,snapshotId,revisionId}` object consumed by the canonical router. A snapshot with no active revision uses the explicit stable `workspace-learning-policy:default-off:v1` revision sentinel, preserving the deterministic `off` policy instead of misrepresenting it as a missing snapshot.

Migration `0268_governed_learning_decision_receipts.sql` adds the first inert evaluator over this frozen policy state. It accepts only an exact live attempt, its accepted policy snapshot, and one workspace-scoped proposal/claim/supporting-evidence lineage. Before recording a verdict it rechecks current Task-note or scoped-Document authority, the latest review, expiry/staleness, conflicts, and a platform-owned confidence floor. The result is one immutable, content-free receipt with exact IDs, hashes, versions, bounded facts, and canonical reason order.

`automatic` is only an eligibility verdict. The evaluator has no destination-writer call, head privilege, activation grant, or reusable capability. Exact retries converge on the original receipt; a changed operation input, another task tree, another subject, or another proposal for the same accepted snapshot conflicts or denies. The receipt table is FORCE RLS with no direct runtime DML, and the app role can call only the target-schema-local SECURITY DEFINER evaluator.

Migration `0269_governed_learning_activation_controller.sql` adds the separate,
inert controller that may consume one final `automatic` receipt. It revalidates
the accepted attempt and initiating human, current policy head and source
override, current evidence ACL/lifecycle/hash, latest Knowledge review, inactive
proposal, conflict facts, and destination CAS before invoking the destination's
native lifecycle. A service actor performs the mutation while the causal human
remains explicit; neither identity substitutes for the other. Immutable
content-free activation and undo receipts bind every source/destination hash,
version, event, and effective boundary.

Undo is compensation, not history deletion. It succeeds only while both the
automatic Knowledge review and destination head remain current. Knowledge adds
an append-only revocation review, Preference uses its native deactivation
lifecycle, and instruction policy restores the exact prior head. A first policy
activation can therefore return to no head through the service-only
`automatic_deactivate` event; accepted-turn event reconstruction observes that
later null boundary. Human activation and rollback semantics are unchanged.
Destination ownership remains:

- Documents/RAG: evidence and retrieval only.
- Memory: facts, decisions, observations, and history.
- Preference Registry: procedures, preferences, working methods, and skill-like guidance; descriptors are bounded and full content is retrieved only on demand.
- Charter/instruction policy: bounded always-composed mandatory context.

## Explicit non-goals

The controller deliberately does not implement:

- automatic Memory or company-profile mutation;
- Personal or Organization scope expansion;
- explicit session command/tool integration;
- runtime prompt composition or automatic snapshot installation;
- Workspace State/API/SDK/UI administration;
- Slack notification delivery.

Canonical policy code: `packages/contracts/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy.ts`, `packages/db/src/workspace-learning-policy-schema.ts`, and migration `0199_workspace_learning_policy.sql`. Canonical evaluator code: `packages/contracts/src/governed-learning-evaluator.ts`, `packages/core/src/domain/governed-learning-evaluator.ts`, `packages/db/src/governed-learning-evaluator.ts`, and migration `0268_governed_learning_decision_receipts.sql`. Canonical activation code: `packages/contracts/src/governed-learning-activation.ts`, `packages/core/src/domain/governed-learning-activation.ts`, `packages/db/src/governed-learning-activation.ts`, and migration `0269_governed_learning_activation_controller.sql`.
