# ADR: Public API compatibility policy

Status: **Accepted** (2026-09-29). This is the canonical policy. The summary in
[`docs/architecture.md`](../architecture.md) §3.10 links here. The exception log
at the end of this file is append-only.

## Context

Product teams integrate against the managed service (`app.opengeni.ai`) with a
pinned `@opengeni/sdk` version, and we cannot force them to upgrade. We deploy
the API continuously. Until now, `docs/architecture.md` §3.10 said clients and
servers are compatible within a major and that evolution is additive, but
nothing enforced it:

- The `x-opengeni-api-contract` exact-match fence was bumped eight times
  between 2026-08-01 and 2026-09-29. Each bump made every mutation from an older
  SDK fail with `409 API_CONTRACT_CHANGED`. Every published SDK up to 7.x also
  throws `OpenGeniApiContractMismatchError` on **any** response whose revision
  header differs from its own, reads included.
- Whole public routes were removed within a major. For example, Packs were
  removed in #2555 while the SDK major stayed the same.

## Decision

### (a) The public surface

The following are public. Integrators may depend on them, and they change only
under this policy:

1. **Routes.** Every `/v1` route (method + path) reachable through a public
   `@opengeni/sdk` method, together with its request and response shapes.
2. **Events.** The session event envelope (`SessionEvent`), the set of event
   `type` names (`SessionEventType`), and the event payload fields documented
   in the SDK types and docs.
3. **Package exports.** Every export of every `package.json` entry point of
   `@opengeni/sdk` and `@opengeni/react`, plus the public members of exported
   SDK client classes.
4. **Ingress formats.** Public routes that no SDK method calls, listed in
   `PUBLIC_INGRESS_ROUTES` (`scripts/public-api/surface.ts`), such as the
   OpenAI-compatible routes a stock OpenAI client calls.
5. **Embedding protocols.** The SDK session proxy and React client's public
   REST/SSE protocol, customer-facing workspace/organization webhook envelopes
   and signatures, credential-provider callbacks, and the public Codemode
   operation/approval/result envelopes. Provider-owned callbacks below are
   different from callbacks that Opengeni sends to an integrator.

The following are **internal**. They may change without notice:

- Routes that only the web app uses and that no public SDK method calls. This
  includes SDK methods whose JSDoc carries `@internal`.
- Provider callbacks whose format the provider owns: Stripe, GitHub, Slack,
  and OAuth.
- Internal worker MCP transports, machine enrollment and NATS auth callout,
  and install scripts. This does not exempt customer-facing tool callbacks or
  the public Codemode operation protocol above.
- The worker↔API and web↔API protocols, including the meaning of
  `x-opengeni-api-contract` for cookie sessions.
- The database schema.

`packages/sdk/README.md` § Compatibility repeats this summary for integrators.

### (b) Package majors and hosted API endpoints

The `@opengeni/sdk` major version identifies package compatibility; it does not
authorize breaking the continuously deployed API for still-supported clients.
The `/v1` path prefix is not bumped per package major. Official servers report
their build through `serverVersion`. Keep existing `/v1` behavior throughout a
supported client's notice period. When incompatible behavior cannot coexist
additively, introduce a new versioned endpoint (for example `/v2`) and retain
the old endpoint until its announced sunset. Do not introduce `/v2` merely to
ship additive changes.

Within a major, changes are **additive only**, and both sides are tolerant
readers:

| Change | Within a major |
| --- | --- |
| New route, new optional request field, new response field, new event type, new export | Allowed |
| New enum or union value **in a response** or event | Allowed. Clients must tolerate unknown values |
| New enum value accepted **in a request** | Allowed |
| Required request field becomes optional | Allowed |
| Remove or rename a route, request field, response field, event type, export, or SDK method | **Breaking** |
| Change a field's type; make a request field required; make a response field optional or nullable | **Breaking** |
| Remove an accepted request enum or union value | **Breaking** |
| New required request field | **Breaking** |
| Stop honouring a documented behaviour even though the shape is unchanged | **Breaking** (review) |

Tolerance runs in both directions:

- **Servers** accept requests from every supported SDK, not just the current
  major. Strict request schemas are fine, provided supported fields remain
  accepted throughout their notice period.
- **Clients** ignore unknown response fields, enum values, and event types.

### (c) Making a breaking change

A breaking change needs all of the following:

1. **Announce it.** Add a changeset that declares `"@opengeni/sdk": major`,
   add a changelog/docs entry, and write migration notes. Notify known affected
   integrators through their established support channels, recording the date,
   affected SDK versions/paths, replacement and sunset. A private PR alone is
   not an integrator announcement.
2. **Keep the old behaviour** on the managed service for **at least 90 days**
   or until the next major ships, whichever is later. Mark the affected SDK
   types and methods `@deprecated`.
3. **Remove it only in a new major**, with migration notes. Record the change
   in `scripts/public-api/breaking-changes.json` with:
   - `ids`: the check's finding ids
   - `deprecation`: a reference to the changeset or docs
   - `removedInMajor`: greater than the current major
   - `sunset`
   - `reason`

