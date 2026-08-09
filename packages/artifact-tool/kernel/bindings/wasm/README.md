# OpenGeni artifact kernel — WebAssembly adapter

This crate exposes the shared artifact-kernel protocol to browsers and Web
Workers. It is deliberately thin: every data-bearing operation accepts and
returns an opaque byte envelope. A stateful session handle exists only to avoid
re-decoding and re-encoding the workbook on every interactive edit. The native
and WebAssembly adapters therefore cannot accidentally acquire different
object models or validation rules.

## JavaScript contract

`wasm-bindgen` maps Rust `&[u8]` inputs and `Vec<u8>` outputs to JavaScript
`Uint8Array` values. The module exports:

| Function | Input | Output |
| --- | --- | --- |
| `capabilities()` | none | encoded protocol capabilities |
| `buildIdentity()` | none | encoded kernel/protocol build identity |
| `createWorkbook(namespaceEnvelope)` | namespace envelope | canonical snapshot |
| `applyCommands(snapshot, commandEnvelope)` | snapshot + atomic command envelope | canonical snapshot |
| `query(snapshot, queryEnvelope)` | snapshot + bounded query | complete bounded projection |
| `canonicalizeSnapshot(snapshot)` | snapshot | canonical snapshot |
| `canonicalizeCollaborationSnapshot(snapshot)` | CRDT snapshot | canonical CRDT snapshot |
| `layoutText(fontBundle, request)` | explicit fonts + rich paragraph | fixed-point shaped layout |
| `canonicalizeRenderTile(tile)` | retained tile | canonical retained tile |
| `canonicalizeRenderPatch(patch)` | retained patch | canonical retained patch |

Interactive editors should use the stateful fast path:

```ts
const session = ArtifactKernelSession.open(snapshot);
const receipt = session.applyCommands(commandEnvelope);
const revision = session.revision(); // bigint
const projection = session.query(queryEnvelope); // OGAKV001
const candidate = session.fork(); // independent staged state
const stateHash = candidate.stateHash(); // sha256:<64 lowercase hex>
const durableSnapshot = session.snapshot();
session.dispose(); // idempotently releases the workbook
session.free(); // releases the small Wasm handle
```

`ArtifactKernelSession.create(namespaceEnvelope)` starts a new workbook. The
session retains the decoded Rust model across edits, so ordinary mutations copy
only their bounded command envelope and small receipt across the JS/Wasm
boundary. Snapshot encoding occurs only at an explicit durability boundary.
`fork()` branches in-memory state without serializing or decoding it;
`stateHash()` hashes the exact canonical snapshot inside Rust without returning
the snapshot across the JS/Wasm boundary.
`close()` and `dispose()` idempotently release the workbook; `isClosed()`
reports lifecycle state. Call generated `free()` when the owning Web Worker
closes the artifact, or use the generated `Symbol.dispose` integration.

`ArtifactCollaborationSession` exposes the same `query()` projection plus
`authorTransaction()`, `applyCommitted()`, `frontier()`, snapshot/hash/fork,
and lifecycle methods over the authoritative CRDT state. Both session classes
use the same shared Rust query codec; native and WebAssembly return identical
OGAKV001 bytes for identical materialized state.

`ArtifactTextLayoutSession.open(fontBundle)` parses explicit OpenType assets
once and keeps bounded shaping/layout caches warm. `layout(request)` returns
the same canonical `OGTLO001` bytes as the native adapter. Fonts are never
looked up through the browser, OS or network; the host must supply the exact
content-addressed bundle. Retained tile and patch envelopes let a Worker cull
and transfer only invalidated viewport content while Canvas/WebGPU owns the
actual glyph atlas and rasterization.

Protocol errors become JavaScript `Error` values. Inputs remain bounded and
validated by the shared protocol crate. The adapter holds no ambient state
outside explicit `ArtifactKernelSession` handles, uses no ambient
clock/randomness/network/filesystem, and contains no unsafe Rust.

## Toolchain and builds

The scripts fail with an actionable message when Rust, the
`wasm32-unknown-unknown` target, or the optional `wasm-bindgen` CLI is missing.
They never install or update global tooling themselves.

```sh
./scripts/check.sh
./scripts/build.sh web ./dist
./scripts/build.sh web ./dist spreadsheet
./scripts/build.sh web ./dist document
./scripts/build.sh web ./dist presentation
```

`check.sh` runs host tests, formatting, Clippy, and the WebAssembly target
check. `build.sh` creates the release `.wasm`, generates deterministic binding
glue, and runs a Bun smoke test against the real generated WebAssembly module.
The smoke test proves exported names, `Uint8Array` inputs/outputs, stateless and
stateful round trips, fork independence, state hashes, session disposal, and
stable cross-boundary error codes. Only wasm-bindgen's `web` target is supported
by this distribution; other targets are rejected instead of receiving an
untested alias of the web output.

The first command emits the complete tool runtime. The three profile commands
emit capability-scoped editor kernels from the same locked source/build
identity. Their capability envelopes explicitly mark every omitted ABI false;
the SDK rejects a profile used for the wrong modality. This keeps first editor
load lazy without maintaining reduced JavaScript semantics.

After a build, the optional scale probe measures real generated WebAssembly at
500,000 and 1,000,000 cells:

```sh
bun run scripts/benchmark.ts ./dist
```

Browser safety limits are 64 MiB per snapshot, 8 MiB per command envelope, and
500,000 cells per batch. They are intentionally below native limits to bound
the peak working set of a 32-bit Wasm process.

For local setup, install the target explicitly:

```sh
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version <Cargo.lock wasm-bindgen version>
```

Production should pin the Rust toolchain, `Cargo.lock`, and wasm-bindgen CLI to
the versions selected by the enclosing repository build. `build.sh` refuses a
crate/CLI version mismatch because their generated ABI schemas must agree.
