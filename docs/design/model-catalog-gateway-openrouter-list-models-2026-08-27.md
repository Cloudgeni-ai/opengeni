# Implementation specification: catalog source, workspace providers, OpenRouter rails, and `list_models`

Status: implementation specification captured on 2026-08-27.

Scope revision on 2026-08-31: OpenRouter is now also a workspace-managed peer
to Vercel AI Gateway. The deployment-managed `openrouter/*` rail remains intact;
the additive workspace rail uses `workspace-openrouter/*`, an encrypted
workspace key, provider-qualified custom-model rows, workspace-paid external
billing, and matching HTTP/UI/SDK lifecycle. Statements below that previously
excluded workspace OpenRouter are superseded by this revision.

Implementation correction on 2026-08-28: migration 0389 is maintenance-only.
Although its tables are additive, it changes OpenGeni's exact runtime-posture
table/grant contract, so already-running pre-0389 processes become unready after
commit. The rolling-migration requirements in the original specification are
superseded by the drained procedure in `docs/deployment.md`.

Repository observation at capture time: this checkout already contained
`0364_workspace_learning_policy_snapshot_lock_order.sql`. The migration was subsequently
renumbered against the eventual PR base to
`0389_model_catalog_and_gateway_custom_models.sql` with
`bun run migration:renumber --next`. The original next-free-ordinal guidance below is retained as
part of the supplied specification.

## 1. Goal

One supported-catalog source (code/env, or one deployment DB row), workspace-admin custom AI
Gateway and OpenRouter slugs, a deployment-managed OpenRouter `:free` rail on OpenGeni's key, a
separate workspace-managed OpenRouter rail, and an agent tool that returns one text list of models
this workspace can use right now, with optional free-text notes per ID.
Catalog membership, enablement, and billing stay three systems.

## 2. Intent

Supported catalog means which product IDs exist (code/env, or the singleton row when toggled),
plus, per workspace and provider, slugs the admin typed for Vercel AI Gateway or OpenRouter.

Enabled means existing policy, connections, and key readiness. It is not stored on catalog rows.

Billing has two separate facts: upstream settlement/credential attribution and the cost exposed to
the workspace. Provider kind can derive the former; the deployment explicitly defines the latter.
The `list_models` cost must not be inferred from provider identity or from what the deployment pays
upstream. Billing policy is not stored on catalog membership rows.

- Local/self-host: today's `getSettings()` (env plus code constants). Default.
- Managed: `OPENGENI_MODEL_CATALOG_SOURCE=database` reads one row. No boot reseed. No Settings UI.
  An operator script writes the row.
- Custom provider: type an exact Vercel AI Gateway or OpenRouter slug. Product IDs are
  `workspace-gateway/<slug>` and `workspace-openrouter/<slug>`. No capability form and no
  `/models` scrape.
- Managed OpenRouter: `OPENGENI_OPENROUTER_API_KEY` injects curated `:free` IDs for every
  workspace on the deployment rail. The workspace rail uses its own encrypted key and billing.
- Agent tool: flat selectable list plus optional notes. Not cheap/intelligent sections.

`TurnExecutionPolicyV1` already freezes the accepted turn. Do not add a second freeze.

## 3. Decisions

- Layers stay separate. Default source is `code`.
- Database mode performs a live read of the singleton, or uses a TTL of at most a few seconds if a
  hot path is proven. Fail closed if missing or invalid. Never overwrite the row from code.
- Keys stay in env even in database mode. No keys in the document.
- Custom means Vercel AI Gateway or workspace OpenRouter. Curated Gateway routes stay pinned;
  provider custom slugs are unpinned and use the reviewed provider-specific generic envelope.
- OpenRouter v1 is curated `:free` only. Reserved provider ID: `openrouter`. Host JSON must not
  declare that ID.
- OpenRouter billing is a reserved derived kind, internal and not a host-JSON kind: deployment API
  key plus `metering: external`. It is not API-key to credits. This describes upstream settlement
  and credit-debit behavior; it does not intrinsically make the product-facing cost `free`.
- `list_models`: empty args, one UTF-8 string, always-visible local function. Notes are optional
  per-ID free text on the catalog document.
- `docs/model-providers.md` is updated in the same change.

## 4. Non-goals

- Gateway/OpenRouter `GET /models`.
- First-party Anthropic/Google or paid deployment-managed OpenRouter membership.
- Changing Codex/SuperGrok overlays or model policy, except admitting stored provider custom
  `workspace-gateway/*` and `workspace-openrouter/*` IDs.
