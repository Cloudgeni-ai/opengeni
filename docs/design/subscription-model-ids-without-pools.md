<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Subscription model IDs without inference pools

Status: option A decided on 2026-10-30, with the decisions in section 10 as
recommended (see `docs/design/ownership-and-reach.md`). Release N (section
7) is built; releases N+1 and N+2 follow. Under the owner's delegation of
2026-10-29, the release PRs are reviewed and merged by the implementing
agent rather than held as drafts (section 8).
Baseline: `0eb7aa010e7cec8b2e6b328e55dd783356b5003b`. Line numbers below are
at that commit.

## 1. Summary

A Claude subscription model has two IDs today, for example
`workspace-claude-subscription/claude-opus-5-5` and
`organization-claude-subscription/claude-opus-5-5`. Which one works in a
workspace depends on which "inference pool" each connected Claude account is
considered part of, and that pool is guessed from whether a workspace
manages the account. The product already decided on 2026-10-22 (D-50 in
`docs/subscription-accounts.md`) that pools no longer exist: an account has
one owner and serves exactly where it reaches. The model IDs are the last
place the pool survives, and they now silently break chats: a workspace
whose Claude logins were merged by the cutover shows no Claude models to
people, while service-initiated turns on the same models in the same
workspace keep running, because placement never used the pool.

**Recommendation:** give every Claude subscription model one ID,
`claude/<upstream model>`, like `codex/<slug>` and `supergrok/<slug>`
already are. A workspace offers a Claude model when an administrator listed
it (in the workspace or the organization list) and at least one Claude
account that reaches the workspace allows it. Which account serves a turn
stays the job of the existing pins, primary and rotation settings. The
catalog, admission and placement all read that one rule. The two
old IDs remain permanent aliases, so existing chats, schedules, policies,
API clients and usage history keep working. The change ships in two
releases (expand, then switch with a backfill) plus a later cleanup, and is
about 7 to 10 agent hours of work.

## 2. How it works today

### 2.1 Where the two IDs come from

Claude models are defined by administrators, per scope, as rows holding only
the upstream model ID: `workspace_gateway_custom_models` for a workspace and
`organization_model_provider_custom_models` for the organization
(`packages/db/src/schema.ts`, `provider_kind = 'claude_subscription'`). The
catalog turns each list into a registry provider whose ID is
`claudeProviderId(kind, scope)`, so the scope becomes the prefix
(`withClaudeConnectionCatalog`, `packages/config/src/index.ts` around line
12130). The same pattern serves the Anthropic API-key kind
(`workspace-anthropic/`, `organization-anthropic/`), where the prefix really
does pick between two different keys. For Claude subscriptions it does not:
since the Claude core cutover (migration 0748) both prefixes are served by
the same shared subscription core, the same connections and the same
placement. Codex and SuperGrok, also on that core, have one prefix each.

### 2.2 How the pool is guessed

Since migration 0907 (D-50) the assignment-policy rows that used to carry a
per-workspace pool are emptied and no longer read, and the per-workspace
`inferenceSource` preference is gone. Placement does not look at pools at
all. Three readers still do, and they derive the pool from the connection's
delegated manager:

