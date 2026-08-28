# SINTEF local internal-application reference

This overlay demonstrates the preview without moving SINTEF source data or
inference outside the local environment. It assumes OpenGeni, the application
namespace, an internal registry, ingress, the source database, and a local model
route are reachable inside the approved network.

## 1. Install the target namespace and RBAC

```bash
kubectl apply -f namespace-rbac.yaml
```

The `opengeni-internal-app-deployer` service account is the control-plane
identity. Create a short-lived token for it and save that token in a workspace
Connection; put only the Connection UUID into `target.template.json`.

```bash
kubectl -n opengeni-internal-apps create token opengeni-internal-app-deployer
```

The deployed application uses the separate, unprivileged
`opengeni-internal-apps` service account.

## 2. Create least-privilege runtime and data Secrets

Create one OpenGeni workspace API key for the demonstration app with only
`sessions:create`, `sessions:read`, and `sessions:control`. The target derives
the Secret name from its prefix plus the application slug. For a
`materials-demo` app, create it without writing the value to a file:

```bash
kubectl -n opengeni-internal-apps create secret generic sintef-app-opengeni-runtime-materials-demo \
  --from-literal=apiKey="$SINTEF_APP_OPENGENI_API_KEY"
```

For the `measurements` data binding, the target template's prefix produces the
Secret reference `sintef-app-data-measurements`. Its key names are owned by the
application image; this example uses one database URL:

```bash
kubectl -n opengeni-internal-apps create secret generic sintef-app-data-measurements \
  --from-literal=MEASUREMENTS_DATABASE_URL="$SINTEF_MEASUREMENTS_DATABASE_URL"
```

OpenGeni stores neither value. Rotate either Secret independently and restart
the application Deployment when the process does not reload its environment.

## 3. Enable the preview

Merge `values.yaml` into the OpenGeni Helm release and upgrade it. The flag is
false in the main chart and in `.env.example`; this overlay is the explicit
opt-in.

```bash
helm upgrade --install opengeni deploy/helm/opengeni \
  --namespace opengeni --create-namespace \
  -f values.yaml
```

Apply database migrations through the release's normal migration job before
using the routes.

## 4. Register resources in the Applications UI

Use `data-source.template.json` and `target.template.json` as the field-by-field
reference. The console generates resource and operation UUIDs. In particular:

- site is exactly `SINTEF Oslo` on both records, so the locality plan proves no
  site transfer;
- external egress is false on the measurements source;
- the target advertises the local model route;
- explicit egress is limited to the sample private CIDRs; adjust them to the
  actual OpenGeni, database, registry, ingress, and DNS topology; and
- the Kubernetes API credential stays in the workspace Connection.

Create an app with an `attach`/`read` binding named `measurements`, select the
local target, and choose **Build in OpenGeni**. In the durable session, verify
the generated files, test results, health endpoint, and
`opengeni.bundle-build.json`. Publish the reviewed workspace through the local
trusted OCI pipeline, then register its digest-pinned image, SBOM, and
provenance. Preview the deployment plan; every check must pass before apply.
The reference publisher configuration is `bundle-publish.template.json`; run
it with `bun run internal-applications:publish -- <config.json>` from the
OpenGeni checkout after Docker has authenticated to the internal registry and
Syft is installed. Keep the publisher API key in `OPENGENI_API_KEY`, never in
the JSON file.

## 5. Acceptance checks

The reusable provider conformance script refuses every context except an
explicit `kind-opengeni-internal-apps-*` context. A safe local rehearsal is:

```bash
kind create cluster --name opengeni-internal-apps-conformance --wait 120s
kubectl --context kind-opengeni-internal-apps-conformance apply -f namespace-rbac.yaml
kind load docker-image traefik:v3.6 --name opengeni-internal-apps-conformance
OPENGENI_INTERNAL_APPLICATIONS_KUBE_CONTEXT=kind-opengeni-internal-apps-conformance \
  bun run acceptance:internal-applications-kubernetes
kind delete cluster --name opengeni-internal-apps-conformance
```

It exercises the real HTTPS API using the private cluster CA and a short-lived
deployer token; applies a digest-pinned workload, Service, and NetworkPolicy;
waits for the current rollout generation; restarts it; applies a second bundle
identity; rolls back and re-verifies health; proves drift detection; retires all
managed resources; and verifies idempotent cleanup in `finally`. No production
or ambient current context is accepted.

```bash
kubectl -n opengeni-internal-apps get deploy,svc,ingress,networkpolicy
kubectl -n opengeni-internal-apps rollout status deploy/<application-slug>
```

Then verify:

1. the internal URL is reachable only through the intended internal ingress;
2. the pod can reach the measurements database and local OpenGeni API;
3. undeclared egress is denied;
4. a native AI request creates a durable session with the application metadata;
5. changing a source or target revision makes an old plan conflict; and
6. deploying a second bundle and selecting rollback restores the first digest;
7. observing after an out-of-band image annotation change reports drift; and
8. retirement removes the managed resources, clears the internal URL, and
   preserves the operation/event timeline.

For packet-path evidence in an actual SINTEF cluster, capture flow logs from the
enforcing CNI (for example Cilium/Hubble or the organization's equivalent)
during one application query and archive: source/destination workload
identities, approved database/model endpoints, denied undeclared egress, plan
digest, deployment operation ID, and timestamp. Kind's default CNI does not
enforce NetworkPolicy and is therefore only a control-plane/rollout
conformance environment, not packet-locality evidence.

Disable `OPENGENI_ADVANCED_DEPLOYMENTS_ENABLED` to hide and freeze the control
surface. This does not delete running workloads; use the deployment's **Retire**
action before disabling the flag when teardown is intended.