- AA, Pareto, scored ranking, JSON tool results, or cheap/intelligent sections.
- Per-workspace notes table.
- Baking the list into `Agent.instructions`.
- Deployment admin UI.
- Image, video, or realtime catalogs.
- New picker rails.
- Changing `TurnExecutionPolicyV1`.
- A tool that switches this session's model. It does not exist today; do not invent it here.

## 5. Review findings: blockers to treat as specification

These were wrong or missing in earlier drafts and are now decisions.

- The next migration is not `0362`. Head on the referenced branch was
  `0363_organization_recovery_custody.sql`. New SQL was the next free ordinal (`0364_...` unless
  main moved, then `bun run migration:renumber --next`). See the current-checkout correction at the
  top of this document.
- `getSettings()` is env-only and synchronous. It must stay that way. Database mode is a separate
  async overlay, `resolveCatalogSettings(db, envSettings)`, used at every catalog/admission site.
  Do not make `getSettings()` read Postgres. Missing one site means the API can show a model the
  worker cannot resolve.
- `projectClientModel` would label OpenRouter as OpenGeni. Today anything with
  `credentialSource.kind === "deployment"` and `mechanism === "api_key"` becomes
  `source: "opengeni"` and provider `OpenGeni`. OpenRouter must omit the optional legacy closed
  `source` field for same-major compatibility while exposing provider `openrouter` and its own
  provider label. The picker rail stays External through existing billing
  (`metering: external`, `upstreamPayer: deployment`). Extend `ClientModel.source`.
- `cost: free` is a deployment-defined workspace-facing price, not an OpenRouter property and not
  an inference from `upstreamPayer`, `metering`, provider kind, or upstream price. A deployment may
  mark OpenRouter or any other product model free regardless of what it pays behind the scenes.
  Closed output words remain `free`, `credits`, `subscription`, and `workspace`; the deployment
  billing policy determines `free` versus `credits`, while connected-subscription and Your Gateway
  models retain their truthful ownership labels.
- Notes break a line if they contain newlines or the field separator. Zod requirements: at most 500
  characters, no `\n` or `\r`, and no `|`. Render with `|` separators. Reject on the document; do
  not truncate at render time.
- This tool does not change the current session model. `session_create` and the human picker consume
  IDs. The first line is `Current: <this session's product id>`. The description says this
  explicitly.
- Do not copy `nested_agent_depth_configuration`'s env reconcile. That pattern overwrites from env
  and is forbidden here.
- Do not add `openrouter-free` to the host `RegistryProviderKind` enum. Inject it in code after
  `parseModelProvidersJson`. Host JSON that uses ID `openrouter` or a reserved Gateway ID fails
  boot. The internal resolved kind is code-only; `registryBilling` and
  `registryCredentialSource` handle it exhaustively and never default.
- Starter `:free` slugs must be tool-capable. OpenGeni turns need function calling. Ship one or two
  reviewed instruct `:free` IDs with capabilities that include tools. If a working slug cannot be
  named at implementation time, ship the rail with an empty model table (key set, zero models)
  instead of a text-only model. Tests pin the constant, not live OpenRouter.
- "Always available" applies only to deployment-managed OpenRouter membership when the deployment
  key is set. The separate workspace OpenRouter rail requires its workspace connection. Policy can
  still hide either rail. Say that in docs.
- Usage settlement is already correct with `metering: external` because `externallyBilled` skips
  `calculateModelUsageCostMicros`. Do not add dummy pricing to make credits work.
- Rename the tool `list_models`. `model_guidance` is leftover band terminology.

## 6. Assumptions

Four seams:

- A: catalog source.
- B: custom Gateway and workspace OpenRouter.
- C: managed OpenRouter.
- D: `list_models` plus `modelNotes`.

Environment variables:

- `OPENGENI_MODEL_CATALOG_SOURCE=code|database`, default `code`.
- `OPENGENI_OPENROUTER_API_KEY`, optional.

The deployment document contains an explicit `defaultModel`, the built-in allow-list, registry
providers, curated Gateway table, curated OpenRouter `:free` slugs, and
`modelNotes: { [productId]: string }`. Omission of `defaultModel` retains schema-v1 compatibility by
using the first built-in model. It contains no keys, default request headers/query, billing,
enabled flags, or band objects. Authenticated registry transports inherit their complete request
metadata and credentials from the matching host declaration after the database provider's kind,
base URL, and wire API/profile match.

The deployment's workspace-facing model-cost policy is a separate billing input. It determines
which deployment-catalog product IDs render as `free` versus `credits` independently of provider
identity and upstream settlement. Its exact code/env and managed-database representation must be
defined before implementation without putting billing onto catalog membership rows.

