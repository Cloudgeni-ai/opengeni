# OpenGeni Capabilities experience — prototype decision brief

Status: reversible local product-design artifact; no production/data-model decision yet  
Date: August 4, 2026  
Owner: Capabilities experience session `792820fa-e129-4f6a-93e5-adc5199f023b`

## Product truth that the experience must explain

The current `enabled` field is not one user concept. It includes:

1. deployment built-ins that are always available and cannot be disabled in the workspace;
2. deployment-configured MCP servers that are always available until configuration changes;
3. workspace-selected library skills;
4. workspace-enabled MCP/installations, optionally backed by a workspace or personal connection;
5. enabled packs that compose tools, skills, connector requirements, knowledge, schedules, and possibly a runtime image;
6. connector-derived first-party surfaces such as social accounts;
7. session policy, which can narrow the workspace runtime set and may inherit or explicitly override workspace defaults.

Connections are a separate authority model:

- workspace connection: shared identity, preferred default for durable agent workloads;
- personal connection: current subject's identity, executable only through the frozen causal delegation snapshot;
- provider principals must not be substituted (for example personal Slack versus the OpenGeni workspace bot);
- Google Drive is currently a personal connection whose configured knowledge destination may be personal, workspace, or company scope;
- workspace policy denies must inherit deterministically and must not be widenable by a session or child. In this workspace, blocking human-input tools are denied and the experience must not imply that an agent can override that policy.

The page therefore cannot answer its core jobs with one “Enabled” bucket or with provider cards above the inventory.

## Research principles translated for OpenGeni

Primary references:

- Apple HIG, Settings and Disclosure Controls: optimize defaults for the largest group, keep task-specific controls in context, expose common actions and progressively disclose advanced configuration.
- Carbon Design System, Data table / Filtering / Contained list: use compact structured rows, one search/filter toolbar, explicit multi-facet state, and detail panels rather than repetitive cards.
- WAI-ARIA APG, Tabs / Dialog / Combobox / Grid: preserve expected keyboard models, explicit focus movement/restoration, accessible names, and semantic list/table behavior.
- WCAG 2.2: focus must remain visible and unobscured; touch targets must meet the product's existing 44px coarse-pointer contract; motion cannot be required to understand state.
- Nielsen Norman Group, Progressive Disclosure: keep frequent decisions visible and defer specialized controls without making them undiscoverable.
- Vercel and GitHub integration management: connection/installation ownership and permission scope belong close to connection health and configuration, not mixed into a marketplace taxonomy.

OpenGeni-specific principles:

1. Start with the question, “What can agents do now?” rather than “Which registry type is this?”
2. Separate availability, selection, connection health, scope, and session default policy.
3. Show exceptions before inventory volume: attention, expiring/revoked connections, policy blocks, and incomplete setup.
4. Put Slack and Google Drive under Connections. Their details remain rich, but providers do not own the global hierarchy.
5. Default Discover to curated, compatible, high-confidence capabilities. Public registry breadth is an explicit advanced expansion.
6. Use compact rows for inventory; use cards only for a small number of recommendations, packs, or first-run tasks.
7. Preserve technical depth in a detail sheet: runtime compatibility, auth, endpoint, provenance, scopes, source, immutable version/hash, and pack composition.
8. Never label a capability merely “Enabled” when it is actually built in, connected, selected, inherited, blocked, or default for new sessions.
9. Keep workspace and personal ownership visible wherever an action changes authority.
10. Keep every state testable at 637+ rows without rendering the full catalog at once.

## Personas and jobs to be done

### 1. Nontechnical founder / operator

Primary job: understand what agents can do now and add a trusted capability for a business task without learning MCP/provider taxonomy.

- Primary: review readiness, resolve setup, enable a recommendation or pack, connect a common service.
- Secondary: understand whether a connection is personal or shared; choose a safe default.
- Rare: inspect endpoint/auth/provenance or add a custom server.
- Failure to prevent: treating “Built in” as an optional installation; connecting a personal account while expecting workspace-wide access.

### 2. Developer

Primary job: find an exact tool/integration, verify compatibility and auth, make it selectable, and understand new-session behavior.

