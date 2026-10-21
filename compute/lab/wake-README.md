# Wake-path experiments

These scripts extend the existing disposable-host lab without changing its
driver. They use public software and synthetic guest data only.

## Matrix

| Script | Experiment |
| --- | --- |
| `wake-pager.ts COUNT ROUNDS MODES` | File, UFFD lazy, learned prefetch, fully eager, and 2 MiB huge-page restore |
| `wake-engine.ts ENGINE COUNT ROUNDS` | Firecracker versus Cloud Hypervisor, same guest image/kernel and hardware |
| `wake-l2.ts COUNT ROUNDS VARIANTS` | zswap compressor, swap readahead, and MGLRU |
| `wake-save.ts COUNT ROUNDS MODES` | Durable Full, resident Diff, dirty-tracked Diff and huge-resident Diff saves, layer merge and live-process validation |
| `wake-ch-save.ts COUNT ROUNDS` | Cloud Hypervisor shared-file memory, explicit flush/reflink checkpoints and process-state validation |
| `wake-pool.ts PAGES ROUNDS` | Huge-page pool reservation time, separately from wake latency |
| `wake-host-info.sh` | Host configuration and binary/image fingerprints |
| `wake-fc-prefault.patch` | Lab-only Firecracker v1.17.0 KVM stage-2 prefault hook |

Set `LAB_HOST_LABEL` to a generic hardware description. Results append to
`$LAB_DIR/results/$WAKE_RESULT.jsonl`. Run only one timed experiment per host.
Keep compilation, installation, artifact copying and other benchmarks outside
the timing windows.

```sh
sudo env LAB_HOST_LABEL=metal-192 WAKE_PREFIX=wake-single \
  WAKE_RESULT=wake-single bun wake-pager.ts 1 5 file,lazy,prefetch,eager
sudo env LAB_HOST_LABEL=metal-192 WAKE_PREFIX=wake-burst \
  WAKE_RESULT=wake-burst bun wake-pager.ts 100 3 file,lazy,prefetch,eager
```

Use `WAKE_REUSE=1` to reuse the immutable snapshots and learned profiles, not
reboot and resnapshot. Keep `WAKE_PREFIX` identical. The lazy variant's first
round writes each VM's learned working set. `WAKE_PREFETCH_ORDER=sorted` sorts
that stored set for larger copy batches; the default preserves first-touch
order. `WAKE_PREFETCH_TIMING=overlap` resumes without waiting for prefetch to
finish; the default waits before resume.

For huge-page variants, preallocate a sufficient host hugetlb pool first.
`huge-lazy`, `huge-prefetch` and `huge-eager` select 2 MiB backing at restore
time. The snapshot itself may have been made with ordinary pages. An entire
100 × 2 GiB eager burst needs at least 102,400 huge pages, plus host headroom.
Hugetlb memory cannot be swapped; unused reserved pool pages also consume host
RAM. Do not benchmark ordinary-page restores with an unnecessary large pool
still reserved. Do not enable dirty logging: it forces KVM mappings to 4 KiB.
Size a lazy-restore pool for its measured resident working sets, separately
from the full-eager pool. Reserving 200+ GiB for a roughly 31 GiB lazy burst on
a 256 GiB host can evict source cache and distort the comparison.

## What the numbers mean

- `commandCompleteMs`: admission to the guest's explicit command-completion
  marker, including pager/VMM startup, snapshot load, prefetch and resume.
- `totalMs`: admission to socket close (legacy harness endpoint). This is not
  command completion: the tested Firecracker transport adds about 500 ms
  after the command has finished. Never subtract a fixed constant; use the
  separately measured marker endpoint.
- `firstByteMs`: admission to the first **guest command output** byte, not the
  host's vsock handshake. Includes work done before resuming the guest.
- `observedCommandMs`: connection start to the command-completion marker.
- `commandMs`: connection start to socket close.
- `transportTailMs`: socket close minus the command-completion marker.
- `burstCommandCompleteMs`: common burst arrival to the completion marker,
  including admission queue time; use this for scheduling comparisons.
- `burstCompletionMs`: measured from the common burst arrival, including queue
  time. This is the relevant measure for admission-concurrency comparisons.
- `loadMs` and `resumeMs`: cumulative phase boundaries from admission.
- `hugetlbMiB`: explicit huge-page residency, absent from ordinary process RSS.
- `hostMemoryAtCompletion`: host page cache and huge-page pool accounting before
  teardown. `/proc/meminfo` memory quantities are KiB; huge-page counts are pages.

All VMs stay alive until the entire burst finishes. KVM/CPU counters are sampled
before any teardown. A result with `lifecycle=retain-all-until-burst-complete`
identifies this measurement boundary. Per-VM memory is sampled at that VM's
command completion, not at a synchronized later idle point.

Boot readiness uses an explicit successful command-completion marker too.
The original harness waited for EOF and consequently included the transport
shutdown tail in both wake and readiness measurements. Marker-aware rows have
`measurement=guest-completion-marker-and-eof`. Keep legacy rows separate.

