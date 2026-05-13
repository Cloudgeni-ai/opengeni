# Infrastructure Completion Audit

This audit maps the active goal to concrete evidence. Treat any `missing` or `partial` row as proof that the goal is not complete.

## Objective

Bring OpenGeni to PR-ready production deployment quality using a repo-owned goal file as the source of truth: support local verification and an Azure reference deployment, track all Azure resources for cleanup, support provisioned and existing Postgres/Temporal, keep work private with no push/PR until all gates pass, and keep checking the goal file until the implementation is complete.

## Prompt-To-Artifact Checklist

| Requirement | Evidence | Status | Notes |
| --- | --- | --- | --- |
| Repo-owned goal file | `docs/infra-deployment-goal.md` | done | Contains end goal, constraints, gates, evidence log, and remaining work. |
| Keep checking goal file | `docs/infra-deployment-goal.md` evidence log updated during implementation | done | Goal evidence, remaining-work notes, and operator actions were updated through the final verification pass. |
| Track Azure resources for cleanup | `docs/azure-resource-ledger.md` | done | Tracks resource group, AKS, ACR, Key Vault, Azure Storage account/container, image tags, temporary pull secret, runtime secrets, Helm release, and PVCs; stale MinIO and runtime smoke resources are marked deleted. |
| Cloud-provider-agnostic deployment contract | `packages/deployment/src/index.ts`, `scripts/deployment-preflight.ts`, `scripts/deployment-conformance.ts` | done | Defines profiles and modes and has live probes for API health, observability metrics, sessions, event replay, SSE, scheduled-task dispatch, storage, existing endpoints, public ingress TLS, and local Docker sandbox readiness. Modal/S3-compatible file resources use the correct Modal mount strategy, Docker/local can use in-container Azure Blob mounts, and Modal/Azure Blob is supported through worker-driven file materialization instead of unsupported native Azure Blob mounts. |
| Existing Postgres support | `azure-existing-services` profile and Terraform `postgres.mode = "external"` | done | Schema/Terraform support exists, and live `azure-existing-services` preflight passed against an explicitly configured Postgres endpoint. |
| Provisioned Postgres support | Terraform `postgres.mode = "managed"` and live Azure Flexible Server `opengeni-codex-8092-pg-ne` | done | Terraform supports Azure Flexible Server and now allow-lists both `PGCRYPTO` and `VECTOR`. A temporary managed PostgreSQL 16 Flexible Server in `northeurope` was created after `westeurope` was subscription-restricted; OpenGeni migrations applied, `pgcrypto` and `vector` extensions were verified, the `vector` type exists, 11 public tables are present, and live preflight connected to the managed endpoint. |
| Existing Temporal support | `azure-existing-services` profile and Terraform `temporal.mode = "external"` | done | Config support exists, and live `azure-existing-services` preflight passed against an explicitly configured Temporal endpoint. |
| Provisioned Temporal support | Helm in-cluster Temporal primitive | done | Self-hosted Temporal renders, runs in local Kubernetes and AKS, and participates in conformance including worker dispatch and scheduled-task trigger paths. Azure Terraform intentionally models Temporal as external because there is no first-party Azure managed Temporal product. |
| Local verification | `bun run check`, `bun run test:integration`, image builds, `bun run dev`, `bun run deployment:conformance` | done | Fast checks and integration tests pass; Docker Compose startup was verified, the sandbox image builds, generated local `.env` passed health/storage smoke, credentialed Docker sandbox conformance passed, Docker sandbox file mounts passed, and sandbox credential hygiene passed. |
| Local Kubernetes verification | local `orbstack` Kubernetes context plus Helm chart | done | Helm release `opengeni-local` revision 4 passed expanded conformance through local port-forwards with in-cluster Postgres, Temporal, NATS, MinIO, and OpenTelemetry Collector enabled. |
| Azure reference deployment | Azure bootstrap resources and AKS Helm release | done | AKS/ACR/Key Vault/Azure Storage exist and are intentionally retained for deployed verification; the temporary managed Postgres proof server was deleted after verification. API, worker, web, NATS, Postgres, Temporal, OpenTelemetry Collector, and public TLS ingress run with Azure Blob object storage and startup retry config. Public Azure LoadBalancer 80/443 reachability passed after switching the temporary ingress-nginx service health probes to TCP. Worker rollout revision 22 is running the Modal/Azure Blob materialization image and public TLS conformance passed. The preferred AKS kubelet `AcrPull` role assignment is implemented in Terraform, but the current Azure principal lacks `Microsoft.Authorization/roleAssignments/write`; the live smoke environment uses a repository-pull-scoped, expiring ACR token tracked in the ledger as the documented fallback. |
| Container images | `docker/opengeni.Dockerfile`, ACR image tags, Helm `image.digest` values | done | API/worker/web build and push; non-root API, worker, and web images are running in AKS as `tag@sha256` references at recorded digests, Azure example values document digest pinning, and the AKS worker now runs the `local-amd64-modal-azure-materialization` digest with the Azure Blob sandbox mount and Modal materialization fixes. |
| Helm chart | `deploy/helm/opengeni` | done | Lints/renders and runs API/worker/web plus NATS/Postgres/Temporal/MinIO with resource defaults, HPA templates, network policies, zero-surge app rollouts for small clusters, non-root app images, digest-pinned images, OpenTelemetry Collector templates, and TLS ingress verified through the public Azure LoadBalancer. |
| Terraform Azure reference | `deploy/terraform/azure` | done | Validates and bootstraps AKS/ACR/Key Vault, supports managed Azure Blob with private access, versioning, and seven-day retention, supports optional AKS Microsoft Defender wiring, and the managed Postgres settings have been live-verified manually against Azure Flexible Server. Existing Azure resources were imported into temporary uncommitted Terraform state under `/tmp`; the bootstrap plan returned no changes, and complete mode with explicit external Postgres/Temporal hosts produced output-only changes and no real infrastructure changes. |
| Object storage for Azure | `packages/storage`, `packages/runtime`, Azure Blob runtime secret, AKS conformance | done | Azure Blob adapter is implemented, AKS API upload/download conformance passed with MinIO disabled, runtime file resources emit native Azure Blob manifest mounts for in-container sandbox backends, Docker/Azure Blob file mounts are live-verified through rclone/FUSE, and Modal/Azure Blob file resources are live-verified through worker-driven sandbox file materialization. |
| Observability | `packages/observability`, API `/metrics`, worker activity instrumentation, Helm OpenTelemetry Collector templates, `docs/deployment.md` | done | App-level request metrics/logs/spans, worker activity spans/metrics, OTLP/HTTP JSON span export, Prometheus metrics, collector manifests, Docker Compose conformance, local Kubernetes collector rollout, AKS collector/export verification, and production dashboard/alert examples are verified or documented. |
| Security hardening | Docs, non-root images, Helm security contexts, NetworkPolicy templates, sandbox hygiene check | done | App images run as UID 1000 and API/worker/web chart templates include non-root security contexts. Docker sandbox credential hygiene passed with preparation profile `none`. Auth/gateway and secret-delivery guidance is documented. Azure Blob has nested public access disabled plus versioning/retention enabled. Permanent ACR pull path is documented through `aks_kubelet_object_id`; because the current Azure principal cannot apply role assignments, a repository-pull-scoped temporary ACR token is documented for the live smoke environment and expires on 2026-05-20. Targeted secret scanning found only placeholders and synthetic test values. |
| No premature push or PR | Local branch only | done | No push or PR created. |
| Public-history transfer | `/Users/jorgensandhaug/Documents/cloudgeni-ai/opengeni-public` | done | Fresh clone from GitHub matches `/tmp/opengeni-public-root` at `9a5be23`; infrastructure patch applied cleanly without merging old private history. |
| PR-ready CI | `.github/workflows/ci.yml` deployment and image jobs | done | Validates deployment profiles, Helm rendering including digest-pinned images, Terraform fmt/validate, and linux/amd64 API/worker/web image builds. Live Azure conformance stays outside public PR CI. |
| Completion proof | This audit | done | All prompt-to-artifact rows are complete. Remaining live-environment caveats are documented as operator actions, not code gaps. |