Overlay call sites that must use `resolveCatalogSettings` in database mode; complete this list in
the PR if another caller appears:

- `GET /v1/config/client`.
- `buildWorkspaceModelCatalog`.
- Session create/send/steer admission (`canonicalConfiguredModel` plus policy).
- Worker claim plus `resolveTurnExecutionPolicyV1` and
  `assertTurnExecutionPolicyMatchesConfigV1`.
- `list_models` implementation.

Custom input is a provider upstream ID. Product ID is `workspace-gateway/` or
`workspace-openrouter/` plus the exact slug. Collision with a curated product ID for that provider
returns 422; the two workspace providers and deployment `openrouter/*` do not collide.

Custom `ConfiguredModel` uses the reviewed conservative capability builder for its provider.
Gateway keeps its Responses-oriented generic envelope; OpenRouter uses Chat/text/function-calling.
Both are runtime records, not a user-defined capability form.

Request fence behavior:

- Curated slugs keep `only`/`order` and Kimi pairing.
- Configured custom slugs do not throw and receive no pin.

Authorization:

- List custom: `workspace:read`.
- Add/remove custom: `workspace:admin`.

The custom table uses FORCE RLS. It has no seed. It is not stored in `workspaces.settings` or
`workspace_model_policies`.

Migration activation is maintenance-first. Stop every API and worker, apply the schema with the
explicit application-role drain fence, and restart only the new binary in code mode. Then upsert a
semantically equivalent database document and converge every API and worker on database mode
before adding database-only membership. Drain or fence accepted turns before removals,
executable-definition changes, or free/credits changes. No backfill. Use the next free ordinal
after the current head.

### `list_models` contract

- Local function, not MCP.
- Args `{}`. Extra keys rejected.
- Input is this turn's workspace catalog, using the same selectable gates as the picker: existence,
  credential readiness, and policy. It also receives `modelNotes` and the current session model ID.
- Output is one UTF-8 string, never JSON.

Example:

```text
Current: gpt-5.6-sol
- openrouter/acme/model:free | Acme | free | Good for bulk drafts. Not for careful refactors.
- gpt-5.6-luna | GPT-5.6 Luna | credits
- gpt-5.6-sol | GPT-5.6 Sol | credits | Use when the task is actually hard.
```

- One line per selectable model, in catalog/picker order. Append a note only when present.
- Zero selectable models produces `No models are available in this workspace.` and still includes
  `Current:` if the session has a model.
- Line shape is always `id | label | cost`, optionally followed by `| note`.
- Never include capabilities, windows, prices, scores, aliases, upstream IDs, URLs, keys, or
  `definitionVersion` on a line.
- Always-visible: add `list_models` to `ALWAYS_VISIBLE_BASE_TOOL_NAMES` and the matching lists in
  `AGENTS.md`, `docs/architecture.md`, and `docs/model-providers.md`. This is an intentional cache
  prefix change. The schema stays empty.
- Starter notes are optional prose on a few IDs, not an enum.
- No workspace notes table.
- Custom Gateway and OpenRouter slugs appear when selectable and receive no automatic note.

### OpenRouter contracts

- `api: chat`.
- `wireProfile: openai`.
- `baseUrl: https://openrouter.ai/api/v1`.
- Generic dispatch.
- Public `HTTP-Referer` and `X-Title` headers are allowed.
- Deployment product ID is `openrouter/<upstream>`, preserving `:free`; credential source is the
  deployment key and billing is deployment/external with deployment-defined `free|credits` cost.
- Workspace product ID is `workspace-openrouter/<upstream>`; credential source is the encrypted
  workspace connection and billing is workspace/external.
- Both use generic dispatch. Workspace custom slugs are admitted through provider-qualified
  custom-model storage and receive the reviewed Chat/text/function-calling envelope.
- No paid deployment-managed OpenRouter membership and no OpenRouter `/models` discovery.

## 7. Codebase facts

- Catalog owner: `packages/config/src/index.ts` (`configuredModels`,
  `configuredRegistryProviders`, `gatewayRegistryProvider`, and overlays).
- Built-in: `OPENGENI_OPENAI_MODEL` plus `OPENGENI_OPENAI_ALLOWED_MODELS`.
- Extra: `OPENGENI_MODEL_PROVIDERS_JSON`; `credentialSource` and `billing` are `z.never()`.
- Curated Gateway: `OPENGENI_GATEWAY_MODELS` when
  `OPENGENI_VERCEL_AI_GATEWAY_API_KEY` is set, or through
  `withWorkspaceGatewayCatalogProvider`.
