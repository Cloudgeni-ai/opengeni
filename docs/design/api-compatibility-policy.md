# ADR: Public API compatibility policy

Status: **Accepted** (2026-09-29), **revised 2026-11-03**. This is the
canonical policy. `AGENTS.md`, [`docs/architecture.md`](../architecture.md)
§3.10, the `opengeni` maintainer skill and the `opengeni-client` integration
skill summarize it and link here; change it here first. The exception log at
the end of this file is append-only.

## The rule

**Existing integrations keep working across every production update.** A
change to the public surface is additive, or it preserves the old behaviour
next to the new one. A major release, a changeset or an elapsed deprecation
period never authorizes removing, renaming or narrowing existing behaviour.

## Context

Product teams integrate against the managed service (`app.opengeni.ai`) with a
pinned `@opengeni/sdk` version, and we cannot force them to upgrade. We deploy
the API continuously.

The first version of this policy (2026-09-29) allowed a breaking change after
a deprecation, at least 90 days and a new SDK major. In practice the
announcement and waiting steps were skipped several times under explicit
exceptions (see the log), majors arrived quickly because every published
package shares one lockstep version, and the npm `latest` SDK (4.6.1 on
2026-11-03) lagged far behind the source (6.7.0). A major version therefore
said little about whether an integration would keep working.

On 2026-11-03 the product owner decided that Opengeni does not ship breaking
changes from now on. There were no external API users yet, so surfaces removed
before that date (see the exception log) stay removed and are not restored.
The rule applies to every change made after it.

## Decision

### (a) The public surface

The following are public. Integrators may depend on them, and they change only
under this policy:

1. **Routes.** Every `/v1` route (method + path) reachable through a public
   `@opengeni/sdk` method, together with its request and response shapes,
   including every route a **published** SDK version calls.
2. **Events.** The session event envelope (`SessionEvent`), the set of event
   `type` names (`SessionEventType`), and the event payload fields documented
   in the SDK types and docs.
3. **Package exports.** Every export of every `package.json` entry point of
   `@opengeni/sdk` and `@opengeni/react`, plus the public members of exported
   SDK client classes.
4. **Ingress formats.** Public routes that no SDK method calls, listed in
   `PUBLIC_INGRESS_ROUTES` (`scripts/public-api/surface.ts`), such as the
   OpenAI-compatible routes a stock OpenAI client calls.
5. **Documented behaviour** of all of the above: defaults, error codes,
   limits and semantics that the SDK docs or types describe.

The following are **internal**. They may change without notice:

- Routes that only the web app uses and that no public SDK method calls. This
  includes SDK methods whose JSDoc carries `@internal` from the start. Marking
  an existing public method `@internal` later is a removal.
- Provider callbacks whose format the provider owns: Stripe, GitHub, Slack,
  and OAuth.
- MCP transports, machine enrollment and NATS auth callout, and install
  scripts.
- The worker↔API and web↔API protocols, including the meaning of
  `x-opengeni-api-contract` for cookie sessions.
- The database schema.

`packages/sdk/README.md` § Compatibility repeats this summary for integrators.

### (b) Allowed and breaking changes

| Change | Status |
| --- | --- |
| New route, new optional request field, new response field, new event type, new export | Allowed |
| New enum or union value **in a response** or event | Allowed. Clients must tolerate unknown values |
| New enum value accepted **in a request** | Allowed |
| Required request field becomes optional | Allowed |
| Mark a member `@deprecated` and document its replacement | Allowed; it keeps working |
| Remove or rename a route, request field, response field, event type, export, or SDK method | **Breaking** |
| Change a field's type; make a request field required; make a response field optional or nullable | **Breaking** |
| Remove an accepted request enum or union value | **Breaking** |
| New required request field | **Breaking** |
| Stop honouring a documented behaviour, default or error code even though the shape is unchanged | **Breaking** (review) |

Tolerance runs in both directions:

- **Servers** accept every request that any published SDK could send.
  Strict request schemas are fine, provided an accepted field or value is
  never removed.
- **Clients** ignore unknown response fields, enum values, and event types.

**Versions describe releases, not compatibility.** All published `@opengeni/*`
packages share one lockstep version, so a major can happen for unrelated
reasons; it never permits a break. Official servers report their build through
`serverVersion`.

### (c) Evolving incompatibly: add, don't replace

When a design cannot be expressed compatibly, ship the new behaviour **next
to** the old one:

1. **Opt in, don't flip.** A new optional request field or option selects the
   new behaviour; omitting it keeps the old behaviour and defaults.
2. **Add, don't redefine.** Return new information in a new response field or
   event type instead of changing what an existing one means. Add a new error
   code alongside the old one rather than renaming it.
3. **New route or method for new semantics.** Keep the old route registered
   and answering as before.
4. **A new API version for a redesign.** Introduce the new version (for
   example a new route family or an explicit version field or header) beside
   the old one. Each version gets a thin, version-specific adapter (routing,
   validation and response mapping) over **shared application logic** in
   `packages/core`, so both versions stay correct without duplicating the
   domain code. The old version is not removed.
