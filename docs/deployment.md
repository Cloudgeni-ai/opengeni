# Deployment

OpenGeni deployment work is organized around a repo-owned deployment contract, deterministic artifacts, and conformance checks. Repository CI validates deployment artifacts; it does not deploy maintainer-owned preview infrastructure from pull requests.

## Profiles

List supported profiles:

```bash
bun run deployment:profiles
```

Render a stack plan before creating anything. The plan lists resource classes,
platform dependencies managed by wrapper commands, external dependencies,
required secret keys, deploy commands, verification commands, and destroy
commands:

```bash
bun run deployment:stack -- --profile gcp-managed
bun run deployment:stack -- --profile aws-existing-services --json
```

After Terraform apply, generate private deployment artifacts from Terraform
outputs and the current shell variable set. The generated Helm values file
contains non-secret provider wiring; `runtime.env` is intended for a private
Kubernetes Secret and must not be committed:

```bash
terraform -chdir=deploy/terraform/gcp output -json \
  > .agent/generated/gcp-managed/terraform-output.json

OPENGENI_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
OPENGENI_DATABASE_URL="$OPENGENI_DATABASE_URL" \
  bun run deployment:runtime-artifacts -- \
  --profile gcp-managed \
  --terraform-output .agent/generated/gcp-managed/terraform-output.json \
  --out-dir .agent/generated/gcp-managed

kubectl -n opengeni create secret generic opengeni-runtime \
  --from-env-file=.agent/generated/gcp-managed/runtime.env \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Single-machine Kubernetes

`deploy/helm/opengeni/values.single-node.example.yaml` is the supported
persistent, non-HA profile for running the complete control plane on one
machine. Kubernetes is used only as the process, restart, volume, and upgrade
supervisor. It is not an autoscaling or failover layer in this profile.

The profile renders one API, web, control worker, turn worker, relay, Postgres,
Temporal, NATS, and MinIO process. It disables HPAs, disruption budgets, and
topology spreading. Container resource requests and limits are omitted, so a
busy role may use otherwise-idle CPU and memory on the machine.

The profile creates four non-preempting Pod priority tiers. Under
kubelet-managed node pressure, presentation (web and relay) is evicted before
turn execution, then live control (API, control worker, and NATS), while
durable services and the migration gate are retained longest. Priority is not a
CPU or memory partition, and it cannot order a kernel OOM that happens before
kubelet reacts. Configure a node-wide `memory.available` eviction threshold
with enough measured OS/Kubernetes headroom, and include every disk/inode
threshold when overriding `eviction-hard`; Kubernetes otherwise zeroes omitted
defaults. This preserves elastic sharing while giving the kubelet room to
enforce the intended order.

The API's single-node readiness probe uses `/traffic-readyz`, which checks only
Postgres. If NATS or Temporal restarts, Kubernetes keeps routing safe
database-backed reads while commands that need the unavailable dependency fail
explicitly and recover after reconnect. `/readyz` remains the complete
Postgres/NATS/Temporal dependency report, so the outage is still visible to
operators. Losing Postgres fails both readiness paths.

The one turn worker uses Temporal's resource-based slot tuner. It admits more
agent turns while whole-machine CPU stays below 80% and memory stays below 75%,
up to 256 active turns; excess work remains durable in Temporal. This is a
safety ceiling, not a reservation or a promise that 256 heavy turns fit. The
ordinary chart default remains a fixed 16 turns per worker so multi-worker
deployments can scale replicas predictably.

The ordinary dependency services remain private `ClusterIP` services. Five
one-port NodePort services are the complete private-edge surface:

| NodePort | Destination | Purpose |
| --- | --- | --- |
| `30080` | web | browser application |
| `30081` | API | API, SSE, enrollment, and agent distribution |
| `30222` | NATS websocket | enrolled-machine command/event transport |
| `30443` | relay | live terminal/desktop byte streams |
| `30900` | MinIO API | signed browser file transfer only |

The NATS client/monitor ports and MinIO admin console are not exposed. On K3s,
bind NodePorts to loopback with
`--kube-proxy-arg=nodeport-addresses=127.0.0.0/8`, then publish only the five
loopback listeners through a private edge such as Tailscale Serve. Route `/` to
web and route `/v1`, `/healthz`, `/readyz`, `/traffic-readyz`, `/metrics`,
`/install.sh`, `/install.ps1`, `/uninstall.sh`,
`/opengeni-agent-minisign.pub`, and `/agent` to the API. Give the NATS
websocket, relay, and MinIO API their own private TLS ports. Set
`selfhosted.natsUrl`, `selfhosted.relayUrl`, and `minio.publicEndpoint` to those
private URLs. Also set `OPENGENI_PUBLIC_BASE_URL` to the browser/API origin. The
API uses it when serving the installer, so an enrolled machine downloads the
agent version baked into this deployment rather than falling back to the public
archive.

For a tailnet-only deployment, `OPENGENI_AUTH_REQUIRED=false` and
`OPENGENI_PRODUCT_ACCESS_MODE=local` mean there is no shared deployment access
key; tailnet membership is the outer access boundary. Internal database, NATS,
enrollment-signing, relay-token, object-storage, and model-provider credentials
remain required because services must still authenticate to each other. They
are not an additional user-facing gateway.

Create the four Secrets before installation:

- `opengeni-postgres`: the Postgres owner `POSTGRES_PASSWORD`;
- `opengeni-minio`: `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`;
- `opengeni-runtime`: the restricted `opengeni_app`
  `OPENGENI_DATABASE_URL`, the environments encryption key, object-storage
  credentials, and Connected Machine signing/NATS/relay secrets;
- `opengeni-migrations`: the owner
  `OPENGENI_MIGRATIONS_DATABASE_URL`,
  `OPENGENI_APP_DATABASE_USER=opengeni_app`, and
  `OPENGENI_APP_DATABASE_PASSWORD`.

Generate the matched database and NATS credentials locally. The command creates
a new mode-`0700` directory containing four mode-`0600` env files, refuses to
overwrite an existing directory, and prints no secret values:

```bash
bun run deployment:single-node-secrets -- \
  --out-dir .agent/generated/single-node/secrets

kubectl create namespace opengeni --dry-run=client -o yaml | kubectl apply -f -

kubectl -n opengeni create secret generic opengeni-postgres \
  --from-env-file=.agent/generated/single-node/secrets/postgres.env

kubectl -n opengeni create secret generic opengeni-minio \
  --from-env-file=.agent/generated/single-node/secrets/minio.env

kubectl -n opengeni create secret generic opengeni-runtime \
  --from-env-file=.agent/generated/single-node/secrets/runtime.env

kubectl -n opengeni create secret generic opengeni-migrations \
  --from-env-file=.agent/generated/single-node/secrets/migrations.env
```

This bootstrap does not require a model-provider API key. A workspace admin can
connect a ChatGPT/Codex subscription from workspace settings after the
application starts. If the deployment instead uses API-billed models, add the
selected provider's credential to `opengeni-runtime` separately. Keep the
generated directory as a private recovery artifact or move the values into a
secret manager; never commit it. The generated environments encryption key must
remain stable across upgrades because it protects persisted subscription and
workspace credentials.

Bootstrap a new machine in two phases. First install only the persistent
dependencies and wait until they are healthy:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni --create-namespace \
  --values deploy/helm/opengeni/values.single-node.example.yaml \
  --set api.enabled=false \
  --set worker.enabled=false \
  --set web.enabled=false \
  --set relay.enabled=false \
  --set migrations.enabled=false \
  --wait --timeout 10m
```

Then enable the application. Because this is an upgrade, the pre-upgrade
database Job can reach the already-running Postgres. It applies forward
migrations, converges the restricted runtime role, and proves a connection
through that role before Helm replaces application pods:

```bash
helm upgrade opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --values deploy/helm/opengeni/values.single-node.example.yaml \
  --wait --timeout 15m
```

Future versions use the same second command with a new official chart/image
version or digest. Postgres and MinIO PVCs remain attached. Database migrations
are forward-only: if the migration gate fails, the old application stays in
place; after a migration succeeds, roll the application forward unless the
older image is explicitly proven compatible with the new schema.

Failure behavior is intentionally uneven:

- web and relay hold no durable product state; losing them removes the browser
  UI or live terminal/desktop streams;
- a turn worker can restart while queued work remains in Temporal/Postgres;
- NATS stores no authoritative history, but losing it disconnects enrolled
  machines and pauses their command path as well as live fanout;
- MinIO owns uploaded file bytes;
- Temporal owns durable orchestration state;
- Postgres owns the durable product record and database migration ledger.

This profile promises restart and persistence on one machine, not service
continuity while that machine is down.

### Database identities and runtime posture

Standalone deployments using the default `OPENGENI_RLS_STRATEGY=force` require
two distinct secret paths:

- **migration/provisioning:** `OPENGENI_MIGRATIONS_DATABASE_URL`,
  `OPENGENI_APP_DATABASE_USER=opengeni_app`, and the corresponding
  `OPENGENI_APP_DATABASE_PASSWORD`; this identity owns/applies schema and is
  available only to migration and role-provision Jobs;
