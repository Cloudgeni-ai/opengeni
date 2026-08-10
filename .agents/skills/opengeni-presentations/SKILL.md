---
name: opengeni-presentations
description: Create, inspect, edit, import, and export durable OpenGeni presentation artifacts and explicit PPTX file boundaries. Use for decks, slides, masters, layouts, rich text, tables, charts, imported media, groups, notes, and visual presentation QA.
---

# OpenGeni presentations

The durable OpenGeni artifact is the default working deck. It is the same live
object the user sees in the Artifacts dock and slide editor. Never maintain a
mutable PPTX shadow or publish a sandbox deck over user edits.

Read [references/api.md](references/api.md) before editing.

## Choose the canonical object

- If the user means “this deck” or a visible presentation, call
  `opengeni__editable_artifact_list`, then `opengeni__editable_artifact_get`
  when needed. Do not guess from chat text.
- To begin empty, call `opengeni__editable_artifact_create` with modality `presentation`.
- To begin from a ready workspace PPTX, call `opengeni__editable_artifact_import`
  with its `fileId`.
  The source remains immutable provenance; the returned artifact becomes the
  working deck.
- Use a standalone local PPTX only when the user explicitly asks to manipulate
  sandbox-local bytes and the pinned local runtime is actually available.
  Normal import/export uses workspace `fileId` boundaries without local bytes.

## Edit and verify

1. Inspect metadata and the slide catalog. Before changing a slide, inspect its
   complete bounded editor scene, including inherited layout facts and notes.
2. Plan the narrative and visual system before creating many nodes. Preserve an
   imported master/layout hierarchy; do not flatten the deck.
3. Make the smallest coherent edit. One `opengeni__editable_artifact_apply`
   call is one atomic command batch. Use inspected ids for existing objects and
   `openGeni.artifacts.ids.stable()` for every new master, layout, slide, or
   node. A direct call must pass the inspected `headSequence` and `stateHash`;
   CodeMode carries its last read head automatically.
4. For one simple edit, call the artifact tools directly. For loops, generated
   ids, slide construction, or several inspections, write auditable Bun code
   using `openGeni.artifacts` from `@opengeni/codemode`. Both paths execute the
   exact same frozen tools and authorization.
5. Inspect every affected slide after mutation. Reconcile bounds, paint order,
   text, chart/table data, notes, and inheritance. If concurrent work invalidates
   an assumption, re-inspect and recompute; never force a stale rewrite.
6. Export only when the user needs PPTX/PDF/image delivery or visual QA.
   `opengeni__editable_artifact_export_status` returns a durable workspace
   `fileId`; it does not write into the sandbox. Download only when local bytes
   are actually needed.

## Design, fidelity, and safety

- Match the audience and source template. Prefer readable content and varied
  slide silhouettes over dense grids of UI cards.
- Treat media, macros, links, relationships, and OOXML as untrusted data. Never
  execute or remotely fetch embedded content without an explicit safe resolver.
- Durable presentation commands do not yet upload new media, author animations,
  or edit arbitrary OOXML relationships. Never hide a gap by changing mutable
  truth back to a local PPTX.
- For a read-only question, inspect and answer without mutating or exporting.

## Completion gate

- The requested result exists in the durable artifact, not merely a local file.
- Every affected slide scene and its notes/inheritance were inspected after the
  final edit; visual exports were reviewed when layout matters.
- Any requested export completed and its `fileId`, format, and pinned source
  head were reported.
- The user can continue from the same deck in the session Artifacts dock.