- Codex/SuperGrok are overlays, not env JSON. OpenRouter has separate deployment-managed and
  workspace-managed overlays with distinct product/provider identities.
- The picker already has an External rail through `billingClassForModel`.
- `canonicalConfiguredModel` already admits any `workspace-gateway/*` at the HTTP edge; the worker
  still needs a `ConfiguredModel`. `normalizeVercelGatewayRequestBody` throws unless the slug is in
  `OPENGENI_GATEWAY_MODELS`.
- `GET /v1/config/client` is the public static catalog. `GET .../model-catalog` adds readiness and
  policy.
- Invalid registry JSON fails boot.
- Default workspace policy is unrestricted (`null` means all). Allowlists can hide OpenRouter.
- External metering skips credit pricing through `externallyBilled`.
- The closest singleton patterns are `nested_agent_depth_configuration` and `host_export_config`.
  Copy their posture, not env overwrite behavior.

## 8. Map

| Area | Path |
| --- | --- |
| Catalog | `packages/config/src/index.ts` |
| Client projection | `apps/api/src/model-catalog.ts` (`projectClientModel`) |
| Request fence | `packages/runtime/src/model-provider-request-policy.ts` |
| Admission | `packages/core/src/domain/sessions.ts` |
| Worker claim | `apps/worker/src/activities/agent-turn/claim.ts` |
| Picker | `packages/react/src/model-policy.ts` |
| Contract | `packages/contracts/src/index.ts` (`ClientModel.source`) |
| First-request tools | `packages/runtime/src/lazy-tool-transport.ts` |
| Agent build | `apps/worker/src/activities/agent-turn/agent-build.ts` |
| Schema contract | `scripts/release-schema-contract.test.ts` (three sites, no hash-ladder edit) |

```text
ENV getSettings()
  -> [database mode: resolveCatalogSettings(db)]
  -> configuredModels()
  -> overlays (Codex / xAI / workspace Gateway + custom rows)
  -> client config / workspace catalog / admission / claim / list_models
  -> MultiProviderModelProvider
  -> Gateway fence (curated pin vs unpinned custom)
```

## 9. What to follow and what not to copy

Follow:

- No billing on documents.
- Overlays, not global mutation.
- Video split between catalog and enablement.
- Secret-safe projection.
- Maintenance migration plus the three-site schema contract and explicit runtime-role drain.
- ConfigMap, then Secret.

Extend:

- Gateway provider accepts custom rows.
- Request fence splits curated from unpinned.
- OpenRouter injects as a sibling.
- `projectClientModel` plus `ClientModel.source`.
- `list_models` joins the first-request set.

Do not:

- Put identity into policy/settings.
- Scrape `/models`.
- Add another turn freeze.
- Add unproven UX.
- Add bands.
- Make `getSettings()` query the database.
- Add reserved kinds to host JSON.

## 10. Layers

### A. Catalog source

```text
code      -> getSettings() + code OpenRouter table
database  -> singleton document + same Zod; keys still env
```

Table: `deployment_model_catalog` with a singleton, JSONB document, version, and `updated_at`.
NON-RLS or no direct DML; application role has SELECT only. It is not in
`RUNTIME_FULL_DML_TABLES`.

Operator flow: `bun run upsert` after Zod validation. Document it in
`docs/model-providers.md` and `docs/deployment.md`. Local remains `code`.

### B. Custom workspace providers

Table: `workspace_gateway_custom_models` with account, workspace, provider discriminator,
`upstream_model_id`, optional label, actor, `retired_at`, and timestamps. FORCE RLS. Active slug and
operation uniqueness include the provider. DELETE retires rather than destroys the row: new
selection excludes it, accepted/existing execution may retain it, and re-adding the same slug
creates a fresh generation so stale mutations cannot affect its successor. The runtime bounds each
provider/workspace pair to 100 active slugs and 1,000 retained generations; retirement cannot
reclaim history while accepted turns or existing sessions may still depend on it.

HTTP: `GET`/`POST`/`DELETE /v1/workspaces/:id/gateway-custom-models` and the parallel
`/v1/workspaces/:id/openrouter-custom-models` surface.

Reject empty, oversized, whitespace, curated collision, and duplicate values.

Overlay custom rows through `withWorkspaceGatewayCatalogProvider`. Worker claim loads custom rows
with the Gateway key.

UI: one input next to the Gateway card.

### C. Gateway request policy

- Curated: `only`/`order`, plus Kimi pairing on the known Kimi slug.
- Configured custom: no throw and no pin.
- Anything else: throw.