- **ordinary runtime:** `OPENGENI_DATABASE_URL`, structurally targeting the same
  database but authenticating as `opengeni_app`; this is the only database URL
  available to API and worker containers.

After every migration and before rolling workloads, the Helm migration hook runs:

```bash
bun run db:provision-roles
bun run db:assert-runtime-posture
```

The Job receives the ordinary runtime Secret first and the separate
migration-only Secret second. This gives the assertion the restricted
`OPENGENI_DATABASE_URL` while keeping the owner URL and provisioning password
out of API and worker pods. Its default command serializes `db:migrate`,
`db:provision-roles`, and `db:assert-runtime-posture`; any failure aborts
`helm upgrade` before workload replacement begins. Operators running without
Helm must preserve the same order explicitly.

After a successful install or upgrade, the default-on `catalogImport` hook Job
imports the committed reviewed integrations snapshot. It receives the runtime
Secret for object-storage configuration but overrides `OPENGENI_DATABASE_URL`
from the migration-only Secret because global catalog and import-provenance
tables are deliberately unavailable to the runtime role. The Job uses a SHA-256
snapshot reference and performs no database, network, or logo-storage work when
that exact revision already completed. Set `catalogImport.enabled=false` to opt
out. Logo fetching is disabled by default so third-party availability cannot
block a rollout; set `catalogImport.skipLogos=false` to opt into validated,
self-hosted catalog logos.

The provisioner converges `opengeni_app` to `LOGIN NOSUPERUSER NOBYPASSRLS
NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`, refuses to guess through any
role membership or ownership, revokes database/schema creation and all table
privileges, then grants the exact current-ledger table contract: full CRUD on 81
ordinary runtime tables, SELECT only on `nested_agent_depth_configuration`,
SELECT + INSERT on append-only `session_spawn_denials`, and no direct table DML
on the five FORCE-RLS host-export tables.
The runtime assertion connects through the runtime URL and checks, using only
PostgreSQL catalogs in a repeatable-read/read-only transaction:

- exact current/session role, attributes, zero role-graph edges, and
  `row_security=on`;
- no database/schema/relation/private-routine ownership and no database/schema
  CREATE;
- exactly 77 declared tenant tables with ENABLE + FORCE + active RLS and at
  least one policy each;
- exact SELECT/INSERT/UPDATE/DELETE grants for each declared privilege class,
  absence of TRUNCATE/REFERENCES/TRIGGER everywhere, and no privileges on any
  undeclared or protected no-direct-DML table;
- access to the `opengeni_private` helpers.

API and worker startup run the same assertion before NATS, Temporal, HTTP
serving, or workflow polling begins. Their readiness endpoints repeat it instead
of treating `select 1` as database readiness. `OPENGENI_RUNTIME_DATABASE_ROLE`
defaults to and should remain `opengeni_app` for standalone deployments.

The `scoped` strategy is an explicit embedding contract: OpenGeni checks only
coherent connectivity/identity because the host owns the role and isolation
boundary. It must not be used to bypass the standalone `force` posture.

Changing an existing standalone environment from an owner, superuser, or
`BYPASSRLS` runtime identity to `opengeni_app` is an identity/ownership cutover,
not an ordinary rolling secret edit. Serialize the first transition through a
reviewed maintenance plan: stop admission/claiming, preserve the migration-only
URL, update the runtime Secret to the restricted URL, provision, run the posture
probe from that exact Secret, then start only the posture-gated runtime. A
rollback may restore a compatible image digest, but must never restore the old
broad database URL or role attributes. If an older image cannot run through the
restricted role, remain in maintenance and fix forward.

For Azure managed Blob storage, the artifact generator can consume the
sensitive Terraform output `object_storage_azure_connection_string` into the
private `runtime.env` file. Keep the Terraform output JSON under `.agent/` or
another ignored private path.

Inspect required modes, variable-set variables, and checks:

```bash
bun run deployment:preflight -- --profile azure-existing-services
```

Run live connectivity probes against the current shell variable set and Kubernetes context:

```bash
KUBECONFIG=/path/to/kubeconfig bun run deployment:preflight -- --profile azure-managed --live
```

Run API-level deployment conformance against a reachable OpenGeni API:

```bash
bun run deployment:conformance -- --base-url https://opengeni.example.com
```

For deployments with the built-in shared-key boundary enabled, pass the same key
used by the backend. Conformance sends it as `x-opengeni-access-key`, verifies
that client config is secret-free, verifies protected routes reject missing
keys, discovers the workspace through `/v1/access/me`, and then exercises
workspace-scoped API/SSE requests:

```bash
OPENGENI_CONFORMANCE_DEPLOYMENT_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  bun run deployment:conformance -- --base-url https://opengeni.example.com
```

For managed deployments, conformance should use an OpenGeni product API key for
the test workspace:

```bash
OPENGENI_CONFORMANCE_PRODUCT_TOKEN="$OPENGENI_TEST_WORKSPACE_API_KEY" \
  bun run deployment:conformance -- --base-url https://staging.app.opengeni.ai
```

If the target reports deployment-key auth and no conformance deployment key is
provided, conformance fails instead of treating auth as a skipped check.

Managed SaaS operators should keep their release pipeline, live Stripe account
checks, staging/prod canaries, backup/restore drills, observability evidence,
and private deployment inventory in an operator-controlled private repository or
secret-managed CI system. The open-source repository intentionally provides the
reusable product, chart, Terraform roots, and conformance commands; it does not
ship Cloudgeni-specific operational release gates or live-account scripts.

For private in-cluster MinIO behind a local port-forward, keep the presigned URL host intact with curl's connect mapping:

```bash
bun run deployment:conformance -- \
  --base-url http://127.0.0.1:18080 \
  --object-connect-to opengeni-minio:9000:127.0.0.1:19000
```

The object-storage check performs a browser-style `OPTIONS` preflight before
the signed `PUT`. Managed and external buckets must allow direct upload CORS
for the deployed web origin. Prefer exact HTTPS origins in production; use `*`
only for disposable private evaluation stacks where signed URLs and the
OpenGeni access key are the real access boundaries.

Do not treat a successful presign as storage acceptance. Release conformance
must exercise the provider-native `OPTIONS` + signed browser `PUT`, API finalize
(which performs authenticated `HEAD`), signed `GET`, and tenant-negative read.
The worker also registers one global `opengeni-file-upload-reaper` Temporal
Schedule. It retains unfinished uploads until the signed URL expires plus one
hour, claims at most 100 objects per run, retries a crashed/failed delete claim
after ten minutes, and settles the RLS row terminal only after the provider's
idempotent delete succeeds. A healthy rollout therefore needs the same worker
Temporal and object-storage access used by normal uploads; disabling or
skipping storage conformance leaves both upload and orphan cleanup unproven.

The conformance command verifies API health, Prometheus metrics exposure, a real session run, event replay, SSE replay, manual scheduled-task dispatch, and file upload/download unless the corresponding `--skip-observability`, `--skip-agent`, `--skip-scheduled-tasks`, or `--skip-storage` flag is set. Skipped checks are explicit verification gaps, not proof that the skipped subsystem works.

Profile the live API → NATS → Connected Machine → process → reply path with an
existing idle machine-backed session:

```bash
bun run deployment:connected-machine-load -- \
  --base-url https://opengeni.example.com \
  --workspace-id 00000000-0000-0000-0000-000000000000 \
  --session-id 00000000-0000-0000-0000-000000000000 \
  --stages 1,10,25,50,100,200
```

The command runs a harmless marker command, warms every supplied session route,
then applies a concurrency staircase. It reports request throughput, p50/p95/p99
latency, and typed failure counts. Before the first write, it reads one supplied
session to discover the target's `X-OpenGeni-Api-Contract` revision and sends
that revision on every terminal probe; older targets that do not advertise a
contract remain supported. Pass multiple `--session-id` values to spread the
test over several machine-backed sessions. Use
`--deployment-access-key` or `--product-token` only when the deployment enables
that boundary; neither credential is printed.

This test measures the Connected Machine control transport and host command
admission. It does **not** measure model-provider capacity, full agent-turn
memory, or useful development-task throughput. Use
`scripts/operator/turn-density-profile.ts` for isolated turn-worker memory, and
run a smaller representative set of real development tasks before choosing an
active-turn concurrency target. A large number of durable idle sessions is not
equivalent to the same number of simultaneously executing turns.

The density profile uses a scripted model and an in-process first-party MCP
endpoint, so it exercises turn setup without a model-provider key or the
deployment's user-facing access mode. It creates a run-scoped account and
workspace, removes both before exit, and prints one
`OPENGENI_DENSITY_RESULT=...` record for automation.

Direct file, Git, and synchronous terminal APIs follow a machine-targeted
session's active pointer from the first request. They use API → NATS → enrolled
agent request/reply and do not need a preceding model turn, a turn worker, or a
cloud-sandbox lease.

For Azure Blob-backed deployments, no object host rewrite should be needed because upload/download URLs are public Azure Blob SAS URLs:

```bash
bun run deployment:conformance -- \
  --base-url http://127.0.0.1:18080 \
  --timeout-seconds 180
```

Current profiles:

- `local-compose`: existing Docker Compose development stack.
- `local-kubernetes`: local Kubernetes cluster running the Helm chart with in-cluster dependencies.
- `single-node-kubernetes`: persistent non-HA Kubernetes stack on one machine, using official images and a private edge.
- `kubernetes-external`: Kubernetes workloads connected to existing customer services.
- `azure-managed`: AKS plus Azure-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `azure-existing-services`: Azure Kubernetes workloads connected to existing Postgres, Temporal, and object storage.
- `aws-managed`: EKS plus AWS-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `aws-existing-services`: EKS workloads connected to existing Postgres, Temporal, and object storage.
- `gcp-managed`: GKE plus GCP-managed substrate where supported, provider-native object storage, and stack-wrapper managed upstream NATS/Temporal charts unless you replace them with existing endpoints.
- `gcp-existing-services`: GKE workloads connected to existing Postgres, Temporal, and object storage.
- `preview-pr`: operator-managed pull-request preview variable set shape.
- `preview-branch`: operator-managed branch preview variable set shape.
- `self-contained-kubernetes`: Kubernetes-hosted dependencies for demos or air-gapped evaluation.

## Local Docker Compose

`bun run dev` is the primary local Docker Compose path. It starts Postgres, NATS, Temporal, MinIO, migrations, imports the fingerprinted reviewed integrations catalog, builds the sandbox image, and starts the API, both workers (control and turn), and web. Set `OPENGENI_CATALOG_IMPORT_ENABLED=false` to omit the catalog import.

When a common host port is already occupied, `bun run dev` auto-selects a nearby free port for Docker Compose and rewrites the in-memory runtime URLs for that run. Set `OPENGENI_POSTGRES_HOST_PORT`, `OPENGENI_NATS_HOST_PORT`, `OPENGENI_NATS_MONITOR_HOST_PORT`, `OPENGENI_TEMPORAL_HOST_PORT`, `OPENGENI_MINIO_HOST_PORT`, or `OPENGENI_MINIO_CONSOLE_HOST_PORT` in `.env` if you need fixed local port choices.

## Build Images

Build local OpenGeni workload images:

```bash
bun run image:build:api
bun run image:build:worker
bun run image:build:web
```

Image builds default to `linux/amd64`, matching the Azure AKS reference node pool. Override with `OPENGENI_IMAGE_PLATFORM` for another target.

For production Helm releases, pin API, worker, web, and migration images by digest as well as tag. The chart renders images as `repository:tag@sha256:...` when `image.digest` is set, which keeps tags readable while making the deployed artifact immutable.

## Verified public release

Merging a changesets Version PR only commits package versions and changelogs; it
does not publish packages or release images. It produces the versioned source
required by the manually dispatched `.github/workflows/release-candidate.yml`.
Release approval is bound to GitHub's native PR author, reviewer, merge actor,
review state, reviewed head, and submission time:

- a `github-actions[bot]`-authored Version PR requires a native pre-merge
  `APPROVED` review from the configured human maintainer;
- the structured `COMMENTED` admin-PASS form is valid only for a
  single-maintainer PR whose author, exact-head reviewer, and merge actor are
  that same human; it is never a substitute for approving a bot-authored
  Version PR;
- any base/head update invalidates the prior verdict, and a review submitted
  after merge is not release evidence.

Candidate or operator admission must fail closed when those provider identities
do not match; do not weaken the provenance check or recreate approval from a
comment, commit message, or local record.

For a single-maintainer source PR, generate the exact structured review body
before merging. Submit the result as a native `COMMENTED` pull-request review;
the formatter can also print the canonical SHA-256 needed by an external
operator to bind the same artifact:

```bash
bun scripts/release-review.ts \
  --base <exact-current-main-sha> \
  --head <exact-reviewed-pr-head-sha> \
  --reviewer <trusted-maintainer-login>

bun scripts/release-review.ts \
  --base <exact-current-main-sha> \
  --head <exact-reviewed-pr-head-sha> \
  --reviewer <trusted-maintainer-login> \
  --digest
```

Regenerate the body and verdict after every head or base movement. Do not edit a
submitted review after merge to manufacture evidence retroactively.

GitHub check lookup is ref-sensitive: a checked head can become undiscoverable
after its source branch is deleted or rewritten even though the check itself
ran successfully. Release-capable heads are therefore retained before merge at
the immutable lightweight tag
`opengeni-release-head-<exact-reviewed-head-sha>`. Trusted Version-PR CI creates
that tag before it creates the exact-head check runs. For a non-Version PR that
will be used directly as a release source, dispatch
`.github/workflows/seal-release-head.yml` from exact current `main` with the PR
number and exact base/head SHAs before merging. The base-owned workflow reruns
the complete source-admission verifier, requires the existing successful
exact-head admission check, then creates or verifies the tag idempotently. It
also publishes a prerelease named `Retained OpenGeni release head <sha>` for
that exact tag. Repository-level immutable releases must be enabled: the
provider response must identify the GitHub Actions bot as author and report the
published prerelease as `immutable: true`, or sealing fails closed. GitHub then
locks the tag and emits its native release attestation.

If a seal creates and publishes that immutable tag/release but is interrupted
before its source-admission and retention checks complete, dispatch the same
workflow from current `main` with `merged_source_sha` set to the exact accepted
PR merge source. This is recovery, not a late seal: it refuses to create either
retained artifact. Before the first check mutation it reconstructs the complete
historical base-to-head tree/file admission, proves the original PR
base/head/merge and tree, re-reads the unchanged GitHub Actions-owned immutable
release, and proves the merged source's ancestry into current `main`. It then
idempotently restores only whichever exact provider checks are absent.

Before the first seal, a repository administrator must enable the provider
feature with the API version that introduced its management endpoint:

```bash
gh api \
  --method PUT \
  --header "Accept: application/vnd.github+json" \
  --header "X-GitHub-Api-Version: 2026-03-10" \
  repos/Cloudgeni-ai/opengeni/immutable-releases
gh api \
  --header "Accept: application/vnd.github+json" \
  --header "X-GitHub-Api-Version: 2026-03-10" \
  repos/Cloudgeni-ai/opengeni/immutable-releases \
  --jq '.enabled'
```

The verification command must print `true`. Enablement affects releases created
after it is switched on, so a mutable failed bootstrap release cannot be
promoted into evidence; push and seal a fresh exact head instead. Treat that
first fresh seal as an activation test: use a low-risk documentation-only PR,
then re-read its exact tag, immutable prerelease, native attestation, and
provider-owned retention check before relying on the mechanism for release
source.

Once the complete tag/immutable-release/PR identity has been re-read without
drift, the workflow idempotently publishes a successful
`Release-head retention` check on the exact head with external identity
`opengeni:release-automation:release-head-retention:v2:pr:<number>:head:<sha>:release-sha256:<digest>`.
The digest binds the publicly readable immutable release identity. An
anonymous downstream operator can therefore re-read the exact tag and release,
require `immutable: true`, and reconstruct the check identity without receiving
a cross-repository credential. Consumers may additionally verify GitHub's
cryptographically signed release attestation with `gh release verify`.
Its byte contract is SHA-256 over newline-free UTF-8 `JSON.stringify` of this
object with the top-level keys sorted in ascending ASCII order:

```json
{
  "authorId": 41898282,
  "authorLogin": "github-actions[bot]",
  "authorType": "Bot",
  "draft": false,
  "id": 123,
  "immutable": true,
  "name": "Retained OpenGeni release head <sha>",
  "prerelease": true,
  "publishedAt": "2026-07-27T02:00:00.000Z",
  "tagName": "opengeni-release-head-<sha>",
  "url": "https://github.com/Cloudgeni-ai/opengeni/releases/tag/opengeni-release-head-<sha>"
}
```

`id` is the live positive release ID and `publishedAt` is the provider
`published_at` value normalized through `new Date(value).toISOString()`. If an
existing release differs from this identity after a retention check exists,
sealing fails rather than creating a second proof; push a new head based on
current `main`, let source admission pass, and seal that new head.
Trusted Version-PR admission publishes the same check. This gives downstream
release operators a provider-owned proof of immutable source retention without
requiring a credential that crosses repository boundaries. A tag and immutable
prerelease are retention evidence, not approval: the native pre-merge review
and every later source/acceptance gate remain mandatory. A missing, moved,
indirect, mutable, non-provider-authored, or post-hoc substitute fails release
provenance. Retained-head prereleases and their tags intentionally accumulate
for the lifetime of their release evidence; never include them in routine
release or tag cleanup.

Release admission derives the merge outcome exclusively from GitHub records; a
workflow caller cannot assert a merge method. The exact current `main` SHA is
fenced before and after admission, must be associated with exactly one merged
PR, and must retain the PR's provider-recorded base, head, merge SHA, actors,
commit count, and exact reviewed-head tree. A matching GitHub `merged` timeline
event must independently bind the source commit, merge actor, and merge time;
association and topology alone do not admit a direct fast-forward push.
Supported provider-derived outcomes are:

- an exact two-parent merge commit with parents `[reviewed base, reviewed head]`;
- an exact one-commit squash on the reviewed base when the PR had multiple
  commits;
- an exact linear multi-commit rebase from the reviewed base with the same
  provider commit count as the PR; and
