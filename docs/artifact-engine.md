# Editable artifact engine

> Status: architecture contract and implementation roadmap. Code remains the
> final authority. This subsystem is separate from static published HTML
> artifacts, retained evidence artifacts, and document-ingestion/RAG.

## 1. Product contract

OpenGeni agents and embedded applications must be able to create, inspect,
edit, calculate, render, collaborate on, and export spreadsheets,
presentations, and documents without Microsoft Office being installed. Agent
scripts and React editors operate on the same canonical model.

The authoring facade is `@opengeni/artifact-tool`. Its stable surface follows
the workflows documented by OpenGeni's Spreadsheet, Presentation, and Document
skills: `FileBlob`, `Workbook`, `SpreadsheetFile`, `Presentation`,
`PresentationFile`, bulk range writes, stable object ids, `inspect`, `help`,
`trace`, render, and Office import/export. Compatibility is behavioral; no
private runtime is a dependency.

An Office file is an import/export representation. It is never the mutable
source of truth after import.

## 2. System shape

```text
agent scripts       @opengeni/react/artifacts       host application
      \                       |                         /
       +------ @opengeni/artifact-tool facade --------+
                              |
                   versioned command protocol
                              |
                 OpenGeni artifact kernel (Rust)
              native N-API             browser WASM
             import/export,             edit, calc,
             render, jobs               layout, inspect
                       \                /
                        canonical model
                              |
                    operation/snapshot codec
                              |
       Postgres authority -- NATS fanout -- object storage bytes
```

The TypeScript reference model behind the facade is an executable API sketch
and development conformance harness. It is not a production semantic fallback:
production fails closed when a compatible native/WASM kernel is unavailable.
Workers load the native kernel and browsers load the same kernel compiled to
WASM. The facade owns feature negotiation so callers do not depend on a
specific kernel target.

## 3. Package and service boundaries

| Boundary | Owns | Must not own |
| --- | --- | --- |
| `@opengeni/artifact-tool` | Stable JS handles, validation, batching, feature negotiation, file facade | Persistence, auth, product UI |
| Artifact Rust kernel | Canonical models, formulas, layout, codecs, render commands, operation merge | Tenant access, network transport |
| `@opengeni/sdk/editable-artifacts` | Typed HTTP/binary-live client, reconnect, version/materialization methods | Model implementation, React |
| `@opengeni/react/artifacts` | Virtualized editors/viewers, presence, selection, comments, export UX | API routing, durable truth |
| `@opengeni/core/editable-artifacts` and `./editable-artifact-live` | Access, authoritative kernel apply, lifecycle, idempotency, version/materialization and durable-live policy | HTTP or UI |
| `@opengeni/db/editable-artifacts` | RLS-scoped artifact persistence adapter, CAS commits, snapshots, receipts, durable outbox | Domain policy, kernel semantics |
| `apps/api` | Authenticated HTTP and binary-live adapters | Model/domain decisions |
| `apps/worker` | Bounded import/export/render/snapshot jobs | Canonical user-edit authority |
| `apps/web` and demo | Route composition and product framing | Reimplementation of SDK/editor behavior |

Agent-authored `.mjs` runs in the existing sandbox and imports the public
package. The API never evaluates agent JavaScript. Managed sandbox images
receive the exact package version paired with the skill documentation; custom
sandboxes use a bounded setup helper. Completed outputs enter OpenGeni through
the ordinary authenticated file/artifact APIs.

## 4. Canonical models

Every object has a collision-safe 128-bit id generated offline: a persisted
cryptographically random 64-bit replica namespace plus a monotonic 64-bit local
counter. Collections preserve explicit order.
Styles, strings, colors, formulas, images, and fonts are interned. Mutations are
atomic command batches with a causal base and an authored transaction id.

The wire layers have one authority each and must not duplicate identity fields:

- `OGATX001` is the sole authored mutation envelope. It binds artifact,
  client-transaction and replica identity, authored causal base, predecessor,
  selective-undo targets, protocol versions, and one canonical modality-command
  payload.