5. **Deprecate softly.** Mark the old member `@deprecated` with its
   replacement and update the docs. Deprecated surface keeps working; a
   deprecation never starts a removal clock.

Request-usage telemetry cannot yet show which customers use what, and absence
of recent traffic never proves a dormant integration is safe to break.

### (d) Exceptions

Only two reasons can justify a breaking change, and both are rare:

1. **An emergency security fix** that cannot be made compatible.
2. **An explicit, recorded approval from the product owner** for that specific
   change (a link to the PR comment or decision).

Every exception needs all of:

- an entry in `scripts/public-api/breaking-changes.json` with
  `"securityException": true` or `"approval": "<link>"`, plus the ids of the
  findings it covers and a reason;
- a row in the exception log below;
- a `Compatibility exception: <link>` line, outside code blocks, in every
  changeset that declares a major release of any package (all published
  packages share one lockstep version, so any major makes `@opengeni/sdk` and
  `@opengeni/react` majors). The link is a
  `https://github.com/Cloudgeni-ai/opengeni/...` URL or
  `docs/design/api-compatibility-policy.md#exception-log`;
- migration notes, and direct notice to affected integrators.

A security refusal of old contract revisions uses
`REFUSED_API_CONTRACT_REVISIONS` (`apps/api/src/app.ts`): the refusal is a
typed `409 API_CONTRACT_CHANGED` naming the minimum SDK version, never a
generic reload prompt.

### (e) The contract header only guards stale stock-web tabs

`x-opengeni-api-contract` exists so that a stale first-party browser tab
(cookie session) reloads onto the matching bundle before it writes. It is not
a versioning mechanism for integrations:

- **Bearer callers** (API keys, delegated tokens) are admitted with an older or
  missing revision. Only a revision in `REFUSED_API_CONTRACT_REVISIONS` is
  refused.
- **New SDKs** default to a compatible mode outside a cookie browser.
- **Bumping the revision** is a web-bundle event, never by itself a public API
  change.

### (f) Enforcement

| Check | Where | What it proves |
| --- | --- | --- |
| Public surface diff | `bun run check:public-api` (refresh: `bun run public-api:refresh`) | The candidate removes or narrows nothing the merge base exposed |
| Published SDK routes | `bun run check:public-api`, over `scripts/public-api/published-sdk.gen.json` | Every exact registered route (`METHOD /path`) a recorded published `@opengeni/sdk` call resolved to is still registered |
| Major releases | `scripts/ci/changeset-plan.ts` (PR fast checks and Batch) | The pending release plan does not release `@opengeni/sdk` or `@opengeni/react` as a major (directly or through the lockstep version group) unless every changeset declaring a major links an exception |
| Contract parity | `packages/sdk/test/contract-parity.test.ts` | SDK wire types match `@opengeni/contracts` |
| Review | PR template "External API impact" | Behaviour, defaults and payload semantics the static checks cannot see |

**Public surface diff.** `bun run check:public-api` regenerates
`scripts/public-api/surface.gen.json` from source:

- SDK call sites are matched to the routes the API actually registers.
- Contracts zod schemas are flattened from JSON Schema (`io: input` for
  requests, `output` for responses).
- SDK/React entry-point exports and SDK client members and signatures are
  collected.

It fails when the committed snapshot is stale (additive changes only need a
refresh), when a public SDK method calls a route the API does not register, or
when the diff against the snapshot on the merge base with `origin/main` has any
breaking finding not covered by an exception entry (d). Entries written under
the earlier major-based policy carry `removedInMajor`; they are history and
admit nothing new.

