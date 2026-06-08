# OpenGeni Deployment And Infrastructure

Use this reference to orient source discovery for OpenGeni deployment work. It is not a frozen operator manual; inspect the current repo before making exact claims.

## Source Map

- Deployment contract and profile renderer: `packages/deployment`.
- Operator guide and commands: `docs/deployment.md`.
- OpenGeni application chart: `deploy/helm/opengeni`.
- Provider substrate examples: `deploy/terraform/azure`, `deploy/terraform/aws`, and `deploy/terraform/gcp`.
- Optional stack wrappers for upstream platform charts: `deploy/stacks`.
- Validation scripts: `scripts/deployment-preflight.ts`, `scripts/deployment-stack.ts`, `scripts/deployment-runtime-artifacts.ts`, `scripts/deployment-temporal-values.ts`, and `scripts/deployment-conformance.ts`.

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
