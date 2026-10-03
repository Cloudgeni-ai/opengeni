# Additive AKS launch capacity

This narrow root manages a general-purpose Linux `launch` User pool on each
existing OpenGeni AKS cluster. It never creates, imports, or replaces a cluster.
Production's `system` pool remains owned by `deploy/terraform/azure` and its
existing production state. Staging has no full-cluster state: this root imports
only the existing staging `system` pool and tightens its autoscaler bounds.
Never manage the production system pool from this root or put the same launch
pool in the full Azure root.

Cluster ARM IDs are derived from the validated subscription UUID and fixed
environment-specific resource-group/cluster names. The existing system-pool
data source verifies the exact pool and parent-cluster identity. Do not add the
full `azurerm_kubernetes_cluster` data source: AzureRM 4.72.0 reads user and,
when local accounts are enabled, admin kubeconfigs into its data-source state.
This root needs no cluster-credential-list permissions. Live North Europe
region admission remains a protected-workflow metadata check, not a claim
inferred from the `neu` names. The `capacity_contract.cluster_id` output keeps
the same ARM-ID contract.

| Environment | Existing system bounds | Additive launch bounds | Warm total | Simultaneous maximum |
| --- | --- | --- | --- | --- |
| Staging | 4–5 D4ds_v4 nodes | 3–6 D4ds_v5 nodes | 7 | 11 |
| Production | 4–6 D4ds_v4 nodes | 3–6 D4ds_v5 nodes | 7 | 12 |

`Standard_D4as_v5` is the explicitly supported alternative, not an automatic
fallback. Both choices have four vCPUs and 16 GiB physical memory. Changing a
pool SKU after creation would require a new reviewed plan; replacement is
blocked. No existing system SKU, disk, pod density, or scheduling policy changes
are part of this root. The new pool has Managed 128 GiB OS disks, 30 pods per
node, no availability-zone pin, and no exclusive taint. Its label is descriptive,
not a requirement placed on existing application, platform, or canary pods.

## Quota and placement are separate gates

With DDSv4 non-cluster usage of eight cores, the proposed joint base maximum is
44 pool cores + 8 external cores + 12 reserve cores = 64. The additive maximum
uses 48 DDSv5 cores + 12 reserve cores = 60. Each family's reserve covers the two
independently rounded 10% pool-upgrade surges and one emergency node. With 32
regional cores outside these clusters, the joint regional envelope is
32 + 44 + 48 + 24 = 148 cores. These are planning examples, not static claims of
available quota: the private workflow must re-read every pool, family usage,
regional usage, SKU restrictions, and non-cluster consumption before admission.
Unknown pools or families must fail closed. Regional headroom never overrides a
family limit or a subscription SKU restriction.

Seven Ready nodes per cluster are a warm floor, not proof of 100-user latency.
The placement contract charges turn workers at 500m CPU / 4 GiB memory requests
and 2 CPU / 6 GiB limits, all application and platform maxima, rollout overlap,
DaemonSets, diagnostic and preview pods, the shared `geni` canary, and node-loss
reserves. A one-core CPU-request sensitivity calculation does not authorize a
CPU request change. New-pool allocatable resources and DaemonSets must be
measured after creation before adopting any computed pod ceiling. Cold
autoscaler capacity is not immediate serving capacity.

## Protected rollout boundary

Use the private operations capacity workflow with an exact reviewed public SHA,
separate per-environment capacity state, and a saved guarded plan. Production
system-bound tightening uses the existing production Terraform workflow first.
An isolated staging bounds phase may target only
`azurerm_kubernetes_cluster_node_pool.system`; this admits monotonic tightening
without pretending the not-yet-created launch pool is deployed. Report a scoped
no-op as scoped, not a full-root no-op. Later pool creation must prove both real
system ceilings and the joint quota/SKU envelope. Globally reject all destruction
and replacement, including operations outside the intended pool addresses.

Terraform configuration never pins autoscaled `node_count`; the lifecycle also
ignores its drift. AzureRM 4.72.0 creates an autoscaled User pool at `min_count`
when count is omitted, so a new launch pool starts at three. Its node-pool update
path GETs the existing pool and retains that response's count in the PUT even
when Terraform has no count diff; it does **not** promise HTTP-level count
omission. A concurrent autoscaler change between that GET and PUT is therefore
a provider race, not eliminated by `ignore_changes`. A real guarded saved plan,
refreshed count admission, and post-apply readback/no-op remain mandatory; mocks
prove neither an imported no-op nor real count preservation.

The staging import rejects wrong cluster/pool IDs, pool name, mode, OS
type, priority, SKU, disk, pod density, or disabled autoscaling. It admits only
monotonic bounds tightening and a live count within four to five, rather than
forcing either a scale-up or scale-down. Every other optional imported field,
including networking, security, labels, taints, OS SKU, versions, and upgrade
settings, is preserved. Pool deletion or decommission is not authorized by this
root. Review the pinned provider's
[create/update implementation](https://github.com/hashicorp/terraform-provider-azurerm/blob/v4.72.0/internal/services/containers/kubernetes_cluster_node_pool_resource.go)
before changing these safeguards.

The new pool's upgrade policy allows one rounded surge node, a 30-minute drain,
and five-minute soak. It does not override PDBs, checkpoints, graceful worker
draining, or retiring database connections. The workflow must inspect pending
pods, disruption budgets, live bounds and Ready nodes, then run an explicit
post-apply no-op check. Never upload Terraform state, credentials, or raw provider
outputs containing cluster access material as evidence.

## Deterministic local checks

```sh
terraform init -backend=false -input=false
terraform fmt -check
terraform validate
terraform test
```

These checks do not create resources or generate launch traffic. They do not
substitute for protected plans, post-apply readback, or the separate reliability
and monitoring gates required before any burst/load test.