- a one-commit squash/rebase equivalence class when both the PR and rewritten
  result contain one commit.

GitHub does not retain a distinct manual UI method field for that final
one-commit case. Admission therefore records the truthful equivalence class
rather than guessing from mutable commit text or accepting caller metadata.
Both possible operations have the same admitted security identity: one exact PR,
base, head, reviewed tree, source tree, and provider merge SHA. Any nonlinear or
discontinuous range fails closed.

The exact reviewed head must still resolve directly from its canonical
`opengeni-release-head-<sha>` tag and have one successful GitHub Actions
`Current-base source admission` check. The exact source must separately have
one successful GitHub Actions result for each required candidate check:
`Typecheck and unit tests`, `Deployment artifacts`, and `Workload image
builds`. Missing, moved, indirect, duplicated, failed, wrong-head, or
foreign-app evidence is rejected. Check history is read with `filter=all`, and
every accepted record must bind the exact commit and the official GitHub
Actions app identity (`github-actions`, app ID `15368`). This admission
metadata does not alter the reproducible schema-v2 candidate receipt or any
chart, manifest, SBOM, provenance, or workload digest.

That workflow requires the exact current `main` SHA, no pending changesets, and
the exact expected package set (for example, `@opengeni/react@0.15.0`). It
builds API, worker, web, relay, and stock headless-sandbox images under
full-source-SHA candidate tags. Migrations explicitly reuse the API manifest.
Each manifest is built at most once; retries reuse existing partial results.
Before acceptance, the same workflow packages the Helm chart twice through the
deterministic release packager, requires byte-for-byte equality, and freezes the
resulting `.tgz` and SHA-256 in the candidate Actions artifact. It does **not**
occupy the official OCI version yet. The immutable GitHub release tag
`opengeni-candidate-<full-source-sha>` retains `release-candidate.json`, its
SHA-256 sidecar, and the chart assets. Retries that fail before this immutable
boundary reconcile existing image state and regenerate the same deterministic
chart bytes; once the candidate release exists, the workflow refuses to rerun
because its producer run-attempt binding is itself immutable. Release admission
must use the original successful candidate run ID instead of trying to rewrite
that release.

The public OCI location is a release authority, not a hard-coded provider.
`OPENGENI_RELEASE_OCI_PREFIX` is a registry host plus an optional repository
namespace (default `ghcr.io/cloudgeni-ai`). `OPENGENI_RELEASE_REGISTRY_AUTH`
selects either built-in `github` auth for that default host or `azure-oidc` for
an Azure Container Registry. The Azure mode accepts only an `*.azurecr.io`
host, uses the environment-scoped `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and
`AZURE_SUBSCRIPTION_ID` variables, pins the Azure actions and CLI version, and
mints a short-lived data-plane token; no registry password is stored.
Federated credentials must bind the exact `public-release`,
`embedded-release`, and `production-release` GitHub environments, and the
workload identity must have the narrow push role on the selected registry.

Whichever registry is selected must permit anonymous pulls. Candidate creation
logs out before it writes a receipt and proves all five image digests through
the unauthenticated path. Embedded and final promotion repeat that proof for
the published image aliases and chart bytes. A private or inconsistently
configured registry therefore fails closed before becoming distribution
authority. The candidate receipt records the full image repository names, and
every later workflow verifies them against the same source-controlled prefix.
Each official workload image is one OCI index containing both `linux/amd64`
and `linux/arm64`; candidate creation builds both variants before freezing the
index digest, so downstream hosts select their native architecture without
building OpenGeni locally.

For the default GHCR location, the owning organization must allow public
package creation and each existing `opengeni-*` container package must be made
public once in its package settings. GitHub does not expose package visibility
as a REST mutation, so release workflows must not attempt to change it. The
manual `verify-public-container-packages.yml` audit and the candidate,
embedded, and final anonymous-pull gates verify the resulting configuration.

Self-hosted embedding consumers have a narrower distribution boundary:
`.github/workflows/release-embedded.yml` publishes only an exact versioned
source that already has an immutable candidate receipt from the canonical
candidate workflow. Its dispatcher supplies the trusted candidate run ID, not a
caller-selected receipt URL or digest. The workflow re-runs the public package
gates, verifies npm `gitHead` and integrity, publishes or reconciles the exact
candidate chart, promotes the receipt's unchanged manifests to version and
full-source-SHA tags, and writes one source-bound package/image/chart BOM. It
deliberately does not create or update `latest`, and its immutable distribution
receipt makes no hosted Workbench, staging, production, or canary claim.

After staging, production, and the 72-hour canary have consumed those exact
digests and chart bytes, the protected operator-controlled
`.github/workflows/release-acceptance.yml` workflow produces the sanitized
schema-v2 acceptance bundle. Its `production-acceptance` environment is the
canonical acceptance boundary. That environment pins the operator repository
and canonical workflow path and holds a narrow artifact-read credential. A
dispatcher supplies only the operator run ID: OpenGeni requires a successful
`workflow_dispatch` run from the configured operator `main`, proves that run's
head remains on `main`, resolves exactly one unexpired source-SHA-named artifact
and its provider digest, and accepts only the two expected sanitized files.
OpenGeni then replaces all operator-supplied candidate/public-producer authority
with its independently verified candidate and current acceptance-run metadata
before validating every schema-v2 row. The canary row is bound to the same
source tree, exact chart bytes, and complete API/migration/worker/web/relay/
sandbox digest map as candidate, staging, and production; a source-only canary
claim fails closed. Acceptance requires the accepted source to remain an
ancestor of current `main`, but does not require it to remain the current tip:
compatible reviewed work can continue to merge during the canary window without
freezing `main` or invalidating an otherwise unchanged proven train. No
dispatcher can select an evidence URL, hash, repository, workflow path, or
artifact name.

Cloud-hosted operators must keep the corresponding private release ledger
equally exact: staging and production use the candidate artifacts with
`rebuild:false`; every required role is deployed; stale Helm, hotfix, and source
metadata is truthfully rewritten or cleared; and any rollback target is bound to
its source, tree, chart, and image digests and independently known safe. These
provider inventory details remain in operator-controlled evidence rather than
the sanitized public bundle, but they are mandatory dependencies of acceptance.

Public release is then an explicit dispatch of `.github/workflows/release.yml`
from a ref pinned to the accepted source SHA. Evidence admission accepts the
candidate and acceptance **run IDs**, not caller-controlled URLs, hashes,
workflow paths, or repository identities. The provenance verifier queries the
GitHub API and requires the canonical repository/workflow, a completed
successful `workflow_dispatch` run, exact commit/tree SHA and run attempt, one
owned unexpired Actions artifact with its provider digest, and the expected
artifact name. URLs and archive digests are derived only after those checks. The
same exact expected package set (including an empty set for an application-only
release) and an explicit zero-gap confirmation are still required. The product
release identity comes from the exact SemVer `version`/`appVersion` pair
committed in `deploy/helm/opengeni/Chart.yaml`; it is independent of whichever
npm packages changed. The selected dispatch ref, `source_sha`, checked-out
commit, and a commit reachable from `main` must identify the same revision.
Candidate admission rejects a product version already occupied by any official
image or chart. A final-release retry permits only aliases that already resolve
to the exact accepted digest.

The dispatch downloads the validated candidate and acceptance artifacts,
verifies their provider ZIP digests and retained sidecars, rejects any changed,
missing, or extra image role, requires migration to equal API, requires the
candidate/staging/production chart version and packaged-byte hash to match, and
validates every machine-readable contract row
before re-running the package typecheck, builds, SDK parity test, and publish
closure guard. Before touching npm it rejects any unlisted unpublished package,
rejects local version drift or an occupied version from another git source, and
retains a pre-publication plan. Afterward it requires every expected registry
entry to bind the accepted source through `gitHead` and a SHA-512 integrity value
before release image aliases can be promoted. That reconciliation also makes an
interrupted post-publication run safely resumable. The final
`verified-release-receipt-<sha>` binds the source, trusted producer provenance,
candidate/acceptance artifact identities, accepted chart bytes, registry identities,
and complete publishable package inventory. The final job is protected by the
`production-release` environment, compares any existing immutable BOM before
mutating version, full-SHA, or `latest` aliases, then verifies every alias and
the anonymous OCI chart pull against the accepted bytes. The final job publishes
or reconciles that exact accepted archive under the official chart version,
records its resulting OCI manifest digest in the BOM, and never rebuilds an
image or repackages the chart after acceptance.

The workflow emits `release-bom-<sha>` containing one deterministic
`release-bom.json`: exact
source SHA, release version, every publishable package version plus npm `gitHead`
and SHA-512 integrity, every release image's immutable SHA-256 digest, and the
official chart reference/version, OCI manifest digest, exact `.tgz` byte hash,
and artifact name. Hosts should consume this BOM as one unit and reject missing,
extra, mutable-tag-only, or version-mismatched components. The same bytes and a
SHA-256 sidecar are published once on the immutable GitHub release tag
`opengeni-release-<full-source-sha>`; a retry compares the existing public assets
byte for byte and fails instead of overwriting them. No moving BOM alias is
created. Ordinary pushes to `main` can open/update the Version PR but cannot
publish.

The stock sandbox remains a separate workload image, but the public release publishes it and
binds its immutable digest in the same BOM:

```bash
docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .
```

The Connected Machine stream relay is a separate deployed component built from
the `agent/` Cargo workspace. It is only needed when Connected Machines are
enabled (see [Connected Machines](#connected-machines)):

```bash
docker build -f agent/crates/opengeni-relay/Dockerfile -t opengeni-relay agent
```

For production Helm releases that enable Connected Machines, pin the
`opengeni-relay` image by digest as well as tag, the same way API, worker, web,
and migration images are pinned.

## Helm

Released OpenGeni charts are published as public OCI artifacts. The immutable
release BOM is authoritative for the chart reference and manifest digest. For
release installs, use that `chart.reference` and pin the chart version
explicitly; the release pipeline packages the chart with `appVersion` set to
the same OpenGeni version, and the default image tags resolve to that
appVersion:

```bash
OPENGENI_VERSION="<published-version>"
OPENGENI_CHART_OCI="<release-bom chart.reference>"

