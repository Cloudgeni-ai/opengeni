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

## Building

The crates target Linux hosts with KVM. Build and test on Linux:

```sh
cargo test --workspace
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
