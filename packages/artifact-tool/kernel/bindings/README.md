# OpenGeni artifact kernel bindings

Production adapters over the same safe Rust model kernel:

- `protocol/` owns the bounded, checksummed byte ABI and stateful session;
- `napi/` exposes native Node/Bun bindings for server and desktop workers;
- `wasm/` exposes the browser WebAssembly binding;
- `build.ts` and `verify.ts` build and exercise the actual JavaScript ABI.

Both runtimes provide two paths:

1. stateless functions decode a canonical snapshot, atomically apply one
   command envelope, and return a canonical snapshot;
2. `ArtifactKernelSession` opens once, applies many command envelopes in
   place, forks independent staging branches without byte round trips, exposes
   the canonical state hash, and snapshots only at a persistence boundary.

The second path is the editor hot path. The first is useful at authoritative
server trust boundaries and as a deterministic conformance oracle.

Text layout has the same split: `layoutText(fontBundle, request)` is the
stateless oracle, while `ArtifactTextLayoutSession.open(fontBundle)` parses
explicit fonts once and retains bounded shaping/layout caches across requests.
The `OGFNT001`, `OGTLQ001` and `OGTLO001` envelopes are canonical,
checksummed, versioned and byte-identical between native and Wasm. Retained
render tiles (`OGRTI001`) and scene patches (`OGRPA001`) cross either boundary
through `canonicalizeRenderTile` and `canonicalizeRenderPatch`.

Native limits allow a 512 MiB font bundle, 8 MiB request and 64 MiB response.
Wasm limits are 48 MiB, 4 MiB and 32 MiB respectively. Both additionally
enforce the shared grapheme, shaping-call, glyph, line, cache and deterministic
work-unit budgets. Neither adapter discovers fonts, reads files or performs
network I/O.

## ABI layering

These binding commands are **not** the package's public
`ArtifactCommandBatchCodec` wire format.

```text
public OGAR operation
  (artifact/transaction/actor/base sequence/causal vector/preconditions)
                         |
  prepareSpreadsheetKernelTransaction (strict canonical validation,
        authorization-bound `sha256:` request identity, operation lowering)
                         |
internal OGAKC001 kernel command
  (create/rename/delete sheet, set cells, clear range)
                         |
          N-API or WASM BindingSession
                         |
             canonical OGARTK01 snapshot
```

The public operation log is durable collaboration intent. The private binding
command is a compact, trusted model mutation after authority/preconditions are
validated. `spreadsheet-adapter.ts` implements the current explicit OGAR to
OGAKC mapping and binds the exact public bytes, lowered bytes, and SHA-256
request identity into one prepared transaction. The formats are intentionally
not interchangeable.

`runtime.ts` normalizes the native and browser module shapes. It owns namespace
encoding, capability negotiation, exact `bigint` revisions, session
fork/hash/lifecycle behavior, and fail-closed module validation.

## Identity

The host generates a cryptographically random, nonzero `u64` replica namespace
once and persists it. `encode_namespace` wraps it for the binding. Both create
and open reject namespace zero so offline replicas cannot silently collide.

## Build and verify

From the repository root:

```bash
bun run packages/artifact-tool/kernel/bindings/build.ts
```

`build.ts` builds both real adapters and runs cross-runtime verification. To
rerun verification against existing outputs, set both explicit paths:

```bash
OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH=/absolute/path/artifact-kernel.node \
OPENGENI_ARTIFACT_KERNEL_WASM_WEB_DIR=/absolute/path/wasm-web \
  bun run packages/artifact-tool/kernel/bindings/verify.ts
```

The scripts fail with a concrete installation command when Rust, the
`wasm32-unknown-unknown` target, `wasm-bindgen`, or Bun is unavailable. They do
not silently omit a runtime.

Production native publishing must build one `.node` artifact per supported
target in CI (at minimum macOS arm64/x64, Linux arm64/x64 glibc, and Windows
x64), attach checksums/provenance, and select by exact platform/architecture.
Never download or guess a native binary at runtime. WASM is a `web`-target
asset built from the same pinned Rust dependency graph and loaded in a
dedicated Web Worker. Browser limits are intentionally smaller (64 MiB
snapshot, 8 MiB command, 500,000 cells per batch) than native limits (512 MiB,
64 MiB, 4,000,000 cells) because JavaScript input, decoded state, and output can
coexist in a 32-bit Wasm process.

## Distribution

Native bindings and the complete browser build matrix ship through
receipt-pinned generated target packages. Browser editors load the narrower
publishable packages `@opengeni/artifact-kernel-wasm-{spreadsheet,document,presentation}`.
Each contains only one verified capability-scoped runtime and exposes its exact
asset URLs plus typed runtime identity. The SDK Worker compares that identity
with the executable before accepting state. A complete native release manifest
still requires every supported target with one build identity. Resolvers never
download, guess, or silently substitute a runtime.