- Primary: search, filter by capability type/category/runtime, inspect details, connect or enable.
- Secondary: choose personal/workspace ownership, inspect tools/scopes, narrow a session's tool set.
- Rare: register a custom MCP/API/plugin/skill or diagnose a stale registry entry.
- Failure to prevent: assuming catalog presence means runtime executable; assuming workspace availability means every session exposes it.

### 3. Enterprise workspace admin / security owner

Primary job: audit who/what has access, health, provenance, defaults, and policy without opening every catalog item.

- Primary: review workspace-shared connections, personal-connection counts without private metadata, attention states, workspace defaults, and policy blocks.
- Secondary: revoke/repair access, inspect scopes and principals, approve a reviewed library skill or pack.
- Rare: inspect import provenance, immutable hashes, audit evidence, or custom endpoint risk.
- Failure to prevent: conflating provider grant scope with OpenGeni authorization or silently borrowing another subject's credential.

### 4. Specialist infrastructure engineer

Primary job: intentionally add specialist infrastructure guidance when doing Terraform/IaC work, without exposing it to unrelated agents/workspaces by default.

- Primary: find the Infrastructure collection/pack, inspect Checkov/Terraform skills, select the exact reviewed skills needed.
- Secondary: inspect source/version/hash and pack composition; attach repository-local skills to a session.
- Rare: update a canonical skill artifact.
- Failure to prevent: universal specialist prompt surface, provider-specific defaults, or deleting skills instead of making them discoverable and opt-in.

### 5. Power user building custom capabilities

Primary job: register and test a custom endpoint/manifest with full technical control.

- Primary: add by URL/domain/manifest, see probe/auth/transport results, choose ownership, enable.
- Secondary: register a pack or skill, inspect conflicts/precedence, manage custom inventory.
- Rare: import reviewed registry snapshots or diagnose schema drift.
- Failure to prevent: presenting unverified metadata as connectable, leaking credentials into URLs/config, or allowing custom policy to widen workspace denies.

## Authority and progressive-disclosure map

| Layer | Visible default | Advanced detail |
| --- | --- | --- |
| Availability | Built in / Added to workspace / Not added | deployment source, runtime adapter, compatibility |
| Connection | Ready / Needs setup / Needs attention | principal, owner, scopes, expiry, last used, provider metadata |
| Scope | Workspace / Only me | subject-delegation and scheduled-task limitations |
| Session behavior | Available to select / Default for new sessions / Blocked by policy | effective policy, inherited source, mandatory/deferred/dropped IDs |
| Trust | OpenGeni / Verified library / Community | provenance, source URL/commit, content hash, live probe receipt |
| Composition | Pack summary | tools, skills, connectors, knowledge, schedules, variable set, runtime image |

## Information-architecture options

### Option A — Lifecycle hubs (recommended)

Top level: **Current · Discover · Connections · Custom**

- Current answers what agents can do now, what needs attention, what is built in, what was added, and what new sessions inherit.
- Discover contains recommendations, packs, curated skill library, categories, and the dense searchable catalog. MCP/public registry is an advanced filter/source, not a primary tab.
- Connections contains Google Drive, Slack personal, Slack workspace bot, Linear, Mobbin, GitHub App, social accounts, and future providers. One provider can have multiple explicit principals.
- Custom contains add-by-URL/domain, custom MCP/API/plugin/skill, registered packs, import/probe diagnostics, and policy/precedence details.

Tradeoffs:

- Best alignment to the five user questions and authority boundaries.
- Ordinary users can avoid provider taxonomy and catalog volume.
- Technical users need one extra click to reach raw catalog/custom controls.
- Requires the route to maintain view state and deep links, but can preserve all existing actions and APIs.

### Option B — Unified inventory table with saved views

One inventory, with saved views: Ready now, Needs setup, Recommended, Connections, Custom; a dense table exposes status, scope, source, type, and actions.

Tradeoffs:

- Excellent for enterprise audit and fast bulk scanning.
- Strongest single mental model for power users.
- Too much mixed vocabulary for founders; connection principals and pack composition become awkward rows.
- Mobile needs a materially different representation and risks hiding essential distinctions in horizontal disclosure.

### Option C — Job-based guided home

