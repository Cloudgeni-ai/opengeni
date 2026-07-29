# PR #722 → Workspace State reconciliation

> **Point-in-time design record — 2026-07-29.** This records the reconciliation
> of PR #722 at exact head `5f72c1d43667562ebd2de9c8e2b6d911f14ffaed`
> against `main` at `cf5a07b55e8a193f42946640c7df377353728649`.
> It is not the current product contract. See
> [`../workspace-state.md`](../workspace-state.md) and
> [`../workspace-instruction-policies.md`](../workspace-instruction-policies.md)
> for canonical current behavior.

## Decision

PR #722 is not a viable authority or runtime change. Its `workspace_charters`
table, active synthesis state, background sweep, MCP charter mutation, and
prompt injection conflict with the founder-authorized architecture delivered by
PR #696. No #722 commit was cherry-picked and the source PR was not
force-rewritten.

The useful portion is structural: a read-only map of existing knowledge,
freshness, deterministic gaps, and a sparse console presentation. Those ideas
are adapted into the additive Workspace State inventory using the current
Documents, Memory, instruction-policy, SDK, authorization, and console APIs.

Authoritative baselines inspected:

- PR #696 exact head
  `954bf24da6e633293308ad06db762eb3f89747a9`, merged as
  `17a6bb6c342e32b4f02954fabd857aebc1645ff2`: sole charter/policy backend;
- PR #631 exact head
  `029a66e5601ec5c6527fd279e5a9be591ad7481c`, merged as
  `6dd18463199e14c4e266722bc7dbd0b253fada62`: current Documents/RAG and
  subject-visible document baseline.

## File-by-file salvage map

“Adapt” means reimplement the useful concept on current `main`; it does not mean
copying #722's implementation. “Replace” means use an already-authoritative
surface instead of adding the changed file's proposed authority.

