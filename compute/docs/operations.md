# Running hosts

What an operator must set up, check and know that the code cannot enforce
alone. Each point says what the agent does, what is left to the deployment,
and what we chose not to build.

## Storage

- **Mount the state volume before the agent starts.** The agent creates its
  state root if the parent directory exists, so an unmounted volume looks
  like an empty host and the agent would start keeping new records on the
  wrong filesystem. Configure the volume's mount, start the agent from a
  systemd unit with `RequiresMountsFor=<state root>` so it starts after
  that mount, and check that the intended volume is there:
  `AssertPathIsMountPoint=` on the volume's mount point, and an
  `ExecStartPre=` that compares the mounted filesystem's UUID with the one
  recorded when the volume was set up. Ordering alone does not prove which
  volume occupies the path.
- **Archives must go off the host.** `--store` takes a directory or object
  storage. A directory is for tests and single machines: the agent warns at
  start, and an archive there is lost with the host. Production hosts use
  `gs://`, `az://` or `s3://`.
- **Disk headroom for saves is the deployment's job.** The agent does not
  yet book disk for the saves it admits (the admission in
  [ADR 14](adr/0014-requests-limits-and-admission.md) is being built), and
  guest disk growth and pages written during a wake from object storage
  will not be booked even then. A full disk does not lose memory: a save
  that cannot write fails and is tried again later, and a wake from object
  storage whose local writes fail waits, shown as stalled, and continues
  once there is room. Size state volumes for the sandboxes placed on them
  and alert on free space early, for example below 20 %.
- **Encryption is the volume's and the store's.** Chunks are stored raw or
  compressed, not encrypted by us, and a host's state volume holds disks and
  memory images. Check that every state volume and the bucket are encrypted
  at rest by their provider. GCP encrypts local SSDs; on Azure, managed-disk
  encryption does not cover temporary disks, so turn on encryption at host
  there. We do not add our own per-tenant encryption.

## Deleting

- **Deleting a sandbox: its pointer goes last, its bytes later.** Removal
  records the intent, stops the VM, removes its network and then deletes
  the pointer in object storage; a step that fails is tried again, and the
  sandbox shows as removing (or blocked) until all are done. A daily sweep
  (`compute-host sweep --store ... --delete`) then deletes the chunks and
  manifests no pointer names that were stored more than about a week
  before it began ([ADR 17](adr/0017-sweeping-unnamed-chunks.md)). Age
  counts from when an object was last stored, so a copy archived long ago
  goes at the first sweep after nothing names it. A chunk another sandbox
  still names stays: identical content is shared.
- **Forgotten memory images** (30 days after last use by default) lose
  their pointer entry together with their working-set pack, and their
  chunks go at a following sweep under the same rule.
- **Only GCS sweeps delete.** A sweep that deletes needs deletes on
  condition, which we use on GCS; on Azure and S3 it refuses and only
  reports, so unnamed chunks stay there until conditional deletes are
  built for those stores. Deleting a pointer there leaves an empty one,
  which reads as no copy.
- **Provider retention comes on top.** GCS soft delete keeps deleted
  objects 7 days by default; set the bucket's policy to what we promise.
- **Quarantined objects** (stored copies that failed their checksum, kept
  for inspection under `quarantine/v1/`) are not swept. Give that prefix a
  lifecycle rule, for example deletion after 30 days.
- **Watch the sweep.** It stops before deleting anything when a pointer or
  manifest cannot be read, by design: deleting around an unreadable entry
  could take chunks it names. Alert when no sweep has succeeded for two
  days; its error names the key that stopped it.

## Upgrades

- **The agent** can be replaced at any time; running VMs keep running
  ([ADR 9](adr/0009-vms-outlive-the-agent.md)).
- **Firecracker**: a wake uses whichever configured Firecracker (the
  current one or one kept with `--retained-firecracker`) reads the image's
  snapshot format on the image's CPU, so a newer compatible release
  restores older images and runs them from then on. Keep the previous
  binary only when a release changes the snapshot format, until no saved
  image needs it. Status shows the runtime the agent launches new VMs
  under, not the runtime of every saved image; each image records its own.
- **The host kernel**: Firecracker does not promise that a memory image
  restores under another host kernel. Before rolling a new host image out,
  save sandboxes on the old one and wake them on the new one (with the
  `save_wake` and `lab` tests and a store both hosts share), and keep the
  old image to roll back to.
- **The guest kernel** a VM booted with stays through every save and wake;
  only a fresh boot picks up a new one. A sandbox's own disk then boots
  with the newest kernel, so a new guest kernel must be tested against the
  root filesystems still in use. We never replace a user's disk to upgrade
  it.
- **Security patches.** A sandbox runs a patched Firecracker only once its
  VMM process is replaced: when it wakes from a saved image (Saved,
  Archived or Remote). One that resumes from Paused or Compressed resumes
  the same process, and one that stays busy keeps it. A restore prefers
  the binary that made the image while it is kept with
  `--retained-firecracker`, so drop a vulnerable binary from that list
  first; the current binary then restores every image whose snapshot
  format it reads. To move a sandbox off a vulnerable VMM now, sleep it to
  `saved` (the `Sleep` request) and wake it. A guest kernel fix needs a
  fresh boot, which means stopping affected sandboxes (they boot fresh
  from their disks). There is no live patching.

## Emergencies

- **Stopping a sandbox when the state disk is read-only.** Removal writes
  its intent first and refuses when it cannot. To contain a sandbox anyway,
  kill its VM directly: `echo 1 > /sys/fs/cgroup/compute/<sandbox id>/cgroup.kill`
  (the path under `--cgroup`). Its files stay and the agent treats
  the VM's end like a crash. Remove the sandbox through the API once the
  disk is writable again.

## Network

- Sandboxes cannot reach the host, other sandboxes, private ranges or the
  metadata address ([ADR 11](adr/0011-fixed-guest-network.md)). Where the
  cloud maps a public address onto the host, the host can also be reached
  through that address: pass it with `--block`, and check from a guest that
  it is refused.

## Capacity and cost

- **Nested hosts need their huge-page pool reserved** (`vm.nr_hugepages`,
  or `hugepages=` on the kernel command line so it is reserved before
  memory fragments). Pages in the pool serve only guests, so size it to the
  guest memory meant to be resident at once, ready pool included, and leave
  the rest to the host: page cache, pagers and the agent. The agent refuses
  to start the nested profile without a pool. On cgroup v2 without the
  `memory_hugetlb_accounting` mount option, a VM's huge pages do not show in
  its `memory.current`.
- **Sleeping sandboxes are not free on the host.** Each record keeps a
  network namespace and its guest-port listeners even when its memory and
  disk live only in object storage. The final measurements report agent
  memory and open files per archived sandbox; placement must count records,
  not only running VMs.
- **Busy is busy.** A sandbox that keeps computing stays awake, whether it
  builds code or mines coins. Sleep policy does not decide who pays: usage
  for billing and account budgets belongs to the layer above.
- **Sharing between customers.** Identical chunks are shared within a store
  prefix. Give each sharing domain (one customer, or one trust zone) its own
  prefix, chosen by the control plane; a host whose sandboxes span domains
  needs one store per domain, which is not built yet.