Top level: **Use your tools · Add for a job · Connect accounts · Build advanced** with a setup checklist and role recommendations.

Tradeoffs:

- Best first-run comprehension and recommendation quality.
- Makes packs and intended-work onboarding natural.
- Creates duplicate placement and weaker deterministic inventory/audit.
- Requires role/personalization data that does not yet exist; risks feeling promotional rather than operational after setup.

## Recommended structure and behavior

### Current

- Compact health summary: Ready now, Needs attention, Connections, Available to new sessions.
- Attention queue first; no giant success cards.
- Compact grouped list:
  - Added to workspace
  - Platform capabilities (built in)
  - Specialist/default skill migration notice during rollout only
- Columns/metadata: status, scope, session-default effect, source/type.
- Row click opens the existing detail sheet; inline action is only the single safe frequent action (repair, configure, or disable when allowed).

### Discover

- First-run: 3–5 job recommendations and packs, never provider setup cards.
- Search is sticky inside the route viewport.
- Default source set: OpenGeni + verified library + configured/added; community registry is an explicit “Search public registry” expansion.
- Facets: category, works with, capability format (advanced), trust/source (advanced), connection requirement, scope availability.
- Results use 40px desktop density and 48px mobile rows. Render a bounded window with stable focus; do not use a card grid for 600+ items.
- Exact result count and active filters are announced. Search matches visible curated fields, not a serialized metadata dump.

### Connections

- Provider list ordered by attention, then connected, then available.
- Each principal is explicit:
  - Slack — Your Slack account · Only me
  - Slack — OpenGeni workspace bot · Workspace
  - Google Drive — connected Google account · Only me; knowledge destination shown separately
- Rich setup/configuration lives in the detail area, not above the global catalog.
- Health states: connected, paused, needs re-consent, needs reconnect, provider app unavailable, disconnected, loading/unverified.

### Custom

- Add MCP server by URL/domain.
- Add API/skill/plugin metadata only with truthful runtime-adapter warning.
- Register/manage packs.
- Advanced inventory/provenance/import diagnostics.
- Workspace policy and skill precedence are visible here, but workspace denies are not editable by sessions and cannot be overridden downstream.

## Default specialist skill decision

Confirmed source truth:

- PRs #520 and #558 moved only Azure Verified Modules to the opt-in curated library.
- Seven directories remain deployment-default: `checkov`, `refactor-module`, `social-media-marketing`, `terraform-search-import`, `terraform-stacks`, `terraform-style-guide`, `terraform-test`.
- No existing Linear issue or PR owns removing the broader specialist bundle.

Recommendation:

1. Keep a very small provider-neutral universal core only if a skill is broadly useful to nearly every agent; none of the six Terraform/Checkov skills meet that threshold.
2. Move the six Terraform/Checkov skills into an immutable **Infrastructure / Terraform** library collection or pack, discoverable and opt-in at workspace scope.
3. Do **not** move `social-media-marketing` in the same minimal change. The built-in marketing pack currently declares no runtime skills and relies on the universal bundle; moving it before built-in pack-to-library composition exists would silently remove the pack's guidance. Make that a separate follow-up: let the marketing pack select the immutable library artifact, verify materialization, then remove the universal copy.
4. Do not delete artifacts. Preserve stable IDs, provenance, version/hash, and migration visibility.
5. Migration should stop materializing the six infrastructure skills for future turns after the deployment changes. Because current sessions do not pin workspace skill-library selections, this is a real behavior change and needs explicit release notes plus regression coverage.
6. Do not couple this migration to Azure inference, credentials, or cloud permissions; a skill contributes guidance only.

Verified implementation seam:

- `packages/core/src/domain/capabilities.ts` discovers every immediate directory in `bundled_hashicorp_terraform_skills` as a `built_in` skill; `applyCapabilityEnablement` makes it always enabled.
- `packages/runtime/src/index.ts` mounts the same directories into every agent and reports them as `deployment default skill bundle` selections.
- `packages/runtime/src/skill-library.ts`, `packages/core/src/domain/capabilities.ts`, and `apps/worker/src/activities/packs.ts` already provide the complete opt-in path: immutable metadata, whole-artifact SHA-256, provenance, catalog activation, runtime readiness, and workspace materialization.
- The smallest coherent migration is therefore to move the six infrastructure artifact directories into `bundled_skill_library`, add reviewed immutable entries, and update catalog/runtime/docs/tests. It does not require a database migration or new runtime model.

