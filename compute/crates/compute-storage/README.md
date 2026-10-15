# compute-storage

Storage primitives and reproducible Linux experiments for sleepable Opengeni
microVMs. This crate is not a production storage daemon or a durability service.

## Reusable library

- `chunk`: fixed-size or bounded deterministic Gear chunking; independent zstd
  compression with raw fallback; BLAKE3 checks of both stored and decoded bytes.
  The object key includes codec and encoded digest, so different compression
  levels cannot race to publish incompatible bytes under one key. Gear here is
  a simple baseline, not an optimized FastCDC implementation.
- `manifest`: versioned complete byte maps with explicit zero, immutable-base,
  and chunk references. Validation rejects gaps, overlaps, overflow and invalid
  references. A hole is not implicitly inherited from a previous checkpoint.
- `dirty`: a generation-fenced bitmap. Mark writes and discards before their
  acknowledgement. Freeze under the block backend's snapshot fence. Failed
  shipping merges old bits back without dropping writes from the new generation.
  This tracks candidates; it does not itself capture immutable data.
- `fiemap` (Linux): conservative candidate ranges between **immutable, open,
  same-filesystem, equal-size** reflink snapshots. Physical addresses are local
  hints, never content identifiers. Unknown flags force a byte comparison. A
  source file must not be rewritten, punched or deleted during comparison.
- `store`: provider-native GCS, Azure Blob and S3 builders from `object_store`;
  normal environment/machine credentials; conditional immutable publication;
  bounded, verified downloads. GCS and Azure were exercised against real cloud
  accounts; S3 is compiled but not cloud-tested in this experiment.
- `lazy`: verified demand reads and an explicitly bounded plaintext FIFO cache.
  Concurrent cache misses may issue duplicate GETs. Missing objects fail closed.
  Base extents currently fail explicitly: callers must flatten the manifest or
  add a separately verified base resolver before using them with this reader.

Chunk size is limited to 16 MiB and decoded sizes are checked before acceptance.
Remote manifest reads are limited to 16 MiB. Hashes detect corruption, not who
is authorized to publish: authorization and checkpoint fencing belong to the
control plane. Keep deduplication within an authorized tenant or public-image
domain; do not expose cross-tenant content-existence oracles.

## Required checkpoint contract

1. Fence the active writer using an authoritative sandbox ownership generation.
2. Quiesce applications if application consistency is required. Guest `fsfreeze`
   provides filesystem consistency, not an application transaction boundary.
3. Pause vCPUs, drain outstanding device I/O and fsync host backing devices.
   Guest `sync` alone is insufficient when a VMM uses unsafe cache semantics:
   host block-device page cache may not yet reach a userspace backend's file.
4. Capture immutable disk layers and matching memory/device state as one epoch.
   Rotate dirty tracking under the same fence, then resume local execution.
   If memory captured a frozen filesystem, record it and thaw before exposing
   the restored guest. A resident control channel must work without new writes
   to a frozen root filesystem.
5. Upload new chunks, then immutable manifests, then atomically commit the
   authoritative checkpoint pointer with an ownership-generation compare/swap.
   `put_manifest` does **not** verify that every referenced object exists and
   does **not** commit that pointer. A successful PUT alone is not a checkpoint.
6. Only after that commit may the dirty generation be acknowledged or a local
   checkpoint be evicted. Retention and garbage collection must honor active
   readers, in-flight publishers, ownership fencing and a recovery grace period.

Host loss recovers the last committed remote epoch, not the last local `fsync`.
Expose checkpoint age; a periodic schedule is not a hard RPO when uploads stall.
Strong remote write acknowledgement requires an explicit checkpoint barrier or
a separately designed replicated write journal. No such journal is implemented.

Base images are immutable, content-addressed versions. Roll out new bases to new
guests; retain the old base while any checkpoint references it. Do not replace a
running guest's lower image beneath filesystem caches. Existing guests upgrade
through normal filesystem/package operations or a deliberate cold migration.

`RestoreClass` defaults to exact equality across CPU, microcode, template, KVM,
machine configuration, VMM and kernels. The caller supplies verified nonempty
identities. It is a scheduler guard, not a proof that arbitrary hypervisors are
compatible. Relax only through an explicit tested restore matrix. Portable disk
images and portable running processes are different promises.

## Lab executables

Run only on isolated hosts with public code and synthetic data. Cloud provider
credentials are never embedded. Provider selection is `gcs`, `azure`, or `s3`;
consult `object_store` builder documentation for credential configuration.

| Binary | Purpose |
| --- | --- |
| `storage-bench BEFORE AFTER [--full]` | FIEMAP candidates vs full byte scan; chunk/codec matrix |
| `storage-density BASE NEW_DIRECTORY COUNT` | FICLONE timing, physical filesystem usage and COW writes |
| `storage-dirty` | Bitmap CPU/memory microbenchmark; not backend latency |
| `storage-dedupe IMAGE...` | Whole-image zero elision and nonzero deduplication |
| `storage-object PROVIDER PREFIX` | PUT/GET matrix and per-batch deletion |
| `storage-pack PROVIDER PREFIX IMAGE MANIFEST` | Upload immutable fixed chunks and a complete map |
| `storage-fetch PROVIDER PREFIX DIGEST OUTPUT [--image]` | Verified manifest or small state image download |
| `storage-nbd PROVIDER PREFIX MANIFEST SOCKET NEW_COW_FILE` | Lab-only demand-read block bridge |

The NBD bridge is **not a durable writable layer**. Its COW sector bitmap lives
only in RAM; a daemon crash loses that map even if the data file was fsynced. It
is single-client, serves requests serially, lacks a recovery journal and is not
hardened for untrusted clients. Its optional prefetch is a training-trace hint,
not a guarantee that every future workload wakes quickly. It exists to measure
object-backed faults before integration with a dedicated disk backend and memory
pager. Disk manifests, small VM state and learned hints are distinct inputs.

`compute/lab/storage-*` uses the existing shared lab helpers. Layering compares
data disks mounted at `/work` behind the same guest root. Enable Writeback cache
semantics and drain host backing devices before copying snapshots. Guest fio
uses direct I/O, but the host page cache is still in the path; results are not
raw-media throughput. `storage-thin-density.ts` requires its owned pool and
deletes only the snapshot IDs it created. Use a fresh `STORAGE_ROOT` per run.

For lazy memory, the lab wraps the memory file in a read-only ext4 image over
NBD: a raw block device has zero `st_size` and cannot be substituted directly for
Firecracker's file-backed memory snapshot. This is a measurement scaffold, not
the intended memory-pager architecture. Stop the VM, unmount memory, disconnect
NBD devices, then stop daemons; never remove backing storage under a live VM.

## Verification

```sh
cargo fmt --manifest-path compute/Cargo.toml -p compute-storage --check
cargo test --manifest-path compute/Cargo.toml -p compute-storage
cargo clippy --manifest-path compute/Cargo.toml -p compute-storage --all-targets -- -D warnings
```

Unit tests cover generation fencing, holes/extent flags, map validation, chunk
integrity, immutable publication and lazy reads. The lab additionally exercises
real Linux ioctls, real provider requests, filesystem freeze and VM restore.