### D. `list_models`

`modelNotes` lives on the catalog document. Resolve selectable rows, notes, and a `Current:` line.
Notes do not appear in the picker.

### E. Managed OpenRouter

Key set means inject `openrouter` and curated slugs. Key unset means absent from today's catalog.
There is no connection. `GET /v1/config/client` includes them when the key is set. Policy can hide
them.

## 11. Milestones

One PR if reviewable. Otherwise:

- M1: unpinned fence, custom table/API/UI, overlay, and edge 422. Source remains code.
- M2: database source, singleton, operator script, fail-closed behavior, and overlay at every site
  in section 6.
- M3: `list_models`, `modelNotes`, and `Current:` line.
- M4: OpenRouter injection, projection/source, External billing, and host-JSON collision. This can
  land with M3.

Do not ship OpenRouter as API-key credits. Do not ship database mode without fail-closed boot tests.

## 12. Acceptance criteria

- AC1: The document and custom rows cannot store billing, keys, or enabled state.
- AC2: `code` plus no OpenRouter key means `configuredModels()` matches today's env behavior.
  Existing `packages/config/test/model-providers.test.ts` stays green without fixture rewrites.
- AC3: `database` plus a valid row means client and workspace catalogs use that document, plus
  Codex/xAI/provider-custom overlays. Env list JSON, code Gateway, and code OpenRouter tables are
  not the source. Deployment OpenRouter rows still require the deployment key; workspace
  OpenRouter rows require the workspace key.
- AC4: Missing or invalid row means API and worker are not ready.
- AC5: Boot does not update the row.
- AC6: `POST { upstreamModelId: "anthropic/claude-sonnet-4.6" }` yields
  `workspace-gateway/anthropic/claude-sonnet-4.6` in that workspace catalog when Gateway is
  connected; the parallel OpenRouter route yields
  `workspace-openrouter/anthropic/claude-sonnet-4.6` when OpenRouter is connected.
- AC7: API rejects extra capability, billing, and credential fields. UI is one input.
- AC8: A custom model is not selectable without its matching provider connection.
- AC9: Duplicate, curated collision, empty, or oversized values return 422. Non-admin returns 403.
- AC10: Unknown `workspace-gateway/*` or `workspace-openrouter/*` that is neither curated nor
  stored for that provider returns 422 at the edge.
- AC11: A custom slug does not throw and receives no curated `only`/`order`. Curated pins remain
  unchanged.
- AC12: Existing turn-policy freeze remains. Custom IDs have `definitionVersion`; removing a slug
  retires it from new selection without invalidating accepted/existing execution, and true
  definition drift still fails closed.
- AC13: A policy allowlist still makes Send return 422 for blocked models.
- AC14: `/v1/config/client` never lists workspace-custom models.
- AC15: No deployment or workspace Gateway/OpenRouter keys appear in documents, events, or picker
  payloads.
- AC16: Update `docs/model-providers.md`, `docs/architecture.md`, `docs/deployment.md`, and
  `AGENTS.md` with `list_models` in the first-request set.
- AC17: New SQL appears in all three release-schema sites. Migration guards pass. Ordinal is the
  next free value after the current head.
- AC18: No `/models` scrape.
- AC19: `modelNotes` is a string map. Band objects fail Zod.
- AC20: A note is optional, at most 500 characters, contains no newline, and contains no `|`.
- AC21: The list is flat and includes every selectable model. Empty selectable state yields the
  fixed empty line, plus `Current:` if present.
- AC22: Result is one string. Schema is empty. Line shape is `id | label | cost` or
  `id | label | cost | note`.
- AC23: Changing notes does not change the tool JSON schema.
- AC24: Every transport's first-request set includes `list_models`.
- AC25: Notes are not present on a `ClientModel` or picker row.
- AC26: No deployment OpenRouter key means no deployment-managed `openrouter/*`; a workspace with
  its own key may still select the separate `workspace-openrouter/*` rail.
- AC27: Deployment key set means curated `openrouter/*` IDs appear in client and workspace
  catalogs without a workspace connection. Workspace `workspace-openrouter/*` IDs require the
  workspace connection. Policy may block either.
- AC28: Deployment OpenRouter rows use `metering: external` and `upstreamPayer: deployment`;
  workspace OpenRouter rows use `metering: external` and `upstreamPayer: workspace`. Neither
  creates a credit debit unless the deployment rail is explicitly sold as credits by the separate
  cost/pricing policy.
- AC29: Host JSON using provider ID `openrouter` fails boot.
- AC30: The managed starter deployment policy marks its curated OpenRouter lines `free`; that label
  comes from deployment billing policy, not from the OpenRouter provider ID or settlement kind.