## integrations.sh delta decision

The current OpenGeni snapshot is not a safe proxy for the live upstream catalog:

- OpenGeni snapshot hash `69f4c411…`, generated July 3 and cleaned July 25, contains 620 unique probed MCP endpoints.
- Live `/api.json` is now a lightweight 5,758-surface v1 index rather than the endpoint/auth/transport records OpenGeni's importer expects.
- OpenGeni normalizes current upstream to zero and deliberately falls back to the old committed snapshot, so refresh appears successful while remaining stale.
- Upstream domain pages and publishing guidance now use a v3 owner-declaration/discovery model.
- Current upstream metadata contains substantial useful breadth but also missing endpoints, templated/local/HTTP endpoints, duplicates, changed endpoints, and owner statements that are not equivalent to OpenGeni verification.

Recommendation:

- Replace the direct `/api.json` refresh contract with a reviewed, versioned v3 snapshot adapter.
- Stable identity: `(ownerDomain, surfaceType, slug)`, with endpoint as mutable, security-reviewed metadata rather than identity.
- Preserve `basis.via` and evidence; label `declared` as owner-provided, not “verified”.
- Keep Discoverable separate from Connectable/Runtime ready.
- Require HTTPS, concrete public endpoint, supported streamable transport, supported auth discovery/contract, safe URL checks, and a live initialize/list-tools probe before enablement.
- Quarantine endpoint changes, duplicate endpoints across owners, templates, local/stdio-only entries, unknown auth, and schema incompatibility for review.
- Do not expose OpenAPI/GraphQL/CLI rows as executable until adapters exist; they may appear in Advanced discovery with truthful metadata-only status.

## Prototype acceptance matrix

The prototype must demonstrate:

- desktop 1440×900 and mobile 390×844;
- first-run/empty, connected current state, attention/error, and loading;
- Current, Discover, Connections, Custom navigation;
- search, category/source/connection filters, and 637-item bounded rendering;
- row/detail configuration, connect/reconnect/disable transitions, personal/workspace ownership;
- Slack's two principals and Google Drive inside Connections;
- keyboard tabs/search/results/detail/close flow with exact focus restoration;
- 44px coarse-pointer targets, focus visibility, color contrast, reduced-motion-safe transitions;
- no full-catalog DOM render and no stale results after search/filter changes.

## Owner audit hypotheses against the frozen prototype

These are owner observations against the frozen prototype, not accepted findings yet:

1. The Discover hero gives Infrastructure/Terraform one of only three prime recommendations. That may over-promote a specialist domain for ordinary workspaces even though the library itself should remain easy to find.
2. Loading skeletons and failed-load panels are visually distinct but do not currently expose an explicit route-level `aria-busy`/live status contract.
3. The Connections summary chip “Workspace shared by default” describes the generic ownership selector but is weaker than direct authority language such as “Workspace shared” versus “Personal · only you.”
4. On narrow screens, the horizontal lifecycle tabs deliberately reveal part of the next item, but the last tab starts off-screen; keyboard behavior is correct, while discoverability of horizontal scrolling still needs visual/accessibility judgment.
5. The browser fixture reports one pack in the capability catalog but returns an empty `/packs` response. In a real workspace the built-in pack makes `showPacks` true, so the full pack-management section can still render above the dense library without the user choosing “Browse packs.” That contradicts the lifecycle hierarchy and needs a real-pack regression.
6. “Other connected capabilities” currently includes every enabled row with a `connectionRef`, including the already dedicated personal Slack principal, so Slack can appear twice within Connections.
7. The “Built in” summary metric includes both `built_in` and deployment-`configured` rows; the label is narrower than the counted authority sources.
8. An available OAuth/API-key item with no chosen connection currently falls through to scope “Workspace,” even though the detail sheet lets the user choose Workspace or Only me. Discovery should not claim an authority decision before it is made.
9. Pack cards always expose “Unregister,” including built-in packs that the API deterministically rejects with `409 built-in packs cannot be unregistered`. The route already has pack catalog source truth, so the production UI can hide that action for built-ins without changing the API contract.
10. Axe is clean, but several frequent mobile controls are below the intended 44px coarse-pointer contract: lifecycle tabs are 40px, category chips and small buttons are 32px, and the row chevron target is 40px. These need targeted `pointer-coarse` sizing rather than globally inflating desktop density.
11. Result counts, loading, and failed-load transitions have no explicit live-status contract. The visual states are strong, but assistive technology is not told when 637 results become 623, when loading begins/ends, or when a retry fails.
12. Incremental rendering is bounded to 48 rows, but the sentinel is entirely silent and has no manual fallback or “Showing 48 of 636” state. This is efficient visually but weak for keyboard/screen-reader understanding and for browsers where intersection observation is unavailable.
13. Catalog search still indexes `JSON.stringify(item.metadata)`, so a result can match invisible implementation metadata that the row/detail surface never explains. A task-oriented library should search deliberate public fields/aliases rather than arbitrary serialized metadata.
14. `Capabilities` is not keyed by `workspaceId` in `App.tsx`, while the route retains catalog, generic connections, social connections, selections, callback guards, and in-flight requests across prop changes. A fast workspace switch can expose prior-workspace identity metadata in Connections and let an older response win. Other tenant-sensitive routes already use `key={workspaceId}`; remounting this route at the tenant boundary is the smallest robust fix and should receive a switch-race regression.

