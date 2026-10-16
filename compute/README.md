# Opengeni compute

Durable sandboxes that sleep when idle and wake on demand, on hosts we run
ourselves. Each sandbox is a small hardware-isolated VM. It keeps its files
and running programs across sleep and costs almost nothing while asleep.

Status: design and prototype phase. Nothing here is used by Opengeni yet.

## Layout

| Path | What it is |
| --- | --- |
| `crates/` | Rust crates; each joins the workspace automatically |
| `lab/` | Throwaway measurement harness (Bun scripts) used to size the design |
| `ARCHITECTURE.toml` | Structure rules checked by `cargo arch`, with existing exceptions in `architecture-baseline.toml` |
| `NOTICE` | What is derived from other projects, and how it was changed |

## Building

The crates target Linux hosts with KVM. Build and test on Linux:

```sh
cargo test --workspace
cargo arch        # structure rules: file size, a pure core, where unsafe code lives
```

Tests that drive a real Firecracker run as root on a KVM host prepared by
`lab/host-setup.sh`, and only when `COMPUTE_TEST_LAB` names that directory:

```sh
sudo env COMPUTE_TEST_LAB=/lab cargo test --workspace
# the nested-host memory profile (needs a reserved 2 MiB page pool)
sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_PROFILE=nested cargo test -p compute-host --test save_wake
# the archive and object-storage wake cycle
sudo env COMPUTE_TEST_LAB=/lab COMPUTE_TEST_STORE=gs://bucket/prefix cargo test -p compute-host --test save_wake
```

## Saving and waking

A host runs one memory profile (`compute-host serve --memory-profile`):

- `bare-metal`: 4 KiB pages, KVM dirty-page tracking, zswap allowed. A save
  writes only the pages the guest changed; a wake from local disk maps the
  image file directly.
- `nested` (a VM inside a cloud VM): 2 MiB pages from a reserved huge-page
  pool, which makes the outer hypervisor's work far cheaper. Dirty tracking
  would split those pages, so a save writes the pages that are resident, and
  every wake goes through the userfaultfd pager (`compute-pager`).

Combinations that would lose data or defeat themselves (dirty tracking with
huge pages, resident saves of swappable memory, compressing huge pages,
mapping a huge-page image from a file) are refused.

Every save is merged, after the VM's diff is written and never under a live
VM, into a new self-contained image generation (a reflink copy of the
previous image with the diff laid over it), so no image depends on another.
A generation is published by writing, syncing and renaming it into place,
checking it, and only then moving the `current` pointer. One check decides
whether a copy is good; an older copy is removed only once a newer one has
passed it, and a copy that fails is moved to quarantine, never deleted. The
same rule holds for archives: the local copy is evicted only after the store
confirms it holds exactly the archived copy.

Archived sandboxes are stored as compressed, content-addressed 256 KiB chunks.
Uploads carry a checksum the object store verifies, and every chunk read is
checked against its hash, so a truncated or corrupt chunk is rejected (and
quarantined) rather than shared into other sandboxes. A wake from object
storage fetches the disk over the host's base image (downloading only chunks
that differ) and pages memory in through the pager as the guest touches it,
prefetching the pages earlier wakes of that sandbox touched first.

## Host capacity

A host takes on only the memory it can hold. Each sandbox has a memory
request, what it is guaranteed while awake (`memory_request_mib`, all of
`memory_mib` unless set lower), and a limit, its VM size; on huge-page hosts
the request is always the whole VM, since a guest never gives huge pages
back. The requests of awake and waking sandboxes, together with what paused
ones still hold and any use above a request, stay within the host's
capacity (`--memory-capacity-mib`; by default the huge-page pool, or the
host's memory less `--memory-headroom-mib`).

Admission is arithmetic on numbers the agent already holds, decided in
microseconds. Inside a request the only relief is instant: ending idle VMs
whose state is already saved, which frees their memory in milliseconds
without I/O. If that is not enough, the request fails at once with the
retryable `host_full` error, saying how much it needed; it never waits for a
pause, compression or save. Room is made ahead of time instead: the host
keeps `--memory-buffer-mib` (default a sixteenth of the capacity) free by
pushing idle sandboxes deeper in the background, least recently used
first, and also makes room for sandboxes that are held while refused, which
then wake by themselves. Held or recently busy sandboxes are never touched.
The status reports the capacity (total, reserved, occupied, free, awake), and
a restarted agent rebuilds it from its records.

The request also sets the VM's guarantees in its cgroup: `memory.low` while
it runs (zero while paused, so the kernel takes from idle VMs first; not
`memory.min`, which would have the kernel kill processes rather than slow a
VM down if the host ever runs short beyond everything unprotected), and
`cpu.weight` from `cpu_request_millis` (all its processors unless set
lower), so contended processors are shared by request while `vcpus` stays
the ceiling. A running VM is never compressed or swapped, not even by the
kernel under memory pressure: `memory.zswap.max` is 0 from launch, on
adoption and before every resume, and opens only while the agent compresses
the paused VM; with `memory.zswap.writeback` at 0 a page zswap refuses is
not swapped out either. The status shows each VM's zswap traffic and memory
pressure. VMMs and pagers have `oom_score_adj` -900, so the host's
out-of-memory killer ends nearly anything else first. On huge-page hosts a
guest that finds the pool empty stalls (its vCPU retries the fault) until a
page is free; admission counting every awake VM whole against the pool
keeps that from happening unless something else takes from the pool.
