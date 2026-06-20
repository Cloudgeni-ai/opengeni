# Preview environment runbook

The preview-deploy **actuator** is `.github/workflows/preview.yml`. It builds + pushes
four GHCR images at `:sha-<sha>` (api / worker / web + the **desktop sandbox image**)
and `helm upgrade --install`s the `preview-managed` profile, then runs the live
deployment preflight. It is **dormant** until the infra below is provisioned — until
then the build runs but the deploy step no-ops cleanly with a "preview not provisioned"
message (no red failure), so the workflow is mergeable and inert.

This is the trusted-maintainer preview from `docs/design/sandbox-surfacing/09-gigapr-delivery.md`
§C/§E. It exists to run the **prove-it acceptance (D1–D7)** against **real Modal** with
the desktop surface flipped on — in preview only.

---

## How the desktop joins the pipeline (read this first)

The desktop is a **Modal sandbox image**, not a fourth Kubernetes deployment. The chart
ships api / worker / web / migrations only — there is intentionally **no desktop
Deployment**. OpenGeni pins each box to `sleep infinity` and launches the
Xvfb→XFCE→x11vnc→websockify→noVNC stack via `ensureDisplayStack` (exec, flock-idempotent).
The same image serves the headless and desktop tiers.

Modal selects the image purely by config: set **`OPENGENI_MODAL_IMAGE_REF`** in the
`opengeni-runtime` secret to the tag this workflow builds
(`ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:sha-<sha>`). It flows straight through
`ModalImageSelector.fromTag(settings.modalImageRef)` — zero code. Channel-B (the pixel
plane) needs `6080 ∈ exposedPorts`, which the desktop-capable backends already merge in.

The workflow flips the runtime flags **in preview only**, via `--set config.*`:
`OPENGENI_SANDBOX_OWNERSHIP_ENABLED=true`, `OPENGENI_SANDBOX_DESKTOP_ENABLED=true`,
`OPENGENI_COMPUTER_USE_ENABLED=true`, `OPENGENI_RECORDING_ENABLED=true`. These default
**off** in the merged code and in every other environment — merging turns nothing on
anywhere else.

---

## What the operator must provision (one-time)

Per `09-gigapr-delivery.md` §E, the build cannot self-provide these. Provision once,
then dispatch the workflow.

### 1. A reachable Kubernetes namespace + a `preview` GitHub Environment

- A small managed K8s namespace (reuse the staging cluster; add `opengeni-preview-branch`).
  The chart provisions in-cluster Postgres+pgvector / Temporal / NATS / MinIO @2Gi each,
  so the namespace needs only compute + a 2Gi PVC each — no managed data services.
  A kind/k3d cluster on a throwaway VM with public ingress is the cheap fallback.
- A GitHub **Environment** named `preview` (Settings → Environments). The deploy job
  declares `environment: preview`, which is what brings the `KUBECONFIG` secret into
  scope.

### 2. The `KUBECONFIG` Environment secret

- A **base64-encoded** kubeconfig for a **namespaced ServiceAccount** (not cluster-admin),
  scoped to the preview namespace.
- Add it as a secret named `KUBECONFIG` on the `preview` Environment.

  ```sh
  # from a kubeconfig that can read the namespace's ServiceAccount:
  base64 -w0 < ./preview-sa.kubeconfig | gh secret set KUBECONFIG --env preview
  ```

### 3. The `opengeni-runtime` secret (created by hand, in-cluster)

The preview profile uses `secret.create:false` + `existingSecret: opengeni-runtime`
(`secrets: externalSecrets`). For a single trusted preview, create it by hand — no
external-secrets operator needed (v1):

```sh
kubectl -n opengeni-preview-branch create secret generic opengeni-runtime \
  --from-literal=OPENGENI_MODAL_APP_NAME=<modal-app> \
  --from-literal=OPENGENI_MODAL_TOKEN_ID=<modal-token-id> \
  --from-literal=OPENGENI_MODAL_TOKEN_SECRET=<modal-token-secret> \
  --from-literal=OPENGENI_MODAL_TIMEOUT_SECONDS=3600 \
  --from-literal=OPENGENI_MODAL_IMAGE_REF=ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:sha-<sha> \
  --from-literal=OPENGENI_OPENAI_API_KEY=<openai-key> \
  --from-literal=OPENGENI_STRIPE_SECRET_KEY=<stripe-secret> \
  --from-literal=OPENGENI_STRIPE_PUBLISHABLE_KEY=<stripe-pub> \
  --from-literal=OPENGENI_STRIPE_WEBHOOK_SECRET=<stripe-webhook> \
  --from-literal=OPENGENI_STRIPE_CREDITS_PRODUCT_ID=<stripe-product> \
  --from-literal=OPENGENI_MODEL_PRICING_JSON='{}' \
  --from-literal=OPENGENI_STREAM_TOKEN_SECRET=<random-hmac-1> \
  --from-literal=OPENGENI_DELEGATION_SECRET=<random-hmac-2>
```

