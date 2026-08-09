# OpenGeni artifact kernel: Node-API binding

Thin `napi-rs` adapter over `../protocol`. Every data envelope crosses as an
owned Node `Buffer`; metadata/lifecycle values use their exact JavaScript scalar
types. This crate contains no artifact decoding or mutation logic of its own.

## JavaScript surface

```ts
capabilities(): Buffer;
buildIdentity(): Buffer;
createWorkbook(namespaceEnvelope: Buffer): Buffer;
applyCommands(snapshot: Buffer, commandEnvelope: Buffer): Buffer;
query(snapshot: Buffer, queryEnvelope: Buffer): Buffer;
canonicalizeSnapshot(snapshot: Buffer): Buffer;
canonicalizeCollaborationSnapshot(snapshot: Buffer): Buffer;
layoutText(fontBundle: Buffer, request: Buffer): Buffer;
canonicalizeRenderTile(tile: Buffer): Buffer;
canonicalizeRenderPatch(patch: Buffer): Buffer;

class ArtifactKernelSession {
  static create(namespaceEnvelope: Buffer): ArtifactKernelSession;
  static open(snapshot: Buffer): ArtifactKernelSession;
  applyCommands(commandEnvelope: Buffer): Buffer; // receipt envelope
  snapshot(): Buffer;
  revision(): bigint;
  query(queryEnvelope: Buffer): Buffer;
  fork(): ArtifactKernelSession;
  stateHash(): `sha256:${string}`;
  readonly closed: boolean;
  close(): void;
  dispose(): void;
}

class ArtifactCollaborationSession {
  static create(namespaceEnvelope: Buffer): ArtifactCollaborationSession;
  static open(snapshot: Buffer): ArtifactCollaborationSession;
  authorTransaction(intent: Buffer, resolvedBase: Buffer): Buffer;
  applyCommitted(transaction: Buffer): void;
  query(queryEnvelope: Buffer): Buffer;
  snapshot(): Buffer;
  frontier(): Buffer;
  revision(): bigint;
  fork(): ArtifactCollaborationSession;
  isClosed(): boolean;
  stateHash(): `sha256:${string}`;
  close(): void;
  dispose(): void;
}

class ArtifactTextLayoutSession {
  static open(fontBundle: Buffer): ArtifactTextLayoutSession;
  layout(request: Buffer): Buffer;
  isClosed(): boolean;
  close(): void;
  dispose(): void;
}
```

Invalid or unsupported envelopes throw an `Error` whose message begins with the
stable protocol code (`[CODE] message`). Callers must treat snapshots and
envelopes as opaque bytes.

`query()` accepts canonical OGAKQ001 bytes and returns complete, bounded
OGAKV001 projections. Keep decoding in the artifact worker; canonical workbook
state never needs to cross onto the UI thread.

## Build and test

Run from this directory:

```sh
cargo test --locked --features noop
cargo clippy --locked --all-targets --features noop -- -D warnings
cargo build --locked --release
```

Then package/rename the native library as a `.node` addon and run the real Bun
smoke test:

```sh
OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH=/absolute/path/artifact-kernel.node \
  bun run scripts/smoke.mjs
```

The release build produces the platform-native `cdylib` in `target/release`.
Packaging must rename it to the `.node` filename expected by the generated
JavaScript loader. Build each supported target in its native or correctly
configured cross-compilation environment; never ship a fallback with different
kernel semantics.

The `noop` feature disables generated N-API registration only for pure-Rust
unit tests. Release packages must never enable it. Loading the produced addon
and exercising every export with real Node/Bun `Buffer` values remains a
separate packaging conformance test.

The Node-API baseline is N-API 8. Inputs are borrowed directly from Node only
for the duration of a synchronous call. Protocol-owned output vectors transfer
into Node `Buffer` ownership without another adapter copy or serialization pass
(the two tiny static metadata envelopes are copied into owned buffers).

Use `ArtifactKernelSession` for interactive editing: it decodes once, mutates
the native workbook in memory, and encodes only at explicit persistence
checkpoints. Keep one JavaScript owner in an artifact worker and call its
synchronous methods serially; do not share a session across event-loop workers.
Use `fork()` to stage speculative or authoritative candidates without a
snapshot encode/decode cycle. `stateHash()` hashes the exact canonical snapshot
inside Rust, avoiding a large JS boundary copy when only convergence proof is
needed.

Use `ArtifactTextLayoutSession` in a dedicated persistent worker when rendering
documents or presentations. It parses the caller-supplied, content-addressed
font bundle once and keeps only bounded Rust caches warm. The same protocol and
fixed-point glyph output run on macOS, Linux and Windows; the binding contains
no OS font lookup or platform text API.