- The nested modality-command payload contains typed editing commands and
  structural preconditions only. It contains no actor, artifact, transaction,
  delivery sequence, or causal frontier that could disagree with `OGATX001`.
- The authoritative server derives the committed-operation envelope after
  validation. It carries derived transaction/operation ids, the one causal dot,
  resolved base/resulting frontier, canonical typed operation bytes, and the
  exact prior/resulting canonical state hashes. Replay verifies both hashes, so
  host routing metadata cannot silently describe a different state chain.
- `OGAKC001` is a private native/WASM command ABI. It is never persisted or
  accepted as client-authored durable truth.

Every boundary canonicalizes and compares exact bytes. Legacy envelopes that
embed a second actor/base are rejected rather than reconciled by precedence.

### 4.1 Spreadsheet

- A sheet is a sparse map of 256 × 256 tiles. Empty tiles do not exist.
- A tile stores compact typed cell columns: value tag, scalar/string id,
  formula id, style id, comment id, and flags.
- Formula source is parsed once into an arena AST. References compile into a
  dependency DAG; edits dirty only reachable dependants.
- Recalculation is topologically partitioned and parallel where dependencies
  allow it. Volatile functions occupy an explicit volatile partition.
- Dynamic arrays own a spill region; spill children point to the anchor and are
  never serialized as independent formulas.
- Rows, columns, tables, names, validations, conditional formats, drawings,
  comments, and merges are first-class objects—not cell-format conventions.
- Charts reference formula-backed source ranges and share the presentation
  chart scene model.

### 4.2 Presentation

- Masters, layouts, and slides are distinct inherited scene graphs.
- Shapes, rich text, charts, tables, connectors, groups, media, and notes keep
  stable ids and local overrides.
- Geometry uses integer document units internally. Conversion to pixels/EMU is
  isolated at rendering and OOXML boundaries.
- An R-tree provides hit testing, marquee selection, and viewport culling.
- Text frames use the shared shaping/layout engine and preserve overflow,
  autofit, placeholder, and language direction semantics.

### 4.3 Document

- Sections contain a structured block tree: paragraphs, lists, tables,
  figures, fields, notes, headers, and footers.
- Inline text uses a rope/sequence structure; marks and tracked changes are
  interval annotations anchored to stable positions.
- Styles, numbering definitions, section geometry, table grids, comments,
  footnotes/endnotes, fields, and relationships remain first-class.
- Pagination derives from content + style + font registry. Page coordinates
  are a render product, not persisted editing authority.

## 5. Layout and rendering

One deterministic layout kernel serves native and WASM builds.

- Font registry resolution is explicit and hashed. Missing fonts produce a
  visible substitution diagnostic, never silent platform-dependent layout.
- HarfBuzz-compatible shaping, Unicode bidi, line breaking, hyphenation, and
  fallback selection are shared across all modalities.
- The kernel emits compact retained render commands grouped into spatial tiles.
- Browser editors replay commands through Canvas/WebGPU and overlay accessible
  DOM controls for active text/selection.
- Native workers rasterize the same commands with Skia to PNG/WebP/PDF.
- Layout caches key on model revision, object/style/font hashes, viewport, and
  locale. A local edit invalidates only affected objects/pages/tiles.
- Visual exports embed deterministic metadata and never depend on a locally
  installed Office application.

## 6. Office codecs and fidelity

The kernel owns bounded ZIP, XML, relationship, style, and media codecs for
XLSX, PPTX, and DOCX. Codecs map OOXML into the canonical model plus a
loss-preservation envelope.

The envelope retains safe unknown parts, content types, relationship edges,
and original ids. Export regenerates modeled parts and copies unchanged safe
parts. Unsupported modeled content is reported during import and inspection;
it is never silently dropped while claiming a lossless edit.

Macro-enabled inputs, OLE objects, external data connections, remote templates,
external relationships, embedded executables, and active content are
quarantined. They may be retained as inert opaque parts only under explicit
policy and are never executed, fetched, or rendered as trusted content.

Codec limits are mandatory before allocation:

- compressed bytes, total expanded bytes, per-entry bytes, entry count,
  compression ratio, nested archive depth;