- AC31: OpenRouter has workspace connection create/rotate/revoke, custom-model list/create/retire,
  SDK methods, and a Settings card with the same replay, concurrency, and accessibility guarantees
  as Vercel AI Gateway.
- AC32: The database document contains slugs and notes, never the key.
- AC33: `projectClientModel` exposes provider `openrouter` for deployment rows and
  `workspace-openrouter` for workspace rows, never `opengeni`; both use the public OpenRouter
  source classification and never use provider label `OpenGeni`.
- AC34: `getSettings()` does not query the catalog table. Database mode uses
  `resolveCatalogSettings`.
- AC35: Cost `free` applies exactly to product IDs the deployment billing policy marks free,
  regardless of provider kind or upstream settlement. Provider identity alone never produces it.
- AC36: Starter OpenRouter models are tool-capable, or the table is empty.
- AC37: The tool description and `Current:` line make clear that calling it does not change the
  session model.
- AC38: The custom-model table discriminator participates in active-slug uniqueness, operation
  replay uniqueness, advisory locks, and per-provider active/history limits, so Gateway and
  OpenRouter cannot race or collide through a shared workspace slug.
- AC39: A workspace OpenRouter turn resolves its key only at workspace turn scope and never reuses
  a process-global provider client containing another workspace's credential.

## 13. Verification

| Acceptance criteria | Verification |
| --- | --- |
| AC1-AC2, AC26-AC30, AC33, AC35, AC39 | `packages/config/test/model-providers.test.ts`, runtime client-cache tests, plus `projectClientModel` tests |
| AC3-AC5, AC32, AC34 | API/boot tests with template DB |
| AC6-AC10, AC13-AC14, AC31, AC38 | `apps/api/test/model-catalog.test.ts`, Gateway/OpenRouter custom-model tests, connection-route tests, SDK parity, and provider-card UI/browser tests |
| AC11 | `packages/runtime/test/model-providers.test.ts` |
| AC12 | Existing turn-policy tests plus one custom ID |
| AC16-AC18 | `check:docs-refs`, migration guards, and ripgrep |
| AC19-AC25, AC36-AC37 | `list_models` resolver, notes Zod, and first-request-set tests |
| UI | Component test for add/remove |

No live Gateway/OpenRouter key is required to merge.

## 14. Blockers for verification

None for autonomous tests. Live slug quality and `:free` churn are accepted; the constant is the
product decision.

## 15. Optional human check

Connect Gateway, add a known slug, select it under Your Gateway, and perform one Send.

## 16. Tests to add

- Config: document schema, overlay, collisions, OpenRouter on/off, reserved ID, external billing,
  and `projectClientModel` source.
- Runtime: curated pin versus unpinned custom.
- API: custom catalog, 422 behavior, client omission, and OpenRouter with a mocked key.
- DB: `migration-<next ordinal>-*.test.ts` with `timeout: 180_000`; no FORCE-RLS backfill window.
- `list_models` resolver: skip blocked, append notes, reject invalid notes, fixed empty line,
  `Current:`, and `free` cost.
- Do not weaken existing Gateway pin tests.

## 17. Deploy

- Add `OPENGENI_MODEL_CATALOG_SOURCE` to Settings, `.env.example`, and a Helm comment. Default is
  `code`.
- `OPENGENI_OPENROUTER_API_KEY` is Secret-only.
- Managed rollout writes the singleton row before switching to `database`.

## 18. Hardening

- Log catalog source and document version at boot, never the document body.
- Bound `upstream_model_id` to 238 printable, non-whitespace characters so the
  generated `workspace-gateway/` and `workspace-openrouter/` product IDs remain
  within the 256-character model-policy contract.
- Do not log keys.

## 19. Risks

| Risk | Mitigation |
| --- | --- |
| Billing on the document | `z.never()` plus AC1 |
| OpenRouter shown as OpenGeni | AC33 |
| `getSettings()` gains a DB read | AC34 |
| Overlay miss causes API/worker disagreement | Section 6 call-site list plus claim test |
| Custom still throws at the fence | AC11 |
| Database auto-seed | AC5 |
| Credits applied to free models | Explicit deployment cost policy plus AC28/AC35 |
| Band UI returns | AC19 |
| Note breaks a line | AC20 |
| Text-only `:free` model | AC36 |
| Migration ordinal collision | Next free after current head plus `migration:renumber` |
| Hash-ladder edit | Stop condition |

## 20. Reread before implementing

