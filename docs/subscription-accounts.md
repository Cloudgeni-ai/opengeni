# Subscription accounts: behaviour contract

This is the provider-neutral contract for subscription-backed model accounts:
accounts a person signs into with a consumer or team plan, today Codex
(ChatGPT), Claude and SuperGrok (xAI). It states the target behaviour that one
shared subscription core must provide for every provider and every consumer.
Provider-specific code is limited to the adapter surface in
[Provider adapters](#provider-adapters).

The entry-point inventory, per-provider capability matrix and Codex audit live
in [subscription-accounts-inventory.md](subscription-accounts-inventory.md).
Existing provider documents describe current behaviour and remain authoritative
for it until the matching requirement below is implemented:
[codex-subscription-rotation.md](codex-subscription-rotation.md),
[codex-provider-account-authority.md](codex-provider-account-authority.md) and
[supergrok-subscription.md](supergrok-subscription.md).

## How to read this contract

- Every requirement has a stable ID (`SUB-<AREA>-<NN>`). IDs are never reused
  or renumbered; a retired requirement keeps its ID and is marked
  `Verification: retired.`
- Each requirement ends with a `Verification:` line. It lists the test files
  (unit `*.test.ts(x)`, integration `*.integration.ts` or end-to-end
  `*.e2e.ts`, anywhere CI discovers tests) that assert the requirement, or
  `pending` with the work item (see
  [Work items](#work-items)) that will add them, or `retired`. A test asserts a requirement
  by naming its ID in its title: the first string argument of a `test`, `it`
  or `describe` call. IDs in comments, other strings, or skipped and `todo`
  tests do not count.
- A test that exercises a requirement without verifying the product, such as
  the reference model's own tests (see [Verification](#verification)), names
  it with the `model:` marker, for example `model:SUB-WAIT-01`. The checker
  still requires the ID to be defined here, but a `model:` mention never
  counts as verification, so it cannot satisfy a `Verification:` line or make
  a `pending` requirement look covered.
- `bun run check:subscription-contract` runs as the `subscription-contract`
  source guard on every CI plan (full, focused and documentation-only), and
  `scripts/check-subscription-contract.test.ts` runs the same check as a unit
  test. It fails when an ID is duplicated, has no verification line, names a
  missing test file, names a test file none of whose titles names the ID,
  names an unknown work item, or when a test file mentions an ID (anywhere,
  including comments) that this document does not define.
- "Must" is a requirement. "Current state" notes describe main today and are
  informative only.

## Scope and boundary

- **In scope:** accounts a person signs into (Codex, Claude, SuperGrok) and
  every consumer that spends them: chat turns, scheduled tasks, child agents,
  goal continuations, context compaction, transcription, realtime voice, image
  and video generation, the workspace tool gateway, billing and limits, the
  API and SDK, and the browser and native clients.
- **Adjacent:** API-key connectors (OpenRouter, Vercel AI Gateway, Anthropic
  API, Opper and later ones) are not subscription accounts. They do not sign
  in, have no plan windows to rotate between, and are not pooled. They must
  still fit the same connection, scope, eligibility and selection interfaces
  so that cross-provider failover and future non-agent model consumers (tools
  and background processes that call a model directly) can use them without a
  parallel framework.

## Terms

- **Connection:** one signed-in provider account with its encrypted
  credential, health and plan metadata.
- **Scope:** where a connection may be used: the whole organization, chosen
  workspaces, or chosen people.
- **Personal connection:** a connection scoped to exactly one person.
- **Pool:** the connections of one provider that are eligible for a given
  piece of work.
- **Session account binding:** the account a session currently runs on.
- **Explicit choice:** a person deliberately chose an account (or "only this
  model/account") for a session. Everything else is an automatic choice.
- **Capacity wait:** a durable, explained wait for an eligible account.
- **Failover:** moving work to another eligible account because the current
  one cannot serve it.
- **Cold cache:** the provider prompt cache for the session's current account
  has predictably expired, so switching accounts costs nothing extra.

## Requirements

### Ownership and scope

- **SUB-OWN-01** Connections are owned by the organization. A workspace
  never owns a connection. Verification: pending (data-model).
- **SUB-OWN-02** A connection's scope is one of: the whole organization,
  a set of chosen workspaces (with a separate switch for Personal workspaces),
  or a set of chosen people. Verification: pending (data-model).
- **SUB-OWN-03** A personal connection is scoped to one person and is usable
  in every workspace that person can use, including their Personal workspace,
  without exposing private workspace inventory to administrators.
  Verification: pending (personal-connections).
- **SUB-OWN-04** An organization administrator can delegate management of a
  connection to a workspace administrator; ownership stays with the
  organization. Verification: pending (data-model).
- **SUB-OWN-05** An organization administrator can disable personal
  connections for the whole organization. Disabling stops new selection of
  personal connections; work already running on one moves at its next safe
  point under SUB-ACCESS-06. Verification: pending (personal-connections).
- **SUB-OWN-06** Widening a personal connection to workspaces or the
  organization turns it into a shared connection and shows a short notice
  that consumer plans may limit use to the account holder.
  Verification: pending (personal-connections).
- **SUB-OWN-07** Who connected an account is audit metadata, never
  ownership or authority. Verification: pending (data-model).
- **SUB-OWN-08** One upstream provider account is one connection per owner,
  however many workspaces it serves, so its quota is counted once.
  Verification: `packages/db/test/subscription-core-m2-postgres.test.ts`
  (provider-account uniqueness per organization/provider/owner).

### Settings and overrides

- **SUB-SET-01** Rotation (Primary first or spread), cross-provider failover
  (on or off, plus the fallback order), personal connections allowed, and
  personal fallback allowed are organization settings with defaults.
  Verification: pending (data-model).
- **SUB-SET-02** A workspace administrator can override any of those settings
  for their workspace unless an organization administrator has locked it.
  Verification: pending (data-model).
- **SUB-SET-03** Every setting resolves to one effective value with a source
  ("Organization default" or "Overridden in this workspace"), and selection
  uses only the effective value. Two settings can never both apply to the same
  pool. Verification: `packages/db/test/subscription-core-m2-postgres.test.ts`
  (SQL/TypeScript settings parity and source resolution).
- **SUB-SET-04** Every settings screen shows the effective value and its
  source, with a one-step reset to the organization default.
  Verification: pending (product-surface).
- **SUB-SET-05** One organization overview lists every workspace's effective
  settings and highlights overrides. Verification: pending (product-surface).
- **SUB-SET-06** Per workspace and provider, effective settings can turn the
  provider off or stop using organization accounts, without changing any
  connection's scope or the workspace model allowlist. Verification:
  `packages/db/test/subscription-core-m2-postgres.test.ts` (provider switch
  overrides and SQL/TypeScript parity; M2 has no production selector).

### Eligibility

- **SUB-ELIG-01** Work may use only connections whose scope includes the
  work's workspace (or, for a personal connection, its owner under
  SUB-ELIG-05). Verification: pending (data-model).
- **SUB-ELIG-02** Workspace model restrictions are a ceiling on every
  selection, including failover. When the session's preferred model is
  outside the restriction, selection uses the first allowed model in its
  failover order, under the same rules as any other failover; it waits on the
  restriction only when no candidate model is allowed, for example under
  "only this model" (D-17). Verification: pending (failover).
- **SUB-ELIG-03** An account is eligible for a model only when its plan
  entitles it to that model, it is not cooling down for that model, and the
  connection's access policy allows the model. This is automatic filtering,
  not a user setting. Verification: pending (shared-core).
- **SUB-ELIG-04** Credential health and allocator eligibility are separate.
  Reconnecting restores health without silently changing allocator
  eligibility. Verification: pending (shared-core).
- **SUB-ELIG-05** A personal connection serves only its owner's own work in
  their private sessions and Personal workspace. Shared team work is funded by
  organization connections. Verification: pending (personal-connections).
- **SUB-ELIG-06** Unknown or stale quota stays unknown. Missing metadata never
  manufactures exhaustion: an account with unknown quota is eligible and
  counts as able to serve. It never ranks ahead of an account with known
  capacity, except that a Primary-first primary keeps precedence
  (SUB-SEL-03, D-15). Verification: pending (verification-suite).

### Selection

- **SUB-SEL-01** Automatic selection prefers organization connections.
  Verification: pending (shared-core).
- **SUB-SEL-02** A personal connection is selected only when its owner chose it
  explicitly for the session, or when the owner opted in to "fall back to my
  account when the organization pool is exhausted" (off by default).
  Verification: pending (personal-connections).
- **SUB-SEL-03** Primary first places new work on the primary account while
  it can serve the work (unknown quota counts as able to serve,
  SUB-ELIG-06); when it cannot, failover moves to the next eligible
  account (SUB-FAIL-02). Spread distributes new sessions fairly across
  eligible accounts. Neither mode moves a session whose cache is warm.
  Verification: pending (shared-core).
- **SUB-SEL-04** A manual pin to an account is binding: the session waits for
  that account instead of moving. Verification: pending (shared-core).
- **SUB-SEL-05** Selection is atomic and concurrency-safe: concurrent
  reservations cannot oversubscribe the primary account or bypass fairness.
  Verification: pending (verification-suite).

### Stickiness and the prompt cache

- **SUB-STICK-01** The account belongs to the session, not to whoever sends
  the message. Verification: pending (cache-stickiness).
- **SUB-STICK-02** While the prompt cache is warm, a session keeps its account
  across turns, senders, goal continuations, scheduled runs on the same session
  and recovery. Child sessions and new scheduled sessions have their own prompt
  cache and start with an automatic choice. Verification: pending (cache-stickiness).
- **SUB-STICK-03** A session moves to another account only when forced
  (exhausted, disconnected, revoked, out of scope, owner left) or when the
  cache is predictably cold. Verification: pending (cache-stickiness).
- **SUB-STICK-04** Cache coldness is exact for Claude: the session has been
  idle longer than the cache lifetime OpenGeni sent, which each cache read
  refreshes. For Codex and SuperGrok the cut-off comes from recorded cached
  token counts against idle time, with a conservative default until measured.
  Verification: pending (cache-stickiness).
- **SUB-STICK-05** Compaction and a model change are re-selection points
  regardless of idle time. Verification: pending (cache-stickiness).
- **SUB-STICK-06** At a re-selection point only automatic choices are
  re-evaluated; an explicit choice is kept. Verification: pending (cache-stickiness).
- **SUB-STICK-07** A session that was started on a personal account and is
  later shared stops using that account at once, even while its cache is
  warm: SUB-ELIG-05 takes precedence over stickiness, so the personal account
  is out of scope for the shared session (SUB-STICK-03). Its next turn moves
  to an eligible organization account, or waits if none can serve.
  Verification: pending (cache-stickiness).

### Exhaustion and failover

- **SUB-FAIL-01** Failover is automatic. No person has to press a button for
  work to continue on another eligible account.
  Verification: pending (failover).
- **SUB-FAIL-02** Failover first tries another eligible account of the same
  provider. Verification: pending (failover).
- **SUB-FAIL-03** When the effective setting allows it, failover then moves to
  another provider using the organization's fallback order for the model,
  mapping the reasoning level to the nearest level the target supports:
  the same level name when the target has it; otherwise the target level
  whose relative position on the target's ladder (lowest 0, highest 1) is
  closest to the requested level's position on the preferred model's ladder,
  with a tie going to the lower level. A level the preferred model does not
  list maps to the middle of the target's ladder (the lower middle when there
  are two) (D-16). Verification: pending (failover).
- **SUB-FAIL-04** Failover never widens access: it uses only allowed models
  and in-scope connections. Verification: pending (failover).
- **SUB-FAIL-05** A session explicitly limited to one account or model ("only
  this") waits instead of failing over. Verification: pending (failover).
- **SUB-FAIL-06** Every switch is recorded as a visible session event with the
  reason, and the session model indicator shows what is running.
  Verification: pending (failover).
- **SUB-FAIL-07** After a cross-provider failover, the session returns to the
  preferred model once that model has capacity and the current cache is cold.
  Verification: pending (failover).
- **SUB-FAIL-08** Exhaustion in the middle of a turn continues the same
  accepted turn on the fallback at the next model-call boundary, re-checking
  funding for the new provider and dropping provider-specific history items
  from the request copy, while keeping completed tool calls and accounting
  entries without repeating them. Verification: pending (failover).
- **SUB-FAIL-09** New sessions whose model has an effective cross-provider
  fallback use portable compaction. An existing Codex remote-compaction session
  converts to portable compaction at its next compaction while Codex has
  capacity; until then it fails over only within Codex and otherwise waits
  with an explained reason. Verification: pending (failover).
- **SUB-FAIL-10** Voice, transcription and media generation do not fail over
  across providers in the first release. Verification: pending (consumers).
- **SUB-FAIL-11** Failover within one turn is bounded and recorded per account,
  so a turn cannot alternate between failing accounts indefinitely.
  Verification: pending (failover).

### Durable waits and recovery

- **SUB-WAIT-01** Work waits only when nothing eligible has capacity, or when
  SUB-SEL-04 or SUB-FAIL-05 forbids moving. Verification: pending (failover).
- **SUB-WAIT-02** A wait is durable, explains its reason and expected reset
  where known, and resumes automatically when capacity returns or the pool
  changes. Verification: pending (verification-suite).
- **SUB-WAIT-03** Waits survive worker loss, workflow continue-as-new and
  replay of existing workflow histories. Verification: pending (verification-suite).
- **SUB-WAIT-04** Pause, resume and cancel are respected while waiting.
  Verification: pending (verification-suite).
- **SUB-WAIT-05** A wait that cannot be armed surfaces as an explicit,
  retryable state, never as a generic activity failure. Database outages keep
  their exact-attempt recovery path. Verification: `apps/worker/test/subscription-capacity-arming.test.ts`.

### Authority and session access

- **SUB-ACCESS-01** The pool authority accepted for a piece of work is frozen
  on it and carried by recovery, goal continuations, child agents, scheduled
  runs, compaction and coalesced internal updates. A turn created by an agent
  message or Agent Steer takes the receiving session's pool, not the
  sender's, and non-human acceptance resolves the workspace or organization
  pool instead of assuming workspace scope.
  Verification: pending (accepted-scope-propagation).
- **SUB-ACCESS-02** Pool authority is additive to session access. Using a
  shared pool never changes who can see a session.
  Verification: `packages/db/test/subscription-pool-private-session-access.test.ts`.
- **SUB-ACCESS-03** A private session arms, waits, is observed by the
  workflow, recovers and keeps pins exactly like a shared session.
  Verification: `packages/db/test/subscription-pool-private-session-access.test.ts`.
- **SUB-ACCESS-04** A pool worker never gains visibility of another member's
  private session. Verification: `packages/db/test/subscription-pool-private-session-access.test.ts`.
- **SUB-ACCESS-05** Revoking a connection or a person's access is enforced on
  the next selection, lease renewal and dispatch check.
  Verification: pending (shared-core).
- **SUB-ACCESS-06** When a personal connection's owner disconnects it, loses
  access or leaves the organization, work on it moves to an eligible
  organization account at the next safe point or stops with a clear message.
  It never moves to another person's account. Verification: pending (personal-connections).

### Leases and execution

- **SUB-LEASE-01** Each executing turn holds a lease on exactly one account.
  Leases fence turn ownership; they do not limit an account's concurrency.
  Verification: pending (shared-core).
- **SUB-LEASE-02** A stale worker cannot renew, release or settle its
  successor's lease. Verification: pending (verification-suite).
- **SUB-LEASE-03** Release is idempotent and expired leases are reaped.
  Verification: pending (shared-core).

### Usage and accounting

- **SUB-ACCT-01** Usage is attributed to the account, workspace, session and
  initiating person. Verification: pending (consumers).
- **SUB-ACCT-02** Retries and failover never duplicate usage or accounting
  entries. Verification: pending (verification-suite).

### Provider adapters

- **SUB-PROV-01** A provider adapter implements only: sign-in protocol
  (OAuth, device code, setup token), token refresh and renewal, request
  transport and wire format, quota observation decoded into the shared quota
  model, error classification into shared typed outcomes, cache-lifetime
  facts, and capability flags. Verification: pending (shared-core).
- **SUB-PROV-02** Provider differences are expressed as capability flags
  (for example: credential cannot auto-renew, has reset credits,
  model-specific entitlements, supports realtime, funds media generation),
  not as provider conditionals in shared code. Verification: pending (provider-migration).
- **SUB-PROV-03** Every provider passes the same lifecycle conformance
  scenarios against scripted local upstreams, with no external network
  traffic. Verification: pending (verification-suite).
- **SUB-PROV-04** API-key connectors fit the same connection, scope,
  eligibility and selection interfaces, so they can be failover targets and
  serve non-agent model consumers. Verification: pending (consumers).

### Provider-specific capabilities

- **SUB-APPS-01** The Codex Apps credential is authorized by its own explicit
  designation, independently of model routing. Changing where models are
  routed never excludes, replaces or widens it; an unavailable designated
  credential is reported with its own reason at most once per turn, and the
  designation can be cleared in every routing mode.
  Verification: `apps/api/test/codex-redemption-routes.test.ts`, `packages/db/test/codex-token-resolver.test.ts`, `packages/runtime/test/runtime.test.ts`.
- **SUB-APPS-02** Reset-credit redemption keeps its explicit human-controlled
  boundary and is never triggered by automatic selection or failover.
  Verification: pending (shared-core).

### Consumers

- **SUB-CONS-01** Every consumer listed in [Scope and boundary](#scope-and-boundary)
  obtains subscription accounts only through the shared core.
  Verification: pending (consumers).
- **SUB-CONS-02** A static check fails when code outside the core and the
  adapters selects, materializes or leases a subscription credential.
  Verification: pending (consumers).

### Product surface

- **SUB-UX-01** Every provider uses the same account rows (with email),
  multiple accounts, connect, reconnect, replace and disconnect.
  Verification: pending (product-surface).
- **SUB-UX-02** The model picker stays a list of models; the session account
  indicator shows which account and provider is running.
  Verification: pending (product-surface).
- **SUB-UX-03** Waiting, failover and recovery states read the same for every
  provider. Verification: pending (product-surface).

### Compatibility and rollout

- **SUB-COMPAT-01** Migration preserves existing credentials, scopes, pins,
  settings, accepted authority, live waits and workflow histories.
  Verification: pending (data-model).
- **SUB-COMPAT-02** Existing per-provider API and SDK shapes keep working as
  aliases that delegate to the core until they are versioned out.
  Verification: pending (rollout).
- **SUB-COMPAT-03** Cutover runs in shadow first (the old path decides, the
  core records its decision, and they are compared), behind a per-provider
  switch with a documented rollback. Verification: pending (rollout).

### Security and observability

- **SUB-SEC-01** Credentials never enter session history, events, run state,
  model-visible tool arguments, logs or the sandbox. Diagnostics are
  secret-safe. Verification: pending (verification-suite).
- **SUB-SEC-02** Fixtures, docs and tests use generated identities and
  reserved example domains only. Verification: pending (verification-suite).

## Work items

Pending requirements name the work item that will verify them. Work items are
delivered as separate pull requests in roughly this order.

| Work item | Delivers |
| --- | --- |
| `private-session-access` | Pool authority additive to session access for Claude and SuperGrok waits, recovery, pins and leases, with an explicit state when a wait cannot be armed. |
| `accepted-scope-propagation` | Agent messages, Steer and non-human acceptance freeze the receiving session's pool scope. |
| `codex-apps-binding` | Codex Apps credential loading, failure reporting and designation management independent of model routing. |
| `verification-suite` | Independent reference model, no-network provider conformance harness, concurrency, crash-ordering and replay suites, and the mutation gate. |
| `data-model` | One provider-keyed connection model: organization ownership, scopes, settings with lockable workspace overrides, and the migration of existing rows. |
| `shared-core` | The provider-neutral core and adapter interface, with Codex moved onto it and its old decision path deleted. |
| `provider-migration` | Claude and SuperGrok moved onto the core, deleting the generic duplicate paths. |
| `cache-stickiness` | Session account binding, cache-coldness prediction and re-selection points. |
| `failover` | Automatic same-provider and cross-provider failover, including mid-turn continuation and Codex remote-compaction sessions. |
| `personal-connections` | Person-scoped connections for every provider, explicit choice, opt-in fallback and the organization switch. |
| `consumers` | Compaction, transcription, realtime, media, tool gateway, billing and API-key connectors on the core, plus the no-bypass check. |
| `product-surface` | Shared account rows, scope and settings screens with effective values, the organization overview, session indicator and waiting states. |
| `rollout` | Shadow comparison, per-provider switch, rollback and removal of compatibility aliases. |

## Decision log

Decisions agreed with the product owner. Later decisions supersede earlier
ones where they conflict. Small cases found during implementation are decided
by the implementer and recorded here; consequential ones are escalated.

| ID | Date | Decision |
| --- | --- | --- |
| D-01 | 2026-10-06 | One provider-neutral core for every provider and consumer; providers keep only small adapters. Every capability exists for every provider. |
| D-02 | 2026-10-06 | Connections are organization-owned and scoped to the organization, chosen workspaces or chosen people. Accounts are never workspace-owned; existing workspace accounts migrate to organization accounts scoped to that workspace. |
| D-03 | 2026-10-06 | Organization accounts are preferred. Personal accounts are used only by explicit choice, or by an opt-in per-person fallback, and only in the owner's private sessions and Personal workspace. |
| D-04 | 2026-10-06 | The account belongs to the session. It sticks while the prompt cache is warm and re-selects only when forced or when the cache is predictably cold. |
| D-05 | 2026-10-06 | Exhaustion switches automatically to another eligible account. No "Continue" button. |
| D-06 | 2026-10-07 | Cross-provider failover is in scope (reverses the earlier working assumption of same-provider only). It is an organization setting with a fallback order. |
| D-07 | 2026-10-07 | Settings are organization defaults with optional workspace overrides that organization administrators can lock; the UI shows effective values, their source and an organization overview. This replaces the earlier "no per-workspace overrides" proposal. |
| D-08 | 2026-10-07 | The model picker stays a list of models. Any picker or settings UI change is previewed with real components before merge. |
| D-09 | 2026-10-07 | Voice, transcription and media generation do not fail over across providers in the first release. |
| D-10 | 2026-10-07 | Pool authority is additive to session access: pool-worker operations re-establish the acting turn's frozen initiating human. |
| D-11 | 2026-10-07 | The definition of done is evidence: requirement-to-test coverage, provider conformance, concurrency, crash and replay suites, migration checks and mutation tests, not a numeric confidence figure. |
| D-12 | 2026-10-07 | Implementer decision: when a person has opted in to personal fallback, the same model on their personal account is tried before cross-provider failover, because keeping the model is what they opted into. |
| D-13 | 2026-10-07 | Implementer decision: "Primary only" becomes "Primary first". The primary account takes new work while it can; a backup account is used when the primary cannot serve, instead of the work waiting while an idle eligible account exists. This removes the behaviour behind the original report of an unused second account. |
| D-14 | 2026-10-07 | Implementer decision: unknown quota is eligible but ranked after accounts with known capacity, so missing metadata neither blocks work nor wins over known capacity. |
| D-15 | 2026-10-07 | Implementer decision, precedence between D-13 and D-14: in Primary first, the primary takes new work whenever it can serve it, and unknown quota counts as able to serve. The known-capacity ranking of D-14 orders only the other accounts (and, in Spread, applies before load balancing), so a primary with unknown quota is not passed over for a backup. |
| D-16 | 2026-10-07 | Implementer decision: reasoning levels map by name first, then by closest relative position on the two ladders; a tie goes to the lower level (cheaper and less likely to exceed the target's plan), and an unlisted level maps to the lower middle. |
| D-17 | 2026-10-07 | Implementer decision: a preferred model that the workspace does not allow is treated like one without capacity. Work uses the first allowed model in the failover order (SUB-WAIT-01 permits no wait while an allowed model can serve) and waits on the restriction only when no candidate model is allowed. |
| D-18 | 2026-10-07 | Implementer decision: accounts connected in a Personal workspace migrate to personal connections of that workspace's owner, with their personal fallback switched on so their Personal-workspace sessions keep working. |
| D-19 | 2026-10-07 | Q-01 resolved after design review: remote compaction keeps no cleartext to convert at failover time, so cross-provider failover relies on portable compaction (SUB-FAIL-09). |
| D-20 | 2026-10-07 | Q-03 resolved after design review: any in-scope connection can be designated for Codex Apps by an organization administrator or the connection's delegated manager, in every routing mode; reset-credit redemption stays human-only from a browser session for those same people, not "whoever connected it". |
| D-21 | 2026-10-07 | Implementer decision: Spread uses a deterministic hash of the session id over eligible accounts (known capacity first), so placement needs no lock across sessions and a session lands on the same account every time. |
| D-22 | 2026-10-07 | Implementer decision: a wait reports the earliest future time at which something the session may use (its explicit choice, or an account it may use automatically) can serve it, counting quota resets and per-model cooldowns. Resets that have passed, and resets of accounts that could not serve the work anyway, are never reported. |
| D-23 | 2026-10-07 | Implementer decision: the Spread hash of D-21 is 32-bit FNV-1a over the UTF-16 code units of `<session id>\|<connection id>`, finished with the murmur3 32-bit finalizer, and the lowest value wins. Raw FNV-1a split three sequentially named accounts 50/25/25, which is not fair spreading. |
| D-24 | 2026-10-07 | Implementer decision: an explicit choice that can never serve the session's model waits with its own reason (`pinned_account_ineligible`) instead of looking like a temporary outage. That covers an account that is gone, no longer authorized for this work, of another provider, or not entitled or allowed for the model (SUB-ACCESS-06). An unhealthy, paused, exhausted or cooling-down chosen account waits as `pinned_account_unavailable` (SUB-SEL-04). |
| D-25 | 2026-10-07 | Implementer decision: workspace overrides of per-provider and per-model settings (rotation, provider switches, fallback order) apply entry by entry, and provider switches field by field, so overriding one provider never resets another. |
| D-26 | 2026-10-07 | Implementer decision: a provider switched off for the workspace (SUB-SET-06) and a compaction mode that ties a session to one provider (SUB-FAIL-09) restrict models exactly like the workspace model restriction of D-17. When the lock is what keeps a usable model away, the wait says so. |
| D-27 | 2026-10-07 | Implementer decision, following SUB-STICK-02 and SUB-STICK-03: turning personal fallback off (by the owner or the organization) stops new automatic selections of personal accounts but is not a forced move. A session whose cache is warm on its owner's personal account keeps it and moves at its next re-selection point. Sharing the session (SUB-STICK-07), revoking the account or the owner leaving (SUB-STICK-03, SUB-ACCESS-06) still move it at once, and disabling personal connections (SUB-OWN-05) moves it at its next safe point. |

### Open decisions

| ID | Question | Recommendation |
| --- | --- | --- |
| Q-02 | Is cross-provider failover on by default for new organizations? | Yes. |

## Verification

The executable reference model of this contract is
`packages/subscriptions/src/reference-model.ts`, published separately as
`@opengeni/subscriptions/reference` so production shadow comparisons can run
`checkDecision`; tests import it through `@opengeni/testing`. It is written
from this document, not from production code, and production placement never
imports it. `decide` returns the contract's
placement for a session (run on an account and model, or wait with a reason);
`checkDecision` checks any decision, including one made by production code,
against the contract's invariants, labelling each violation with the
requirement it breaks (an ineligible account names the precise
`SUB-ELIG-0x`, `SUB-OWN-05` or `SUB-ACCESS-06`). `checkDecision` is not
fully independent of `decide`: both use the same effective-settings,
eligibility, cache-warmth and reasoning-level helpers, so a mistake in a
shared helper would be invisible to the invariant check. Scenario tests pin
those helpers' behaviour directly. The model's tests name requirements with
the `model:` marker because they check the model, not the product. Its tests
generate thousands of worlds and
include a mutation gate: ignoring a pin, switching while the cache is warm,
using a personal account without an explicit choice, waiting while capacity
exists and crossing providers when forbidden are each caught by a named
requirement. Production conformance tests
(`packages/subscriptions/test/reference-conformance.test.ts` and
`reference-bridge.test.ts`) require every decision of the shared core's policy
package, `@opengeni/subscriptions`, to pass `checkDecision` and to equal the
model's decision. They run over generated reference worlds, multi-turn
trajectories, scripted scenarios
(`packages/testing/src/subscription-reference-worlds.ts`) and generated
production inputs that use features the model lacks (provider switches,
frozen personal authority, compaction locks, quota shapes), bridged to the
model. Requirements stay `pending` until production placement runs on the
core.

### Shadow comparison

Before any provider moves to the core (SUB-COMPAT-03), every Codex, Claude and
SuperGrok turn compares the core with the legacy selector. Right after the
legacy selection, the worker
(`apps/worker/src/activities/agent-turn/subscription-core-shadow.ts`) loads the
placement world for that session and turn from today's tables through the
legacy adapter (`packages/db/src/legacy-subscription-world.ts`). It then runs
the core's placement and the reference model's `checkDecision` on it.

It never changes placement and never delays the turn:

- it starts in the background after the legacy selection, and at most two run
  at once per worker process; further turns skip it (`busy`);
- it fails open on every error, timeout and cancellation;
- it reads under the turn's own session actor, so a private session is visible
  only through its frozen initiating human and never through an empty subject.
  A personal (user-scope) pool is read as that human, as the legacy selector
  reads it; other pools never read personal rows;
- its statements are SELECTs in one transaction, bounded by
  `OPENGENI_SUBSCRIPTION_CORE_SHADOW_TIMEOUT_MS` (default 250 ms, at most
  1000 ms), and no statement starts after that deadline. The transaction is
  `READ ONLY` for Codex. For Claude and SuperGrok, the credentials' row
  security records and removes its own transient capability row, exactly as
  legacy reads of those pools do, so those reads are not `READ ONLY`.

`OPENGENI_SUBSCRIPTION_CORE_SHADOW_ENABLED=false` turns it off; it is on by
default. It records only content-free data, in fixed-label metrics:

- `opengeni_subscription_core_shadow_comparisons_total{provider,parity,placement}`:
  whether the legacy account is inside the core's eligible set (security
  parity) and whether the core would place elsewhere or wait
  (would-switch);
- `..._parity_failures_total{provider,reason}`;
- `..._violations_total{provider,requirement}`;
- `..._inputs_total{provider,input}`: the legacy inputs the Codex fleet shadow
  omits, such as pins and their source, rotation, the pool in effect, model
  filters, plan exclusions, cooldowns and lease reuse;
- `..._skips_total{provider,reason}`;
- `..._duration_seconds{provider}`.

A throttled debug log line carries the per-decision record with per-session
aliases instead of connection ids.

The evidence gates for the whole programme (work item `verification-suite`) are: complete
requirement-to-test coverage (this document reaches no `pending` entries),
no-network provider conformance, concurrency, crash-ordering and replay
suites, migration checks, and mutation tests showing that dropping the
initiating human, ignoring a pin, omitting a wake revision, clearing a newer
cooldown, allowing stale settlement, repeating a completed tool, or switching
account while the cache is warm each fails a specific test. Skipped or missing
infrastructure never counts as passing.