- XML depth, attributes, text bytes, entity/doctype rejection, relationship
  count and target policy;
- image dimensions/decoded bytes, font bytes/count, sheet/cell/object count,
  formula length/AST nodes, and render pixels/time.

## 7. Collaboration and undo

Collaboration uses modality-aware operations rather than synchronizing one
large JSON object.

- Text and ordered collections use sequence CRDT operations.
- Scalar properties and cell contents use causal last-writer registers.
- Geometry, range writes, style applications, and table/layout changes are
  atomic multi-object transactions.
- Deletes are tombstoned until every retained causal frontier passes them.
- Undo is selective: it targets authored operation ids and reverses their
  still-visible contribution. It never submits an ordinary inverse write that
  can overwrite later concurrent work.
- Presence, cursors, viewport, and transient selection are ephemeral and never
  enter the durable operation log.
- Every causal operation owns a dot `(replicaId, counter)`; wall-clock time is
  never conflict authority. Server sequence orders delivery only.
- Agent transactions carry the same actor/base-vector semantics as humans.
  Concurrent changes merge; a structural precondition conflict returns a typed
  conflict instead of overwriting or silently rebasing.

## 8. Durable data and live transport

Postgres remembers; NATS transports. The artifact path follows the repository's
existing invariant but does not put high-rate edit traffic into session SSE.
The API applies and validates every mutation through its authoritative native
kernel before committing it; clients never author canonical operation bytes or
state transitions by themselves.

Names are distinct and must never collapse into one overloaded "version":

- `headSequence`: monotonic PostgreSQL delivery order;
- `causalFrontier`: semantic CRDT causality;
- `snapshotCoverage`: exact sequence/frontier reconstructed by a snapshot;
- `versionId`: immutable user-visible checkpoint;
- model schema, operation protocol, codec, kernel, font-registry, and policy
  versions: independent compatibility/materialization inputs.

Durable records:

- `editable_artifacts`: workspace identity, modality, title, current snapshot
  and operation frontier, lifecycle state;
- `editable_artifact_transactions`: one authoritative transaction header,
  derived actor/attempt authority, request hash, sequence interval, causal base
  and resulting frontier/state hash;
- `editable_artifact_operation_segments`: bounded binary segments belonging to
  one transaction;
- `editable_artifact_snapshots`: immutable content-addressed model snapshot,
  full CRDT state (dots, vectors, tombstones, selective-undo metadata), covered
  sequence/frontier, kernel/schema version, byte facts;
- `editable_artifact_versions`: immutable named/pinned user checkpoints;
- `editable_artifact_materialization_jobs` and results: immutable
  XLSX/PPTX/DOCX/PDF/render work;
- `editable_artifact_blob_refs`, live outbox, replica leases, and idempotency
  receipts for create/import/edit/snapshot/materialize operations.

Every table carries account/workspace composite foreign keys, FORCE RLS,
bounded binary facts, and least-privilege reviewed runtime grants. Immutable
history tables reject update/delete outside explicit maintenance boundaries.

Large snapshot, original import, media, and materialization bytes live in object
storage. Database rows contain opaque object references plus size/SHA-256/MIME;
public responses never expose buckets or keys.

An authenticated binary WebSocket carries committed operation batches and
ephemeral presence. The commit transaction also inserts a live-outbox row; a
dispatcher retries NATS publication. WebSocket servers periodically reconcile
the durable artifact head and reconcile immediately after NATS reconnect, so a
lost final notification cannot leave a client stale forever. Session SSE
receives only bounded metadata such as artifact created, version published,
export ready, or failed.

Live bootstrap subscribes to NATS before reading the durable head, retains only
the newest target sequence while replaying, and then delivers contiguous
transactions. Replay and socket queues are bounded by count and bytes. A slow
or expired client receives `resync_required` and reloads a verified snapshot;
the cursor advances only after the local kernel applies a transaction. Presence
uses a separate ephemeral, rate-limited, TTL-bound channel.

