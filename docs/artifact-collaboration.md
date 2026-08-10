# Artifact collaboration

> Canonical product contract. This document defines how humans and agents work
> on one durable document, spreadsheet, or presentation. Office files are
> explicit import and export boundaries, never mutable shared state.

## One object, several clients

An editable artifact has one authoritative head in OpenGeni. Postgres owns its
identity, authorization, causal transaction log, receipts, and checkpoints;
object storage owns immutable snapshots, source imports, media, and exported
bytes. The Rust kernel is the only authority allowed to turn typed commands
into committed state.

React, direct model tools, and sandbox Codemode are clients of this same
application:

```text
React editor -- binary live protocol ----+
                                           |
model tools -- AttemptToolEnvironment -----+--> artifact application --> kernel --> Postgres
                                           |                              |          object storage
Codemode ---- same AttemptToolEnvironment --+
```

The model and Codemode paths share one frozen attempt catalog and one executor.
`openGeni.artifacts` is an authored convenience facade over those exact tools;
it owns no authorization, persistence, retry, or alternate editing logic.

## Agent surface

One first-party tool family is available when the exact attempt has artifact
permissions:

| Operation | Purpose |
| --- | --- |
| `editable_artifact_list` | Discover artifacts associated with the current session. |
| `editable_artifact_create` | Create an empty canonical document, spreadsheet, or presentation. |
| `editable_artifact_import` | Import a ready workspace DOCX/XLSX/PPTX file as a new canonical artifact. |
| `editable_artifact_get` | Read current identity, modality, title, head, and state hash. |
| `editable_artifact_inspect` | Run one bounded modality query against an exact current-head reconstruction. |
| `editable_artifact_apply` | Submit one atomic typed command batch fenced to the inspected head. |
| `editable_artifact_export` | Pin the exact head and enqueue DOCX/XLSX/PPTX/PDF/PNG/WebP materialization. |
| `editable_artifact_export_status` | Read export progress and, on success, obtain one durable workspace file receipt. |

All state-changing calls use durable idempotency. Every agent mutation uses a
fresh replica for that atomic transaction, so it never depends on process-local
writer state. Direct edits must carry the inspected head sequence and state
hash; CodeMode carries its cached read head automatically. The core checks that
fence before work and again after every commit race, so stale agent work never
silently rebases over human changes. Tool results contain bounded JSON metadata and file ids,
never snapshot bytes, object keys, platform credentials, or signed URLs.

Simple actions may call these tools directly. Complex work uses
`openGeni.artifacts` in a sandbox script for loops, batching, and intermediate
inspection without filling model context. Both routes execute the same tool
definitions.

## Files are boundaries

Office files are import/export representations only:

- Import starts with a ready workspace `fileId`. A trusted native runtime reads
  and verifies those bytes, creates one canonical sequence-zero snapshot, and
  publishes a new artifact.
- Export pins an exact artifact head, runs the durable materializer, copies the
  verified result into the workspace file store, and returns a `fileId` plus
  name, MIME, size, hash, artifact id, and source head.
- Export does not write into a sandbox. If code genuinely needs local bytes, it
  uses the existing Files tool to download that returned file.
- Re-import always creates a new artifact. It never overwrites another
  artifact or changes the meaning of an existing Office source.

The ordinary workflow edits the durable artifact directly. Local files remain
useful only when the user explicitly asks to ingest, deliver, or manipulate a
standalone file.

## Session and UI semantics

Every successful agent create, import, read, inspect, edit, or export associates
the artifact with that exact session after artifact authorization succeeds. The
session dock lists those associations and opens the same SDK/React editor used
by the full artifact route. “Used here” is not inferred from chat text or a
historical tool receipt.

Humans editing in React and agents editing through tools see the same committed
head. A tool inspection reports the exact `headSequence` and `stateHash` it
read; a successful mutation reports the new receipt. Live clients reconcile
through the existing durable outbox and binary protocol.

## Modality parity

The agent surface exposes only commands already implemented by the durable
command protocol. Missing features are explicit capability gaps, never an
excuse to switch mutable truth back to an Office file.

| Modality | Durable agent edits now | Explicit gaps |
| --- | --- | --- |
| Spreadsheet | sheet create/rename/delete, rectangular value/formula write, range clear; workbook metadata and bounded viewport inspection | styles, merges, dimensions, validation, comments, charts, drawings |
| Document | document flags; paragraph add/edit/format/style; table add/style; page breaks; sections/page geometry; comments/replies/resolution; tracked changes; summary/body/story/section/review inspection | fields, notes, figures/media, footnotes/endnotes, arbitrary block deletion/reordering |
| Presentation | masters/layouts/slides; titles/layout/notes; node insert/delete/move/bounds/transform/content; slide size; metadata/catalog/editor/resolved-slide/viewport inspection | animation/timing, executable media, arbitrary OOXML relationship editing |

Import may retain safe unsupported OOXML parts as inert fidelity data, but an
edit that would invalidate an unsupported part must fail closed. Export never
claims losslessness when the fidelity report says otherwise.

## Non-negotiable invariants

1. One durable artifact head; no file/artifact dual-write.
2. One attempt tool definition and executor for model and Codemode calls.
3. One authoritative kernel path for human and agent mutations.
4. Files cross the boundary by immutable `fileId` receipts only.
5. No implicit sandbox writes, Office UI automation, mutable signed URLs, or
   object-storage identities in model history.
6. Unsupported work fails with a typed, actionable error; it never switches to
   a second persistence path or best-effort compatibility mode.