## Current Verified Commands

- `bun run check`
- `bun test`
- `helm lint deploy/helm/opengeni`
- `helm template ...`
- `terraform -chdir=deploy/terraform/azure fmt -check`
- `terraform -chdir=deploy/terraform/azure validate`
- `docker build` for API, worker, and web as `linux/amd64`
- Azure AKS node readiness check
- Azure NATS `/healthz` check
- Azure web service HTML smoke through port-forward
- `KUBECONFIG=/tmp/opengeni-aks-kubeconfig bun run deployment:preflight -- --profile azure-managed --json --live` for Kubernetes namespace reachability
- Public clone patch transfer file comparison against the old worktree changed files
- AKS full-stack smoke: API, worker, web, NATS, Postgres, Temporal, and MinIO pods running.
- AKS API `/healthz` through local port-forward.
- AKS Postgres `pgvector` extension present and migrated public tables visible.
- AKS live session run reached `idle` with persisted `agent.message.delta`, `agent.message.completed`, and `turn.completed` events.
- AKS SSE replay endpoint returned persisted events through local port-forward.
- AKS MinIO-backed file upload, complete, download-url, and download round trip passed through local port-forward.
- `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --object-connect-to opengeni-bootstrap-minio:9000:127.0.0.1:19000 --timeout-seconds 180 --json`
- AKS Azure Blob-backed conformance with MinIO disabled: `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --timeout-seconds 180 --json`
- Azure Blob evidence object: `files/78a265f8-34af-4ec2-9e06-dc22eeadbbd1/original/conformance.txt` in container `opengeni-files`.
- Local Kubernetes Helm conformance on `orbstack`: `bun run deployment:conformance -- --base-url http://127.0.0.1:28080 --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000 --timeout-seconds 180 --json`
- Local Kubernetes conformance session: `b26da00b-be3c-419c-9b6c-f63f54afe5f9`; conformance file: `2e1e7686-6c8e-43c6-bd3d-bbcd915d40cf`.
- Rebuilt-image local Kubernetes conformance session: `b9125b7a-d8f0-4457-8494-9924d890f9f2`; conformance file: `0b02c80a-f957-437b-9c8d-8481b942adfa`.
- AKS rebuilt-image digests verified in running pods: API `sha256:91e52c110e63c87679ddc4c3eadd02215e9e2d3f918ba7f0412600680ee27fe4`, worker `sha256:d722bfee2c86ce4cfd7a68c830a7f1f3c9e7f54f935507644c4c8f80c28b06a8`, web `sha256:a2510532b4903ebab4714ee8bebf1e81724901d56b0e56a73b11d3ed45999165`.
- AKS Azure Blob conformance after rebuilt-image rollout: session `9f587faf-419a-46f2-906b-87aea7ec46ce`; conformance file `a3154537-4953-4fcb-bafa-f659105cab3a`.
- Helm API, worker, and web deployment strategies now use `maxSurge: 0` and `maxUnavailable: 1`; verified in local Kubernetes and AKS releases.
- Local Kubernetes conformance after Helm strategy upgrade: session `aa8d0346-816d-45b7-b4b8-8c4b5116509a`; conformance file `8cdfac14-54c6-47eb-92e7-dbe1d7ca6b43`.
- AKS Azure Blob conformance after Helm strategy upgrade: session `e4016466-65dc-41ed-8df3-a54bcf7e56ae`; conformance file `c8993a36-ee63-4fd0-907d-5861d12dc2e6`.
- Startup dependency retry tests and integration: focused config/API tests passed, `bun run typecheck` passed, and `bun run test:integration` passed across API 23, DB 5, NATS 2, Temporal workflow 9, and worker activity 12 tests.
- Local Kubernetes conformance after startup retry image rollout: session `2b8d8dc5-2ab7-4d49-9870-a7c887d27ece`; conformance file `0203e3c5-75cc-4203-9f2d-72ac3a0944e5`.
- AKS Helm revision 17 includes startup retry config values `30`, `1000`, and `5000`; running pod digests are API `sha256:52b924e9df2f96725f8dd59557d6532b7cbccab96fc6ebd30cd184062ff67ec1`, worker `sha256:a359999a0f85ce19f4224a9888eb59056e6e864ae5d8adfd5803c6cad3a8bd89`, and web `sha256:7f734e4a49c0fd47c331a414bcd17eddf813dde6cc77452e9a4c8e2118517619`.
- AKS Azure Blob conformance after startup retry rollout: session `6e611f57-2a3d-41d4-9a69-c0e89fa360a4`; conformance file `2f30ac09-ea11-41fa-92f8-5df6129430e7`.
- Local sandbox image build: `docker build -f docker/sandbox.Dockerfile -t opengeni-sandbox:local .`.
- Local Docker Compose startup: `bun run dev` started Postgres on alternate host port `6432`, NATS, Temporal, MinIO, API on `8000`, worker on task queue `opengeni-runs-ts`, and Vite on an alternate free web port.
- Local Docker Compose generated-env smoke: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --skip-agent --json`; conformance file `e558879c-e93d-41fc-9371-087cd64e7096`.
- Local Docker Compose credentialed full conformance with secrets sourced in-memory from the private old repo env and not written to this repo: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --sandbox-backend none --timeout-seconds 240 --json`; session `344d7777-3dac-4b0c-9bfb-fdc795a1be5c`; conformance file `b12ceb69-8aa9-44dc-ab28-5f66f768b39b`.
- Observability unit tests: `bun test packages/observability/test/observability.test.ts`.
- Observability Helm render: `helm template opengeni-smoke deploy/helm/opengeni --namespace opengeni-smoke --set observability.otel.enabled=true --set observability.collector.enabled=true`.
- Boolean env parsing tests: `bun test packages/config/test/config.test.ts packages/observability/test/observability.test.ts`.
- Local Docker Compose generated-env smoke after observability: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --skip-agent --json`; conformance file `d6a5f73a-11a4-4dba-a04a-5a6aa1cee011`.
- Local Docker Compose credentialed full conformance after scheduled-task and observability checks were added: session `2173d8f6-7ab1-4b48-b18f-15c8c51907f9`; scheduled task `b2cf8f56-c333-4f05-ab73-1164b4a048c3`; scheduled task session `fd10e180-51de-42bf-b27a-76d260823074`; conformance file `fa1a2eec-1b72-44ad-bb71-440ec2fa2f5b`.
- Workload image builds after observability package addition: `docker build --platform linux/amd64 -f docker/opengeni.Dockerfile --target api|worker|web -t opengeni-*:local-k8s-observability .`.
- Local Kubernetes Helm revision 4 with OpenTelemetry Collector enabled passed expanded conformance: session `be08079b-dde4-4db3-82b8-a51e5a76706a`; scheduled task `4ba0f319-cc52-4ba3-b15e-50522e32f751`; scheduled task session `cce6db55-a172-40b0-8f4d-fd3e458eaa72`; conformance file `b8c55b3a-2832-4348-912c-69f93f5caa49`.
- AKS Helm revision 18 with OpenTelemetry Collector enabled passed expanded conformance: session `f1d16b1b-d139-4bca-afe4-b0ef2991057e`; scheduled task `a6a244f2-6ece-47f4-a825-f0159cee7f14`; scheduled task session `266cb1d6-1f47-4543-a823-f102e2352c59`; conformance file `0823be7c-641d-40bc-8a45-7106c491e1dc`.
- AKS observability rollout image IDs: API `sha256:4a2f541b8644721694abca4f56911067250b984357c815a1d1ad0082d1aeb9ac`, worker `sha256:9267f6c12a4e23f7cb8690059fccf89c23fa36bcef854da5a5efaf4ca7d063ee`, web `sha256:d797a70f08d0d3e072f1b5b6ba15677fef72db36d813365821a91e8833da744b`, and collector `otel/opentelemetry-collector-contrib:0.139.0`.
- AKS deployed observability evidence: `/metrics` exposed `opengeni_http_requests_total` and `opengeni_http_request_duration_seconds_bucket` for conformance routes; collector debug logs showed OTLP traces and Prometheus metrics after the run.
- Production observability documentation now includes minimum dashboard panels, PromQL examples, and alerts for API health/errors/latency, worker failures/duration, scheduled-task dispatch, object storage, SSE replay, collector health, and sandbox credential hygiene.
- Temporary AKS ingress-nginx chart `4.15.1` installed with Azure public VIP `4.175.162.38`; OpenGeni Helm revision 19 enabled TLS ingress for `opengeni.4.175.162.38.sslip.io`.
- Ingress TLS and routing through the controller service passed: HTTPS `/healthz`, `/v1/config/client`, and SSE replay returned over the TLS ingress using the self-signed smoke certificate.
- Public Azure LoadBalancer reachability passed after annotating the temporary ingress-nginx service to use TCP health probes instead of HTTP/HTTPS `/` probes. Direct HTTP to `4.175.162.38/healthz` returned `200`, direct HTTPS to `opengeni.4.175.162.38.sslip.io/healthz` returned OpenGeni API health with the smoke CA, and public TLS conformance passed using `NODE_EXTRA_CA_CERTS=/tmp/opengeni-aks-ingress.crt bun run deployment:conformance -- --base-url https://opengeni.4.175.162.38.sslip.io --timeout-seconds 240 --skip-observability --json`: session `6ba5a497-12eb-4b79-be98-6ae808f3c5ad`, scheduled task `1281f751-34fa-4631-b3c0-b646f4af0869`, scheduled task session `b577864a-5daf-45a8-b4fa-b674eb0ba914`, conformance file `8a76d117-35b1-417b-98f7-fd150b1b803a`.
- Public Azure TLS conformance passed again after rolling AKS worker revision 22 to `local-amd64-modal-azure-materialization`: session `be952e87-6bd0-4494-ab7c-7247f5f8e940`, scheduled task `6af60d39-5a0f-4a9b-9115-196a8ec6fda9`, scheduled task session `9158d46d-6b7a-4e93-9f7a-6ecab85abf06`, and conformance file `f60b9b36-27c5-4b95-a8a3-24efe640988f`; observability remained intentionally internal.
- Final local/static verification after AKS observability and ingress work: `git diff --check`, Helm lint/template rendering, Terraform fmt/validate, `bun run typecheck`, `bun test`, `bun run check`, and `bun run test:integration` passed.
- Helm now supports immutable API, worker, web, and migration image digest pinning; digest rendering was verified with `helm template`.
- AKS Helm revision 20 runs digest-pinned API, worker, web, and migration images and passed expanded conformance: session `0ce3a7f6-e0bd-4d63-a67b-1bd3901525ac`; scheduled task `e8e6f1f3-ca47-46b9-96bf-57038d610b88`; scheduled task session `17762537-2f93-4369-a9ee-690c6606bc0d`; conformance file `137f8d39-6f65-4db5-a253-ebd16d6ce4b4`.
- Live `azure-existing-services` preflight passed with explicit endpoint configuration for Postgres, Temporal, NATS, API health, and Azure Blob reachability; required runtime env validation passed without printing secret values.
- Local Docker sandbox conformance passed with session `8da30bbe-a2a6-480d-a448-67d04278925e`; scheduled task `085aba63-dd23-4b56-85bb-b003ef6e85ff`; scheduled task session `dcb9e6ce-9f21-4b73-8f52-b5ac3d89d3cc`; conformance file `cbda4677-602d-4e73-bd7b-7cff0c539c17`.
- Docker sandbox file mount proof passed: file `c0d0a1f7-9e55-41c4-a7cc-55d9273933c9`, session `63d2fbaa-accf-4ccd-bc8f-79f45248237a`, exact content match, and `agent.toolCall.*` events present.
- Docker sandbox credential hygiene proof passed: session `8fa1fea7-2b1e-4450-8e4b-22fab9fd00d7` returned `sandbox env safe` after checking common model/cloud/token variable names through a sandbox tool call.
- CI now renders digest-pinned Helm values and builds API, worker, and web workload images for `linux/amd64`.
- Production security boundary documentation now covers external auth/gateway requirements, ingress controls, safe secret-delivery patterns, and sandbox credential exposure rules.
- Modal/Azure Blob file-resource live attempts initially failed before model execution because the current OpenAI Agents SDK Modal client first rejected manifest users and then rejected Azure Blob mount entries. Runtime now avoids that unsupported mount path by materializing Azure Blob file resources as sandbox files before the agent starts.
- Managed Postgres proof passed on Azure Flexible Server `opengeni-codex-8092-pg-ne` in `northeurope`: server state `Ready`, version `16`, `azure.extensions=PGCRYPTO,VECTOR`, OpenGeni migrations applied, extensions `pgcrypto` and `vector` exist, `pg_type` includes `vector`, 11 public tables are present, and live preflight connected to `opengeni-codex-8092-pg-ne.postgres.database.azure.com:5432`.
- Docker sandbox Azure Blob file mount proof passed after fixing standard Azure Blob endpoint handling for rclone: file `e07ba892-c092-4b01-abcb-8bc2fb11abd2`, session `bc4f59ac-38af-4006-9d6f-eec43966b877`, exact content match, and `agent.toolCall.*` events present.
- Modal sandbox Azure Blob file materialization proof passed after replacing the unsupported mount path: file `e388b663-f4e9-4d37-b0e5-f5d400233496`, exact content `modal-azure-blob-file-proof-64def23b-0c00-4aa4-97e6-a5738b9c8872`, and agent output matched exactly.

