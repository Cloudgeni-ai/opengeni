# compute-storage

Content-addressed storage of sandbox disks and memory images in object
storage: what the host agent archives to, wakes from and sweeps.

- `chunk`: fixed-size or bounded content-defined chunking, independent zstd
  compression with a raw fallback, and BLAKE3 checks of both the stored and
  the decoded bytes. An object's key includes its codec and encoded digest,
  so two compression levels never race to publish different bytes under one
  key.
- `manifest`: versioned complete byte maps of zero, base and chunk extents.
  Validation rejects gaps, overlaps, overflow and invalid references; a hole
  is never inherited from an earlier copy.
- `store`: GCS, Azure Blob and S3 through `object_store`, with the machine's
  own credentials; conditional immutable publication; bounded, verified
  downloads; listing and generation-conditional deletion (GCS only for now).
- `fresh` and `sweep`: deleting what no stored copy names any more, safely
  while archives that may reuse it are in flight; see
  [ADR 17](../../docs/adr/0017-sweeping-unnamed-chunks.md).

Everything read back is hashed and fails closed: a missing, short or
corrupt object is an error, never zeros. Hashes detect corruption, not who
may publish: which pointer is current, and who may move it, is the host
agent's business. Deduplication stays within one tenant or public image
domain, so the store never answers whether another tenant holds some
content.

Chunks are at most 16 MiB and manifests at most 16 MiB; decoded sizes are
checked before they are accepted. GCS and Azure were exercised against real
accounts; S3 compiles but is untested against a real bucket.

The phase 1 storage experiments (FIEMAP and dirty-bitmap scans, an NBD
demand-read bridge, a second lazy reader, object and density benchmarks)
answered their questions and were removed; their results are in
[the measurements](../../docs/measurements.md) and git history keeps the
code.

## Verification

```sh
cargo fmt --manifest-path compute/Cargo.toml -p compute-storage --check
cargo test --manifest-path compute/Cargo.toml -p compute-storage
cargo clippy --manifest-path compute/Cargo.toml -p compute-storage --all-targets -- -D warnings
```