- `listSubscriptionCoreServingConnections`
  (`packages/db/src/subscription-core/catalog.ts:209`) labels a serving
  shared connection `workspace` only when `managedByWorkspaceId` equals this
  workspace, otherwise `organization`. The comment in
  `docs/design/subscription-core-2026-10-07.md` §5.3 (C2a, "legacy
  `{workspace, organization}` meaning is kept by pool") still says
  assignment policies decide; that text predates 0907 and is stale.
- `readSubscriptionCoreClaudeCatalogReadiness`
  (`packages/db/src/subscription-core-claude-reads.ts:516`) makes
  `workspace-claude-subscription/` models ready only through a
  `workspace`-labelled connection or the caller's own personal connection,
  and `organization-claude-subscription/` models only through an
  `organization`-labelled shared connection. Organization custom-model
  admission (`subscriptionCoreClaudeOrganizationModelAdmitted`, line 540)
  uses the same split.
- Cross-provider failover replays pre-cutover accepted authority by pool,
  again comparing the manager with the workspace
  (`packages/db/src/subscription-core/failover-world.ts:438`).

### 2.3 The defect

A workspace's `workspace-claude-subscription/` models disappear whenever
none of the Claude connections serving it has `managed_by_workspace_id`
equal to that workspace. Two ordinary paths get there, and neither is
reversible from the product.

**The cutover itself (the case observed on a self-hosted deployment).**
Before the Claude core cutover, two workspaces had each connected the same
Claude login separately: two legacy rows with `authority_scope = workspace`,
one per workspace. The cutover planner deduplicates them into one shared
connection reaching both workspaces. It records one assignment policy per
workspace with `pool: "workspace"` and that workspace as manager
(`addPolicy`, `packages/db/src/subscription-core/cutover-plan.ts:548`), but
sets the connection's `managedByWorkspaceId` only when the group has exactly
one source (`group.length === 1 && localSources.length === 1`, line 621);
for the merged login it is NULL. Until #5526 the catalog read those policy
rows to label pools. #5526 (D-50, 2026-10-22) stopped reading them in
`catalog.ts`, and its migration 0907 deletes them and keeps NULL, because a
connection with two local copies has no single owner (the `owned` step,
`packages/db/drizzle/0907_subscription_connection_one_owner.sql:252`). Since
then `catalog.ts:209` labels the merged connection `organization` in both
workspaces, and both lose every `workspace-claude-subscription/` model. A
login connected in only one workspace kept its manager and kept working,
which is why the failure looked random.

**An administrator sharing an account.** `updateSubscriptionCoreConnectionAccess`
(`packages/db/src/subscription-core/access.ts:535`) keeps
`managed_by_workspace_id` only while the connection reaches exactly its
managing workspace. Sharing it with any second workspace writes NULL, and
nothing writes it back: narrowing the reach to the original workspace keeps
NULL because `keepOwner` requires a non-null owner. This matches D-50
("making it serve more workspaces makes it the organization's").

Either way, on a deployment whose product offers only
`workspace-claude-subscription/` models, the workspace shows no Claude
models, with no error and no setting that explains why.

### 2.4 Readiness, admission and placement disagree

The pool label is read only by the Claude catalog readiness and the
organization custom-model admission. Placement never reads it: chat
eligibility checks the connection's reach, switch, health and model
allowlist and the workspace allowlist
(`packages/subscriptions/src/eligibility.ts:127` and line 189), and the
core's funding check for a model asks whether any serving connection allows
it (`readSubscriptionCoreRouteFunding`,
`packages/db/src/subscription-core/route-readiness.ts:38`). The cutover
wrote connection allowlists in both prefixed forms, so those connections
allow `workspace-claude-subscription/…` too.

On the affected deployment this showed directly: while the catalog listed
no Claude models for the workspace, hundreds of service-initiated turns
pinned to `workspace-claude-subscription/claude-opus-5-5` in the same
workspace kept completing on those connections. Only people were blocked,
because the composer reads the catalog. The same model in the same
workspace was "not available" to one reader and served by another.

The root cause is not the access editor or the cutover. D-50 made "who
manages an account" a question of administration only, but two readers
still use it to decide which model IDs exist, while placement uses a
different rule. Any fix that keeps two pool-meaning prefixes has to keep
guessing a pool from something, and keeps a second rule beside placement's.

## 3. Where the prefixed IDs live

"History" means records of what already happened, which are never
rewritten. "Configuration" means stored choices that drive future work.

| Place | What holds a prefixed ID | Kind |
| --- | --- | --- |
| Custom-model rows (workspace and organization) | Only `upstream_model_id`; the prefix is derived from the table | Neither: no data change needed |
| Registry provider kinds | `claude-subscription-workspace` and `claude-subscription-organization` kinds and their pricing, credential source and billing switches (`packages/config/src/index.ts`, around lines 7637, 9121, 9634, 11581); worker checks in `apps/worker/src/activities/agent-turn/claim.ts`, `claude-core.ts`, `session-title.ts`; `packages/runtime/src/anthropic-messages.ts` | Code |
| Sessions and drafts | `sessions.model`, `new_session_drafts.model`, `composer_drafts.model` | Configuration |
| Turn snapshots | `session_turns.model` and `metadata.turnExecutionPolicyV1` (`providerId`, `productModelId`, `requestedModelId`, definition digest). The accepted-policy check already has a legacy-Claude exception (`packages/config/src/index.ts` around line 8950) | History |
| Scheduled tasks and automations | `scheduled_tasks.agent_config.model`; the v1 `claude_provider_account_authority_snapshot` (`scope: workspace/organization`, not read on the core route); `automation_trigger_revisions.session_template` | Configuration |
| Defaults | Workspace session defaults; `organization_model_defaults.session_defaults.model`; `model_compaction_thresholds` keyed by model ID | Configuration |
| Model policy and allowlists | `workspace_model_policies` and `organization_model_defaults` `allowed_providers` / `allowed_models`; `subscriptionCoreClaudeModelPolicyProviderIds` requires both provider IDs for a workspace model (`packages/db/src/subscription-core-claude-adapter.ts:222`); `policyProviderIdForModel`, `NON_CREDIT_POLICY_PROVIDER_IDS`, `RESERVED_MODEL_PROVIDER_IDS` (config) | Configuration and code |
| Connection allowlists | `subscription_connections.allowed_model_ids` holds product IDs, written in both forms by the cutover (`subscriptionCoreClaudeProductModelIds`) | Configuration |
| Cooldowns | `subscription_connection_quota.quota.modelCooldowns`, keyed by both product IDs (adapter line 365; 0748 parity check) | Short-lived state |
| Subscription settings | Fallback orders (D-35) keyed by and listing model IDs | Configuration |
| Usage and Insights | `model_call_facts.provider` / `model`, `usage_events`; SQL `opengeni_private.insights_usage_payer` (0604) and `organization_model_usage_summary` (0592) list the two provider IDs as subscription payers; the Insights model filter is `provider || '/' || model`; `apps/web/src/components/insights/payer.ts` | History plus readers |
| Readiness and restrictions | `ConnectionModelRestrictions` keys (`packages/db/src/workspace-model-connection-access.ts:93`), `loadCoreRoutedClaudeCatalogReadiness` (`packages/core/src/default-session-model.ts:361`), `pools` on serving connections | Code |
| Admission and accepted authority | `subscriptionCoreClaudeCustomModelAdmitted` and the 0716 compatibility records' `sharedPool`; failover replay (above) | Code over history |
| `list_models` tool | One line per selectable model ID plus `Current: <session model>` (`apps/worker/src/activities/agent-turn/list-models.ts`) | Model-facing |
| Picker and web | `packages/contracts/src/model-picker-order.ts`, `model-display.ts`; models pages; `apps/web/src/lib/agent-brain-prompt-model.ts` | UI |
| SDK and public API | Model IDs as values in session, scheduled-task and policy requests; catalog `id` and `provider` (`apps/api/src/model-catalog.ts:42`); `@opengeni/react` `model-policy.ts:277` and `model-picker-model.ts:129` map prefixes to labels and billing groups; `docs/model-providers.md` documents both prefixes | Public |

## 4. Options

**A. One ID per Claude model (recommended).** `claude/<upstream>`, provider
ID `claude-subscription`. The workspace's model list is the organization
list plus the workspace's own list, one entry per upstream model (the
workspace's label wins). A model is ready when any connection that serves
here allows it. `pools`, both prefix-keyed restrictions and the
pool-labelled admission go away.

**B. Keep both prefixes, drop the pool.** Both prefixes become ready from
the same set of serving connections; the prefix only says which list
defined the model. Smallest change and no ID migration, and it fixes the
defect. But the picker shows the same model twice wherever both lists name
it, model policy still needs two provider IDs per model, cooldowns and
allowlists stay duplicated, and the prefix keeps implying a difference that
does not exist. It keeps exactly the confusion D-50 set out to remove.

**C. Option A, and derive the list from the deployment.** Like Codex, the
Claude list would come from the deployment's known Claude models
(`CLAUDE_NATIVE_MODEL_PROFILES`), filtered by connection allowlists and
model policy, and the claude_subscription definition rows would be
retired. It removes the most, but it is a product change: administrators
lose custom labels and the ability to add a new upstream model before a
deployment knows it, and the Anthropic API-key kind would still need the
rows. It can follow A later without touching IDs again.

Not offered: making the pool guess smarter (a sticky manager, a new "home
workspace" column, or reading assignment rows again). That brings back the
concept D-50 removed, under another name.

| | A | B | C |
| --- | --- | --- | --- |
| Fixes the defect | Yes | Yes | Yes |
| One ID per model | Yes | No | Yes |
| Matches Codex and SuperGrok | Yes | No | Yes, fully |
| ID migration | Yes, aliases kept | None | Yes, aliases kept |
| Product change for administrators | None | None | Lists and labels go |
| Agent hours | 7 to 10 | 2 to 3 | 10 to 13 |

## 5. End state under option A

- **IDs.** `claude/<upstream>` with provider `claude-subscription` and one
  registry kind, `claude-subscription`. `policyProviderIdForModel` maps the
  prefix directly, as it does for `codex/` and `supergrok/`, so policy and
  credit checks agree with the router even without the workspace overlay.
- **Model list.** Organization rows (with today's inheritance rule) plus
  the workspace's rows, deduplicated by upstream ID. The definition rows and
  their management screens do not change; they now only say "offer this
  model here". An entry's definition version comes from the workspace row
  when there is one, otherwise the organization row.
- **Who serves.** Exactly the connections `listSubscriptionCoreServingConnections`
  already returns: active, switched-on shared connections that reach the
  workspace, plus the person's own personal connections in their own
  Personal workspace. Pins, the provider primary and rotation choose among
  them, as they already do in placement. `managed_by_workspace_id` keeps
  meaning delegated management only (who may reconnect or allocate); no
  catalog, readiness or admission code reads it. Whether sharing should
  end that delegation was decided separately (OR-2 in
  `docs/design/ownership-and-reach.md`: it does not); it no longer affects
  which models exist.
- **One rule for every reader.** Catalog readiness, the picker and
  `list_models`, admission, the funding check and placement all ask the
  same question: does a connection returned by
  `listSubscriptionCoreServingConnections` for this workspace and subject
  allow this model (`subscriptionCoreConnectionAllowsModel`, plus the
  workspace model policy)? Placement then adds only what changes from
  moment to moment (capacity, pins, rotation, cache warmth) and never
  narrows which connections count. A conformance test over generated
  worlds checks that a model is catalog-ready exactly when admission
  admits it and placement finds an eligible connection with capacity
  ignored, for people, service actors and the owner's Personal workspace.
- **Readiness and restrictions.** One `claude/` restriction, the union of
  the serving connections' allowlists, as for Codex. The `pools` field and
  `servesWorkspacePool` / `servesOrganizationPool` are deleted.
- **Admission.** A model is admitted when an active definition row exists
  (workspace row first, then organization row) and a serving connection
  for the established subject allows it. Service actors and borrowed
  subjects still see shared capacity only.
- **Accepted authority.** A pre-cutover compatibility record admits shared
  capacity when its `sharedPool` is `workspace` or `organization`, and its
  personal list keeps its meaning. The failover replay stops filtering by
  manager. This lets old carriers (mostly schedules created before the
  Claude cutover) use any account that reaches the workspace, which is
  what D-50 already says.
- **Model policy.** One provider ID. Converting a stored policy: the new
  provider is allowed when `organization-claude-subscription` was allowed
  (today both forms need it); a model is allowed when either legacy form
  was listed. Nobody loses a model; a policy that allowed a model "only on
  workspace accounts" cannot be expressed any more, which is D-50's rule.
- **Allowlists, cooldowns, fallback orders, compaction thresholds.** One
  key per model. Merging two legacy entries takes the union for lists, the
  later expiry for cooldowns, and the lower threshold for compaction (it
  compacts no later than before).
- **Public catalog.** Each Claude entry gains an optional `aliases` field
  listing its two legacy IDs, so a client that stored or filters by an old
  ID can match it. `provider` becomes `claude-subscription`.

## 6. Old IDs keep resolving

Both legacy forms are registered as aliases of the canonical model
(`aliases` on the registry model, read by `canonicalizeConfiguredModelId`),
generated from the rule rather than stored. Every input boundary already
canonicalizes or will: session and scheduled-task creation, model switches,
policy writes, `session_create`, the HTTP API. They stay accepted for as
long as the public API major lasts, and history keeps them forever.

History is never rewritten. A turn snapshot naming
`organization-claude-subscription` is verified by treating the legacy
provider ID and kind as the canonical provider in the accepted-policy check
(the same kind of bounded exception as the existing legacy-Claude and
`wireProfile` ones), so a turn accepted by an old binary still runs on a new
worker, including turns parked for capacity for days. Insights reads map
the two legacy provider IDs to `claude-subscription` when grouping, so a
model's usage before and after the switch shows as one line; the stored
facts stay as written.

## 7. Rollout

The repository rule is that every binary of the previous release keeps
working after a migration commits (`docs/migrations-expand-contract.md`).
An old binary does not know `claude/`, so canonical IDs may only be written
once no such binary runs. That takes two releases.

**Release N, expand (one PR).** Ship all of section 5 in readers: the
canonical provider and its aliases, canonicalization at every boundary, the
accepted-policy compatibility, pool-free readiness and admission, one
policy provider rule, cooldowns written under all three keys and read by
their latest expiry, the `claude-subscription` payer in both Insights SQL
payer classifications (rolling function replacements) and in `payer.ts`, and the
picker, React and display helpers recognising `claude/`. Writers and the
catalog still emit the legacy IDs, but both prefixes are now ready from the
same serving connections, the same rule placement uses, so the defect is
fixed in this release with no data change: the merged cutover connections
become visible again where they already serve. The one-rule conformance
test lands here. A
workspace that defines the same model in both lists sees it twice until
release N+1. Nothing is model-facing except that models which were wrongly
missing reappear in `list_models`.

**Release N+1, switch (one PR, after N is fully rolled out).** The catalog,
`list_models`, defaults and every writer emit `claude/`. A rolling batched
backfill (`-- opengeni:batched-backfill`) rewrites configuration only:
session and draft models, scheduled-task and automation templates,
defaults and compaction keys, model policies, connection allowlists and
fallback orders, merging as in section 5. Release N binaries read the
rewritten rows, and release N+1 binaries tolerate an unfinished backfill,
so it can run before or after rollout. Cooldowns are not backfilled; old
keys expire within hours. Documentation and the API changelog describe the
new IDs and the `aliases` field.

**Release N+2, cleanup (small PR).** Delete the two legacy registry kinds,
the legacy writers and the triple cooldown write. The alias rule, the
accepted-policy exception and the Insights mapping stay. Stop writing the
v1 Claude authority snapshot on scheduled tasks if nothing reads it by
then.

Self-hosted deployments must not jump from before N straight to N+1 while
old replicas serve traffic; a jump needs a parked (maintenance) rollout.
The release notes for N+1 say so.

## 8. Model-facing and prompt-cache impact

The prompt-cache rule is that no text an earlier request already sent may
change. This design keeps it:

- **`list_models`.** From release N+1 the tool lists `claude/...` lines,
  one per model instead of up to two, and `Current:` shows the canonical
  ID once a session's model is rewritten. Only new tool results carry the
  new text. Earlier results stay in history byte for byte. If an agent
  later reuses an ID it saw in an old result, the alias resolves.
- **Tool descriptions and schemas.** Unchanged. No tool schema enumerates
  model IDs, and the `list_models` description does not mention prefixes.
- **Instructions.** No instruction module renders the model ID, so system
  text is unchanged.
- **Upstream requests.** Anthropic receives the same upstream model ID,
  instructions, tools and history; session pins are kept per provider
  (`claude`), not per model ID. A session whose stored model is rewritten
  keeps its account and its warm cache. The serving-failover comparison of
  `productModelId`
  (`apps/worker/src/activities/agent-turn/subscription-serving-capacity.ts:103`)
  must compare canonical IDs so a rewrite never reads as a model change.
- **Behaviour.** Models that a pool guess hid become selectable, which is
  the fix. Compaction can come earlier only where two legacy thresholds
  differed.

Because this changes model-facing tool output, both release PRs open as
drafts for owner review, per the repository's rule for model-facing
changes.

## 9. Other connection kinds

The API-key kinds (`workspace-` and `organization-` for `anthropic`,
`gateway`, `openrouter` and `opper`, plus `organization-openai` and
`organization-azure-openai`) have the same shape of ID, but there the
prefix is currently the only thing that chooses which key pays: they are
one key per scope, outside the shared core, with no pins, primary or
rotation. Collapsing their IDs needs a serving rule, and the shared core's
planned API-key connectors (§5.3 "API-key connectors on the shared core" in
the core design) provide it. Recommendation: leave them unchanged in this
work, and give each kind one ID (`anthropic/`, `openrouter/` and so on)
when it moves onto the core, reusing this alias rule and rollout. Each is
roughly 1 to 2 agent hours on top of its core move.

## 10. Decisions to confirm and risks

Decisions:

1. Option A, with `claude/` as the prefix (alternative:
   `claude-subscription/`, which is longer but cannot be mistaken for the
   API-key kind).
2. The workspace list is the organization list plus its own; the
   workspace's label wins.
3. Policies, allowlists and fallback orders merge by union; compaction by
   the lower threshold.
4. Pre-cutover accepted authority may use any shared account that reaches
   the workspace.
5. API-key kinds wait for their core move.
6. Catalog readiness, admission, funding and placement share one rule; the
   catalog may never hide a model placement would serve, nor the reverse.

Risks:

- An external client that filters the catalog by the old prefix sees no
  Claude models after N+1. Mitigations: `aliases` on each entry, release
  notes, and legacy IDs still accepted as input. Owners of embedding
  products should be told before N+1 ships.
- Older `@opengeni/react` versions label `claude/` models generically
  until upgraded; they still work.
- A missed comparison site that does not canonicalize would treat a legacy
  and a canonical ID as different models. The build adds a check that no
  code outside the alias rule, the compatibility exception and migrations
  names the legacy prefixes.
- A deployment that skips release N without parking can fail turns during
  the overlap.
- Release N makes Claude models visible to people in workspaces that lost
  them after #5526 and 0907. They are served by accounts that already serve
  those workspaces' service-initiated turns, so no account gains reach, but
  administrators may see models return that they took as deliberately
  hidden.

## 11. Effort

For agent execution, including tests on real PostgreSQL and a rolling
compatibility test with the previous binary's reads:

| Step | Agent hours |
| --- | --- |
| Release N (expand, fixes the defect) | 4 to 6 |
| Release N+1 (switch and backfill) | 2 to 3 |
| Release N+2 (cleanup) | about 1 |
| Total | 7 to 10 |

Owner review and the time between releases are on top of that.