Snapshot publication freezes an exact sequence, reconstructs deterministically,
uploads content-addressed bytes, reads/hash/decode-verifies them, and publishes
through a forward-only CAS. Old operations disappear only when verified
snapshots and every pinned version remain reconstructible and no active replica
lease needs the causal history. Expired replicas must full-resync. Orphan bytes
are swept separately.

Artifact creation uses the same authority boundary at sequence zero. The public
create request contains only client semantics (idempotency key, modality, and
title), never a state hash, snapshot bytes, or kernel/schema versions. A trusted
native-kernel adapter creates the canonical empty full-CRDT snapshot; bounded
storage streams it to an immutable content-addressed object and streams it back
for an independent size/SHA-256/version check. The ordinary snapshot verifier
then reconstructs it before one database transaction publishes the artifact,
checkpoint zero, snapshot/blob reference, creation receipt, and live outbox.
Competing idempotent creators may produce orphan candidates, but only the
advisory-lock winner becomes durable and retries return that winner.

## 9. Import, edit, and export flows

### Create

1. The authenticated caller submits only canonical client semantics (modality,
   title, and an idempotency key); it cannot supply a state hash or snapshot.
2. After create authorization, the trusted native genesis factory produces the
   canonical empty model bytes and version facts. An immutable bounded writer
   uploads them, then an independent ranged read verifies size, SHA-256,
   canonical decode, embedded boundary, and state hash.
3. One DB transaction resolves create idempotency and publishes artifact,
   sequence-zero checkpoint, blob facts, verified genesis snapshot/current
   snapshot, creation receipt, and compact snapshot outbox event at the same
   positive authorization revision.
4. The request hash binds only canonical client semantics. Generated snapshot
   facts belong to the winning receipt; identical concurrent retries may have
   produced different temporary bytes and must replay the winner rather than
   conflict. Unreferenced uploads are swept separately.

### Import

1. Client uploads bytes through the existing file API.
2. Core creates an idempotent import job bound to exact file digest and policy.
3. Worker parses in a bounded isolated process and uploads canonical snapshot.
4. A single transaction publishes artifact + snapshot + diagnostics.
5. SDK reconciles the artifact and opens live sync from snapshot frontier.

### Edit

1. Browser/agent validates commands locally and submits a stable replica id,
   transaction id, request hash, causal base, and typed commands—not trusted
   canonical operation bytes.
2. Server derives principal or exact live session/turn/attempt/generation
   authority and reads a consistent detached basis: head sequence, causal
   frontier, state hash, snapshot/tail references, and authorization revision.
3. `(artifact, actor, transactionId)` with the same request hash replays its
   receipt; a different hash conflicts.
4. Outside any database transaction, the authoritative native kernel validates
   structural preconditions and applies the complete transaction atomically.
5. One short DB transaction compares the exact detached basis (including the
   authorization revision), appends header + bounded segments, advances head
   sequence, causal frontier and state hash, and inserts receipt + live-outbox
   row. A stale basis is recomputed against the new head within a strict retry
   budget; permission changes fail rather than rebase.
6. Dispatcher publishes only after commit; clients apply contiguously or
   gap-fill. Unknown mutation outcomes retry the same transaction id and hash.

### Export

1. Client requests format for an immutable artifact frontier.
2. Existing matching materialization returns immediately.
3. Otherwise a content-addressed worker job loads snapshot + tail operations,
   exports and verifies bytes, then publishes the materialization exactly once.
4. Download uses the existing authenticated file/object-storage boundary.

Materialization uniqueness is the complete tuple `stateHash + format +
normalized optionsHash + codecVersion + kernelVersion + fontRegistryHash +
policyHash`. Publication is idempotent; duplicate computation after a crash is
allowed. Large artifact paths require bounded streaming/range object-storage
methods rather than whole-buffer reads.

## 10. Authorization, SDK, and deployment

- Editable-artifact permissions are least-privilege `read`, `edit`, `import`,
  `export`, and `manage`; static HTML publication permissions are not reused.
- An `ArtifactAuthorizationPort` lets embedded hosts enforce per-artifact
  sharing. WebSockets reauthorize periodically, on every mutation, and on
  permission invalidation.
