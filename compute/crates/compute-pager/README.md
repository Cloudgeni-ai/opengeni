# compute-pager

A Linux snapshot pager for Firecracker's `mem_backend.backend_type = "Uffd"`.
The library's mapping/profile logic is portable. The UFFD backend and runner
require Linux. No async runtime is imposed: use a dedicated thread, or call
the blocking pager from `tokio::task::spawn_blocking` in an async host agent.

## What it does

- Receives the snapshot memory layout and an owned UFFD via SCM_RIGHTS.
- Supports 4 KiB and explicit 2 MiB hugetlb pages, including both Firecracker
  page-size field names. The deprecated `page_size_kib` field contains **bytes**.
- Serves only touched pages, or replays a learned working set before/alongside
  resume. Contiguous runs use multi-page `UFFDIO_COPY` operations.
- Records an ordered, deduplicated first-touch profile for a bounded interval.
  Profiles carry a version and caller-supplied immutable snapshot identity.
- Supports address-sorted replay when sequential I/O and copy batching matter
  more than preserving first-touch order. The stored profile remains ordered.
- Drains mapping notifications before copying. REMOVE permanently changes the
  backing of affected pages to zeros; UNMAP retires destinations. Old snapshot
  data must never be reintroduced after a balloon/free-page discard.
- Handles duplicate faults, `EEXIST`, partial copy progress, and `EAGAIN` when
  removal races a copy. Pending demand faults survive a retry.
- Tracks copies, bytes, zeros, retry events, faults, removals, and prefetch time.

The pager does **not** populate KVM's second-level page tables. Copying guest
RAM and constructing KVM mappings are distinct operations. It also does not
fetch snapshots from object storage, run a VM engine, allocate a huge-page
pool, or implement a host-wide admission scheduler.

## Supervision contract

1. Bind the socket in a private directory accessible only to the owning VMM
   and pager. The received FD and mapping describe a trusted owned VMM, not an
   arbitrary network client. The embedding host owns peer authentication.
2. Open an immutable snapshot. `Pager::new` is unsafe because truncating or
   rewriting an mmap-backed source can invalidate memory safety or guest state.
3. Supply a stable identity for that exact snapshot; change it when the bytes
   change. The identity is checked, not computed or authenticated by this crate.
4. Keep the pager serving while the VMM can fault, including paused restore:
   restoring devices may touch memory before guest vCPUs run.
5. Monitor both processes. If the pager fails, terminate/recover the associated
   VMM; Firecracker keeps another UFFD reference and otherwise can hang forever.
6. Stop the VMM before stopping its pager. In the service loop, ESRCH means
   the target memory space exited and is treated as normal disconnection.
7. Do not concurrently mutate a `Pager`. Its single owner serializes demand,
   invalidation, and prefetch; demand gets priority at every prefetch batch.

Unknown UFFD modes/events (e.g. write protection, minor faults, FORK, REMAP)
fail explicitly rather than pretending they are missing-page faults. An UNMAP
only retires existing addresses; this implementation does not accept a later
replacement mapping on the same connection. The mmap source can receive I/O
errors as SIGBUS; the supervisor must treat pager death as restore failure.

## Runner

```sh
cargo build -p compute-pager --release
compute-pager SOCKET MEMORY_SNAPSHOT SNAPSHOT_ID OUTPUT_PREFIX lazy 5000
compute-pager SOCKET MEMORY_SNAPSHOT SNAPSHOT_ID OUTPUT_PREFIX PROFILE.json 5000 sorted
compute-pager SOCKET MEMORY_SNAPSHOT SNAPSHOT_ID OUTPUT_PREFIX eager 5000
```

The runner writes `OUTPUT_PREFIX.ready` after prefetch, then serves faults until
SIGTERM/SIGINT or VMM disconnect. It writes `.profile.json` and `.stats.json`
on service-loop exit. The host can wait for `.ready` before resuming, or resume
while prefetch runs. Include time spent waiting for ready in user-visible wake
latency. The runner waits at most 30 seconds for a VMM connection and bounds
handshake reads to 10 seconds; the embedding host owns broader timeouts.

Use a new output prefix per run. The caller owns socket-file cleanup. `eager`
means the entire guest memory image, including zero-filled/free regions; it
deliberately measures the memory and bandwidth cost of fully eager restore.

## Checks

```sh
cargo fmt --all --check
cargo test -p compute-pager
cargo clippy -p compute-pager --all-targets -- -D warnings
# Also runs real kernel UFFD tests; requires permission for user-mode UFFD.
cargo test -p compute-pager -- --include-ignored
```

Kernel tests exercise actual demand faults, partial batch copies, EEXIST,
REMOVE followed by zero-fill, and UNMAP retirement. The lab scripts add real
Firecracker snapshot/balloon/hugetlb tests and burst measurements.

## Primary protocol references

- Firecracker v1.17.0: `src/vmm/src/persist.rs` and
  `docs/snapshotting/handling-page-faults-on-snapshot-resume.md`.
- Firecracker v1.17.0: `docs/hugepages.md` and `docs/memory-hotplug.md`.
- Linux UAPI: `include/uapi/linux/userfaultfd.h`.
- Linux KVM: `Documentation/virt/kvm/api.rst`, section `KVM_PRE_FAULT_MEMORY`.

`KVM_CAP_PRE_FAULT_MEMORY` appears in Linux v6.11 (not v6.10). Capability probing
and actual ioctl success are still required: kernel version alone is not a
guarantee that a particular vCPU mode supports it.