helm upgrade --install opengeni "$OPENGENI_CHART_OCI" \
  --namespace opengeni \
  --create-namespace \
  --version "$OPENGENI_VERSION" \
  --set secret.existingSecret=opengeni-runtime
```

Use the repo checkout chart path only for development, chart edits, local
rendering, or smoke tests against locally built images. `deploy/helm/opengeni`
keeps the canonical product release identity in the exact SemVer
`version`/`appVersion` pair in `Chart.yaml`; bump both together before producing
a candidate for a new product release, even when no npm package changed. If you
install from a clone instead of the OCI chart, set `api.image.tag`,
`worker.image.tag`, `web.image.tag`, `migrations.image.tag`, and, when enabled,
`relay.image.tag` to the image tag you intend to run.

Render the development chart path with an existing secret:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set global.imageRegistry=REGISTRY.example.com \
  --set secret.existingSecret=opengeni-runtime
```

For production NATS, use an existing endpoint or the official NATS chart and pass the resulting URL through `nats.url` or `OPENGENI_NATS_URL`. The chart-owned NATS template is only a disposable fixture for local and smoke verification:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set nats.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

For a self-contained Kubernetes smoke deployment, enable the optional dependency primitives:

```bash
helm template opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set postgres.enabled=true \
  --set temporal.enabled=true \
  --set nats.enabled=true \
  --set minio.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

For local Kubernetes parity testing, build local images and install the same chart into the local cluster:

```bash
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target api -t opengeni-api:local-k8s .
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target worker -t opengeni-worker:local-k8s .
docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target web -t opengeni-web:local-k8s .
kind load docker-image opengeni-api:local-k8s opengeni-worker:local-k8s opengeni-web:local-k8s --name "${KIND_CLUSTER_NAME:-opengeni-local}"

export OPENGENI_ACCESS_KEY="${OPENGENI_ACCESS_KEY:?set OPENGENI_ACCESS_KEY for local shared-key auth}"
kubectl create namespace opengeni-local --dry-run=client -o yaml | kubectl apply -f -
kubectl -n opengeni-local create secret generic opengeni-runtime-local-k8s \
  --from-literal=OPENGENI_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install opengeni-local deploy/helm/opengeni \
  --namespace opengeni-local \
  --values deploy/helm/opengeni/values.local-kubernetes.example.yaml
```

Then run conformance through port-forwards:

```bash
kubectl -n opengeni-local port-forward svc/opengeni-local-api 28080:8000
kubectl -n opengeni-local port-forward svc/opengeni-local-minio 29000:9000

OPENGENI_CONFORMANCE_ACCESS_KEY="$OPENGENI_ACCESS_KEY" \
  bun run deployment:conformance -- \
  --base-url http://127.0.0.1:28080 \
  --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000
```

The chart defaults API, worker, and web deployments to zero-surge rolling updates (`maxSurge: 0`, `maxUnavailable: 1`) so one-node smoke clusters do not need spare node capacity during upgrades. Increase surge settings in larger production clusters if you want faster replacement and have capacity headroom.

The in-cluster Postgres, Temporal, NATS, and MinIO templates are disposable conformance fixtures for local Kubernetes, CI, and smoke verification. They are not lightweight production alternatives or the production distribution of those systems. Production operators should use managed services, existing customer endpoints, or official upstream charts/operators, and provider-native object storage through the runtime secret.

Production self-hosted platform dependencies should use mature upstream projects rather than OpenGeni-owned replicas of those systems:

- NATS: official NATS Helm chart, or an existing managed/customer NATS endpoint.
- Temporal: Temporal Cloud, an existing customer endpoint, or the official Temporal Helm chart connected to external persistence.
- Postgres: managed cloud Postgres, an existing customer database, or a production PostgreSQL operator such as CloudNativePG.
- Secrets: External Secrets Operator with Azure Key Vault, AWS Secrets Manager, GCP Secret Manager, Vault, or an equivalent store.
- TLS: cert-manager, cloud load balancer certificate integration, or an existing ingress/TLS stack.
- Observability: OpenTelemetry Collector/Operator plus Prometheus Operator-compatible resources, exported to a self-hosted LGTM-compatible stack or a managed cloud backend.

The OpenGeni Helm chart owns OpenGeni API, web, worker, migrations, optional Terraform Registry MCP docs service, and integration resources such as `ServiceMonitor`, `PrometheusRule`, `ExternalSecret`, and workload NetworkPolicies. It must not become a replacement chart for NATS, Temporal, Postgres, cert-manager, or the observability platform.

The stack wrapper may install upstream charts as a convenience layer. That
keeps lifecycle commands visible and reversible without making those charts
OpenGeni chart dependencies. For managed cloud profiles, the generated stack
plan includes:

- upstream NATS from `https://nats-io.github.io/k8s/helm/charts`, release
  `opengeni-nats` in namespace `opengeni-platform`;
- upstream Temporal from `https://go.temporal.io/helm-charts`, release
  `opengeni-temporal` in namespace `opengeni-platform`;
- `deploy/stacks/opengeni-platform-networkpolicies.yaml`, which keeps those
  ClusterIP services limited to OpenGeni API/worker pods when the cluster CNI
  enforces Kubernetes `NetworkPolicy`;
- runtime endpoints wired as `nats://opengeni-nats.opengeni-platform.svc.cluster.local:4222`
  and `opengeni-temporal-frontend.opengeni-platform.svc.cluster.local:7233`.

Temporal still needs durable persistence. The committed example upstream
Temporal values file at
`deploy/stacks/official-temporal-postgres.values.example.yaml` documents the
shape, but stack runs should generate a private values file under
`.agent/generated/` instead of editing the example:

```bash
TEMPORAL_POSTGRES_HOST="$(terraform -chdir=deploy/terraform/gcp output -raw postgres_host)" \
  bun run deployment:temporal-values -- \
  --out .agent/generated/official-temporal-postgres.values.yaml
```

The generator writes no database password. By default it uses the managed
Postgres admin user `opengeni` and asks the upstream Temporal schema jobs to
create/manage the `temporal` and `temporal_visibility` databases. Create a
Kubernetes Secret named `opengeni-temporal-postgres` in `opengeni-platform`
with that user's password. Keep that database server and secret outside the
OpenGeni app chart lifecycle.
Use `TEMPORAL_POSTGRES_CONNECT_ADDR=host:port` instead of
`TEMPORAL_POSTGRES_HOST` when the provider-specific connection endpoint already
includes a port or needs a proxy-local address.

Some managed PostgreSQL services require encrypted connections. For AWS RDS,
the managed stack wrapper downloads the AWS RDS global CA bundle into
`.agent/generated/<profile>/`, creates a private `opengeni-postgres-ca`
ConfigMap in `opengeni-platform`, and generates Temporal SQL TLS settings with:

```bash
TEMPORAL_POSTGRES_TLS_ENABLED=true
TEMPORAL_POSTGRES_TLS_CA_FILE=/etc/opengeni/postgres-ca/ca.pem
TEMPORAL_POSTGRES_TLS_CA_CONFIG_MAP_NAME=opengeni-postgres-ca
```

Use an encrypted OpenGeni application database URL for the same service, for
example `OPENGENI_DATABASE_URL=postgres://.../opengeni?sslmode=require` for AWS
RDS. If a different provider or customer database requires a custom CA, mount
that CA through a private ConfigMap/Secret before running
`bun run deployment:temporal-values`. That database-to-Temporal-server TLS is
separate from the OpenGeni-to-Temporal client settings below.

After the upstream Temporal chart is running, the stack wrapper applies
`deploy/stacks/official-temporal-namespace-job.yaml` to register the Temporal
namespace used by OpenGeni (`default` by default). The OpenGeni worker cannot
poll task queues until that Temporal namespace exists.

Use this boundary when building a production cluster:

| Capability | Production source | OpenGeni wiring |
| --- | --- | --- |
| NATS | Existing endpoint or official NATS chart from `https://nats-io.github.io/k8s/helm/charts/` | `nats.enabled=false` plus `nats.url` or `OPENGENI_NATS_URL` |
| Temporal | Temporal Cloud, existing endpoint, or official Temporal chart from `https://go.temporal.io/helm-charts` with external persistence | `temporal.enabled=false` plus `OPENGENI_TEMPORAL_HOST`; add `OPENGENI_TEMPORAL_API_KEY` for Temporal Cloud |
| Postgres | Managed cloud Postgres, existing database, or CloudNativePG from `https://cloudnative-pg.github.io/charts` | `postgres.enabled=false` plus `OPENGENI_DATABASE_URL` |
| Secrets | External Secrets Operator from `https://charts.external-secrets.io`, Vault, or cloud-native secret delivery | `externalSecret.enabled=true` or `secret.existingSecret` |
| TLS | cert-manager, cloud load balancer certificates, or an existing ingress/TLS stack | `ingress.tls` and SSE-safe ingress annotations |
| Observability | OpenTelemetry Collector/Operator, Prometheus Operator CRDs, or a managed OTLP/Prometheus backend | `/metrics`, OTLP env, `ServiceMonitor`, `PrometheusRule` |

The runtime secret must provide values such as:

- `OPENGENI_DATABASE_URL`
- `OPENGENI_RUNTIME_DATABASE_ROLE=opengeni_app` for standalone FORCE-RLS deployments (the default)
- `OPENGENI_TEMPORAL_HOST`
- `OPENGENI_TEMPORAL_API_KEY` for Temporal Cloud; it enables TLS automatically
- `OPENGENI_TEMPORAL_TLS_ENABLED=true` for server-auth TLS without an API key
- optional `OPENGENI_TEMPORAL_TLS_SERVER_NAME`, `OPENGENI_TEMPORAL_TLS_ROOT_CA_CERTIFICATE_BASE64`, and the paired `OPENGENI_TEMPORAL_TLS_CLIENT_CERTIFICATE_BASE64` / `OPENGENI_TEMPORAL_TLS_CLIENT_PRIVATE_KEY_BASE64` for custom SNI, CA roots, or mTLS; any of these TLS materials also enables TLS
- `OPENGENI_NATS_URL` when not using in-cluster NATS
- `OPENGENI_STARTUP_DEPENDENCY_RETRY_*` when dependencies need longer startup windows
- `OPENGENI_OPENAI_API_KEY` or Azure OpenAI equivalents
- `OPENGENI_OBJECT_STORAGE_BACKEND=s3-compatible` plus endpoint/access-key settings for local/self-contained modes
- `OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob` plus Azure Blob connection string/account-key settings
- `OPENGENI_OBJECT_STORAGE_BACKEND=aws-s3` plus `OPENGENI_OBJECT_STORAGE_REGION`; prefer IRSA/EKS Pod Identity over static keys
- `OPENGENI_OBJECT_STORAGE_BACKEND=gcs` plus `OPENGENI_OBJECT_STORAGE_GCS_PROJECT_ID`; prefer GKE Workload Identity over service-account JSON
- `OPENGENI_PRODUCT_ACCESS_MODE=local|configured|managed`, independent of cloud/infrastructure profile
- `OPENGENI_BILLING_MODE=disabled|stripe`, `OPENGENI_ENTITLEMENTS_MODE=none|static|managed`, and `OPENGENI_USAGE_LIMITS_MODE=none|static|managed`
- `OPENGENI_AUTH_REQUIRED=true` and `OPENGENI_ACCESS_KEY` only when using the optional deployment shared-key boundary
- `OPENGENI_BETTER_AUTH_SECRET`, trusted origins, public base URL, Resend key, and delegation secret when `OPENGENI_PRODUCT_ACCESS_MODE=managed`
- `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` (base64, exactly 32 bytes; generate with `openssl rand -base64 32`) for workspace variable sets; required when `OPENGENI_PRODUCT_ACCESS_MODE=managed` outside local/test, optional otherwise (variable set routes return 503 until it is set). See `docs/variable-sets.md`.
- `OPENGENI_STRIPE_SECRET_KEY`, publishable key, webhook secret, and model pricing JSON when `OPENGENI_BILLING_MODE=stripe`
- sandbox backend credentials when required

Do not commit real secret values.

Keep `OPENGENI_MIGRATIONS_DATABASE_URL` and
`OPENGENI_APP_DATABASE_PASSWORD` out of the runtime Secret. Put them in a
separate migration-only Secret referenced by `migrations.secret.existingSecret`.

OpenGeni's storage package intentionally exposes a small provider-neutral boundary instead of calling provider SDKs directly from routes. The current shipped backends are `s3-compatible`, `azure-blob`, `aws-s3`, and `gcs`; sandbox file resources are emitted as native storage mounts when the sandbox backend supports them, or materialized through short-lived signed downloads when a backend cannot mount that provider directly. Additional providers should be added behind the same boundary, or bridged through a library such as `files-sdk` if that becomes the lowest-maintenance adapter layer.

Sandbox file mount support is also backend-specific:

| Sandbox backend | S3-compatible | Azure Blob | AWS S3 | GCS |
| --- | --- | --- | --- | --- |
| Docker/local in-container sandboxes | rclone mount | rclone mount | signed download materialization | signed download materialization |
| Modal | SDK cloud bucket mount | signed download materialization | signed download materialization | signed download materialization |

### Existing-session tool replacement rollout

`OPENGENI_SESSION_TURN_TOOL_REPLACEMENT_ENABLED` defaults to `false`. This is a
two-phase compatibility gate, not a permanent product default: older workers
merge an explicit follow-up `tools` array with session tools, while current
workers treat the accepted turn's `tools` plus `tools_provided` as exact
provenance. Enabling replacement before old workers are gone can silently widen
an explicit empty or narrowed turn.

Activate in this order:

1. Roll the provenance-aware API with the flag still `false`, and wait until no
   old API instance serves traffic. Explicit `tools` on existing-session user
   messages returns `503`; omitted tools continue to inherit normally.
2. Let any explicit replacement turns admitted before the gate settle.
3. Roll provenance-aware workers. Drain or terminate every old poller and prove
   no old attempt remains active before continuing.
4. Set `OPENGENI_SESSION_TURN_TOOL_REPLACEMENT_ENABLED=true` and roll the API
   configuration. Existing-session explicit replacement is now admitted.

Rollback is the reverse safety fence, not simply a worker image rollback:

1. Disable the flag first so no new explicit replacement turn can be admitted.
2. Drain every already-admitted replacement turn.
3. Only then roll workers back.

Initial session creation remains able to accept an explicit tool policy while
the flag is off. Reusable scheduled runs synthesize inherited internal turns and
are not separately blocked. Never rewrite or globally reinterpret historical
`tools_provided=false` rows; their durable meaning remains “the accepted turn
omitted tools and inherits its session policy.”

## Terraform Registry MCP Docs

The Helm chart can deploy an optional, cluster-internal HashiCorp Terraform MCP
server for authoritative Terraform Registry documentation:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set terraformMcp.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

This renders a `ClusterIP` service at
`http://<fullname>-terraform-mcp:8080/mcp`. For a release named `opengeni`, the
default service name is `opengeni-terraform-mcp`. Register it in
`OPENGENI_MCP_SERVERS`, for example:

```json
[
  {
    "id": "terraform-registry",
    "name": "Terraform Registry Docs",
    "url": "http://opengeni-terraform-mcp:8080/mcp",
    "cacheToolsList": true
  }
]
```

Then select it per session with an explicit tool reference such as
`{"kind":"mcp","id":"terraform-registry"}`. The chart does not wire a Terraform
Enterprise token or other provider credential into this server; it is a
registry-docs endpoint only.

## Connected Machines

A Connected Machine is a user-owned computer (a laptop, workstation, or server,
including macOS) enrolled as a first-class primary compute backend
(`OPENGENI_SANDBOX_BACKEND=selfhosted`). When a session turn targets a Connected
Machine, the platform establishes the machine session directly and routes tool
execution to the agent running on that machine over a NATS request/reply control
plane. No cloud sandbox box is created for that turn, no platform-minted GitHub
token is distributed to the machine (it uses its own local git credentials), and
repositories are not cloned onto it by the platform; the working directory is
chosen per session.

This is a separate, optional deployment surface. It is gated OFF by default;
existing deployments are completely unaffected unless an operator enables it.

### Enable flag