The required secret keys, by source:

| Key(s) | Why | Notes |
|---|---|---|
| `OPENGENI_MODAL_APP_NAME`, `OPENGENI_MODAL_TOKEN_ID`, `OPENGENI_MODAL_TOKEN_SECRET`, `OPENGENI_MODAL_TIMEOUT_SECONDS` | Modal sandbox backend (`OPENGENI_SANDBOX_BACKEND: modal`) | Modal is the npm SDK — no Modal CLI. Creds in `~/.modal.toml [opengeni]`. |
| **`OPENGENI_MODAL_IMAGE_REF`** | **Selects the desktop image** | Set to `ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:sha-<sha>` — the tag the workflow just built. Update it on each redeploy if the desktop image changed. |
| `OPENGENI_OPENAI_API_KEY` | Model provider for real turns | Needed for D4 (agent drives the desktop) — a scripted model defeats the proof. |
| `OPENGENI_STRIPE_SECRET_KEY`, `OPENGENI_STRIPE_PUBLISHABLE_KEY`, `OPENGENI_STRIPE_WEBHOOK_SECRET`, `OPENGENI_STRIPE_CREDITS_PRODUCT_ID`, `OPENGENI_MODEL_PRICING_JSON` | Profile sets `billingMode: stripe` | Use Stripe test-mode keys. `OPENGENI_MODEL_PRICING_JSON` can be `{}` for preview. |
| `OPENGENI_STREAM_TOKEN_SECRET`, `OPENGENI_DELEGATION_SECRET` | The two desktop HMAC secrets (required-when-desktop) | Generate two random secrets (`openssl rand -hex 32`). Without `OPENGENI_STREAM_TOKEN_SECRET` (or the delegation secret) the pixel plane gracefully degrades. |

Data-plane URLs (Postgres / Temporal / NATS / MinIO) are **in-cluster** and wired by
the chart — you do **not** put them in this secret for the preview profile (`inCluster`
modes). The chart also generates Better Auth / managed-mode env via its config; if the
managed product paths complain about a missing `OPENGENI_BETTER_AUTH_SECRET` /
`OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` etc. for your run, add them to the same secret
(`openssl rand -hex 32` each). The prove-it run (D7 billing) reads internal `usage_events`,
so Stripe needs only to be configured, not exercised.

### 4. Ingress host + TLS + DNS

- A real subdomain you control (e.g. `preview.opengeni.dev`) with cert-manager + an
  ingress controller in the cluster. Pass it as the workflow's **`host`** input.
- The workflow `--set`s `ingress.hosts[0].host`, `ingress.tls[0].hosts[0]`,
  `ingress.tls[0].secretName=opengeni-preview-tls`, `config.OPENGENI_PUBLIC_BASE_URL`,
  and `minio.publicEndpoint` from `host`. MinIO needs its `/<bucket>` route + public
  HTTPS endpoint for the direct-to-blob upload topology + CORS; the preview values set
  `minio.corsAllowOrigin: "*"`. The profile's `sseTimeoutSeconds: 3600` must be honored
  by the ingress (long-lived SSE) — set the controller's read-timeout annotation
  accordingly on the namespace's ingress class.

---

## Running it

1. Provision (1)–(4) above.
2. GitHub → Actions → **Preview Deploy** → Run workflow:
   - `namespace`: `opengeni-preview-branch` (default)
   - `host`: your preview hostname (e.g. `preview.opengeni.dev`)
   - `ref`: `claude/naughty-engelbart-2d3b09` (default)
3. The workflow builds + pushes the four `:sha-<sha>` images, `helm upgrade --install`s
   the preview-managed profile (migrations run as the chart's pre-upgrade Job —
   expand-then-use), and runs `bun scripts/deployment-preflight.ts --profile
   preview-branch --live`. All-green is the precondition for the prove-it run.
4. After the first deploy, set `OPENGENI_MODAL_IMAGE_REF` in the `opengeni-runtime`
   secret to the **`:sha-<sha>`** tag this run produced (the desktop image), then restart
   the worker/api pods so they pick it up:
   `kubectl -n opengeni-preview-branch rollout restart deploy/opengeni-preview-worker deploy/opengeni-preview-api`.
5. Drive the prove-it acceptance (D1–D7 in `09-gigapr-delivery.md` §D) against the
   deployed host; capture artifacts into `docs/design/sandbox-surfacing/evidence/`.

If `host` is blank or the `KUBECONFIG` secret is absent, the workflow still builds +
pushes the images and the deploy step no-ops with a clear "preview not provisioned"
message (not a failure).
