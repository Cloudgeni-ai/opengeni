<!-- docs-refs: record -->

> **Point-in-time design record — 2026-07-31.** Written against the tree at
> authoring time; paths and names may have moved. Code wins. See
> [`../hierarchical-memory.md`](../hierarchical-memory.md) for the current
> contract.

# Hierarchical memory database/domain foundation

## Decision

Extend the existing `knowledge_memories` authority instead of creating a
parallel graph, agent-profile, or preference store. The bounded first slice is
database/domain only:

- typed workspace/user/role/session/ephemeral scopes;
- hierarchical namespaces and normalized labels;
- typed relationship edges where they express durable provenance or
  applicability;
- immutable creator facts and append-only apply/revert evidence;
- deterministic normalized plans, operation ids, plan hashes, row locks, and
  version compare-and-swap;
- exact account/workspace/subject/role/session FORCE-RLS boundaries.

No API, SDK, MCP, worker retrieval/injection, prompt, automatic-learning, or UI
surface is part of this record.

## Why extend the current table

The existing row already owns sanitized memory text, search indexes,
embeddings, statuses, validity, and supersession compatibility. Moving those
fields into a new hierarchy would create two competing knowledge authorities
and require a cross-store cutover before any scoped behavior could be trusted.
An additive typed selector keeps one memory identity while allowing later
contract/runtime slices to opt in deliberately.

## Authority decisions

Free-form provenance is not authorization. A memory's creator is a frozen
subject or service fact, and an exact-attempt operation re-derives its initiator
from the active turn/attempt rows. Session creation ownership, source strings,
and caller-supplied metadata never become human authority. The old nullable
creator-session link remains non-authoritative and may be cleared only by its
foreign-key cleanup when a session is deleted; the creator kind, identifier,
and bounded context remain frozen.

Role is a scoped applicability dimension, not a replacement for workspace or
subject authorization. Its key comes from persisted session metadata and must
already be normalized. Direct callers cannot attach role or session context.
Services have workspace reach only; a missing human subject cannot satisfy a
user selector through SQL null semantics.

Historical scopes that cannot be mapped exactly become `legacy` and are hidden
from the runtime role. There is no self-asserted admin GUC. Database owners can
still inspect rows for operator audit through PostgreSQL's normal owner or
superuser authority.

## Relationship decisions

The foundation uses a small typed edge vocabulary rather than arbitrary edge
names. `conflicts_with` and `related_to` are symmetric; all other edges are
directed. Correction/supersession edges point replacement → retired record.
Edges are soft-retired because deletion would destroy the state required for a
deterministic revert and an intelligible audit chain.

## Lifecycle decisions

Apply and revert are database functions because table privileges alone cannot
atomically combine exact authority validation, endpoint visibility, row locks,
CAS checks, mutations, and immutable evidence. The runtime role gets SELECT on
the edge/event tables and EXECUTE on these functions, but no direct mutation
privilege. The database recomputes the domain's compact, recursively sorted JSON
hash before mutation, so the runtime role cannot forge a plan identity. An
attempt-bound idempotent retry also has to retain the exact session, turn,
attempt, and execution generation.

Audit state is structural and secret-safe. It never copies memory text, source
references, metadata, or embeddings. A revert is a new event referencing the
apply event; history is never rewritten. The same immutable actor must revert,
and intervening memory or edge-version changes fail with a serialization
conflict even if an edge was removed and later reactivated.

## Deployment decision

This is a maintenance migration, not a rolling expansion. The visible-text
dedup identity changes from workspace-global to typed-scope-local, and old
writers do not understand typed selectors. Activation therefore fences live
runtime sessions twice, takes an exclusive memory-table lock, and forbids old
writers from restarting after commit.

## Separation from adjacent authorities

The structured preference registry remains the only active preference
authority. Workspace instruction policies remain the charter/policy authority.
This memory foundation does not activate either system, synthesize policy, or
feed new state into prompts. Those separations prevent a generic knowledge edge
or a legacy `kind = preference` row from silently becoming executable
instruction authority.

## Recovery and current-main reconciliation — 2026-08-01

The retained source was recovered from Modal archive generation 405 rather
than reimplemented. The immutable source was commit
`b28b1a4f6f62cd74301fc72275bdfde1a2d72183`, tree
`a2c55cc88d1f33abada99cc21a39513569e9499a`, based on
`f413e6cd849b37de02602bf9ea2900673b7235fb`. A Git bundle exported from the
archive snapshot had SHA-256
`abeb61d19cc119b9316ac30bde44f094968c597f9e5956c409fad4ea97422b06`
and reproduced that commit and tree exactly.

Archive generation 405 also retained a two-file worktree patch applied after
that commit and before the source owner was fenced. The 1,650-byte patch had
SHA-256
`7204993c9ecb043a970a2b44cb7a8f9d9921c3d341a6fe6b5537bcefc0d911f8`;
it corrected the pre-cutover writer fence plus the shared-PostgreSQL fixture and
skip-warning identifiers. Those archive-only fixes were carried forward at the
reconciled `0151` ordinal.