### (d) Emergency security exception

If a security fix cannot wait for a major:

- Refuse the affected contract revisions for **every** caller through
  `REFUSED_API_CONTRACT_REVISIONS`. This is added together with the fence
  scoping that admits bearer callers across revisions.
- The refusal is a typed, actionable error. It returns
  `409 API_CONTRACT_CHANGED` with a message and field naming the minimum SDK
  version (e.g. "upgrade `@opengeni/sdk` to ≥ 7.4.1"). It is never a generic
  reload prompt.
- Notify affected integrators directly.
- Log the exception in the table below and add an allowlist entry with
  `"securityException": true`.

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

| Check | Command | What it proves |
| --- | --- | --- |
| Public surface snapshot | `bun run check:public-api` (refresh: `bun run public-api:refresh`) | See below |
| Contract parity | `packages/sdk/test/contract-parity.test.ts` | SDK wire types match `@opengeni/contracts` |
| Published SDK integration | `bun test --timeout 240000 ./test/integration/sdk-compatibility.integration.ts` | Real npm clients against current HTTP/API, worker, database and storage; current source runs the same scenario |
| Supported-version retention | `bun run check:public-api` | Exact pinned versions; dropping a pin requires a previously committed retirement notice with at least 90 days and an elapsed sunset |

**Public surface snapshot** (`bun run check:public-api`) regenerates
`scripts/public-api/surface.gen.json` from source:

- SDK call sites are matched to the routes the API actually registers.
- Contracts zod schemas are flattened from JSON Schema (`io: input` for
  requests, `output` for responses).
- SDK/React entry-point exports and SDK client members are collected.

The check fails in each of these cases:

- **Stale snapshot.** The committed snapshot is out of date. Additive changes
  only need a refresh.
- **Breaking change.** The diff against the snapshot on the merge base with
  `origin/main` has a breaking finding that is not allowlisted, or that is
  allowlisted without a pending `"@opengeni/sdk": major` changeset.
- **Missing route.** A public SDK method calls a route the API does not
  register.

The snapshot check is a CI guard. It runs in full mode and whenever the impact plan
touches `@opengeni/api-router`, `@opengeni/contracts`, `@opengeni/sdk`, or
`@opengeni/react`, including anything those packages depend on.

### (g) Supported SDK window and executable coverage

The committed [matrix](../../test/integration/sdk-compatibility/versions.json)
is the executable minimum support baseline. Start with the latest patch of
each of the four most recent stable minor lines, plus every known customer pin
(including canaries). On 2026-11-03, npm's `latest` is **4.6.1**, not the
numerically greatest historical version or the repository's unpublished 6.5.1.
The stable representatives are 4.3.1, 4.4.1, 4.5.0 and 4.6.1; CloudGeni pins
5.5.2-canary.41014501986001. Patch releases within those lines remain additive;
testing a representative does not permit breaking another patch.

On release, review registry publication dates/tags and customer pins, add the
new representative and retain old entries until retirement is announced and
the full notice period passes. A new major, an advancing four-minor window or
a customer upgrading does not automatically remove a supported pin. Record
retirement notices in `retirementNotices` with `version`, `announcedOn`,
`sunset`, and `migration` (the public announcement/migration reference). Do not
backdate announcements. The guard requires the notice on the comparison base
before a separate PR can remove the test. New known pins join the matrix even
if they are outside the ordinary stable window. Legacy exceptions below are
historical, not permission for new unannounced retirements.

The integration lane runs sequentially, installs exact registry releases in
separate temporary projects with lifecycle scripts disabled, and starts each
consumer in a clean subprocess outside the monorepo. It never substitutes
workspace packages for published clients. Current source runs the same flow.
One disposable API/Postgres/NATS/object-storage stack serves the matrix. Only
the model and Temporal dispatch are scripted; public request handling,
authorization, persistence, worker execution and signed file transfer are real.
The synthetic MCP provider's HTTPS address is mapped to its local HTTP fixture
only at worker transport preparation. No paid provider or customer resource is
used. Failures name the SDK version and integration path.

This runs in the existing **integration tier**, not fast PR unit checks: full
Batch/main CI and focused impact plans for API, SDK/React, contracts, core,
worker/runtime, database, events, storage and testing changes select it. Changes
to its fixtures select it too. Do not skip an old client to make a failure green;
fix the regression or follow the retirement policy. See the
[coverage audit](../api-compatibility-testing.md) for boundaries and commands.

### (h) Internal cutovers remain allowed

Maintenance migrations, worker/web protocol changes, Temporal or NATS
changes, and web-only route changes stay allowed if the public surface is
unaffected. The snapshot check proves the route, schema, and export part of
that claim. The pull-request template asks every change for its external API
impact.

## Consequences

- Additive PRs that touch the surface must commit a refreshed snapshot. This
  is a mechanical `bun run public-api:refresh`.
