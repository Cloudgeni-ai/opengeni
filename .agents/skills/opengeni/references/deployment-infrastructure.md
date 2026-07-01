# OpenGeni Deployment And Infrastructure

Use this reference to orient source discovery for OpenGeni deployment work. It is not a frozen operator manual; inspect the current repo before making exact claims.

## Source Map

- Deployment contract and profile renderer: `packages/deployment`.
- Operator guide and commands: `docs/deployment.md`.
- OpenGeni application chart: `deploy/helm/opengeni`.
- Provider substrate examples: `deploy/terraform/azure`, `deploy/terraform/aws`, and `deploy/terraform/gcp`.
- Optional stack wrappers for upstream platform charts: `deploy/stacks`.
- Validation scripts: `scripts/deployment-preflight.ts`, `scripts/deployment-stack.ts`, `scripts/deployment-runtime-artifacts.ts`, `scripts/deployment-temporal-values.ts`, and `scripts/deployment-conformance.ts`.
- Connected Machine (`selfhosted` backend) surfaces: the stream relay edge `agent/crates/opengeni-relay`; the enrollment routes `apps/api/src/routes/enrollments.ts` over `apps/api/src/sandbox/enrollment.ts`; the agent install/binary routes `apps/api/src/routes/install.ts` plus the committed `agent/install`; the relay/NATS chart templates under `deploy/helm/opengeni/templates` (`relay-*.yaml`, `nats-*.yaml`) and the `relay`/`nats`/`selfhosted` blocks in `deploy/helm/opengeni/values.yaml`; the `@opengeni/react/machines` client subpath.

If paths move, rediscover by searching for deployment profile names, `DeploymentContract`, `stackPlanFor`, `deployment:preflight`, `deployment:stack`, Helm values files, and Terraform roots.

For any concrete deployment claim, inspect the selected profile and render the
current stack plan:

```bash
bun run deployment:stack -- --profile <profile>
```

Use the stack plan as the operator-facing map for created resource classes,
managed wrapper charts, external dependencies, required secret keys, deploy
commands, verification commands, and destroy commands.

## Durable Model

OpenGeni should deploy as a provider-neutral application layer plus provider-specific substrate wiring:

- The OpenGeni Helm chart owns API, web, worker, migrations, runtime config, app service accounts, app NetworkPolicies, and integration resources.
- Managed or existing platform services provide durable Postgres, object storage, secrets, ingress/TLS, and observability.
- NATS and Temporal are outside the OpenGeni app chart in production. They can be existing endpoints, managed services where available, or official upstream Helm charts installed by stack-wrapper commands.
- Built-in Postgres, Temporal, NATS, and MinIO chart templates are disposable fixtures for local development, CI, previews, and smoke/conformance use; do not present them as production substitutes.
- Runtime artifacts generated from Terraform outputs split non-secret Helm values from private runtime env files. Generated artifacts belong in ignored local paths and must not be committed.

## Real Versus Smoke Deployment

A real deployment means the API, web app, worker, Postgres, NATS, Temporal,
object storage, model provider, selected sandbox backend, ingress/auth boundary,
and observability path are configured for the intended environment and verified
together.

A smoke deployment means one or more pieces are intentionally stubbed,
deterministic, disabled, or only statically validated. Helm rendering,
Terraform validation, image builds, deterministic test workers, fixed "hello"
responses, and `OPENGENI_SANDBOX_BACKEND=none` are smoke signals, not proof of
real agent execution.

`OPENGENI_SANDBOX_BACKEND=none` is acceptable for API, platform, auth,
observability, and object-storage smoke checks. It is not acceptable when the
claim is that real agent execution, tools, file resources inside the sandbox, or
production sandbox isolation works.

## Profiles And Modes

The built-in profile families are:

- Local: Docker Compose and local Kubernetes with disposable dependencies.
- Generic Kubernetes: app workloads connected to existing services.
- Azure/AWS/GCP managed: provider Terraform substrate, provider-native object storage, and optional stack-wrapper upstream NATS/Temporal.
- Azure/AWS/GCP existing services: app workloads wired to already-owned provider services.
- Preview/self-contained: isolated conformance-oriented Kubernetes environments.

For exact profile names, supported modes, env vars, generated commands, and validation checks, inspect `packages/deployment` or run the deployment scripts.

When planning a deployment, make these choices explicitly from current source:

- Runtime target: local, generic Kubernetes, Azure, AWS, GCP, preview, or self-contained smoke.
- Service ownership: managed substrate, existing customer services, or disposable in-cluster fixtures.
- Persistence: managed/external Postgres with required extensions and durable Temporal persistence.
- Coordination: existing/managed/official-chart Temporal and NATS endpoints outside the app chart.
- Files: provider-native object storage where possible, with browser-upload CORS for the deployed origin.
- Execution: real model provider credentials and a real sandbox backend unless the goal is smoke only.
- Edge: ingress, TLS, auth boundary, metrics exposure, tracing/logging, and secret delivery.
- Product posture: `access.mode` (`local`, `configured`, `managed`), `billing.mode`, `entitlements.mode`, and `usageLimits.mode`. Keep this orthogonal to cloud profile names such as `azure-managed`.

## Connected Machines Versus Self-Hosted Deployment