## Local Kubernetes Requirement

- The local Kubernetes path must use the same Helm chart as Azure.
- Local Kubernetes may use in-cluster Postgres, Temporal, NATS, and MinIO for parity/smoke testing, but production docs must still prefer managed/external object storage such as Azure Blob.
- The conformance command must pass against the local Kubernetes API service, including API health, session run, event replay, SSE replay, and object storage upload/download.

## Current Operator Actions

- Full API/worker Azure smoke now runs with in-cluster Postgres, Temporal, NATS, Azure Blob object storage, OpenTelemetry Collector, and public TLS ingress through ingress-nginx. For a long-lived production environment, replace the smoke-only in-cluster Postgres/Temporal and temporary ingress certificate with production-grade service choices.
- Active AKS/ACR/Key Vault/Azure Storage resources are intentionally retained for ongoing deployed verification and are fully covered by `docs/azure-resource-ledger.md`; the temporary managed Postgres proof server was deleted after verification.
- API and worker now retry startup connections to NATS and Temporal with bounded configurable backoff, and the default local stack path has been smoke-tested after the change.
- The current Azure principal cannot create role assignments, so AKS `AcrPull` requires an operator action for the preferred path. The retained smoke deployment currently uses the tracked, expiring `acr-pull-temp` secret.
- Azure Blob API object storage is implemented and verified, sandbox manifests support Azure Blob mounts for in-container backends, Docker sandbox file mounts are verified, and Modal cloud sandbox file resources are verified through sandbox file materialization.
- The stale `opengeni-runtime-live` secret and unused MinIO PVC were deleted; the retained AKS smoke deployment uses `opengeni-runtime-azure` and one Postgres PVC.
- Observability is implemented for app metrics/logs/spans and Helm collector rendering; local Kubernetes plus AKS collector rollouts are verified; production dashboard and alert examples are documented.