- This document, especially sections 2-6 and 10.
- `docs/model-providers.md`.
- `configuredModels`, `gatewayRegistryProvider`, and `projectClientModel`.
- `normalizeVercelGatewayRequestBody`.
- `AGENTS.md` migration rules.

Ignore any earlier transcript instruction to freeze turns. Turn freezing is already
`TurnExecutionPolicyV1`.

## 21. Stop conditions

Stop if the implementation introduces any of the following:

- Keys, billing, or enabled state on catalog/custom rows.
- A `/models` scrape.
- Anthropic/Google or paid OpenRouter added "while here".
- OpenRouter represented as API-key to credits.
- Cheap/intelligent sections or a band enum.
- List text in `Agent.instructions`.
- A session-model-switch tool.
- `getSettings()` reading the catalog table.
- Editing `releaseSchemaContractHash`.
- Defaulting database mode on.
- Automatic overwrite of the singleton.
- Capability or "prove vision" UI.
- Changing `TurnExecutionPolicyV1`.

## 22. Merge condition

Merge when AC1-AC37 pass across the listed tests, typecheck, migration guards, and docs.

Reviewer sentence:

> Code versus DB defines the list; policy and connections decide who can use it; custom is
> type-a-Gateway-slug; OpenRouter `:free` uses our key on External and the deployment decides its
> workspace-facing cost; `list_models` is one string of selectable models plus optional notes, and
> it does not change this session.

## 23. Implementation and UX quality bar

The intended delivery is one large PR if it remains reviewable. Implement and test the complete
vertical slice locally, then iterate until the behavior is coherent across catalog source,
admission, worker execution, policy, billing projection, tools, deployment, and UI.

Real-provider testing is a first-class local validation objective when suitable credentials are
available, while remaining optional for merge as stated above. Never commit or expose those
credentials.

The custom-Gateway UI is also a first-class product surface, not a checkbox afterthought. It should
be iterated under strict visual and interaction critique until it is intuitive, accessible,
responsive, and visually coherent with the existing Gateway connection card and shared settings
patterns. Validate loading, empty, connected/disconnected, success, duplicate, collision,
validation, authorization, and deletion states. Run component tests and inspect the live route at
desktop and narrow widths before handoff.

## 24. Current repository assessment (non-normative)

This section records implementation-readiness findings from the 2026-08-27 checkout. The
specification above remains authoritative; resolve the open decisions below before coding the
affected contract.

### What the change is asking for

This is one vertical model-catalog authority change with four extensions, not four unrelated
features:

1. Build one normalized, secret-free deployment catalog document and select either the current
   code/env construction or a database singleton as its membership source.
2. Overlay workspace-local Gateway slugs only after the deployment catalog is resolved, while
   retaining the existing workspace Gateway connection as the credential/readiness boundary.
3. Inject a reserved OpenRouter provider only when the deployment key exists, deriving external
   upstream settlement and a distinct client source from that internal provider kind while taking
   the workspace-facing `free`/`credits` label from deployment billing policy.
4. Reuse the exact authenticated workspace-catalog selectability result to expose a stable local
   `list_models` tool whose schema is constant and whose dynamic output is plain text.

Catalog membership must be resolved before every admission, projection, worker verification, and
tool construction. Policy, credentials, health/readiness, and billing remain independent inputs.

### Confirmed implementation shape

- Keep `getSettings()` synchronous and env-only. A practical package boundary is:
  `@opengeni/db` owns raw singleton/custom-row reads, `@opengeni/config` owns document Zod and pure
  catalog application, and `@opengeni/core` composes the async
  `resolveCatalogSettings(db, envSettings)` boundary consumed by API and worker.
- Move or extract `buildWorkspaceModelCatalog` from `apps/api` into a shared core-owned resolver.
  The worker cannot safely import an API app module, and duplicating selectability would violate
  the `list_models`/picker equivalence requirement.
- Add the local tool through a stable runtime agent option/callback so its description and empty
  schema are transport-invariant while the worker supplies the exact turn-scoped string result.
- `deployment_model_catalog` belongs in `NON_RLS_RUNTIME_TABLES` and
  `RUNTIME_READ_ONLY_TABLES`. `workspace_gateway_custom_models` belongs in the FORCE-RLS posture
  and the exact runtime DML class its lifecycle requires. Neither belongs in
  `RUNTIME_FULL_DML_TABLES` by accident.
- The current External picker rail and external-usage settlement already support OpenRouter's
  billing semantics. No pricing shim or new picker rail is needed.
- The existing Gateway settings component is a good visual owner. Add slug management inside its
  disclosure instead of creating a second bordered card beside or inside it.

