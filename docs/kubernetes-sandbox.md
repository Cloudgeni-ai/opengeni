# Kubernetes sandbox backend

OpenGeni can provision user-code sandboxes as Kubernetes Pods without an
external sandbox provider. Set `OPENGENI_SANDBOX_BACKEND=kubernetes`; the turn
worker creates one Pod per durable sandbox lease, addresses it by immutable Pod
UID, executes commands through `pods/exec`, and uses the ordinary OpenGeni tar
archive ledger to restore `/workspace` after a Pod is reaped.

This is different from merely deploying the OpenGeni control plane to
Kubernetes. The control plane may run on Kubernetes while using Modal, Docker,
or another backend. The setting above chooses where agent code executes.

## Configuration

The Kubernetes backend is not an HTTP URL/API-key integration. It uses
`kubectl` authentication:

- In-cluster workers use their Kubernetes service-account token. The Helm chart
  can create the narrow Role/RoleBinding automatically.
- A worker outside the cluster can set an absolute
  `OPENGENI_KUBERNETES_KUBECONFIG` plus an optional context and namespace.

Minimum out-of-cluster configuration:

```bash
OPENGENI_SANDBOX_BACKEND=kubernetes
OPENGENI_KUBERNETES_IMAGE=ghcr.io/your-org/opengeni-sandbox@sha256:...
OPENGENI_KUBERNETES_KUBECONFIG=/absolute/path/to/kubeconfig
OPENGENI_KUBERNETES_CONTEXT=your-context
OPENGENI_KUBERNETES_NAMESPACE=opengeni
```

Build the sandbox image from `docker/sandbox.Dockerfile`, push it to the
company's registry, and pin the resulting digest. It is a separate image from
the API and worker images.

Resource and lifecycle controls are explicit:

```bash
OPENGENI_KUBERNETES_CPU_REQUEST=250m
OPENGENI_KUBERNETES_CPU_LIMIT=2
OPENGENI_KUBERNETES_MEMORY_REQUEST=512Mi
OPENGENI_KUBERNETES_MEMORY_LIMIT=4Gi
OPENGENI_KUBERNETES_EPHEMERAL_STORAGE_REQUEST=1Gi
OPENGENI_KUBERNETES_EPHEMERAL_STORAGE_LIMIT=20Gi
OPENGENI_KUBERNETES_WORKSPACE_SIZE_LIMIT=10Gi
OPENGENI_KUBERNETES_STARTUP_TIMEOUT_SECONDS=120
OPENGENI_KUBERNETES_IMAGE_PULL_POLICY=IfNotPresent
```

The request must not exceed its limit. New Pods receive both values, so the
deployment does not silently depend on namespace defaults. Pin production
images by digest.

Optional controls:

- `OPENGENI_KUBERNETES_KUBECTL_PATH`: command name or absolute path; defaults to
  `kubectl`.
- `OPENGENI_KUBERNETES_SERVICE_ACCOUNT`: service account assigned to sandbox
  Pods, normally the chart's tokenless account with any required image-pull
  secrets.
- `OPENGENI_KUBERNETES_AUTOMOUNT_SERVICE_ACCOUNT_TOKEN`: defaults to `false`.
  Enable only when code inside the sandbox deliberately needs the Kubernetes
  API. Selecting a service account does not automatically mount its API token.
- `OPENGENI_KUBERNETES_RUNTIME_CLASS`: selects a cloud-supported isolated
  runtime such as AKS `kata-vm-isolation` or GKE `gvisor`.
- `OPENGENI_KUBERNETES_NODE_SELECTOR_JSON` and
  `OPENGENI_KUBERNETES_TOLERATIONS_JSON`: portable JSON scheduling controls for
  a dedicated/tainted sandbox node pool.
- `OPENGENI_KUBERNETES_PRIORITY_CLASS`: optional Pod priority class.

`OPENGENI_KUBERNETES_ISOLATION_MODE` records the intended security boundary:

- `standard` (default) runs a normal Pod. It is suitable for trusted local
  lifecycle testing, but is not a hostile multi-tenant boundary.
- `runtime-class` requires `OPENGENI_KUBERNETES_RUNTIME_CLASS`; use this for AKS
  Kata and GKE gVisor.
- `provider-managed` declares that an external scheduling policy supplies the
  isolation boundary, such as an EKS Fargate profile selecting the sandbox
  namespace.

OpenGeni rejects `standard` Kubernetes isolation when
`OPENGENI_PRODUCT_ACCESS_MODE=managed`, and also rejects mounting a Kubernetes
API service-account token into managed sandbox Pods. This is a fail-closed
configuration guard, not proof that the cluster has the named runtime or
provider policy installed; deployment conformance must verify that separately.

## Helm

Use the chart's integrated setup when OpenGeni and its sandboxes share a
cluster:

```yaml
config:
  OPENGENI_SANDBOX_BACKEND: kubernetes
  OPENGENI_KUBERNETES_IMAGE: ghcr.io/your-org/opengeni-sandbox@sha256:...

kubernetesSandbox:
  enabled: true
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      cpu: "2"
      memory: 4Gi
```

