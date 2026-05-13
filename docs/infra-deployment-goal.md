# OpenGeni Infrastructure Goal

This file is the source of truth for the current infrastructure work. Keep it updated as implementation details change, and do not treat the work as complete until every required gate is satisfied with evidence.

## End Goal

OpenGeni is ready for an open-source pull request that adds a robust, cloud-provider-agnostic deployment foundation and proves it works locally and in an Azure reference environment.

The final state must support:

- Local full-stack development with the existing Docker Compose path.
- Local Kubernetes development and conformance through the same Helm chart used for Azure reference verification.
- Kubernetes as the default workload plane for OpenGeni API, web, worker, migration jobs, telemetry collection, and optional in-cluster services.
- Azure as the first real reference deployment target.
- Existing customer services for Postgres and Temporal, not only newly provisioned resources.
- Managed, external, and in-cluster modes where the primitive supports those modes.
- A deterministic deployment contract that agents, docs, Helm, Terraform, and conformance checks can all use.
- A private iteration flow: do not push a branch, open a PR, publish deployment endpoints, or expose premature work before all gates pass.

## Non-Negotiable Constraints

- Do not commit secrets, local `.env` files, Azure subscription identifiers that are not necessary examples, generated credentials, kubeconfigs, Terraform state, or customer-specific values.
- Do not print secret values to logs or final answers.
- Track every Azure resource created for this work in `docs/azure-resource-ledger.md` before or immediately after creation.
- Prefer least-privilege cloud identities and short-lived credentials.
- Treat sandbox credential exposure as explicit opt-in through preparation profiles and allowlists.
- Preserve OpenGeni's runtime architecture: API is the public surface, Postgres is durable truth, NATS is live fanout, Temporal is orchestration, workers own side effects, and sandboxes are isolated execution environments.
- Support both provisioned and existing Postgres/Temporal deployment modes.
- Keep all generated artifacts reproducible from source-controlled templates or scripts.

## Required Capabilities

The deployment foundation must describe and verify these primitives:

- Kubernetes runtime for API, web, worker, migrations, and support workloads.
- Postgres with pgvector for sessions, event log, documents, and indexes.
- Temporal endpoint, namespace, task queue, and worker connectivity.
- NATS endpoint for live fanout, with durable replay still backed by Postgres.
- S3-compatible object storage for local/self-contained modes and explicitly implemented provider adapters for production object stores such as Azure Blob.
- Secret delivery from Kubernetes Secrets, External Secrets, Vault, Azure Key Vault, or equivalent.
- Ingress/TLS with long-lived SSE support and safe timeouts.
- OpenTelemetry-compatible traces, metrics, and structured logs.
- Container registry and immutable image tags.
- Sandbox backend selection and readiness verification.
- Backup, restore, retention, and cleanup expectations for durable data.
- Auth/gateway boundary guidance until OpenGeni ships built-in auth, tenancy, RBAC, or API keys.

## Target Profiles

- `local-compose`: existing local Docker Compose stack plus local sandbox image.
- `local-kubernetes`: local Kubernetes cluster running the Helm chart with in-cluster dependencies for parity with the cloud workload shape.
- `kubernetes-external`: Kubernetes workloads connected to existing Postgres, Temporal, NATS, object storage, secrets, ingress, and observability.
- `azure-managed`: Azure reference deployment with managed Azure substrate where practical and OpenGeni workloads on AKS.
- `azure-existing-services`: AKS workload deployment connected to existing customer Postgres and Temporal.
- `self-contained-kubernetes`: optional profile for demos, air-gapped testing, or customers who want in-cluster dependencies.

## Azure Reference Expectations

The Azure path should be able to create or connect:

- Resource group tagged for cleanup.
- AKS cluster.
- Azure Container Registry or customer-provided registry.
- Azure Database for PostgreSQL Flexible Server with pgvector verified, or existing compatible Postgres.
- Temporal endpoint from Temporal Cloud, customer-provided Temporal, or a self-hosted profile.
- Azure Blob object storage for production file bytes, with optional S3-compatible/MinIO only for local and self-contained smoke deployments.
- Azure Key Vault or External Secrets integration.
- Ingress controller, DNS/TLS instructions, and SSE-compatible configuration.
- Azure Monitor or another OpenTelemetry export target.
- Workload identity or an equivalent secure secret-delivery strategy.

## Verification Gates

The work is not complete until all applicable gates pass:

- `bun install --frozen-lockfile`
- `bun run typecheck`
- `bun test`
- web production build
- integration tests for API, DB, NATS, Temporal workflow, and worker activity
- local full-stack smoke test through `bun run dev`
- local Kubernetes smoke/conformance test through the Helm chart
- deployment contract schema validation for every target profile
- Helm lint/template/schema validation
- Terraform fmt/validate/plan for Azure reference modules
- preflight against existing Postgres and Temporal modes
- Azure deployment smoke test
- conformance session run: create session, stream events, replay events, execute worker turn, verify persisted event history
- object storage upload/read verification from API and sandbox-relevant path; Azure Blob must pass API upload/download conformance without MinIO.
- sandbox backend readiness test
- scheduled task verification when Temporal is configured
- observability verification for logs, metrics, traces, and labels
- security checks: secret scan, no committed credentials, explicit sandbox env allowlist, network policy review
- cleanup verification for all temporary Azure resources

## Conformance Checks

The conformance suite should prove:

- API `/healthz` responds.
- API can connect to Postgres.
- Migrations are applied exactly once and are safe to rerun.
- pgvector extension is available when document search is enabled.
- API and worker can reach Temporal.
- Worker can poll the configured task queue.
- API and worker can publish/subscribe through NATS.
- SSE reconnect can backfill from Postgres by event sequence.
- Object storage can store, retrieve, and presign or expose objects as configured.
- Sandbox can start, receive the expected environment, and avoid unintended credential exposure.
- A scripted agent run can complete without live model dependency.
- Logs, metrics, and traces include enough correlation fields for production debugging.

## PR-Ready Definition

The final change is ready to push and open a PR only when:

- All required gates above pass or have a documented, acceptable reason for being skipped.
- `docs/azure-resource-ledger.md` is complete and any temporary resources are deleted or intentionally retained.
- README, SECURITY, AGENTS, and deployment docs match the implemented behavior.
- CI covers the new package/scripts without requiring live Azure credentials.
- The Azure reference path is reproducible from a clean checkout plus documented credentials.
- There are no untracked required artifacts.
- The diff contains no unrelated refactors or generated noise.

## Current Status

- Status: PR-ready locally; no push or PR has been created.
- Active goal: make this repo PR-ready for local and Azure deployment foundations.
- Completion notes: the implementation, docs, local verification, local Kubernetes verification, Azure smoke deployment, and Azure resource ledger are complete. The only live-environment caveat is Azure RBAC: the current principal cannot create the preferred AKS kubelet `AcrPull` role assignment, so the retained smoke deployment uses a tracked, repository-pull-scoped, expiring ACR token until an operator with `Microsoft.Authorization/roleAssignments/write` applies the documented role assignment.

## Evidence Log