The whole feature is gated by `OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (default
`false`). While it is off, the enrollment routes return `404` — the surface does
not exist for the deployment — and the `selfhosted` backend is inert.

### Components to deploy

Enabling Connected Machines adds two net-new deployed components plus their
ingress and secret wiring:

- **Stream relay** (`opengeni-relay` image): a stateless wss byte-pump that
  splices the agent's producer stream and the viewer's consumer stream for a
  channel (pty/desktop). Enable with `relay.enabled=true`; the chart then renders
  the relay Deployment, Service, HPA, PodDisruptionBudget, NetworkPolicy, and —
  when observability is on — a ServiceMonitor. The relay holds no cluster state
  and makes no cluster egress; both the agent and the viewer dial IN through the
  ingress.
- **NATS with auth-callout**: the machine's agent dials a NATS websocket to reach
  the request/reply control plane, authenticated per workspace by a NATS
  auth-callout responder. Use chart-managed NATS with
  `nats.authCallout.enabled=true` for the single-machine profile and
  preview/smoke stacks, or fold the same `deploy/nats/auth-callout.conf` config
  into an external multi-node NATS deployment (`nats.enabled=false`).

Both the relay and the NATS websocket need public wss ingress hosts (for example
`relay.<domain>` and `nats.<domain>`) with the long-lived-stream ingress
annotations (read/send timeouts of at least `3600` seconds, buffering off). Flip
`selfhosted.enabled=true` together with `relay.enabled=true` and the NATS
callout.

### Ingress channel affinity

The relay pairs a channel's producer and consumer in a per-replica in-memory
registry, so both dials for a given channel must reach the SAME relay replica.
When running more than one relay replica behind an L7 ingress, configure the
ingress to route both dials for a channel to the same backend (consistent-hash or
session affinity keyed on the channel); otherwise a producer and consumer can
land on different replicas and never pair.

### Runtime-secret keys

Set these in the runtime secret (never a committed values file) when enabling
Connected Machines:

- `OPENGENI_STREAM_TOKEN_SECRET` — HMAC the relay verifies the viewer (`ogs_`)
  stream token with.
- `OPENGENI_SELFHOSTED_RELAY_TOKEN_SECRET` — HMAC the relay verifies the agent
  (`ogr_`) producer token with; may be omitted to reuse
  `OPENGENI_STREAM_TOKEN_SECRET` for both planes.
- `OPENGENI_ENROLLMENT_SIGNING_SECRET` — HMAC the control plane signs the
  enrollment bearer with (falls back to `OPENGENI_DELEGATION_SECRET`).
- `OPENGENI_SELFHOSTED_NATS_CALLOUT_ACCOUNT_SEED`,
  `OPENGENI_SELFHOSTED_NATS_CALLOUT_PUBLIC_KEY`,
  `OPENGENI_SELFHOSTED_NATS_CONTROL_PASSWORD`, and
  `OPENGENI_SELFHOSTED_NATS_CALLOUT_PASSWORD` — the NATS auth-callout account
  seed/public key and the control/callout logins.

Non-secret wiring goes in config/values: `OPENGENI_SELFHOSTED_NATS_URL` and
`OPENGENI_SELFHOSTED_RELAY_URL` (the public wss URLs the agent dials, matching the
ingress hosts) plus the callout account/user names. The relay's non-secret tuning
knobs are `OPENGENI_RELAY_RING_FRAMES`, `OPENGENI_RELAY_SPLICE_BUFFER`,
`OPENGENI_RELAY_RATE_BURST_BYTES`, `OPENGENI_RELAY_RATE_BYTES_PER_SEC`, and
`OPENGENI_RELAY_PAIR_TIMEOUT_SECS`. A missing token secret makes the relay reject
every connection (fail-closed).

### Agent binary distribution

The machine agent is served from the control plane itself. The API exposes the
install script and the per-deploy agent binary at auth-exempt paths
(`/install.sh`, `/install.ps1`, `/uninstall.sh`, and `/agent/*`), so
`curl -fsSL https://<host>/install.sh | sh` installs the exact agent build that
matches the running control plane (the per-SHA binary baked into the API image),
with no dependency on an external CDN. A public release archive is the fallback
for other OS/arch assets and the self-update channel. Route these paths (and an
optional `get.<domain>` host) to the `api` service in the ingress.

`/agent/latest/<asset>` is a compatibility route backed by the immutable
versioned release selected by `OPENGENI_AGENT_STABLE_VERSION` (default `0.1.8`).
`OPENGENI_AGENT_RELEASES_BASE_URL` selects the archive origin. Promote or roll
back the stable channel by changing the configured version only after the
corresponding `agent-v<version>` release and its signed assets exist; never move
or delete an agent release tag. A baked asset still takes precedence so a
deployed control-plane image serves its release-coherent binary directly.

### Enrolling a machine

Enrollment binds a machine to a workspace and requires the enable flag. Two paths
are supported:

- **Device flow**: the agent starts an enrollment
  (`/v1/enrollments/device/start`) and a workspace member holding
  `enrollments:manage` approves it at the consent page
  (`/v1/workspaces/:workspaceId/enrollments/device/approve`).
- **Zero-click enroll token**: a workspace member holding `enrollments:manage`
  mints a short-TTL enroll token
  (`/v1/workspaces/:workspaceId/enrollments/token`) that the agent redeems
  headlessly (`/v1/enrollments/token/exchange`) with no human approval — suited
  to fleet or headless provisioning.

Client SDKs surface the machine dashboard and enrollment flow through the
`@opengeni/react/machines` subpath, and target a session at a specific machine
with `CreateSessionRequest.targetSandboxId` (plus an optional `workingDir`).

## Security Boundary

OpenGeni separates deployment edge access from product access. `OPENGENI_AUTH_REQUIRED=true` is an optional deployment shared-key boundary for smoke tests and simple self-hosting. It is not the tenant model and it does not create users, accounts, workspaces, or billing state. Set `OPENGENI_ACCESS_KEY` through a Kubernetes Secret, ExternalSecret, or provider secret manager; clients send it as `x-opengeni-access-key`.

Product access is controlled by `OPENGENI_PRODUCT_ACCESS_MODE`:

- `local` bootstraps a local default account/workspace.
- `configured` supports self-hosted embedded deployments with delegated bearer tokens or the deployment shared-key boundary.
- `managed` uses Better Auth for browser human auth, OpenGeni-owned API keys for product/API access, Stripe prepaid credits, usage, limits, and local entitlement mirrors.

Long-lived public deployments should still sit behind a gateway or ingress stack that provides:

- TLS termination with a managed certificate.
- Authentication and authorization for every user-facing route.
- Rate limits and request size limits appropriate for session, file, and SSE traffic.
- Long-lived SSE support with buffering disabled and read/send timeouts of at least `3600` seconds.
- Access logs that include request id, user or tenant id from the gateway, route, status, and duration.
- Explicit deny rules for internal-only surfaces if you expose only the public client API.

When `OPENGENI_AUTH_REQUIRED=true`, `/v1/config/client` remains public but does not expose the access key, `/healthz` is public by default for Kubernetes probes, and `/metrics` is protected by default unless `OPENGENI_AUTH_ALLOW_METRICS=true` is set for an internal scraper path.

For AKS smoke deployments using `ingress-nginx` behind an Azure LoadBalancer service, configure the ingress controller service health probes explicitly. HTTP/HTTPS probes to `/` can mark ingress-nginx unhealthy when the default backend returns a non-200 response, leaving the public VIP allocated but unrouted. TCP probes are sufficient for the temporary ingress-controller smoke path:

```yaml
controller:
  service:
    annotations:
      service.beta.kubernetes.io/azure-load-balancer-health-probe-protocol: Tcp
      service.beta.kubernetes.io/port_80_health-probe_protocol: Tcp
      service.beta.kubernetes.io/port_443_health-probe_protocol: Tcp
```

Secret delivery should use one of these patterns:

- Kubernetes Secret created by an external secret operator from Azure Key Vault, Vault, Doppler, 1Password, or an equivalent system.
- Workload identity plus an application-side secret fetcher, once the application layer owns that integration.
- A short-lived manually created Kubernetes Secret only for smoke tests.

Do not put provider credentials, model keys, storage keys, kubeconfigs, TLS private keys, Terraform state, or generated connection strings in committed values files. Sandbox credentials are opt-in through `OPENGENI_SANDBOX_PREPARATION_PROFILES` and `OPENGENI_SANDBOX_ENV_ALLOWLIST`; keep the default `none` profile unless the run truly needs cloud or GitHub credentials inside the sandbox.

## Observability

OpenGeni emits Prometheus-native metrics. Scrape `/metrics` directly; do not route scraped metrics through OTLP. API and worker processes also emit structured JSON logs and optional OTLP/HTTP JSON traces.

Service endpoints:

- API: `GET /metrics` and `GET /healthz` on `OPENGENI_API_PORT` (default `8000`); `GET /traffic-readyz` checks Postgres for traffic routing, while `GET /readyz` reports Postgres, NATS, and Temporal with bounded timeouts.
- Worker: `GET /metrics`, `GET /healthz`, and `GET /readyz` on `OPENGENI_WORKER_HTTP_PORT` (default `8001`); readiness requires lifecycle state `ready` plus healthy Postgres, NATS, and Temporal checks. A draining worker stays live but becomes unready before polling stops.
- Relay: `GET /metrics` and `GET /healthz` on the relay port when the relay is enabled.

Useful settings:

- `OPENGENI_OBSERVABILITY_STRUCTURED_LOGS=true` for JSON logs.
- `OPENGENI_OBSERVABILITY_METRICS_ENABLED=true` to expose process and domain metrics.
- `OPENGENI_WORKER_HTTP_PORT=8001` for the worker metrics/health listener.
- `OPENGENI_AUTH_ALLOW_HEALTH=true` allows `/healthz`, `/traffic-readyz`, and `/readyz` through the deployment-key gate.
- `OPENGENI_AUTH_ALLOW_METRICS=true` allows API `/metrics` through the deployment-key gate for an internal scraper path.
- `OPENGENI_DISABLE_OPENAI_TRACING=true` disables OpenAI Agents SDK tracing; tracing also defaults off when no OTLP endpoint is configured.
- `OPENGENI_OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` to export spans to an OpenTelemetry Collector.
- `OPENGENI_OTEL_EXPORTER_OTLP_HEADERS=key=value,...` for exporter headers; put this in a secret when it contains credentials.

The Helm chart has optional Prometheus Operator wiring, off by default:

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni \
  --set observability.serviceMonitor.enabled=true \
  --set observability.prometheusRule.enabled=true \
  --set secret.existingSecret=opengeni-runtime
```

`ServiceMonitor` and `PrometheusRule` templates render only when `monitoring.coreos.com/v1` CRDs are installed. The starter rules cover stuck turns (`opengeni_turn_oldest_inflight_age_seconds > 900`), sandbox create failure ratio, orphan sandbox growth, and scraped target availability. The chart-managed OpenTelemetry Collector remains optional and is for traces/logs forwarding, not scraped metrics.

Minimum production dashboards should cover:

- API traffic: request rate, error rate, and p50/p95/p99 latency by `route`, `method`, `status`, `variable set`, and `component`.
- Worker execution: activity run rate, failure rate, and p50/p95/p99 `runAgentTurn` duration by `activity`, `status`, `variable set`, and `component`.
- Turn lifecycle: `opengeni_turns_total{outcome}`, `opengeni_turn_duration_seconds`, `opengeni_turns_inflight`, and `opengeni_turn_oldest_inflight_age_seconds`.
- Model, Codex, and sandbox SLIs: `opengeni_model_calls_total{provider,outcome}`, `opengeni_model_call_duration_seconds{provider}`, `opengeni_codex_credential_selections_total{strategy,reason}`, `opengeni_codex_credential_failures_total{kind,outcome}`, `opengeni_codex_pool_observations_total{depth}`, `opengeni_codex_pool_low_total{depth}`, `opengeni_sandbox_creates_total{backend,outcome}`, `opengeni_sandbox_create_duration_seconds{backend}`, `opengeni_sandbox_leases{liveness}`, `opengeni_sandbox_warming_timeouts_total`, and `opengeni_sandbox_orphans_terminated_total`.
- Queue and billing: `opengeni_turns_queued`, `opengeni_credit_balance_micros{account_id}`, `opengeni_credit_micros_total{kind}`, and `opengeni_build_info{version,revision}`.
- Dependency health: Postgres connection health, Temporal worker poll health, NATS connectivity, object-storage write/read conformance, and sandbox backend readiness.
- Runtime health: API/worker restarts, CPU/memory saturation, pod pending time, collector scrape/export errors, and OTLP export failures.

Prometheus-style examples:

```promql
sum by (route, method) (rate(opengeni_http_requests_total{variable set="production"}[5m]))
```

```promql
sum by (route) (rate(opengeni_http_requests_total{variable set="production",status=~"5.."}[5m]))
/
sum by (route) (rate(opengeni_http_requests_total{variable set="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(opengeni_http_request_duration_seconds_bucket{variable set="production"}[5m]))
)
```

```promql
sum by (activity, status) (rate(opengeni_worker_activity_runs_total{variable set="production"}[5m]))
```

```promql
histogram_quantile(
  0.95,
  sum by (le, activity) (rate(opengeni_worker_activity_duration_seconds_bucket{variable set="production"}[5m]))
)
```

```promql
max(opengeni_turn_oldest_inflight_age_seconds{variable set="production"})
```

Minimum production alerts:

- API/worker availability: `/healthz` or `/readyz` is unavailable from probes for more than 2 minutes.
- API errors: 5xx ratio is above 2% for 10 minutes, or any critical route stays above 5% for 5 minutes.
- API latency: p95 latency is above the product SLO for 10 minutes, tracked separately for `/v1/workspaces/:workspaceId/sessions`, event replay, SSE, scheduled-task trigger, and file routes.
- Turn stuck: the oldest in-flight turn is older than 15 minutes for 5 minutes.
- Sandbox create failures: sandbox create failure ratio is above 20% for 10 minutes.
- Sandbox orphan growth: `increase(opengeni_sandbox_orphans_terminated_total[30m]) > 0`.
- Codex credential pool: any zero-eligible observation is critical; repeated one-eligible observations are warning-level reduced redundancy. The default PrometheusRule uses `opengeni_codex_pool_low_total{depth="zero"|"one"}`.
- Worker failures: `runAgentTurn` failure ratio is above 5% for 10 minutes.
- Worker duration: p95 `runAgentTurn` duration is above the expected model/tool budget for 15 minutes.
- Scheduler health: manual scheduled-task conformance does not dispatch a session through Temporal within the configured timeout.
- Storage health: object-storage conformance cannot create, complete, presign, and read a file.
- Streaming health: SSE replay conformance does not return persisted events after reconnect.
- Collector health: collector pod is not ready or its configured OTLP exporter reports failures.
- Secret/sandbox hygiene: conformance detects unintended sandbox variable-set variables or sandbox backend startup failures.

## Azure Reference

The Azure Terraform root lives at `deploy/terraform/azure`.

It supports:

- AKS for OpenGeni workloads.
- ACR for images.
- Key Vault for runtime secret storage.
- Managed Azure PostgreSQL when `postgres.mode = "managed"`.
- Existing customer Postgres when `postgres.mode = "external"`.
- Existing Temporal endpoint when `temporal.mode = "external"`.
- Managed Azure Blob storage when `object_storage.mode = "managed"` and `object_storage.api = "azure-blob"`.
- Existing Azure Blob or S3-compatible object storage through runtime secrets.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed Blob URLs.

Before applying anything in Azure:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, Key Vault, or Terraform variables that are not committed.
3. Run:

```bash
terraform -chdir=deploy/terraform/azure init
terraform -chdir=deploy/terraform/azure validate
terraform -chdir=deploy/terraform/azure plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## AWS Reference

The AWS Terraform root lives at `deploy/terraform/aws`.

It supports EKS, ECR, S3, AWS Secrets Manager, optional RDS PostgreSQL, and existing Postgres/Temporal endpoints. Use `deploy/helm/opengeni/values.aws-managed.example.yaml` as the non-secret Helm values shape.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed S3 URLs.

Before applying anything in AWS:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, AWS Secrets Manager, or uncommitted Terraform variables.
3. Run:

```bash
terraform -chdir=deploy/terraform/aws init -backend=false
terraform -chdir=deploy/terraform/aws validate
terraform -chdir=deploy/terraform/aws plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## GCP Reference

The GCP Terraform root lives at `deploy/terraform/gcp`.

It supports GKE, Artifact Registry, GCS, Secret Manager, workload identity, optional Cloud SQL PostgreSQL, and existing Postgres/Temporal endpoints. Use `deploy/helm/opengeni/values.gcp-managed.example.yaml` as the non-secret Helm values shape.

Set `object_storage.cors_allowed_origins` to every browser origin that will
directly upload files to signed GCS URLs.

Before applying anything in GCP:

1. Keep provider resource names and cleanup notes in private operator-controlled storage outside the repository.
2. Keep secrets in local env files, Secret Manager, or uncommitted Terraform variables.
3. Run:

```bash
terraform -chdir=deploy/terraform/gcp init -backend=false
terraform -chdir=deploy/terraform/gcp validate
terraform -chdir=deploy/terraform/gcp plan
```

After apply, save exact resource names and cleanup commands outside the repository.

## Previews

The public repository does not include a pull-request workflow that deploys to
maintainer-owned infrastructure. The `preview-pr` and `preview-branch` profiles
are reusable stack-contract shapes for operator-owned automation. If an operator
wants preview deployments, they should run `bun run deployment:stack` in their
own CI/CD variable set with their own cluster, registry, secrets, and teardown
policy.

Preview profiles are managed-product previews, not fake demos. They use
disposable in-cluster Postgres, Temporal, NATS, and MinIO fixtures so state can
be torn down safely, but they still run the real API, web app, worker, model
provider, and configured sandbox backend. The checked-in
`values.preview-managed.example.yaml` file keeps replicas small and enables the
fixture data plane; generated private runtime artifacts must still provide
managed auth, Resend, Stripe test mode, GitHub App, model-provider, Modal, and
image digest values. Do not use `OPENGENI_SANDBOX_BACKEND=none` for previews
that are meant to validate product behavior.

Preview deployments should be private or maintainer-gated even when signup is
enabled. The source repo may contain the contract, Helm values shape, and
conformance scripts, but not provider secrets, kubeconfigs, Terraform state,
preview tenant data, or unsanitized evidence.

## Conformance

A deployment is not acceptable until it proves:

- API health works.
- Migrations run safely.
- Postgres and pgvector are available.
- Temporal is reachable and workers can poll the task queue.
- NATS pub/sub works.
- SSE reconnect replays from Postgres.
- Object storage can write/read.
- Sandbox backend can start and does not receive unintended credentials.
- A scripted session can create, stream, replay, run, and complete.
- A scheduled task can be created, manually triggered through Temporal, dispatch a session, and be cleaned up.
- Logs, metrics, and traces carry enough correlation data for production debugging.

Use `bun run deployment:stack`, `bun run deployment:preflight`, provider
Terraform validation, Helm rendering, and this conformance suite as the merge
and release gate for deployment changes.