The first command includes real execution time; subtracting a separately
measured awake command is useful context but is not a pure causal isolation of
wake overhead. Guest disk/controller and CPUID differences between engines can
also change the awake command runtime. Record both, rather than attributing all
engine differences to snapshot loading.

The KVM counters are the host kernel's counters, not a cloud provider's outer
hypervisor counters. Likewise, nested host `/proc/stat` guest time can contain
time lost to outer virtualization; it is not a pure-computation measurement.

## Cache and storage controls

Suffix a mode with `-cold` to evict its memory snapshot from host page cache
before the clock starts. The guest root filesystem stays warm. The normal
label is deliberately `snapshot-written-and-reused`, not a promise that every
snapshot byte stayed cached under memory pressure.

Use `WAKE_MEMORY_ROOT` to select a separate filesystem containing
`<vm-id>/mem.snap`, and `WAKE_STORAGE_LABEL` to identify the layout. Copy the
same immutable snapshots there before running single-SSD versus striped tests.
VM state and guest disks remain at their original locations. This isolates the
snapshot-memory read path, not total storage-system performance.
`diskIo` records per-device read/write bytes and busy/weighted-I/O milliseconds
over the complete burst. RAID and underlying-device counters overlap; do not
sum both layers. The benchmark host must be otherwise idle for attribution.

Verify actual block devices with `lsblk`, not just cloud-provided aliases.
Some bare-metal images expose many local NVMe namespaces with identical serial
strings and only one `google-local-nvme-ssd-*` alias. Counting those aliases can
silently select a single drive instead of building the intended array.

`WAKE_CONCURRENCY` changes admission for this experiment only. Compare
`burstCommandCompleteMs` p90/p99, not merely latency after an individual VM starts.
Low concurrency can improve service time while making queueing worse.
Use `WAKE_CLOSE_AT_COMPLETION=1` for admission sweeps: the client closes its
probe socket at the completion marker, releasing the admission slot without
waiting for the peer's EOF delay. Such rows identify
`completionPolicy=client-close-at-marker`; their transport tail is deliberately
client-controlled and must not be compared with natural peer-EOF rows.

## KVM pre-fault experiment

Apply `wake-fc-prefault.patch` to a clean public Firecracker v1.17.0 checkout
using `git apply --recount`. Build for the test host. The patch only handles the
lab's contiguous, below-2-GiB x86 guest RAM layout; it is not a production VMM
feature or a general GPA-layout implementation.

```sh
sudo env WAKE_REUSE=1 WAKE_PREFIX=wake-burst \
  WAKE_VMM=/lab/bin/firecracker-prefault WAKE_NO_SECCOMP=1 \
  WAKE_PREFAULT_WORKING_SET=1 WAKE_RESULT=wake-prefault \
  bun wake-pager.ts 100 3 file,prefetch
```

The first resuming vCPU applies `KVM_PRE_FAULT_MEMORY` inside a process-wide
one-time barrier; every other vCPU waits there before entering `KVM_RUN`.
Subsequent resumes skip this lab hook. An earlier exploratory hook on vCPU 0
alone allowed vCPU 1 to run concurrently: do not label those results as
before-guest prefaulting. Use the separately named gated-patch results.
`WAKE_PREFAULT_PROFILE` selects one explicit profile;
`WAKE_PREFAULT_MIB` selects a whole low-memory range. The harness's
`WAKE_PREFAULT_WORKING_SET=1` supplies each VM's own learned profile. Errors fail
the experiment rather than silently falling back. The existing stock seccomp
policy does not permit this experimental ioctl, hence lab-only `--no-seccomp`.

The ioctl constructs KVM's second-level address mappings. UFFD prefetch only
fills host RAM. On a nested host, the caller controls the inner KVM, not the
cloud's outer combined/shadow mapping; measure rather than assume that inner
pre-faulting eliminates all expensive outer transitions.

## L2 controls

Variants have the form `compressor:page-cluster:MGLRU`, e.g.
`zstd:3:7,zstd:0:7,lz4:0:7,zstd:3:0`. The script restores the original settings
in its finalizer and records unsupported configurations explicitly. It uses
the existing cgroup reclaim operation with zswap writeback disabled.
`WAKE_SKIP_RECLAIM=1` provides a matched L1 pause-in-RAM baseline with no reclaim.
Reclaim preparation runs with bounded asynchronous concurrency (default 8,
`WAKE_RECLAIM_CONCURRENCY`). Its duration is reported separately as `reclaimMs`
and is excluded from the wake clock. Only expected `EAGAIN` partial-reclaim
results are tolerated; other reclaim errors fail the run.

Changing compressors does not rewrite already compressed pages in older pools.
The script therefore prepares fresh VMs for each configuration and destroys
that set before moving to the next one. Rounds within a configuration reuse the
same VMs. Compare the full distributions, not tiny differences in one trial.

## Save path and layer correctness