- Added deployment source-of-truth package: `packages/deployment`.
- Added profile/preflight command: `bun run deployment:profiles` and `bun run deployment:preflight`.
- Added Helm chart: `deploy/helm/opengeni`.
- Added Azure Terraform reference substrate: `deploy/terraform/azure`.
- Added workload image Dockerfile: `docker/opengeni.Dockerfile`.
- Verified `bun run typecheck` passes.
- Verified `bun test` passes.
- Verified Helm lint and template rendering pass.
- Verified Terraform fmt/validate pass for `deploy/terraform/azure`.
- Verified local image builds for `opengeni-api:local`, `opengeni-worker:local`, and `opengeni-web:local`.
- Verified `bun run check` passes.
- Added CI deployment-artifact validation for profiles, Helm rendering, and Terraform validation.
- Added completion audit: `docs/infra-completion-audit.md`.
- Created Azure bootstrap substrate in `rg-opengeni-codex-8092`: AKS, ACR, and Key Vault.
- Pushed `opengeni-api:local`, `opengeni-worker:local`, and `opengeni-web:local` to the Azure Container Registry.
- Installed a NATS-only Helm bootstrap release on AKS and verified NATS `/healthz`.
- Verified temporary ACR pull secret path, deployed the web image to AKS, and smoke-tested the web service through local port-forward.
- Fixed image build scripts to default to `linux/amd64` after AKS rejected the initial local arm64 image.
- Rebuilt and pushed explicit `local-amd64` tags for API, worker, and web images.
- Recorded all created Azure resources and cleanup commands in `docs/azure-resource-ledger.md`.
- Confirmed AKS `AcrPull` role assignment is blocked by the current Azure principal lacking `Microsoft.Authorization/roleAssignments/write`; Terraform now supports `create_acr_pull_role_assignment=false`.
- Added Terraform output and docs for operator-managed AKS `AcrPull` assignment when Terraform lacks RBAC permissions.
- Added non-root app images and Helm security contexts for API, worker, and web.
- Verified non-root web image in AKS with `runAsUser=1000` and `allowPrivilegeEscalation=false`.
- Added default CPU/memory requests and limits for API, worker, web, migrations, and NATS; verified chart render and AKS web rollout.
- Added optional HPA templates for API, worker, and web; verified Helm rendering.
- Added optional Helm-managed Postgres, Temporal, and MinIO primitives for self-contained Kubernetes and Azure reference smoke deployments.
- Added live preflight probe support for Kubernetes namespace, TCP endpoints, object storage endpoint reachability, and API health.
- Moved the work from the old private-history worktree to a fresh public-history clone at `/Users/jorgensandhaug/Documents/cloudgeni-ai/opengeni-public`; the public clone matches `/tmp/opengeni-public-root` at `9a5be23` before applying this patch.
- Attempted an AKS in-cluster dependency smoke pass, then restored the stable NATS/web bootstrap and deleted the temporary runtime secret and PVCs after Postgres/Temporal were not yet ready on the small reference node.
- Fixed the in-cluster Postgres chart security context for the official pgvector image and verified Postgres, Temporal, MinIO, NATS, web, API, and worker are all running in AKS.
- Verified AKS API health through port-forward, pgvector availability, migrated table count, a real session run to final `idle`, replayed persisted events, SSE replay output, and MinIO-backed file upload/download.
- Added reusable deployment conformance command: `bun run deployment:conformance`.
- Verified `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --object-connect-to opengeni-bootstrap-minio:9000:127.0.0.1:19000 --timeout-seconds 180 --json` against the AKS port-forwarded API and MinIO service.
- Added provider-neutral object storage boundary with `s3-compatible` and `azure-blob` backends.
- Added Azure Blob configuration validation, SAS upload/download URL support, server-side head/read support, and unit tests.
- Added Terraform support for managed Azure Storage account and private Blob container when `object_storage.mode = "managed"` and `object_storage.api = "azure-blob"`.
- Created Azure Storage account `opengenicodex8092files` and private container `opengeni-files`; updated the Azure resource ledger with cleanup commands.
- Rotated the Azure Storage access key after a local environment inspection printed the previous connection string in command output; updated the Kubernetes runtime secret with the rotated key.
- Rebuilt and repushed API, worker, and web `local-amd64-nonroot` images after the Azure Blob adapter changes.
- Switched the AKS `opengeni-bootstrap` release to `OPENGENI_OBJECT_STORAGE_BACKEND=azure-blob`, disabled MinIO, and verified API, worker, web, Postgres, Temporal, and NATS pods are running.
- Verified `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --timeout-seconds 180 --json` against AKS with Azure Blob storage: API health, live session run, event replay, SSE replay, and file upload/download passed.
- Confirmed the Azure Blob container contains the conformance object `files/78a265f8-34af-4ec2-9e06-dc22eeadbbd1/original/conformance.txt`.
- Hardened MinIO bucket bootstrap retries for local Docker Compose, test Docker Compose, and the optional Helm self-contained MinIO job.
- Added local Kubernetes parity as a required target: the Helm chart must run and pass conformance locally, not only on Azure.
- Added first-class `local-kubernetes` deployment profile to the deployment contract.
- Built local Kubernetes workload images `opengeni-api:local-k8s`, `opengeni-worker:local-k8s`, and `opengeni-web:local-k8s`.
- Verified fresh Helm install into local `orbstack` Kubernetes namespace `opengeni-local` with in-cluster Postgres, Temporal, NATS, and MinIO.
- Fixed Helm migration hook ordering so clean installs create chart resources before running migrations, while upgrades still run migrations before workload changes.
- Verified local Kubernetes conformance: `bun run deployment:conformance -- --base-url http://127.0.0.1:28080 --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000 --timeout-seconds 180 --json` passed API health, live session run, event replay, SSE replay, and file upload/download.
- Replaced the temporary Azure Blob sandbox file-resource limitation with native `azure_blob_mount` manifest entries for attached files.
- Updated ACR digest tracking after rebuilding API, worker, and web images for Azure Blob sandbox manifest support.
- Rolled the rebuilt local Kubernetes images and re-verified local Kubernetes conformance after the runtime change: session `b9125b7a-d8f0-4457-8494-9924d890f9f2`, file `0b02c80a-f957-437b-9c8d-8481b942adfa`.
- Rolled the rebuilt AKS images and verified the running pods use API digest `sha256:91e52c110e63c87679ddc4c3eadd02215e9e2d3f918ba7f0412600680ee27fe4`, worker digest `sha256:d722bfee2c86ce4cfd7a68c830a7f1f3c9e7f54f935507644c4c8f80c28b06a8`, and web digest `sha256:a2510532b4903ebab4714ee8bebf1e81724901d56b0e56a73b11d3ed45999165`.
- Verified AKS Azure Blob conformance against rebuilt images: session `9f587faf-419a-46f2-906b-87aea7ec46ce`, file `a3154537-4953-4fcb-bafa-f659105cab3a`.
- Fixed Helm API, worker, and web deployment strategy defaults to use zero-surge rolling updates so the one-node local and Azure reference clusters do not require spare node capacity during upgrades.
- Applied the zero-surge strategy to the live local Kubernetes and AKS releases.
- Re-verified local Kubernetes conformance after the Helm strategy upgrade: session `aa8d0346-816d-45b7-b4b8-8c4b5116509a`, file `8cdfac14-54c6-47eb-92e7-dbe1d7ca6b43`.
- Re-verified AKS Azure Blob conformance after the Helm strategy upgrade: session `e4016466-65dc-41ed-8df3-a54bcf7e56ae`, file `c8993a36-ee63-4fd0-907d-5861d12dc2e6`.
- Added configurable API/worker startup dependency retries for NATS and Temporal: `OPENGENI_STARTUP_DEPENDENCY_RETRY_ATTEMPTS`, `OPENGENI_STARTUP_DEPENDENCY_RETRY_INITIAL_DELAY_MS`, and `OPENGENI_STARTUP_DEPENDENCY_RETRY_MAX_DELAY_MS`.
- Verified startup retry unit coverage and full integration coverage after the change: API 23, DB 5, NATS 2, Temporal workflow 9, and worker activity 12 integration tests passed.
- Rebuilt and repushed API, worker, and web images after the startup retry change; current ACR digests are API `sha256:52b924e9df2f96725f8dd59557d6532b7cbccab96fc6ebd30cd184062ff67ec1`, worker `sha256:a359999a0f85ce19f4224a9888eb59056e6e864ae5d8adfd5803c6cad3a8bd89`, and web `sha256:7f734e4a49c0fd47c331a414bcd17eddf813dde6cc77452e9a4c8e2118517619`.
- Verified local Kubernetes conformance on retry-build images: session `2b8d8dc5-2ab7-4d49-9870-a7c887d27ece`, file `0203e3c5-75cc-4203-9f2d-72ac3a0944e5`.
- Applied startup retry config to AKS Helm revision 17 and verified running API, worker, and web pods use the retry-build ACR digests.
- Verified AKS Azure Blob conformance after startup retry rollout: session `6e611f57-2a3d-41d4-9a69-c0e89fa360a4`, file `2f30ac09-ea11-41fa-92f8-5df6129430e7`.
- Verified the sandbox image Dockerfile now survives the previously flaky apt download path by building `opengeni-sandbox:local` successfully.
- Verified default local Docker Compose startup through `bun run dev`: dependency containers started, migrations reran safely, sandbox image built from cache, API listened on `8000`, worker joined the Temporal task queue, and Vite selected an alternate free web port.
- Verified Docker Compose API/object-storage smoke with generated local `.env`: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --skip-agent --json` passed API health and file upload/download with file `e558879c-e93d-41fc-9371-087cd64e7096`.
- Verified full Docker Compose conformance using private model credentials sourced in-memory without writing secrets to the public repo: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --sandbox-backend none --timeout-seconds 240 --json` passed API health, live session run, event replay, SSE replay, and file upload/download with session `344d7777-3dac-4b0c-9bfb-fdc795a1be5c` and file `b12ceb69-8aa9-44dc-ab28-5f66f768b39b`.
- Added repo-owned observability primitives: API Prometheus metrics at `/metrics`, HTTP request metrics/logging/spans, worker `runAgentSegment` activity metrics/spans, OTLP/HTTP JSON span export, and optional Helm-managed OpenTelemetry Collector manifests.
- Verified observability unit coverage: `bun test packages/observability/test/observability.test.ts` passed.
- Verified Helm observability rendering: `helm lint deploy/helm/opengeni` and `helm template ... --set observability.otel.enabled=true --set observability.collector.enabled=true` rendered collector, OTLP endpoint, `/metrics`, and Prometheus scrape annotations.
- Fixed boolean environment parsing so string values such as `false` and `0` are not coerced to true; verified with config tests and direct `getSettings()` inspection.
- Expanded `bun run deployment:conformance` to verify `/metrics` and manual scheduled-task dispatch through Temporal.
- Re-verified local Docker Compose generated-env smoke after observability changes: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --skip-agent --json` passed API health, observability, and file upload/download with file `d6a5f73a-11a4-4dba-a04a-5a6aa1cee011`.
- Re-verified credentialed full Docker Compose conformance after observability and scheduled-task changes: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --sandbox-backend none --timeout-seconds 240 --json` passed API health, observability, live session run, event replay, SSE replay, manual scheduled-task dispatch, and file upload/download with session `2173d8f6-7ab1-4b48-b18f-15c8c51907f9`, scheduled task `b2cf8f56-c333-4f05-ab73-1164b4a048c3`, scheduled session `fd10e180-51de-42bf-b27a-76d260823074`, and file `fa1a2eec-1b72-44ad-bb71-440ec2fa2f5b`.
- Fixed `docker/opengeni.Dockerfile` to include the new `packages/observability` workspace manifest before `bun install --frozen-lockfile`; verified API, worker, and web image builds.
- Upgraded local Kubernetes release `opengeni-local` to revision 4 with `opengeni-*-:local-k8s-observability` images and the chart-managed OpenTelemetry Collector enabled.
- Verified local Kubernetes expanded conformance after observability rollout: `bun run deployment:conformance -- --base-url http://127.0.0.1:28080 --object-connect-to opengeni-local-minio:9000:127.0.0.1:29000 --timeout-seconds 240 --json` passed API health, observability, live session run, event replay, SSE replay, manual scheduled-task dispatch, and file upload/download with session `be08079b-dde4-4db3-82b8-a51e5a76706a`, scheduled task `4ba0f319-cc52-4ba3-b15e-50522e32f751`, scheduled session `cce6db55-a172-40b0-8f4d-fd3e458eaa72`, and file `b8c55b3a-2832-4348-912c-69f93f5caa49`.
- Pushed ACR observability rollout tags for AKS: API digest `sha256:4a2f541b8644721694abca4f56911067250b984357c815a1d1ad0082d1aeb9ac`, worker digest `sha256:9267f6c12a4e23f7cb8690059fccf89c23fa36bcef854da5a5efaf4ca7d063ee`, and web digest `sha256:d797a70f08d0d3e072f1b5b6ba15677fef72db36d813365821a91e8833da744b`.
- Upgraded AKS release `opengeni-bootstrap` to Helm revision 18 with the chart-managed OpenTelemetry Collector enabled; the migration hook initially needed temporary old web/worker scale-down because the one-node reference cluster was at 96% requested memory, then completed and restored all desired pods.
- Verified AKS revision 18 running image IDs: API `sha256:4a2f541b8644721694abca4f56911067250b984357c815a1d1ad0082d1aeb9ac`, worker `sha256:9267f6c12a4e23f7cb8690059fccf89c23fa36bcef854da5a5efaf4ca7d063ee`, web `sha256:d797a70f08d0d3e072f1b5b6ba15677fef72db36d813365821a91e8833da744b`, and collector `otel/opentelemetry-collector-contrib:0.139.0`.
- Verified AKS expanded conformance after observability rollout: `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --timeout-seconds 240 --json` passed API health, observability, live session run, event replay, SSE replay, manual scheduled-task dispatch, and Azure Blob upload/download with session `f1d16b1b-d139-4bca-afe4-b0ef2991057e`, scheduled task `a6a244f2-6ece-47f4-a825-f0159cee7f14`, scheduled session `266cb1d6-1f47-4543-a823-f102e2352c59`, and file `0823be7c-641d-40bc-8a45-7106c491e1dc`.
- Verified deployed AKS observability export evidence: `/metrics` exposed request counters and duration buckets for conformance routes, and the collector debug exporter logged OTLP traces plus Prometheus metrics after the conformance run.
- Documented minimum production dashboards, PromQL examples, and alerts for API health/errors/latency, worker activity health, scheduled-task dispatch, object storage, SSE replay, collector health, and sandbox credential hygiene in `docs/deployment.md`.
- Installed temporary `ingress-nginx` chart `4.15.1` in AKS with low resource requests for ingress/TLS verification; Azure assigned public VIP `4.175.162.38`.
- Upgraded AKS release `opengeni-bootstrap` to Helm revision 19 with TLS ingress enabled for `opengeni.4.175.162.38.sslip.io` and reduced the worker memory request to fit the tiny one-node reference cluster alongside ingress-nginx.
- Verified ingress TLS and API routing through the ingress controller service: `curl --resolve opengeni.4.175.162.38.sslip.io:18443:127.0.0.1 --cacert /tmp/opengeni-aks-ingress.crt https://opengeni.4.175.162.38.sslip.io:18443/healthz` returned API health, `/v1/config/client` returned client config, and `/v1/sessions/f1d16b1b-d139-4bca-afe4-b0ef2991057e/events/stream?after=0` replayed SSE events over HTTPS.
- Public Azure LoadBalancer reachability initially timed out because the temporary ingress-nginx service generated HTTP/HTTPS health probes to `/`; after annotating the service to use TCP health probes, Azure updated the probes and direct traffic started routing to ingress-nginx.
- Verified public Azure ingress reachability: direct HTTP `http://4.175.162.38/healthz` returned `200`, direct HTTPS `https://opengeni.4.175.162.38.sslip.io/healthz` returned OpenGeni API health with the smoke CA, and `https://opengeni.4.175.162.38.sslip.io/v1/config/client` returned client config.
- Verified public Azure TLS conformance with `NODE_EXTRA_CA_CERTS=/tmp/opengeni-aks-ingress.crt bun run deployment:conformance -- --base-url https://opengeni.4.175.162.38.sslip.io --timeout-seconds 240 --skip-observability --json`: API health, live session run, event replay, SSE replay, manual scheduled-task dispatch, and Azure Blob upload/download passed with session `6ba5a497-12eb-4b79-be98-6ae808f3c5ad`, scheduled task `1281f751-34fa-4631-b3c0-b646f4af0869`, scheduled session `b577864a-5daf-45a8-b4fa-b674eb0ba914`, and file `8a76d117-35b1-417b-98f7-fd150b1b803a`; observability was intentionally checked on the internal API path rather than exposing `/metrics` publicly.
- Re-ran local/static gates after the AKS observability and ingress work: `git diff --check`, `helm lint deploy/helm/opengeni`, ingress/collector Helm template rendering, `terraform -chdir=deploy/terraform/azure fmt -check`, `terraform -chdir=deploy/terraform/azure validate`, `bun run typecheck`, `bun test`, `bun run check`, and `bun run test:integration` all passed.
- Added Helm `image.digest` support for API, worker, web, and migration images; production examples now show `tag@sha256` pinning.
- Upgraded AKS release `opengeni-bootstrap` to Helm revision 20 with digest-pinned API, worker, web, and migration images: API `opengeni-api:local-amd64-observability@sha256:4a2f541b8644721694abca4f56911067250b984357c815a1d1ad0082d1aeb9ac`, worker `opengeni-worker:local-amd64-observability@sha256:9267f6c12a4e23f7cb8690059fccf89c23fa36bcef854da5a5efaf4ca7d063ee`, and web `opengeni-web:local-amd64-observability@sha256:d797a70f08d0d3e072f1b5b6ba15677fef72db36d813365821a91e8833da744b`.
- Verified AKS expanded conformance after digest pinning: `bun run deployment:conformance -- --base-url http://127.0.0.1:18080 --timeout-seconds 240 --json` passed API health, observability, live session run, event replay, SSE replay, manual scheduled-task dispatch, and Azure Blob upload/download with session `0ce3a7f6-e0bd-4d63-a67b-1bd3901525ac`, scheduled task `e8e6f1f3-ca47-46b9-96bf-57038d610b88`, scheduled session `17762537-2f93-4369-a9ee-690c6606bc0d`, and file `137f8d39-6f65-4db5-a253-ebd16d6ce4b4`.
- Verified the `azure-existing-services` profile with live explicit endpoints by port-forwarding the existing AKS Postgres, Temporal, NATS, and API services while using Azure Blob HTTPS as the external object-storage endpoint. `bun run deployment:preflight -- --profile azure-existing-services --check-env --live --json` passed required environment checks plus Kubernetes namespace, Postgres TCP, Temporal TCP, NATS TCP, Azure Blob HTTP reachability, and API health probes without printing secret values.
- Verified local Docker sandbox readiness with private model credentials sourced in-memory: `bun run deployment:conformance -- --base-url http://127.0.0.1:8000 --sandbox-backend docker --timeout-seconds 300 --json` passed API health, observability, live session run, event replay, SSE replay, manual scheduled-task dispatch, and MinIO upload/download with session `8da30bbe-a2a6-480d-a448-67d04278925e`, scheduled task `085aba63-dd23-4b56-85bb-b003ef6e85ff`, scheduled session `dcb9e6ce-9f21-4b73-8f52-b5ac3d89d3cc`, and file `cbda4677-602d-4e73-bd7b-7cff0c539c17`.
- Verified Docker sandbox file mounts end-to-end: uploaded file `c0d0a1f7-9e55-41c4-a7cc-55d9273933c9`, attached it as a session file resource, required the agent to read `/workspace/files/c0d0a1f7-9e55-41c4-a7cc-55d9273933c9/sandbox-proof.txt` through the sandbox shell, and confirmed session `63d2fbaa-accf-4ccd-bc8f-79f45248237a` completed with exactly the file contents plus `agent.toolCall.*` events.
- Verified sandbox credential hygiene with `OPENGENI_SANDBOX_PREPARATION_PROFILES=none`: session `8fa1fea7-2b1e-4450-8e4b-22fab9fd00d7` used a sandbox tool call to check common model, Azure, ARM, and GitHub credential environment variable names and completed with `sandbox env safe`.
- Expanded CI deployment coverage to render digest-pinned Helm values and build API, worker, and web workload images for `linux/amd64`; live Azure conformance remains a documented manual/operator gate rather than a public PR workflow.
- Documented the production security boundary in `docs/deployment.md`: OpenGeni API needs an external auth/gateway layer before public exposure, production ingress requirements, safe secret-delivery patterns, and sandbox credential exposure rules.
- Attempted Modal-backed Azure Blob file-resource proof with local API/worker configured for Azure Blob and Modal. The first attempt failed with `ModalSandboxClient does not support manifest users yet`; runtime now sets `runAs` only for Docker. The second attempt failed with `ModalSandboxClient only supports ModalCloudBucketMountStrategy mount entries`; runtime now uses Modal cloud bucket mounts for S3-compatible storage and rejects Modal/Azure Blob with a clear compatibility error because the current SDK does not support that pairing.
- Updated Azure deployment contract and Helm example values so Azure Blob profiles default to `OPENGENI_SANDBOX_BACKEND=none` instead of claiming Modal compatibility for Azure Blob file mounts.
- Created temporary managed Azure PostgreSQL Flexible Server `opengeni-codex-8092-pg-ne` in `northeurope` after Azure reported Flexible Server provisioning restricted in `westeurope`; recorded it in `docs/azure-resource-ledger.md`.
- Verified managed Postgres support: set `azure.extensions=PGCRYPTO,VECTOR`, applied OpenGeni migrations, confirmed extensions `pgcrypto` and `vector`, confirmed `pg_type` includes `vector`, and confirmed 11 public tables on database `opengeni`.
- Patched the Azure Terraform reference to allow-list `PGCRYPTO,VECTOR` for managed Postgres instead of only `VECTOR`, matching the live migration requirement.
- Attempted Docker-backed Azure Blob file-resource proof. The first attempt exposed a standard Azure Blob rclone endpoint bug (`account.https://account.blob.core.windows.net`); runtime now omits `endpointUrl` for standard Azure Blob account endpoints while preserving custom endpoints.
- Verified Docker-backed Azure Blob file mounts end-to-end after the endpoint fix: uploaded file `e07ba892-c092-4b01-abcb-8bc2fb11abd2`, attached it as a session file resource, required the agent to read `/workspace/files/e07ba892-c092-4b01-abcb-8bc2fb11abd2/sandbox-proof.txt`, and confirmed session `bc4f59ac-38af-4006-9d6f-eec43966b877` completed with exactly the file contents plus `agent.toolCall.*` events.
- Rebuilt and repushed the AKS worker image with the Azure Blob sandbox-storage fixes, deployed Helm revision 21, and verified worker readiness at `opengenicodex8092acr.azurecr.io/opengeni-worker:local-amd64-sandbox-storage@sha256:292aceafa79f58afca015bc78f1670557d2d3091ff5b176a533497a97a31c468`.
- Repaired AKS image pull for the new worker image by creating tracked temporary ACR token `opengeni-codex-8092-pull` scoped to `_repositories_pull`, replacing Kubernetes secret `acr-pull-temp`, deleting the initially exposed `password1`, and retaining only a 7-day `password2` in the cluster secret.
- Replaced the Modal/Azure Blob incompatibility with runtime file materialization: the worker reads attached Azure Blob objects server-side and passes inline file entries to the Modal sandbox, avoiding unsupported Modal Azure Blob mounts and avoiding a dependency on `curl` inside the Modal image.
- Live-verified Modal plus Azure Blob file resources without the API/Temporal stack: uploaded Azure Blob object `files/e388b663-f4e9-4d37-b0e5-f5d400233496/original/sandbox-proof.txt`, materialized it into a Modal sandbox, and confirmed the agent returned the exact content `modal-azure-blob-file-proof-64def23b-0c00-4aa4-97e6-a5738b9c8872`.
- Rebuilt and repushed the AKS worker image with Modal/Azure Blob materialization support, deployed Helm revision 22, and verified worker readiness at `opengenicodex8092acr.azurecr.io/opengeni-worker:local-amd64-modal-azure-materialization@sha256:9ef2c21fcf679bde85aabf1f53e1db1c41256363e7e89fdfd019526734abfc16`.
- Re-verified public Azure TLS conformance after the revision 22 worker rollout: `NODE_EXTRA_CA_CERTS=/tmp/opengeni-aks-ingress.crt bun run deployment:conformance -- --base-url https://opengeni.4.175.162.38.sslip.io --timeout-seconds 240 --skip-observability --json` passed API health, live session run, event replay, SSE replay, manual scheduled-task dispatch, and Azure Blob upload/download with session `be952e87-6bd0-4494-ab7c-7247f5f8e940`, scheduled task `6af60d39-5a0f-4a9b-9115-196a8ec6fda9`, scheduled session `9158d46d-6b7a-4e93-9f7a-6ecab85abf06`, and file `f60b9b36-27c5-4b95-a8a3-24efe640988f`.
- Deleted temporary managed Postgres server `opengeni-codex-8092-pg-ne` after proof and removed `/tmp/opengeni-managed-pg.env`; active AKS/ACR/Key Vault/Azure Storage resources are intentionally retained for continued deployed verification and have cleanup commands in `docs/azure-resource-ledger.md`.
- Hardened the live Azure Blob storage account to match the Terraform reference: nested public blob access disabled, blob versioning enabled, and seven-day blob/container delete retention enabled.
- Patched Azure Terraform to model private Azure Blob access, AKS node-pool upgrade settings, and optional AKS Microsoft Defender workspace wiring. Existing Azure resources were imported into temporary uncommitted state under `/tmp`; `terraform plan` in bootstrap mode returned no changes, and complete mode with explicit external Postgres/Temporal hosts produced output-only changes and no Azure resource changes.
- Re-ran the preferred AKS kubelet `AcrPull` role assignment with the current Azure principal and an isolated local service-principal login; both failed with `AuthorizationFailed` for `Microsoft.Authorization/roleAssignments/write`, so the documented operator action remains required for the preferred long-lived image-pull path.
- Deleted stale AKS resources after Azure Blob became the active object store: `opengeni-runtime-live` secret and `data-opengeni-bootstrap-minio-0` PVC. Verified all retained AKS pods are running and only the Postgres PVC disk remains.
- Final verification after Terraform/storage cleanup: `bun install --frozen-lockfile`, `bun run check`, `bun run test:integration`, `git diff --check`, Helm lint/template rendering with digest-pinned API/worker/web/migration images, `terraform -chdir=deploy/terraform/azure fmt -check`, `terraform -chdir=deploy/terraform/azure validate`, imported-state Terraform plan, and targeted committed-secret pattern scan passed. The secret scan matched only placeholders and synthetic test values.

## Remaining Operator Actions

- For a long-lived Azure environment, have an Azure operator with `Microsoft.Authorization/roleAssignments/write` grant AKS kubelet `AcrPull` on the ACR and then remove `acr-pull-temp`.
- Replace smoke-only public TLS, ingress, and in-cluster Postgres/Temporal choices with the target production services for a real customer environment.
- Keep active Azure reference resources intentionally retained only while deployed verification continues; delete them with the ledger cleanup commands when the live environment is no longer needed.