- Browsers connect with an HTTP-minted, short-lived, artifact-scoped ticket;
  durable bearer tokens and object keys never enter query strings.
- Native parsing/rendering runs in isolated, no-network subprocesses with CPU,
  memory, output, and crash boundaries. N-API faults cannot kill API/turn
  workers.
- The browser kernel runs in a dedicated Web Worker. One ref-counted SDK sync
  controller/socket owns each open artifact. IndexedDB retains verified
  snapshot, applied cursor, and pending idempotent transactions.
- WASM/worker asset URLs are configurable for CSP, CDN, and self-hosting. Kernel
  payloads split by model/calc, layout/render, and modality codec rather than
  one mandatory download.
- Live handling is transport-neutral with Bun/Node/edge adapters; `createApp()`
  is not assumed to own portable WebSocket upgrades.
- Heavy artifact work has a dedicated Temporal task queue and worker deployment,
  separate from turn/control workers. Rolling deployment is schema → artifact
  workers/outbox → API/live adapters → SDK/React. Mixed-version handshakes fail
  read-only/unsupported, never silently change semantics.
- Platform-native packages cover Linux glibc/musl x64/arm64, macOS x64/arm64,
  and Windows x64; browser WASM remains separate and lazy.

### Runtime placement

| Placement | Model runtime | Durable/local state | Distribution contract |
| --- | --- | --- | --- |
| Managed or self-hosted agent sandbox | Linux native Rust binding in the pinned sandbox image; isolated native subprocess for codecs/render | Output buffers and bounded scratch only; durable publication goes through authenticated artifact APIs | Sandbox image pins the matching skill, JS facade, native package, codec/kernel/font versions, and checksums |
| Self-hosted API/artifact worker on Linux | Exact glibc or static-musl x64/arm64 native package | PostgreSQL authority plus configured S3-compatible object storage; NATS/Temporal are transport/work scheduling, never truth | Platform resolver selects an exact optional package and fails closed when absent or incompatible |
| Self-hosted API/artifact worker on macOS | Exact macOS x64/arm64 native kernel package; production materialization currently fails closed because no production sandbox launcher is shipped | Local development only may opt into an explicitly unsandboxed subprocess against loopback PostgreSQL/object storage; health reports `sandboxEnforced: false` | Canonical current-host development manifest with exact receipt/file hashes; rejected in production and never relabeled as production authority |
| Self-hosted API/artifact worker on Windows | Exact Windows x64 native kernel package; production materialization currently fails closed because no production sandbox launcher is shipped | Same PostgreSQL/object-storage contracts once a native production launcher exists | Signed/checksummed package selected by OS/architecture; no Office/COM dependency |
| Any supported browser on those hosts | The same Rust source compiled to `wasm32`, loaded once in a dedicated Web Worker | Verified snapshot/tail and pending exact intents in IndexedDB; canonical state remains Worker-owned | Lazy same-origin/configured CDN assets: Worker entry, paired JS glue, `.wasm`, and exact operation mapper identity |

The browser path is not a reduced semantic implementation. Native and WASM
share model/protocol corpora and build identity; platform differences are only
resource ceilings and host adapters. A browser may edit against a remote or a
self-hosted control plane identically. Persistent desktop installation is not
required for browser editing, while local/self-hosted workers use native code
to avoid WASM memory ceilings and accelerate large import/render jobs.

## 11. Performance budgets

Budgets are release gates, measured on pinned representative hardware and
reported with fixture/kernel/font versions.

| Operation | Initial budget |
| --- | ---: |
| Create workbook + one sheet | p95 < 5 ms |
| Bulk-write 100,000 primitive cells | p95 < 100 ms |
| Recalculate 100,000 simple dependent formulas after one input edit | p95 < 50 ms |
| Scroll/pan editor after warm layout | p95 frame < 16.7 ms |
| Apply and display remote operation | p95 < 50 ms excluding network |
| Import 25 MB ordinary XLSX/PPTX/DOCX | p95 < 2 s, bounded peak memory |
| Render one ordinary sheet/slide/page at 2× | p95 < 100 ms after warm fonts |
| Export unchanged imported artifact | byte-preserving safe parts; p95 < 2 s at 25 MB |

