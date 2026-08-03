# Workspace Memory Slack publication contract

This document is the canonical contract for the first independently reviewable
Workspace Memory Slack publication slice. The slice defines a pure,
deterministic security and projection
boundary in `packages/core/src/domain/memory-slack-publication.ts`. It does not
persist configuration or deliveries and does not call Slack.

## Source and authority boundary

The evaluator accepts only an explicit `sourceType=workspace_memory` snapshot.
It never accepts a Document, document chunk, scoped-knowledge claim, collection,
prompt, session log, tool result, or connector payload. Organization, workspace,
and immutable initiating-user personal Documents remain governed RAG evidence
under `scoped-knowledge.md`; collections remain optional organization only and
are never an authority or publication boundary.

Within Workspace Memory, publication additionally requires exact account and
workspace equality plus typed `scopeType=workspace` and `audience=workspace`.
User, role, session, ephemeral, legacy, and restricted records fail closed. A
service identity, connection owner, session creator, collection id, label, or
source reference cannot widen that decision.

## Eligibility and noise policy

Nothing publishes by default. A later admin configuration must explicitly set
`enabled=true`. The safe enabled policy is:

- `major` changes requested as `auto` may publish automatically;
- `normal` changes requested as `auto` are downgraded to `review`;
- explicit `review` remains review for enabled major/normal importance;
- `minor` is quiet unless a later admin policy explicitly includes it;
- `never` is always ineligible.

Ordinary create/correct projections require an `active` or `approved`
`kind=decision` memory inside its validity window. Supersession projections
require the old row to be `superseded` and to name the exact replacement. A
correction requires the replacement row to name the exact retired memory. These
rules preserve history rather than silently presenting stale text as current. A
correction or supersession that points to the same memory row fails closed.

Governed-learning notifications remain later scope. They must enter through
their own durable immutable receipts; they cannot be synthesized from a
Document, proposal, prompt, or mutable UI state and are not implemented by this
slice.

## Bounded allowlist projection

The evaluator does not receive raw Memory text. The caller must supply an
explicit bounded share summary plus distribution metadata. The returned
projection contains only:

- workspace id, memory id, and positive memory version;
- created/corrected/superseded change identity and one related memory id;
- occurrence timestamp, importance, and effective `auto|review` mode;
- canonical secret-redacted summary with an explicit truncation fact;
- normalized namespace and a sorted, de-duplicated bounded label subset, only
  when the shared secret redactor leaves every selector unchanged;
- an optional secret-redacted bounded owner label;
- immutable workspace/memory identifiers for a later UI link.

Memory bodies, metadata, source references/excerpts, embeddings, hidden prompts,
connection ids, channel ids, credentials, and raw actor subject ids are not in
the projection type. Recognized credential material in namespace or labels is a
deterministic denial rather than a selector rewrite, and malformed summary,
namespace, or labels input also denies instead of throwing. The final stable
JSON projection is independently bounded to 4 KiB.

## Loop prevention and idempotency

A `slack_derived` origin is always ineligible, preventing a future Slack-derived
knowledge record from recursively publishing its own notification. Eligible
projections receive `memory-slack:v1:<sha256>` over canonical stable JSON. Exact
retries converge; a new memory version, summary, correction target, timestamp,
importance, or effective mode produces a different key.

The key and projection are not themselves an outbox. A later persistence slice
must atomically bind them to workspace-admin configuration, the exact verified
OpenGeni Slack bot connection/channel, prospective enablement generation,
delivery attempts, terminal state, and audit receipts. That later work must
reuse the existing Slack post operation and may not weaken this evaluator.

## Explicitly later slices

- workspace-admin configuration persistence and API;
- immutable publication snapshots/outbox and retry/terminal receipts;
- Slack worker delivery through the verified bot operation;
- review queue, responsive configuration/preview UI, and authoritative links;
- governed-learning receipt integration;
- connector/channel membership handling, release, deployment, and production
  confirmation.