## Independent critique synthesis

### Visual/browser critique — BLOCK on frozen checkpoint

Substantive findings accepted:

- mobile lifecycle navigation clipped the final tab and did not meet the intended coarse-pointer target contract;
- Discover said “work, not technology” but immediately exposed format/source/MCP taxonomy and the full 637-row catalog;
- mobile inventory hid scope while keeping the less important format label;
- Google Drive still dominated the first Connections viewport and wrapped destructive controls awkwardly;
- initial load errors duplicated the inline recovery state with a toast and over-emphasized raw technical identifiers.

Direction retained as successful: desktop Current hierarchy, compact row discipline, explicit empty/loading composition, sticky search, and bounded 48-row rendering.

### Persona / information-architecture critique — BLOCK on semantics, PASS on shell

Substantive findings accepted:

- “Ready now” / “Available now” overstated subject-owned connections that require explicit delegation;
- workspace availability and an individual session's effective tool selection were described but not represented as separate facts;
- the lifecycle shell is calmer for founders, but administrators and developers still need state, authority, runtime readiness, and pack composition exposed independently in details;
- the infrastructure job path must connect the specialist collection/skills coherently without promoting it as a universal recommendation.

The lifecycle-hub architecture remains recommended, with truthful labels and an explicit handoff to session-level effective-tool inspection rather than pretending this page can edit that policy today.

### Adversarial interaction/state critique — BLOCK on frozen checkpoint

Substantive findings accepted:

- overlapping mount/callback/manual refreshes were last-response-wins and could overwrite newer catalog or connection state;
- mutation handlers announced settled success even when their authoritative post-mutation refresh failed;
- generic connection-list failures could be misread as “not installed,” particularly for Google Drive and the workspace Slack bot;
- a deleted API-key connection could disappear between planning and update, leaving reconnect without the existing fresh-row recovery path;
- Google Drive folder navigation and public-registry searches needed latest-request fencing;
- built-in pack unregister, configured/built-in labeling, and personal connection versus knowledge-destination authority needed more truthful presentation.

### Iteration applied locally after critique

The second reversible prototype now:

- remounts Capabilities on `workspaceId` and generation-fences catalog refreshes, OAuth refresh commits, registry searches, and Drive folder browsing;
- reports “Workspace ready” and “Available to select,” marks personal rows “Delegation required,” and keeps scope visible on mobile;
- defaults Discover to enabled/OpenGeni/configured/verified-library rows, requires explicit community expansion, moves format/source into disclosure, and excludes invisible metadata from search;
- gives incremental rendering an announced `Showing N of M` state and manual Show more fallback;
- fits all four tabs at 390px, raises mobile targets, and adds reduced-motion-safe transitions where introduced;
- renders a real built-in pack fixture only after explicit pack selection and hides its impossible unregister action;
- leads Connections with ordinary connection health, excludes the dedicated personal Slack row from the generic list, and makes Drive compact with separate personal identity and knowledge-destination scope;
- distinguishes “change saved but refresh failed” from fully refreshed mutation success, and treats unknown Slack/Drive health as unavailable rather than disconnected/installable.