Fixtures also cover sparse million-row sheets, 100k-formula graphs, 500-slide
decks, 1,000-page documents, large images, RTL/CJK/emoji, and intentionally
hostile archives. Budgets may tighten; regressions require explicit evidence.
The browser-facade budget walks the emitted entry point and every recursively
referenced static ESM import; dynamically imported codec/render chunks are not
startup bytes. The benchmark also reports and sanity-caps the complete emitted
install closure, so code splitting cannot conceal unbounded optional growth.
The complete optional document/spreadsheet/presentation codec closure is capped
at 896 KiB raw / 280 KiB gzip and 24 emitted chunks; none of those bytes may
enter the 320 KB raw / 100 KB gzip eager facade budget.
Browser editors load one capability-scoped kernel, never the 1.8 MiB all-tools
kernel: document and presentation are each capped at 350 KB raw / 120 KB gzip;
the formula/collaboration spreadsheet kernel at 700 KB raw / 230 KB gzip. The
complete native-parity browser tool kernel is separately capped at 2 MiB raw /
700 KB gzip and is loaded only by callers that request its combined surface.
Pinned native memory fixtures run in separate processes and report allocator
bytes, peak live bytes, and resident-set deltas. The browser benchmark reports
the actual WebAssembly linear-memory size alongside edit, fork, state-hash, and
binary-size gates; JavaScript render runs report heap, RSS, and external-memory
deltas. This prevents a fast timing result from hiding a full-model clone or an
unbounded native/WASM allocation.

## 12. Verification gates

1. **Facade conformance:** execute every supported code pattern from the three
   OpenGeni skills against TypeScript, native, and WASM backends.
2. **Differential model tests:** identical command streams produce identical
   canonical snapshots, inspection records, formula values, and operation ids.
3. **OOXML round trips:** import → inspect → edit → export → re-import and compare
   semantic structure, formulas, styles, comments, inheritance, and safe unknown
   parts. Unchanged fixtures additionally compare preserved package parts.
4. **Visual goldens:** render every sheet/slide/page, inspect montages, and run
   bounded pixel/perceptual diffs for affected fixtures.
5. **Office interoperability:** open generated files in LibreOffice and available
   Microsoft Office canaries; re-save/re-import selected fixtures.
6. **Formula suite:** value/error/array/date/locale/precedent cases, randomized
   dependency graphs, cycle and volatile-function behavior.
7. **Collaboration algebra:** operation permutation, duplication, delay, offline
   replay, concurrent delete/edit, undo, reconnect, snapshot compaction, and
   deterministic convergence.
8. **Security fuzzing:** ZIP/XML/media/formula parsers, relationship graphs,
   binary operation decoder, decompression and allocation limits.
9. **Performance:** criterion/native plus browser benchmarks enforce the budgets
   above and capture CPU, allocations, peak RSS, WASM heap, and artifact bytes.
10. **Product E2E:** agent skill creates artifact → React edits → reconnects →
    publishes version → exports → re-imports. Run in React demo and `apps/web`.

No modality is labeled production-ready until its conformance, round-trip,
visual, security, collaboration, performance, and product E2E gates pass.

## 13. Delivery order

1. Freeze facade capability matrix, binary protocol, CRDT semantics, threat
   model, naming, and DB state machine; build the TypeScript API sketch.
2. Land the minimal Rust native/WASM spreadsheet kernel, loaders, differential
   properties, and performance harness.
3. Land persistence, authorization, idempotency, outbox, ticketed sync, SDK
   controller, browser worker, and one-cell end-to-end proof.
4. Complete spreadsheet calculation, rendering, XLSX codec, editor, and every
   security/collaboration/performance/demo gate; ship spreadsheet only then.
5. Add the shared scene/text/chart engine and presentation vertical slice.
6. Add the document tree/layout/comments/redlines vertical slice.

This ordering proves durability and collaboration inside the first complete
vertical slice rather than retrofitting them after public APIs harden.
