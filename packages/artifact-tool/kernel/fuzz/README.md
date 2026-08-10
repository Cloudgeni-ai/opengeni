# Artifact kernel fuzzing

These targets are deliberately outside the normal Cargo workspace and never
run on production inputs with network access.

```bash
cargo install cargo-fuzz
cargo fuzz run --fuzz-dir packages/artifact-tool/kernel/fuzz snapshot_decode
cargo fuzz run --fuzz-dir packages/artifact-tool/kernel/fuzz collaboration_snapshot_decode
cargo fuzz run --fuzz-dir packages/artifact-tool/kernel/fuzz operation_sequences
cargo fuzz run --fuzz-dir packages/artifact-tool/kernel/fuzz collaboration_sequences
cargo fuzz run --fuzz-dir packages/artifact-tool/kernel/fuzz binding_protocol_decode
```

`snapshot_decode` and `collaboration_snapshot_decode` assert that every accepted
materialized or CRDT snapshot has one stable canonical re-encoding.
`operation_sequences` interprets bounded arbitrary bytes as model operations,
verifies snapshot round trips after each accepted batch, and proves failed
batches leave the model byte-identical.
`collaboration_sequences` permutes causal chains, duplicates, range edits,
rename/delete/undo, and deferred delivery, then requires byte-identical CRDT
snapshots.
`binding_protocol_decode` covers the native/WASM command, receipt, frontier,
intent-identity, materialized-snapshot, and collaboration-snapshot boundaries;
every accepted canonical envelope must re-encode byte-identically.

The checked-in seed corpus is exercised in CI/local validation with the actual
`libfuzzer-sys` runners (without requiring the `cargo-fuzz` subcommand):

```bash
bun run --cwd packages/artifact-tool fuzz:smoke
```

This 256-run `libfuzzer-sys` runner smoke is a corpus/crash/canonicality gate.
It is not coverage-instrumented when invoked by plain Cargo, and is not a
substitute for time-bounded `cargo fuzz run` campaigns with sanitizer builds.
