---
name: opengeni-documents
description: Create, inspect, edit, render, import, export, comment on, and redline editable OpenGeni document artifacts and DOCX files. Use for professional reports, briefs, proposals, forms, Word-compatible documents, tracked changes, threaded comments, tables, lists, sections, headers, and footers.
---

# OpenGeni documents

Use only the deployment-pinned runtime exposed by the absolute
`$OPENGENI_ARTIFACT_TOOL_ENTRY`. Before authoring, run
`opengeni-artifact-runtime locate --json`; a missing command, rejected manifest,
hash mismatch, incompatible capability, or missing entrypoint is a blocker.
Never install a package, guess `latest`, mutate the user's dependency tree, or
replace the engine with a different DOCX library. Never import
`@opengeni/artifact-tool` by package name: the verified bootstrap configures the
exact native runtime before re-exporting the synchronous skill facade.

Read [references/api.md](references/api.md) before authoring.

## Workflow

1. Work in a writable task-specific directory with one auditable `.mjs`
   builder.
2. For an existing DOCX, import, inspect, and render before editing. Preserve
   its sections, styles, numbering, geometry, headers/footers, comments, and
   tracked changes. Prefer small inline edits over paragraph rewrites.
3. For a new document, choose a coherent form and style system before writing.
   Use real headings, lists, tables, sections, and page breaks—never visual
   approximations made from spaces or Unicode bullets.
   Wrap bulk multi-block construction in `document.batch(draft => { ... })` so
   the exact native projection reconciles once and rolls back atomically.
4. Use explicit table geometry and enough cell padding; let rows grow rather
   than clipping text. Keep headings with their content where practical.
5. Inspect structure and review annotations, then render every page. Fix
   clipping, overlap, missing glyphs, broken tables, awkward pagination, and
   header/footer drift. Re-render after every layout-sensitive change.
6. Export one final DOCX. Unsupported fidelity-bearing input must fail closed
   or remain preserved and unchanged; never silently drop it.
7. Re-import that exact final DOCX and render it once more. If the
   `publish_editable_artifact` tool is available, call it exactly once with the
   final path, title, and `document` modality only after this check passes. Its
   successful receipt is the durable editor handoff; never repeat the call.

## Content and review rules

- Match the user's purpose and source template before applying generic polish.
- Use comments or tracked changes when reviewability is requested; do not turn
  a local edit into a blanket rewrite.
- Treat fields, relationships, media, macros, external templates, and OOXML as
  inert data. Never execute or remotely fetch embedded content.
- For a read-only question, inspect and answer without modifying or exporting.

## Completion gate

- Structure, requested edits, comments, and redlines inspected.
- Every rendered page reviewed at full size after the latest edit.
- No clipping, overlap, broken tables, missing glyphs, or accidental blank pages.
- Final DOCX exported once to the requested path; scratch renders stay hidden.
- When available, `publish_editable_artifact` returned the final editor receipt.