The recovery was applied to current main
`d4d89600e6d333237f4cda767fde34c3a9d38467`. The live migration ledger already
ended at `0150_slack_task_interactions.sql`, so the preserved hierarchical-memory
migration and its PostgreSQL proof moved from ordinal `0146` to `0151`. The SQL
bytes were otherwise unchanged and retain SHA-256
`6fa855d1a09e65088bf2cc63b9cf45673b41b9efa9426590b839c2b79a4aa335`.

The original recovered patch contained 35 hunks across 17 paths. Every retained
hunk was accounted for below against that current-main base:

| Path | Hunks | Reconciliation record |
| --- | ---: | --- |
| `AGENTS.md` | 1 | Extends the current Workspace Memory V1 invariant with the recovered typed-selector, FORCE-RLS, immutable-lifecycle, and no-inferred-authority guardrails. |
| `docs/README.md` | 1 | Adds the canonical hierarchical-memory document to the current docs map. |
| `docs/architecture.md` | 2 | Adds the bounded memory-foundation overview; updates the current DB map to 98 Drizzle tables, 97 FORCE-RLS tables, 91 full-DML, five read-only, seven read-insert, 103 runtime-DML tables, and the then-current `0151` maintenance boundary while preserving all current-main migration and Slack/artifact text. |
| `docs/design/hierarchical-memory-foundation-2026-07-31.md` | 1 | Adds the point-in-time authority/design record and this complete recovery manifest. |
| `docs/hierarchical-memory.md` | 1 | Adds the then-current operational contract with the reconciled `0151` anchors. |
| `packages/db/drizzle/0151_hierarchical_memory_foundation.sql` | 1 | Adds the recovered maintenance migration byte-for-byte under the next free ledger ordinal. |
| `packages/db/src/index.ts` | 6 | Exports the governance API and makes visible-text uniqueness detection accept both the legacy and typed-scope index names, including PostgreSQL cause metadata. |
| `packages/db/src/memory-domain.ts` | 2 | Adds typed scopes, namespaces, labels, relationship canonicalization, deterministic apply/revert plans, and stable plan hashes; the import hunk switches to the hash-capable crypto import. |
| `packages/db/src/memory-governance-schema.ts` | 1 | Adds the relationship and immutable lifecycle-event Drizzle schema with the reconciled migration comment. |
| `packages/db/src/memory-governance.ts` | 1 | Adds exact direct/attempt authority resolution plus apply/revert function adapters. |
| `packages/db/src/provision-roles.ts` | 1 | Grants only SELECT on governance ledgers and EXECUTE on the target-schema-local apply/revert functions. |
| `packages/db/src/runtime-posture.ts` | 2 | Adds relationship/event tables to FORCE-RLS and read-only privilege classes while retaining current-main Slack/artifact classifications. |
| `packages/db/src/schema.ts` | 4 | Adds typed selector, namespace, label, creator, and scoped-dedup columns/indexes to `knowledge_memories`; re-exports the governance schema under the reconciled `0151` comments. |
| `packages/db/test/memory-governance-domain.test.ts` | 1 | Adds deterministic unit coverage for normalization, applicability, edge ordering, operation identities, and revert identities. |
| `packages/db/test/migration-0151-hierarchical-memory.test.ts` | 1 | Adds the recovered genuine PostgreSQL/FORCE-RLS multi-subject proof with only ordinal/path fixture strings changed from `0146` to `0151`. |
| `packages/db/test/runtime-posture.test.ts` | 4 | Reconciles exact current-ledger counts to 97/11/91/5/7/5/103 and both protected unions to 108. |
| `scripts/release-schema-contract.test.ts` | 5 | Extends the governed ledger filter through `0151`, appends its maintenance classification and content hash, and records the 144-file ledger count, latest-migration assertion, and schema-contract SHA-256 `bbf75f5e22e96f0debdea344f96e87409dee9a54348e854cb73fe6e18fadfdb7`. |

No API, SDK, MCP, worker retrieval/injection, prompt composition, automatic
learning, UI, release, deployment, or historical PR integration was added
during reconciliation.

Before merge, current main advanced to
`9a1e72a420f5c7b21024df22d94ad437bfe53c55` and allocated
`0151_slack_delivery_backoff.sql`. The final branch therefore moves the memory
migration and PostgreSQL proof to the next free ordinal, `0152`. Correctness
review also repaired relationship-revert CAS evidence so a revert now locks and
checks both endpoint memory versions as well as the edge version. That bounded
repair changes the final migration SQL SHA-256 to
`bf3c4ee84a4d9bce7503607d3f34c7046890e5daddeaf0f8390cbd06fb468cdc`.
The combined 145-file migration ledger ends at `0152` with schema-contract
SHA-256
`8a8cfe345f4d749ce10b102fa4326a4d6293fa8e71807daed59f6c856f5949d2`.