With `rbac.create=true` (the default), the chart grants the OpenGeni service
account only Pod create/get/list/watch/delete and Pod exec in the sandbox
namespace. The API, control worker, and turn worker mount that controller token:
turns create and use Pods, the API services interactive sandbox operations, and
control-worker lease maintenance captures and deletes Pods. Other chart
workloads do not mount it. Sandbox Pods use `automountServiceAccountToken:
false` by default.

The chart defaults to a dedicated `<release>-sandboxes` namespace and creates a
tokenless workload service account, baseline Pod Security labels, a namespace
quota, and a sandbox NetworkPolicy. It also emits explicit ephemeral-storage
requests/limits and a size-limited `/workspace` `emptyDir`. Set
`namespaceCreate=false` when the namespace is managed outside Helm. The Helm
installer needs permission to create the namespace and its Role/RoleBinding.

The NetworkPolicy denies ingress, allows DNS and the OpenGeni release, and can
allow public IPv4 while excluding private, link-local/metadata, loopback, and
reserved ranges. It has no effect unless the cluster CNI enforces Kubernetes
NetworkPolicy. Add required private endpoints through
`kubernetesSandbox.networkPolicy.extraEgress`; do not disable the policy merely
to make an endpoint reachable.

## Cloud isolation profiles

The Pod adapter is the same on AKS, GKE, and EKS; only image registry,
scheduling, and the isolation boundary vary. Start from the checked-in values:

```bash
# AKS Pod Sandboxing / Kata
helm upgrade --install opengeni deploy/helm/opengeni \
  -f deploy/helm/opengeni/values.kubernetes-sandbox.aks.example.yaml

# GKE Sandbox / gVisor
helm upgrade --install opengeni deploy/helm/opengeni \
  -f deploy/helm/opengeni/values.kubernetes-sandbox.gke.example.yaml

# EKS Fargate (create the namespace-selecting Fargate profile first)
helm upgrade --install opengeni deploy/helm/opengeni \
  -f deploy/helm/opengeni/values.kubernetes-sandbox.eks.example.yaml
```

AKS Kata gives each selected Pod a lightweight VM boundary; see [AKS Pod
Sandboxing](https://learn.microsoft.com/azure/aks/concepts-pod-sandboxing).
GKE requests gVisor with `runtimeClassName: gvisor`; see [GKE
Sandbox](https://cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods).
EKS schedules Pods onto Fargate through namespace/label selectors; see [EKS
Fargate profiles](https://docs.aws.amazon.com/eks/latest/userguide/fargate-profile.html).
The EKS example also sets equal CPU/memory requests and limits because Fargate
uses guaranteed QoS sizing.

AWS's VPC CNI does not enforce Kubernetes NetworkPolicy on Fargate, and its
native policy agent does not consistently cover standalone Pods. For the EKS
profile, therefore create a `SecurityGroupPolicy` selecting
`opengeni.ai/managed: "true"` in the sandbox namespace, attach a dedicated
least-privilege security group, and enforce private-subnet route/NACL/egress
proxy policy. Treat the rendered Kubernetes NetworkPolicy as defense in depth,
not the AWS enforcement boundary. See [EKS network-policy
limitations](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy.html)
and [security groups for
Pods](https://docs.aws.amazon.com/eks/latest/userguide/security-groups-for-pods.html).
Start from
`deploy/kubernetes/eks-sandbox-security-group-policy.example.yaml`, replacing
the namespace and security-group ID before applying it.

For managed hostile multi-tenancy, also use a dedicated sandbox capacity/trust
zone, enforced egress policy, digest-pinned images, admission/image policy,
quotas, provider workload identity with least privilege, centralized audit
logs, and an automated check that every live sandbox actually landed on the
required isolated runtime. A namespace, RBAC, and an ordinary `runc` Pod alone
are insufficient.

## Files, persistence, and limitations

- Repository and inline manifest entries are materialized through the same
  Agents SDK manifest path used by other remote providers.
- Attached files use short-lived signed downloads. Kubernetes Pods do not need
  privileged FUSE mounts or static object-storage keys.
- Warm turns attach to the exact Pod UID. A name reused for a different UID is
  rejected.
- Before normal deletion, the canonical reaper captures and verifies a tar of
  `/workspace`; cold recovery creates a fresh Pod and hydrates that archive.
- The initial backend is headless. It truthfully reports no desktop stream,
  interactive PTY, or exposed-port tunnel. Shell/files/git remain available.
- The Pod disables host network/PID/IPC sharing, service links, privilege
  escalation, and the default capability set; it adds only the file/user
  ownership capabilities required by workspace materialization, uses the
  runtime-default seccomp profile, and mounts a size-limited `emptyDir` at
  `/workspace`.

Kubernetes namespaces and ordinary Pods are not a complete hostile-code
security boundary by themselves. The managed-mode isolation guard therefore
requires an explicit isolated-runtime or provider-managed selection.

## Measure startup and round trips

With a reachable cluster and image:

```bash
bun run sandbox:benchmark:kubernetes
```

The benchmark creates one real Pod, materializes a file, runs a command, reads
cgroup counters, captures `/workspace`, exact-resumes by UID, reports timings
as JSON, and deletes the Pod. Run several samples with both a cold and cached
image. `createToReady` includes scheduling, image pull, container start, and
manifest materialization; it is the useful comparison against Modal's create
latency. Static tests and Helm rendering do not establish real-cluster latency.