- The fingerprint derives from what the SDK declares and from `@opengeni/contracts`.
  It does not cover:
  - SDK-only types without a contracts schema (only the name and presence of
    the SDK method are tracked);
  - opaque event payload internals;
  - semantic behaviour changes.

  Review still owns these, guided by the PR template.
- The published-SDK suite covers core integration flows, not every route. Add steps when
  an integration pattern becomes load-bearing.
- Package major ordering alone does not identify supported releases: the public
  packages were reset to lockstep 1.x after earlier 7.x publications. Use the
  explicit matrix and publication history, not a numeric maximum. No new
  blanket refusal of an older major is introduced by this policy.

## Follow-ups

- **Refusals name the minimum SDK version.** `REFUSED_API_CONTRACT_REVISIONS`
  and the bearer admission of older revisions ship with the contract-fence
  scoping change, not with this ADR. When that lands, the refusal body for a
  listed revision must carry a typed field (for example `minimumSdkVersion`)
  and a message of the form "upgrade `@opengeni/sdk` to ≥ X". The generic
  "Reload this client" text only suits stale stock-web tabs. Each refused
  revision is paired with the minimum SDK release that no longer sends it.

## Exception log

| Date | Change | Reason | Minimum SDK | Integrators notified |
| --- | --- | --- | --- | --- |
| 2026-10-15 | Published Site limits follow the viewer; `effectiveLimits` describes non-member limits, `free` responses normalize to `standard`, `guestTools` is accepted but ignored, and audience refusals use `not_available_for_viewer` with a `legacyCode` migration alias. SDK and React changesets declare major releases. | Bendik's immediate Site redesign and merge-blocker instructions require uncapped members, non-member data-only tools and new defaults on existing Sites without republishing. This records that user-directed semantic exception to the announcement/90-day sequence, following the earlier user-directed exceptions; it is not a security exception or a claim that Sites are pre-GA. See [migration guidance](../published-sites.md). | No SDK revision refusal; existing request shapes remain accepted. Clients matching earlier error codes must update or use `details.legacyCode`. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-03 | Native Atlassian browse/source-save/resume and source-sync execution return retirement refusals; hosted MCP remains supported. | Operator explicitly requested immediate retirement of the native Jira/Confluence integration in favor of hosted MCP. This is a user-directed semantic compatibility exception to the usual announcement/90-day/new-major sequence, not a security exception. Routes, SDK methods, wire types, historical data and cleanup remain. See [migration guidance](../atlassian.md). | Unchanged; no SDK revision refusal is introduced. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-12 | Variable Sets are replaced by vaults: `/variable-sets` and `/environments` routes return 410 `variable_sets_removed`, legacy selection fields (`variableSetIds`, `variableSetId`, `environmentId`, `defaultVariableSetIds`) return 422 when they carry a value, and protected-fill site authentication is removed. SDK and React move to 2.0.0. | Founder-directed secrets overhaul shipped as one release: existing sets were migrated to vaults with the same ids and values, and the replacement (`client.vaults(workspaceId)`, `{{secret:…}}` references, `vaultPolicy`) ships in the same release. User-directed exception to the 90-day deprecation window, not a security exception. | 2.0.0 for vault methods; older SDKs keep working except for the removed Variable Set calls. | Requested by the managed-service operator; no outbound integrator notification was sent. |
| 2026-10-21 | PR5165: `sessionRealtimeTransportKind` returns `websocket` instead of the deprecated `gateway` and `xai-subscription` names. Legacy negotiation helpers and transport starters remain available and deprecated. Ship the existing declaration unchanged: SDK/contracts minor, React patch. | Bendik (bendik@cloudgeni.ai) approved this **one-off** exception at **06:21 UTC on October 21, 2026**, recorded in PR5165 comment6309551766. The bounded audit found no known incompatible production consumer, not zero usage: historical Gateway counters, unidentified callers and unproven deployed bundles remain limits. This explicitly permits this change without the usual new-major/retained-behaviour sequence; it is not a security exception or a general policy relaxation. See the [release note](../../.changeset/realtime-kind-policy-exception.md) and [response compatibility disclosure](../../.changeset/realtime-response-compatibility-notes.md). | No new SDK revision refusal. Update consumers matching the old return names to `websocket`; response-validator and new-client/old-server limitations remain as disclosed. | Operator-approved exception; no outbound integrator notification is claimed. Independent review and normal release gates remain required. |
| 2026-10-27 | Removed without the 90-day window: the first automation API and its webhook ingress, PR Review and the Opengeni Lens App, resumable transcription recordings, the retired Knowledge search routes, the `Deprecation`/`Sunset` headers with the SDK `onDeprecation` option, the response-header omission for SDKs up to 7.x, and the 410 answers on the removed Variable Set routes (they now answer 404; non-empty legacy selection fields still answer 422). | Pre-launch cleanup directed by the maintainer: these surfaces had no users. | None (no refusal) | Not applicable |
