# Artifact kernel binding protocol

Shared safe-Rust ABI codec for the N-API and WebAssembly adapters.

The boundary is deliberately byte-only:

- namespaces use a checksummed `OGAKN001` envelope;
- mutations use a checksummed, bounded `OGAKC001` envelope;
- model state uses the kernel's canonical `OGARTK01` snapshot envelope;
- stateless mutation returns canonical snapshot bytes directly;
- stateful mutation returns a compact `OGAKR001` receipt and leaves snapshot
  serialization to an explicit durability boundary;
- reads use a checksummed `OGAKQ001` request and `OGAKV001` response. Kind 0
  returns a sparse row-major viewport; kind 1 returns ordered sheet metadata
  and exact used bounds. Results are complete or rejected, never truncated;
- malformed, oversized, non-canonical, or partially valid inputs fail before
  the caller receives new state.

The host owns randomness and persists the 64-bit replica namespace. The
binding rejects namespace zero and never invents identity, accesses clocks,
performs I/O, or evaluates JavaScript.

Use `BindingSession` for the editor hot path: open/create once, apply many
atomic command envelopes, inspect the `u64` revision, and snapshot only at a
persistence boundary. `fork()` creates an independent staging session without
serializing/decoding; `state_hash()` returns lowercase SHA-256 over the exact
canonical snapshot without copying snapshot bytes through JavaScript. The
stateless functions intentionally decode and encode on every call and are
suited to authoritative server transactions.

`query()` runs entirely against the decoded session model. Request-provided
item/byte limits are clamped to the protocol hard caps (1,048,576 viewport
area, 262,144 returned cells, 10,000 metadata sheets, 8 MiB response), and an
oversized result returns `ARTIFACT_LIMIT`. Collaboration-session responses pin
each returned sheet to its current creation-operation generation. Version 1
does not model row/column dimensions, hidden state, or merges and reports zero
feature bits rather than inventing defaults.

Computing exact used bounds visits at most 4,000,000 populated cells per
metadata query. Larger catalogs fail explicitly rather than creating an
unbounded worker stall; a future kernel-maintained bounds index can raise this
without changing the wire format.

```bash
cargo test --locked --manifest-path packages/artifact-tool/kernel/bindings/protocol/Cargo.toml
cargo clippy --locked --manifest-path packages/artifact-tool/kernel/bindings/protocol/Cargo.toml --all-targets -- -D warnings
cargo bench --locked --manifest-path packages/artifact-tool/kernel/bindings/protocol/Cargo.toml --bench session
```
