# Published SDK compatibility

Policy: [Public API compatibility](design/api-compatibility-policy.md).
Matrix: [`versions.json`](../test/integration/sdk-compatibility/versions.json).

## Run

```sh
bun install --frozen-lockfile
bun test --max-concurrency=1 --timeout 240000 ./test/integration/sdk-compatibility.integration.ts
bun run check:public-api
```

Docker Compose is required. The test starts one uniquely named disposable
Postgres/NATS/Garage stack, applies all migrations, runs API requests using the
restricted app role, and tears it down. Registry access is required for exact
npm installs; package lifecycle scripts are disabled. Temporary consumers and
their dependencies are removed after each version. Set `TMPDIR` to a workspace
task directory on shared machines. No production credentials, live model,
browser, or sandbox image is required. Lazy sandbox ownership permits real
credential resolution; the MCP-only scenario never provisions a sandbox.

Every version runs the same consumer in its own process outside the checkout.
The published cases assert the installed version and `dist` resolution, so
workspace linking cannot silently turn them into current-SDK tests. A current
source case exercises the same customer journey before publication. Test and
command deadlines bound hangs; install failures are failures, never skips.

The existing CI impact planner selects this **integration-tier** suite for
relevant API, contracts, SDK/React, core, worker/runtime, database, events,
storage and test-harness changes, and changes to the matrix/consumer. Batch and
full main CI run it. Fast PR checks retain the cheap static policy/unit guards.

## Audited boundaries (2026-11-03)

| Boundary | Existing protection and additional coverage |
| --- | --- |
| REST | `scripts/public-api/surface.gen.json` records 880 public routes, 1,554 contract schemas and 179 SDK/React entry points at the audit base, with no unmatched SDK route. The new matrix exercises organization-key auth, tenant creation/idempotency, external identity, sessions, messages, key revocation and error statuses against registered handlers. |
| Streaming/events | `packages/sdk/src/stream.ts`, `apps/api/src/http/sse.ts` and the durable event store own replay/resume. Published consumers read actual SSE through approval and completion, send a follow-up, resume after a cursor and check no duplicate sequence. |
| Tool approval/callback | The real production worker activity uses `ScriptedModel`, pauses before a configured MCP tool, consumes the SDK approval decision and calls the local provider exactly once. Temporal scheduling is an explicit fixture driver, not a second fake implementation of API handlers. |
| Files/artifacts | Published SDK signed upload → object-storage PUT → API completion → metadata/download and authenticated retained-artifact download use real Garage. This protects public file transport, not every editable-document operation or provider-specific S3/Azure/GCS behavior. |
| Embed/React | Each published SDK's session proxy serves a strict browser client: client config, SSE and approval submission cross the actual proxy. React uses this transport; existing React embedding/browser suites cover present-day components. Historical React visual rendering is not claimed by a headless SDK integration test. |
| Customer webhooks and credential providers | Published SDK helpers verify actual worker-signed credential requests and dispatched terminal webhooks, including human lineage, exact MCP URL/header transport, event/delivery IDs and the initial turn receipt. These are public integration contracts, unlike Stripe/GitHub/Slack-owned inbound callbacks. No diagnostic callback endpoint substitutes for a real turn. |
| Codemode | `packages/codemode` and API operation routes own durable operation handles, approval-pending results and resume/result semantics. Existing programmatic-approval integration tests exercise this protocol. A public SDK MCP approval is not proof of every historical Codemode client. |

The public-surface guard cannot prove opaque payload semantics or SDK-only
types without a contract schema. The runtime matrix is a core-path regression
net, not exhaustive compatibility for 880 routes. Keep both, and add a focused
scenario whenever a new customer path becomes load-bearing.

PR #4064's reusable conformance suite is for **subscription-core provider
adapters**, not public SDK/server interoperability. Its scripted-provider
pattern is useful; it cannot substitute for a registry-installed customer.

## CloudGeni consumer audit

Audited `Cloudgeni-ai/cloudgeni` main at
`a560199b912a83f871889d0e95daadf41124b52b` (November 2, 2026). Root
`package.json`, `bun.lock` and the [CLI manifest](https://github.com/Cloudgeni-ai/cloudgeni/blob/a560199b912a83f871889d0e95daadf41124b52b/apps/cloudgeni-cli/package.json) pin SDK,
contracts and React to `5.5.2-canary.41014501986001`.

[CloudGeni tenancy](https://github.com/Cloudgeni-ai/cloudgeni/blob/a560199b912a83f871889d0e95daadf41124b52b/apps/opengeni/src/standalone/tenancy.ts) creates idempotent tenants and acts
as external humans. `standalone/session-client.ts` relies on requested session
IDs, `initialTurnId`, event IDs/cursors, approvals, uploads and completion.
`standalone/relay.ts` uses the published session proxy, with strict browser
clients in its web app. `standalone/integrations.ts` registers per-workspace
credential providers and terminal webhooks. `standalone-credential-provider.ts`
and `terminal-turn-webhook.ts` verify signatures and causal identity; they
deliberately reject diagnostic-only callbacks. Those paths informed the matrix.

CloudGeni also uses composer/control revisions, pause/settlement, schedules,
usage, Rigs and artifact editing. Their existing focused tests remain necessary;
this bounded matrix does not claim to test every product feature. Codemode is
agent-side `ogtool` in this consumer, not a separately pinned host dependency.

## Published package history and version identity

On the audit date, `@opengeni/sdk`, `@opengeni/react`, `@opengeni/contracts` and
`@opengeni/codemode` all have npm `latest` **4.6.1** and `canary`
**6.4.1-canary.41530037043001**. Earlier SDK 7.x publications precede the
lockstep reset to 1.x: numeric maximum is not publication recency. The four
stable matrix releases were published on October 22, 2026. CloudGeni's exact
SDK/React/contracts pin **5.5.2-canary.41014501986001** was published on
October 30, 2026; it remains in the matrix separately from stable releases.

Before this change clients sent the API contract revision, not their package
version. The optional `x-opengeni-sdk-version` now records the built package's
version on HTTP and SSE requests. The API accepts missing/unknown values and
records only a bounded version-shaped value in request logs and spans, never
high-cardinality metric labels. It is not identity, authorization, negotiation,
or a replacement for a deprecation announcement.

Update pins deliberately using npm registry metadata and known integrator
lockfiles. Never use floating tags in CI or drop a red version. The canonical
policy specifies the support window and the retirement-notice gate.
