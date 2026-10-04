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
4. **Ingress formats.** The automation webhook ingress
   (`POST /v1/webhooks/automations/:endpointId`) and its accepted payload
   format.

The following are **internal**. They may change without notice:

- Routes that only the web app uses and that no public SDK method calls. This
  includes SDK methods whose JSDoc carries `@internal`.
- Provider callbacks whose format the provider owns: Stripe, GitHub, Slack,
  and OAuth.
- MCP transports, machine enrollment and NATS auth callout, and install
  scripts.
- The worker↔API and web↔API protocols, including the meaning of
  `x-opengeni-api-contract` for cookie sessions.
- The database schema.

`packages/sdk/README.md` § Compatibility repeats this summary for integrators.

### (b) Versioning: SDK major = API major

The `@opengeni/sdk` major version **is** the API compatibility major. The
`/v1` path prefix is not bumped per major. Official servers report their build
through `serverVersion`.

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

- **Servers** accept every request that an SDK of the same major could send.
  Strict request schemas are fine, provided a field is never removed within a
  major.
- **Clients** ignore unknown response fields, enum values, and event types.

### (c) Making a breaking change

A breaking change needs all of the following:

1. **Announce it.** Add a changeset that declares `"@opengeni/sdk": major`,
   add a changelog/docs entry, and write migration notes.
2. **Advertise it on the wire.** Add an entry to `DEPRECATED_ROUTES` in
   `apps/api/src/http/deprecation.ts`. Every response of the affected route
   then carries:
   - `Deprecation: @<unix seconds>` (RFC 9745)
   - `Sunset: <HTTP-date>` (RFC 8594)
   - `Link: <notes>; rel="deprecation"`

   These headers are exposed through CORS. The SDK surfaces them through
   `OpenGeniClientOptions.onDeprecation`. By default it logs one
   `console.warn` per route; `false` silences it. If the change is to a field
   rather than a whole route, deprecate the routes that carry the field and
   mark the SDK type `@deprecated`.
3. **Keep the old behaviour** on the managed service for **at least 90 days**
   or until the next major ships, whichever is later. The registry rejects a
   `sunset` less than 90 days after `deprecatedAt`.
4. **Remove it only in a new major**, with migration notes. Record the change
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
- **Responses to a bearer caller** that announced a different revision omit the
  header (`apps/api/src/http/api-contract-compat.ts`). Published SDKs up to 7.x
  reject any other revision, so sending it would break them on the next bump.
  An explicit `API_CONTRACT_CHANGED` refusal keeps the header.
- **New SDKs** default to a compatible mode outside a cookie browser.
- **Bumping the revision** is a web-bundle event, never by itself a public API
  change.

### (f) Enforcement

| Check | Command | What it proves |
| --- | --- | --- |
| Public surface snapshot | `bun run check:public-api` (refresh: `bun run public-api:refresh`) | See below |
| Published-SDK compatibility | `bun run test:sdk-compat` | See below |
| Deprecation headers | `apps/api/test/deprecation-headers.test.ts`, `packages/sdk/test/deprecation.test.ts` | Registry validity, header format, CORS exposure, and the SDK notice hook |
| Contract parity | `packages/sdk/test/contract-parity.test.ts` | SDK wire types match `@opengeni/contracts` |

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

**Published-SDK compatibility** (`bun run test:sdk-compat`) installs the latest
patch of the last three stable minors of the current major from npm. They are
configurable through `--versions`, `OPENGENI_SDK_COMPAT_VERSIONS`, and
`OPENGENI_SDK_COMPAT_MINORS`.

- Each version drives the current API over real HTTP on real PostgreSQL with
  the contract fence enabled. The flow is:
  1. `ensureWorkspace`
  2. `addExternalWorkspaceMember`, then `asUser`
  3. `createSession`, then `sendMessage`
  4. `listEvents`, then an SSE replay
  5. `createScheduledTask`, then `triggerScheduledTask`
- The check fails on any 5xx, any `409 API_CONTRACT_CHANGED`, any
  SDK-thrown contract mismatch, or any broken step.
- No worker or model runs. The check stops at API acceptance plus durable
  event and scheduled-task state.

Both checks are CI guards. They run in full mode and whenever the impact plan
touches `@opengeni/api-router`, `@opengeni/contracts`, `@opengeni/sdk`, or
`@opengeni/react`, including anything those packages depend on.

### (g) Internal cutovers remain allowed

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
- The old-SDK suite covers one embedding flow, not every route. Add steps when
  an integration pattern becomes load-bearing.
- SDKs from an older major (for example 6.x, whose contract revision predates
  this policy) are outside the default run and are expected to be refused.

## Follow-ups

- **Refusals name the minimum SDK version.** `REFUSED_API_CONTRACT_REVISIONS`
  and the bearer admission of older revisions ship with the contract-fence
  scoping change, not with this ADR. When that lands, the refusal body for a
  listed revision must carry a typed field (for example `minimumSdkVersion`)
  and a message of the form "upgrade `@opengeni/sdk` to ≥ X". The generic
  "Reload this client" text only suits stale stock-web tabs. Each refused
  revision is paired with the minimum SDK release that no longer sends it.
- **Pinned-SDK header omission depends on bearer admission.** The response-header
  rule in (e) keeps published SDKs from throwing on a newer revision. Their
  mutations are still refused with `409 API_CONTRACT_CHANGED` until bearer
  callers are admitted across revisions. Until then, a contract revision bump
  fails `bun run test:sdk-compat`, and that failure is deliberate.

## Exception log

| Date | Change | Reason | Minimum SDK | Integrators notified |
| --- | --- | --- | --- | --- |
| 2026-10-03 | Native Atlassian browse/source-save/resume and source-sync execution return retirement refusals; hosted MCP remains supported. | Operator explicitly requested immediate retirement of the native Jira/Confluence integration in favor of hosted MCP. This is a user-directed semantic compatibility exception to the usual announcement/90-day/new-major sequence, not a security exception. Routes, SDK methods, wire types, historical data and cleanup remain. See [migration guidance](../atlassian.md). | Unchanged; no SDK revision refusal is introduced. | Requested by the managed-service operator; no outbound integrator notification was sent. |
