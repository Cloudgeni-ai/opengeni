# OpenGeni artifact kernel

This crate is the deterministic model core beneath `@opengeni/artifact-tool`.
It deliberately knows nothing about JavaScript, React, filesystems, ZIP/Office
codecs, platform font discovery, rasterizers, networking, or persistence
transports.

## Invariants

- Safe Rust only; no platform ABI or runtime dependency.
- Stable 128-bit entity ids, independent of memory addresses or process state.
- Zero-based sheet coordinates stored in sparse `256 x 256` tiles.
- Typed cells distinguish empty, boolean, finite number, text, formula, and
  spreadsheet-error state.
- A command batch validates completely before it changes the workbook. A batch
  advances the revision exactly once; an invalid batch changes nothing.
- Snapshots are canonical little-endian binary. Identical workbook state emits
  identical bytes. Decoding is bounded, checksummed, strict, and rejects
  non-canonical ordering or trailing data.

## Collaboration slice

`CollaborativeWorkbook` is the authoritative spreadsheet collaboration model.
One client transaction owns one causal dot `(replica namespace, persisted
counter)` and any number of uniquely identified suboperations. The transaction
is validated and becomes visible atomically; wall-clock time is never conflict
authority.

- Scalar cells are causal registers. Causal successors win; concurrent maxima
  use a stable dot/operation tie-break while retaining every contribution needed
  for selective undo.
- Range clears are sparse causal tombstones. They affect existing cells and are
  also joined to later-arriving concurrent cells, so delivery order cannot
  change the result and a billion-cell empty range allocates no cells.
- Sheet structure uses stable creation generations and retained predecessor
  anchors. Concurrent delete/edit is delete-visible while preserving the edit;
  undoing the delete reveals it.
- Dependency-missing transactions are bounded and deferred. Exact retries are
  no-ops; conflicting transaction, dot, or operation reuse fails explicitly.
  Submitted version vectors must be causally closed: observing a dot also
  requires every dependency that dot observed, preventing impossible authored
  histories from weakening preconditions.
- Collaboration snapshots (`OGACRD01`) contain the full retained transaction,
  causal, tombstone, undo, and materialized state. Decode deterministically
  reconstructs and verifies both the frontier and ordinary workbook snapshot.
- `retention_metadata()` exposes retained causal floors, pending bases,
  tombstones, and undo links so the persistence layer can combine them with
  pinned versions and replica leases before removing external operation
  segments. The first slice retains internal history rather than guessing a
  locally safe garbage-collection frontier.

The intended outer layers are adapters:

```text
TypeScript API / React editors / collaboration
                    |
              WASM or N-API
                    |
        opengeni-artifact-kernel
                    |
       XLSX / DOCX / PPTX codecs, renderers
```

The kernel can therefore be compiled for native hosts or `wasm32` without
forking the model semantics. ABI bindings should translate commands and
snapshots at the edge instead of exposing Rust layout.

## Spreadsheet calculation profile

Formula source is authoritative: command and snapshot boundaries discard
untrusted cached results and derive them again. The engine parses each formula
once, interns equivalent expression trees, and keeps forward/reverse edges by
stable sheet id and cell coordinate. An input edit recalculates only its dirty
reverse-dependency closure in deterministic topological levels. Sheet renames
rewrite only syntactic qualifiers; sheet deletion leaves `#REF!` source and
dependency tombstones. Cycles and cells blocked by a cycle resolve to
`#CYCLE!`.

The implemented, bounded function profile is:

- Aggregates: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`.
- Logic: `IF`, `IFERROR`, `AND`, `OR`, `NOT`.
- Numeric: `ABS`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `POWER`, `SQRT`.
- Text: `LEN`, `LOWER`, `UPPER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `CONCAT`.
- Date parts: `DATE`, `YEAR`, `MONTH`, `DAY`.
- Exact lookup: `INDEX`, `MATCH`, `XLOOKUP` (exact, forward search only).

Scalar/range A1 references, quoted cross-sheet references, arithmetic,
comparison, concatenation, percent, error propagation, and lazy `IF`/`IFERROR`
branches are supported. This is deliberately not an Excel-compatible formula
runtime. Volatile clock/random functions, external workbooks, network/data
functions, named expressions, arrays/spills, implicit intersection, locale
grammar, approximate lookup, and the wider Excel function catalog are not
implemented; unknown functions produce `#NAME?` and unsupported syntax produces
an inert worksheet error.

Hard ceilings cover source bytes, tokens, nesting, arguments, referenced range
area, reads and operations per formula and recalculation, dependency depth,
formula/cell/edge/AST/range counts, result length, retained values, and aggregate
interned UTF-8. Callers may tighten but never relax them. Failed edits and
recalculations commit neither authored nor derived state.

## Shared text layout and retained rendering

`text_layout` is the common document/presentation text engine. Callers provide
exact OpenType bytes, face indices and family metadata; the registry derives a
content-addressed asset digest and face id. It never consults operating-system
fonts or a network. Rustybuzz shaping, Unicode bidi, grapheme segmentation and
Unicode line breaking therefore execute identically in native workers and
Wasm sandboxes. Output uses signed 1/64-CSS-pixel fixed point and retains exact
glyph clusters, advances, ink bounds, font identities and substitution
diagnostics.

The implemented line semantics include hard Unicode paragraph breaks, spaces,
zero-width break opportunities, fixed-width tabs and discretionary soft
hyphens. OpenType features, language, script, direction and explicit fallback
faces are part of the cache key. Layout and font-coverage cache mutations commit
only after a request succeeds; byte, grapheme, span, shaping, glyph, line,
cache and work-unit limits fail closed.

`document::Document::paginate_text` places shared-layout lines into explicit
section page geometry and preserves UTF-8 plus UTF-16 source anchors.
`presentation::RichText::layout_frame` places shared paragraphs in fixed EMU
frames with deterministic vertical alignment and explicit overflow. The first
slice intentionally rejects document tables/list markers/justification and
presentation justification. It reports presentation overflow instead of
inventing margins or auto-fit. Dictionary hyphenation, vertical writing,
headers/footers and full Office pagination remain future semantic work.

`RetainedRenderScene` converts layouts into immutable glyph commands indexed by
sparse viewport tiles. Versioned, checksummed tile and patch envelopes are
canonical and bounded. Renderers validate both the 128-bit face id and full
SHA-256 asset hash before building a native, Canvas or WebGPU glyph atlas.

## Verify

```bash
cargo test --manifest-path packages/artifact-tool/kernel/Cargo.toml
cargo bench --manifest-path packages/artifact-tool/kernel/Cargo.toml --bench kernel
cargo bench --manifest-path packages/artifact-tool/kernel/Cargo.toml --bench text_layout
OPENGENI_ARTIFACT_BENCH_PINNED=1 bun --cwd packages/artifact-tool run bench:release
```

The dependency-free benchmark is intentionally a normal executable rather than
a benchmark-framework contract. It exercises dense command ingestion, sparse
tile lookup, deterministic snapshot encode/decode, random edits over one
million dense cells, and repeated collaboration edits over a one-million-cell
causal model. The pinned release runner isolates memory fixtures, captures
allocator/RSS/WASM-heap facts, builds a fresh WASM adapter, and reads every gate
from `bench/budgets.json`.