Validation on August 4, 2026:

- 97 directly affected unit/component tests pass (291 expectations);
- legacy capability browser suite: 5/5 pass (47 expectations);
- redesigned experience browser suite: 4/4 pass (56 expectations), including 637-item desktop density, 390px mobile/reduced-motion/empty state, loading/error recovery, axe checks, and deliberately reversed overlapping-refresh responses;
- all 23 repository typecheck projects pass;
- the independent accessibility critic remains queued on connected Codex capacity. No alternate inference provider was used. The owner-run browser suite has zero axe violations in all asserted states, exact tab keyboard checks, 44px mobile tab checks, reduced motion, focus-restoration regressions in the legacy suite, and overflow assertions, but this is not represented as a substitute for independent review.

No production skill/default, API, database, Linear, PR, merge, release, or deployment mutation has occurred.

Screenshot evidence in the prototype checkpoint:

- `current-desktop-1440x900.png`
- `discover-desktop-1440x900.png`
- `connections-desktop-1440x900.png`
- `custom-desktop-1440x900.png`
- `current-mobile-390x844.png`
- `connections-mobile-390x844.png`
- `first-run-empty-mobile-390x844.png`
- `loading-desktop-1440x900.png`
- `error-desktop-1440x900.png`

## Founder-level decision checkpoint

Recommended decision: approve Option A and the specialist-skill migration direction, while keeping integrations.sh schema repair as a separate focused follow-up from the initial Capabilities UX PR unless the smallest coherent UX slice requires new trust/status fields.

The reversible prototype can proceed before approval. Production data-model migration, default-skill removal, catalog sync changes, PR creation, merge, release, and provider/cloud changes remain fenced until the coordinator checkpoint.

## Bounded post-critique implementation slice

If Option A is approved, the focused production PR should contain only:

1. **Tenant boundary:** key the Capabilities route by `workspaceId`; add a fast workspace-switch/race regression.
2. **Current:** rename the combined built-in/configured metric to truthful platform/deployment language; retain compact attention-first rows.
3. **Discover default:** show current + OpenGeni + configured + verified-library capabilities by default; disclose the full community catalog intentionally. Search/filter copy must explain when the full library is being searched.
4. **Discover controls:** keep task categories visible; move format/source taxonomy into one progressive “Filters” disclosure; remove arbitrary serialized metadata from search matching; announce result/filter changes.
5. **Packs:** render pack management only after Browse packs / Packs selection; use catalog source truth to hide Unregister for built-ins; add a real `/packs` browser fixture rather than catalog-count-only coverage.
6. **Connections:** put compact health rows for ordinary connected capabilities first; exclude the dedicated personal Slack principal from that generic list; make Google Drive a compact expandable/configure surface so provider setup does not consume the first mobile viewport.
7. **Authority copy:** show “Choose scope” before an OAuth/API-key ownership decision; preserve Workspace versus Only me in mobile rows; remove the ambiguous “Workspace shared by default” summary phrase.
8. **Responsive/accessibility:** make all four lifecycle tabs fit at 390px, retain 44px coarse-pointer targets, add explicit loading/error/result live semantics, provide a manual “Show more” fallback with `Showing N of M`, and disable nonessential animation under reduced motion.
9. **Error behavior:** use the inline retry state for initial-load failure without duplicating the same error in a toast; keep technical references subordinate to human recovery copy.
10. **Specialist defaults:** move the six byte-identical infrastructure skills from deployment default to immutable opt-in library entries; retain `social-media-marketing` until built-in pack-to-library composition is implemented and tested.

Explicitly out of scope for this PR: integrations.sh v3 ingestion/schema repair, bulk capability operations, session-default policy editing, built-in pack runtime skill composition, social-media skill migration, new provider OAuth behavior, database migrations, OPE-165, and unrelated release lanes.