**Published SDK routes.** `scripts/public-api/published-sdk.gen.json` records,
per published SDK version, every route call extracted from the TypeScript
source the package ships (`@internal` methods excluded), together with the
exact registered routes (`METHOD /path`) each call resolved to at refresh. A
call resolves to the routes that match it exactly for each of its verbs; an
SDK placeholder may stand in for a route literal only when every literal the
SDK wrote lines up with a route literal. The check fails when the candidate API
no longer registers one of the stored routes, by method and path. Calls the
API had already dropped before 2026-11-03 (26 for 4.6.1) are listed as
`acceptedGaps` with their reason. A generic call with no literal after its
first placeholder (such as the 4.6.1 session proxy's `${base}/${area}/${id}`)
never resolves loosely; its real routes are pinned by hand in
`routeOverrides` with a reason, and refresh keeps them. After
each stable SDK publication, record the new version with
`bun run public-api:published-refresh` (defaults to the npm `latest` tag;
`-- --version X` for another); it keeps earlier versions and refuses to record
a new gap without `--accept-gaps "<reason>"`, which is only for an approved
exception.

The surface and published-SDK checks run as the `public-api` CI guard in full
mode and whenever the impact plan touches `@opengeni/api-router`,
`@opengeni/contracts`, `@opengeni/sdk`, or `@opengeni/react`, including
anything those packages depend on. The changeset guard runs on every PR.

### (g) Internal cutovers remain allowed

Maintenance migrations, worker/web protocol changes, Temporal or NATS
changes, and web-only route changes stay allowed if the public surface is
unaffected. The checks prove the route, schema, and export part of that claim.
The pull-request template asks every change for its external API impact.

## Consequences

- Additive PRs that touch the surface must commit a refreshed snapshot. This
  is a mechanical `bun run public-api:refresh`.
- The static checks derive from what the SDK declares and from
  `@opengeni/contracts`. They do not cover:
  - SDK-only types without a contracts schema (only the name, presence and
    signature of the SDK method are tracked);
  - opaque event payload internals;
  - request and response shapes of older published SDKs (only their routes);
  - semantic behaviour changes.

  Review owns these, guided by the PR template and the major-changeset guard.
- There is no behavioural old-SDK test suite yet. Add one, running a
  published SDK against a candidate server, when an integration pattern
  becomes load-bearing.

## Follow-ups

- **Published React routes.** The published `@opengeni/react` session UI
  reaches routes through the session proxy that no inventory records yet.
  Record them alongside the SDK's.
- **Refusals name the minimum SDK version.** When a revision is first added to
  `REFUSED_API_CONTRACT_REVISIONS`, its refusal body must carry a typed field
  (for example `minimumSdkVersion`) and a message of the form "upgrade
  `@opengeni/sdk` to ≥ X". The generic "Reload this client" text only suits
  stale stock-web tabs.

## Exception log

Rows dated before 2026-11-03 were recorded under the earlier major-based
policy and are history; they are not precedents for new exceptions.

| Date | Change | Reason | Minimum SDK | Integrators notified |
| --- | --- | --- | --- | --- |
| 2026-10-15 | Published Site limits follow the viewer; `effectiveLimits` describes non-member limits, `free` responses normalize to `standard`, `guestTools` is accepted but ignored, and audience refusals use `not_available_for_viewer` with a `legacyCode` migration alias. SDK and React changesets declare major releases. | Bendik's immediate Site redesign and merge-blocker instructions require uncapped members, non-member data-only tools and new defaults on existing Sites without republishing. This records that user-directed semantic exception to the announcement/90-day sequence, following the earlier user-directed exceptions; it is not a security exception or a claim that Sites are pre-GA. See [migration guidance](../published-sites.md). | No SDK revision refusal; existing request shapes remain accepted. Clients matching earlier error codes must update or use `details.legacyCode`. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-03 | Native Atlassian browse/source-save/resume and source-sync execution return retirement refusals; hosted MCP remains supported. | Operator explicitly requested immediate retirement of the native Jira/Confluence integration in favor of hosted MCP. This is a user-directed semantic compatibility exception to the usual announcement/90-day/new-major sequence, not a security exception. Routes, SDK methods, wire types, historical data and cleanup remain. See [migration guidance](../atlassian.md). | Unchanged; no SDK revision refusal is introduced. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-12 | Variable Sets are replaced by vaults: `/variable-sets` and `/environments` routes return 410 `variable_sets_removed`, legacy selection fields (`variableSetIds`, `variableSetId`, `environmentId`, `defaultVariableSetIds`) return 422 when they carry a value, and protected-fill site authentication is removed. SDK and React move to 2.0.0. | Founder-directed secrets overhaul shipped as one release: existing sets were migrated to vaults with the same ids and values, and the replacement (`client.vaults(workspaceId)`, `{{secret:…}}` references, `vaultPolicy`) ships in the same release. User-directed exception to the 90-day deprecation window, not a security exception. | 2.0.0 for vault methods; older SDKs keep working except for the removed Variable Set calls. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-21 | PR5165: `sessionRealtimeTransportKind` returns `websocket` instead of the deprecated `gateway` and `xai-subscription` names. Legacy negotiation helpers and transport starters remain available and deprecated. Ship the existing declaration unchanged: SDK/contracts minor, React patch. | Bendik (bendik@cloudgeni.ai) approved this **one-off** exception at **06:21 UTC on October 21, 2026**, recorded in PR5165 comment6309551766. The bounded audit found no known incompatible production consumer, not zero usage: historical Gateway counters, unidentified callers and unproven deployed bundles remain limits. This explicitly permits this change without the usual new-major/retained-behaviour sequence; it is not a security exception or a general policy relaxation. See the [release note](../../.changeset/realtime-kind-policy-exception.md) and [response compatibility disclosure](../../.changeset/realtime-response-compatibility-notes.md). | No new SDK revision refusal. Update consumers matching the old return names to `websocket`; response-validator and new-client/old-server limitations remain as disclosed. | Operator-approved exception; no outbound integrator notification is claimed. Independent review and normal release gates remain required. |
| 2026-10-27 | Removed without the 90-day window: the first automation API and its webhook ingress, PR Review and the Opengeni Lens App, resumable transcription recordings, the retired Knowledge search routes, the `Deprecation`/`Sunset` headers with the SDK `onDeprecation` option, the response-header omission for SDKs up to 7.x, and the 410 answers on the removed Variable Set routes (they now answer 404; non-empty legacy selection fields still answer 422). | Pre-launch cleanup directed by the maintainer: these surfaces had no users. | None (no refusal) | Not applicable |