"Self-hosted" is overloaded in this repo — keep the two meanings distinct:

- **Self-hosted DEPLOYMENT**: an operator runs the whole OpenGeni product
  (API/web/worker + Postgres/NATS/Temporal/object storage) on their own
  infrastructure. This is what every profile above and `docs/deployment.md`
  describe.
- **Connected Machine (user-owned compute)**: the `selfhosted` sandbox backend
  (`OPENGENI_SANDBOX_BACKEND=selfhosted`; also the 11th entry in the
  `SandboxBackend` enum and the `selfhosted` `MachineKind`). A user enrolls their
  own computer as a first-class primary compute target. A machine-targeted turn
  establishes the machine session directly and routes tool execution to the
  agent on that machine over NATS request/reply; the platform creates no cloud
  box, distributes no platform-minted git token (the machine uses its own git
  credentials), and does not clone repos onto it. Optional and OFF by default.

Operator surfaces the Connected Machine feature adds, all gated by
`OPENGENI_SANDBOX_SELFHOSTED_ENABLED` (default off → enrollment routes 404, the
backend is inert):

- **The stream relay** (`opengeni-relay` image, `relay.enabled=true`): the wss
  channel a machine's agent dials OUT to. It splices the agent's producer stream
  and the viewer's consumer stream in a per-replica in-memory registry, so a
  multi-replica relay behind an L7 ingress needs channel affinity (both dials for
  a channel must reach the same replica). It holds no cluster state and makes no
  cluster egress.
- **NATS with auth-callout** (`nats.authCallout` or an external NATS running the
  same `deploy/nats/auth-callout.conf`): the per-workspace-scoped control plane
  the agent authenticates to.
- **Agent-binary hosting from the control plane**: the API serves the install
  script and the per-deploy agent binary at auth-exempt paths (`/install.sh`,
  `/install.ps1`, `/agent/*`; `apps/api/src/routes/install.ts`), so the install
  one-liner pulls the exact agent build matching the running control plane, with a
  public release archive as fallback/self-update.
- **Runtime-secret + non-secret wiring**: the relay/enrollment/NATS token secrets
  and the `OPENGENI_SELFHOSTED_*` URLs/names (see the `values.yaml` `secret:`
  comment and `packages/config`).

## Verification Meaning

Passing typecheck, unit tests, Helm rendering, and Terraform validation only proves static correctness. A deployment is operational only after conformance verifies health, access boundary, workspace discovery, workspace-scoped session creation/run, event replay, SSE reconnect, scheduled-task dispatch, object storage upload/download, managed auth/API key behavior when applicable, billing/credit behavior when applicable, and the selected sandbox/model path for the intended configuration.

Deterministic test workers and fixed responses are infrastructure smoke tools, not proof that real model-provider credentials, real sandbox backends, or production tool execution are configured.

Skipped conformance checks are explicit verification gaps. Do not report a
subsystem as working when its check was skipped, replaced by a deterministic
stub, or run against a different profile than the one being claimed.

Stop and resolve the gap before claiming operational readiness when model
credentials are missing, the sandbox backend is `none` but real execution is
expected, object-storage CORS is unknown, ingress/auth behavior is ambiguous, a
core conformance check is skipped, cloud credentials allow creation but not
cleanup, or docs contradict current source.

## Security Boundaries

- Ingress-enabled deployments require an explicit product access mode and, when selected, a deployment edge boundary.
- The deployment shared-key boundary is deliberately simple and uses `x-opengeni-access-key`. It is not Better Auth, not an API key, and not the tenant model.
- Product API keys and delegated product tokens use `Authorization: Bearer`.
- First-party MCP access is workspace-scoped at `/v1/workspaces/:workspaceId/mcp` and follows the same access grant model as the REST routes.
- Managed billing uses local Stripe mirrors, prepaid credit ledger entries, usage events, and local limit checks. Core operational routes should not import Stripe.
- RLS confidence requires testing policies through a non-owner database role with transaction-local workspace/account settings. Do not claim RLS from app-level checks alone.
- Prefer workload identity, IRSA/EKS Pod Identity, managed identity, or secret-manager delivery over static cloud keys.
- Object-storage CORS must allow the deployed browser origin for signed direct uploads; use exact HTTPS origins for long-lived deployments.
- Keep cloud account identifiers, generated credentials, kubeconfigs, Terraform state/plans, filled tfvars, and private endpoints outside the public repository.

## Provider-Specific Quirks Worth Rechecking

- Azure Blob maps `OPENGENI_OBJECT_STORAGE_BUCKET` to a container and uses SAS URLs for browser upload/download. Managed Postgres may require provider extension allowlists for Temporal visibility schemas.
- AWS S3 should use native `aws-s3` storage with region and identity-based auth where possible. RDS-backed Temporal often needs TLS/CA wiring for the official Temporal chart.
- GCS should use native `gcs` storage with Workload Identity where possible. GKE node placement and Cloud SQL private networking can materially change cost and readiness.
- Docker/local S3-compatible storage needs host and sandbox endpoints to match the network where signed URLs are consumed.
- Modal and non-Docker sandboxes generally receive file resources through signed-download materialization rather than native object-store mounts.

When changing any of this, update code, docs, examples, and tests together; stale deployment docs are worse than missing docs.