| # | PR #722 path | Decision | Reconciliation |
| ---: | --- | --- | --- |
| 1 | `.env.example` | **Reject** | No feature flag, model setting, schedule, or synthesis configuration is needed for an on-demand GET projection. |
| 2 | `apps/api/src/app.ts` | **Adapt** | Register only the additive `workspace-state` GET route on current `main`. |
| 3 | `apps/api/src/mcp/server.ts` | **Reject / replace** | Reject `charter_propose_update` and agent charter writes. Existing Documents/Memory MCP and instruction-policy HTTP APIs remain authoritative; no Workspace State MCP mutation is added. |
| 4 | `apps/api/src/routes/knowledge-bank.ts` | **Adapt** | Replace refresh/mutation semantics with `routes/workspace-state.ts`: one authorized, no-store GET returning bounded aggregates. |
| 5 | `apps/web/src/App.tsx` | **Adapt** | Add `/workspaces/:workspaceId/state`; do not mount a Knowledge Bank editor. |
| 6 | `apps/web/src/components/rail/workspace-nav.tsx` | **Adapt** | Add a read-only Workspace State destination using existing navigation conventions. |
| 7 | `apps/web/src/lib/events.ts` | **Reject** | No background-sweep or synthesized-charter events exist in the accepted slice, so no timeline projection is added. |
| 8 | `apps/web/src/routes/knowledge.tsx` | **Adapt** | Preserve sparse cards, freshness, gaps, and state handling in `routes/workspace-state.tsx`; remove refresh mutation, charter history/editor, lock, and synthesis controls. |
| 9 | `apps/web/src/routes/workspace-settings.tsx` | **Replace with authoritative existing API** | Workspace State deep-links to existing settings. It does not add charter/sweep toggles or duplicate policy administration. |
| 10 | `apps/web/src/types.ts` | **Replace with authoritative existing API** | Use the SDK's dedicated `WorkspaceStateResponse`; do not create route-local Knowledge Bank authority types. |
| 11 | `apps/worker/src/activities.ts` | **Reject** | No background inventory or synthesis activity is registered. |
| 12 | `apps/worker/src/activities/agent-turn.ts` | **Reject** | No generated charter block or Workspace State data enters normal or compaction prompts. A later runtime-composition slice owns that behavior. |
| 13 | `apps/worker/src/activities/knowledge-bank.ts` | **Reject** | AI/heuristic purpose, goal, gap, and charter synthesis is outside this slice and cannot create active policy. |
| 14 | `apps/worker/src/index.ts` | **Reject** | No worker registration or task queue change. |
| 15 | `apps/worker/src/workflows.ts` | **Reject** | No Temporal workflow export. |
| 16 | `apps/worker/src/workflows/knowledge-bank-sweep.ts` | **Reject** | Replace the sweep concept with a user-requested, read-only HTTP projection that writes nothing. |
| 17 | `docs/architecture.md` | **Adapt** | Document the additive inventory and its authority/runtime fences; do not document Knowledge Bank as a control plane. |
| 18 | `packages/config/src/index.ts` | **Reject** | No enable flag, synthesis model, or sweep interval. |
| 19 | `packages/contracts/src/index.ts` | **Adapt** | Export a bounded `WorkspaceStateResponse` only; reject `workspace_charters`, sweep requests, and mutation contracts. |
| 20 | `packages/db/drizzle/0132_knowledge_bank.sql` | **Reject** | No migration. `workspace_charters` and `knowledge_bank_state` would duplicate authority and persist active synthesis. |
| 21 | `packages/db/src/index.ts` | **Replace with authoritative existing API** | Reuse `listKnowledgeMemories`, `getWorkspace`, and the existing instruction-policy functions without adding Knowledge Bank exports or writes. |
| 22 | `packages/db/src/knowledge-bank.ts` | **Reject / replace** | Reject charter CRUD, state, locking, sweep persistence, and runtime block generation. Read projection uses existing DB/Documents APIs and pure aggregation. |
| 23 | `packages/db/src/runtime-posture.ts` | **Reject** | No tables or privileges are added. |
| 24 | `packages/db/src/schema.ts` | **Reject** | No parallel charter or synthesis-state schema. |
| 25 | `packages/documents/src/index.ts` | **Replace with authoritative existing API** | Reuse `listDocumentBases` and subject-aware `listDocuments`; do not alter the Documents authority. |
| 26 | `packages/documents/src/knowledge-bank.ts` | **Reject** | No document-to-charter synthesizer. Topics, status, source kind, and freshness are aggregated structurally. |
| 27 | `packages/documents/test/knowledge-bank.test.ts` | **Adapt** | Preserve structural map/gap test intent in pure sanitized projection tests; reject synthesis expectations. |
| 28 | `packages/runtime/src/index.ts` | **Reject** | No prompt provider, generated instruction block, or runtime composition change. |
| 29 | `packages/sdk/src/client.ts` | **Adapt** | Add `getWorkspaceState(workspaceId)` GET only; no refresh, charter mutation, or sweep SDK methods. |
| 30 | `packages/sdk/src/index.ts` | **Adapt** | Export read-only Workspace State types. |
| 31 | `packages/sdk/src/types.ts` | **Adapt** | Preserve the useful response-model idea in a dedicated zero-dependency `workspace-state.ts` mirror, not a Knowledge Bank write model. |
| 32 | `packages/sdk/test/client-coverage.test.ts` | **Adapt** | Cover the stable GET route in a focused SDK test; no mutation-route coverage is accepted. |
| 33 | `packages/testing/src/settings.ts` | **Reject** | No sweep/model/config defaults are required. |
| 34 | `test/integration/api.integration.ts` | **Adapt** | Preserve RBAC and response-shape intent in focused API authorization, route-discipline, contract, and projection tests; reject sweep, mutation, and prompt-injection integration cases. |

## Accepted slice

The accepted implementation is limited to:

- strict, bounded response contracts and a zero-dependency SDK mirror;
- `workspace:read` endpoint authorization and independent
  `documents:search` knowledge gating;
- subject-visible bounded SQL document aggregates plus a bounded newest Memory sample;
- policy-head and latest-revision metadata without bodies or provenance IDs;
- explicit current read-time truth and `not_captured` policy-snapshot truth;
- deterministic, non-persisted gap codes;
- read-only console cards, deep links, loading/empty/error/permission states;
- focused security, bounds, route, SDK, and UI tests;
- canonical architecture and operator documentation.

## Deferred or prohibited

Runtime composition, preference storage, source/fact schema work, connectors,
policy activation/mutation UI, background synthesis,
and any new charter authority remain outside this change. PR #722 remains a
source of design concepts only until its status is resolved by its owning human
workflow.