### Additional catalog/admission sites found in this checkout

The section 6 list is not complete for the current tree. The implementation audit must also cover:

- New-session draft validation.
- Scheduled-task validation.
- PR-review session/model admission.
- Automation and site-auth maintenance session creation.
- Worker goal policy checks.
- SuperGrok/client projection helpers that call `configuredModels` after applying an overlay.
- Billing helpers and runtime model-routing fallbacks that resolve provider identity from
  `Settings`.

A final symbol audit should cover every source caller of `configuredModels`,
`configuredAllowedModels`, `canonicalizeConfiguredModelId`, `canonicalConfiguredModel`,
`policyProviderIdForModel`, `resolveTurnExecutionPolicyV1`,
`assertTurnExecutionPolicyMatchesConfigV1`, `resolveModelProvider`, and `configuredProviders`.

### Specification decisions required before implementation

1. **Exact deployment document schema.** The specification names its conceptual contents but not its
   JSON contract. Define the schema version and exact fields for the built-in model list, registry
   providers, curated Gateway entries, OpenRouter entries, and notes. In particular, decide whether
   the deployment default `OPENGENI_OPENAI_MODEL` must be present in the document, whether it is
   itself document-owned, and what happens when the env default is not a document member.
2. **Secret references in the document.** Current registry providers support both an inline
   `apiKey` and an `apiKeyEnv` name. The database document must reject inline key material. Confirm
   that a non-secret `apiKeyEnv` reference is allowed, or define a separate provider-to-env binding
   contract.
3. **Deployment model-cost policy representation.** `free` is now explicitly a deployment-defined
   workspace-facing price independent of provider identity and upstream settlement. Define the
   exact code/env and managed-database authority for mapping deployment-catalog product IDs to
   `free` versus `credits`, including validation for unknown IDs and the behavior of an omitted
   entry. Keep it separate from catalog membership rows. Anonymous deployment routes then use that
   same policy instead of receiving an OpenRouter-specific or inferred label.
4. **Custom-model delete contract.** The collection path is specified, but the target is not.
   Choose either `DELETE .../gateway-custom-models/:customModelId`, a request body containing the
   exact upstream ID, or another unambiguous contract. Also define the optional label's length and
   character rules; the one-input UI implies the label is API/operator-only or omitted by the UI.
5. **Fail-closed runtime behavior.** Clarify whether a missing/invalid singleton terminates API and
   worker startup, leaves processes alive with readiness false, or does both at different stages.
   Also define the request/claim error after a previously valid live row is deleted or becomes
   invalid.
6. **Operator upsert semantics.** Replace the placeholder `bun run upsert` with an exact command,
   input mechanism, database credential, and version/CAS policy. Define whether `version` is
   operator supplied, monotonically incremented by the command, or a document schema version
   separate from a row revision.
7. **OpenRouter starter table.** Select and review one or two current tool-capable `:free` slugs, or
   deliberately approve an empty starter table. If headers are emitted, define the exact public
   `HTTP-Referer` and `X-Title` values so definition digests and tests are deterministic.
8. **Gateway disconnected UX.** Decide whether admins may preconfigure custom slugs before a key is
   connected. Either behavior can satisfy the backend contract, but the UI copy, empty state, and
   disabled/read-only behavior should be deliberate.

### August 27, 2026 verification update

- The OpenRouter credential was supplied through an encrypted Variable Set and was never written to
  the repository or printed. A live Chat Completions request to the reviewed Nemotron starter
  returned HTTP 200, emitted a native `tool_calls` finish, called `list_models`, and reported zero
  provider cost for that request.
- Repository dependencies are installed. Focused unit, contract, runtime, UI, browser, formatting,
  lint, typecheck, build, documentation, and migration guards run locally without requiring the
  secret to enter test output.
- Docker is unavailable in this sandbox, so database suites that explicitly require the full Docker
  stack remain a CI/full-stack concern. The new database integration coverage skips locally when a
  PostgreSQL fixture cannot be acquired and runs normally when CI supplies one.

### Not blockers

- `TurnExecutionPolicyV1` already carries the product/provider/upstream definition and
  `definitionVersion`; no second turn freeze is needed.
- Workspace Gateway connection storage, encryption, readiness, and the Settings card already
  exist.
- The picker already has an External billing rail.
- External-metered usage already avoids OpenGeni credit debit.
- Chromium and the repository's Playwright dependency make desktop/narrow visual QA feasible after
  dependency installation and stack startup.
- GitHub CLI authentication is available for eventual branch/PR delivery.