`wake-save.ts` reports first and subsequent saves separately. `full` writes a
complete image; `resident` uses Firecracker's native mincore-based Diff mode;
`dirty` enables KVM dirty tracking; `huge-resident` starts from a lazily restored
hugetlb guest and then saves resident pages without dirty tracking. Its initial
full snapshot is preparation, not included in the measured incremental save.
Every timed save requests durable snapshot files. Per-process write bytes and
allocated file blocks are reported alongside device-level I/O counters.
The save workload retains guest filesystem cache after preparation and adds a
live process canary; use its recorded resident-memory samples rather than
assuming the smaller working set of the separate wake benchmark.

Fresh-boot resident tests assert zero cgroup swap bytes before and after each
save, but that observation is not a production guarantee that swapping is
disabled. Mincore cannot distinguish absent zero pages from swapped-out data:
do not use it for swappable guests. Hugetlb pages are naturally unswappable.
Dirty tracking remains the appropriate native incremental path when swapped
pages must be represented, but forces 4 KiB KVM mappings even over huge backing.

The first Diff of a fresh boot is independently resumable. Later layers, and
the first measured layer of an already restored huge guest, require their
immutable parent. The benchmark resolves layers in order with the upstream
snapshot-editor into a NEW reflink clone, and restores with the matching latest
device-state file. A counter held only in a running guest process must continue
from its saved value; the representative guest workload must also succeed.

Never merge into a base still backing a live VM. A hole in a delta means
"inherit parent", not "zero"; blindly sparsifying zero-filled delta extents
loses overrides. A compact indexed image needs explicit data, zero and parent
entries, plus exact image identity and matching VM/disk generation metadata.
Ordinary private file-backed RAM also does not make saving a simple fsync:
copy-on-write modifications live in anonymous pages and must be captured.

Cloud Hypervisor's `file` memory zones with `shared=true` are different: snapshot
creation skips copying that RAM. Select `WAKE_ENGINE_FILE_MEMORY=1` explicitly.
The experiment flushes the working memory file while paused, makes an immutable
reflink checkpoint, and flushes checkpoint/state metadata. Before every restore
it clones that checkpoint into a separate writable working file. Never map the
checkpoint itself writable. Record preparation I/O too: shared RAM can incur
disk writes during guest execution, so low checkpoint write bytes do not mean
low total lifecycle I/O. This save timing includes pause and reflink creation.
The shared-file save runner stops VMMs before final counter sampling; its KVM
counter deltas must not be interpreted as fault counts. CPU and disk counters
are host-lifetime counters and remain meaningful at that boundary.

Snapshot layout must be controlled in disk comparisons. Full Firecracker
images can allocate all guest RAM even when mostly zero. `cp --sparse=always`
changes physical allocation without changing logical bytes. RAID devices may
also have very different readahead defaults. Record both rather than attributing
all differences to SSD count.

## Unresolved cold-lazy failure

The 100-VM pure 4 KiB lazy-UFFD test on a single SSD with sparse source files
reproducibly left several guests spinning in `rcu_preempt` before first output.
Their pagers were idle with no pending UFFD events, and a source-file comparison
matched the original bytes. Guest watchdogs reported soft lockups. Marker-based
client close did not fix it; learned prefetch completed the same cold workload.
This points toward a timing-sensitive guest/KVM/restore interaction, not proof
of a disk timeout or a proven pager root cause. Do not call this path production
ready, or treat prefetch as a proven general fix, until the cause is isolated.

## Source versions

Protocol/feature research is grounded in public upstream sources:

- Firecracker v1.17.0: huge pages, UFFD snapshot restore, memory/device hotplug,
  `src/vmm/src/persist.rs`, and `src/vmm/src/vstate/vcpu.rs`.
- Cloud Hypervisor v54.0: snapshot restore, live migration, passthrough,
  `vmm/src/config.rs`, and `vmm/src/memory_manager.rs`.
- Linux v6.11 and v6.17: KVM/userfaultfd UAPI headers, KVM API documentation,
  and x86 KVM MMU implementation.

Firecracker 1.17 has virtio-mem memory hotplug; older "no memory hotplug"
comparisons are stale. Cloud Hypervisor 54 has Copy, OnDemand (UFFD) and
CopyOnWrite restore modes; its default is Copy. Capability support does not
imply every device can be snapshotted or live-migrated: passthrough and external
device backends require their own compatibility checks.

In that release, CopyOnWrite falls back to eager copying for shared RAM,
huge pages, hotpluggable memory, KSM and several other configurations. OnDemand
rejects vhost-user, VFIO, vfio-user and vDPA devices. Do not assume a simple-VM
fast-restore result composes with virtio-fs or GPU passthrough. Keep engine
selection separate from capability-validated memory/device configurations.

All command timings use the lab's synthetic vsock shell service and public
guest workload, not the production connected-machine agent. Cache behavior,
working sets and guest process startup costs must be revalidated with the
production workload before selecting operational thresholds.
