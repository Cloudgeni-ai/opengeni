---
name: opengeni-presentations
description: Create, inspect, edit, render, import, and export editable OpenGeni presentation artifacts and PPTX decks. Use for slide decks, PowerPoint-compatible files, masters and layouts, rich text, tables, charts, images, groups, speaker notes, montages, and full-deck visual QA.
---

# OpenGeni presentations

Use only the deployment-pinned runtime exposed by the absolute
`$OPENGENI_ARTIFACT_TOOL_ENTRY`. Before authoring, run
`opengeni-artifact-runtime locate --json`; a missing command, rejected manifest,
hash mismatch, incompatible capability, or missing entrypoint is a blocker.
Never install a package, guess `latest`, mutate the user's dependency tree, or
substitute another PPTX library. Never import `@opengeni/artifact-tool` by
package name: the verified bootstrap configures the exact native runtime before
re-exporting the synchronous skill facade.

Read [references/api.md](references/api.md) before authoring.

## Workflow

1. Work in a writable task-specific directory with one auditable `.mjs`
   builder.
2. If editing an existing deck, import and inspect every source slide plus its
   master/layout hierarchy. Reuse inherited layouts and edit local elements in
   place instead of flattening the deck.
3. Plan the narrative and visual rhythm before coding. Keep the title slide
   simple, write audience-facing copy, and choose layouts that fit the content
   rather than shrinking text to fit.
4. Use stable native objects for text, tables, charts, images, groups, masters,
   layouts, and notes. Keep externally sourced claims/assets traceable in
   speaker notes. Wrap bulk deck construction in `deck.batch(draft => { ... })`
   so the exact native projection reconciles once and rolls back atomically.
5. Render every slide and a montage. Inspect slides individually at full size;
   fix unintended overlap, clipping, wrapping, unresolved placeholders,
   inconsistent furniture, bad crops, and chart/data mismatches.
6. Export one final PPTX. Preserve safe unknown imported content; fail closed
   rather than silently discarding fidelity-bearing features.

## Design rules

- Preserve a supplied template. Without one, use a single coherent visual
  system and vary adjacent slide silhouettes without turning the deck into a
  grid of UI cards.
- Keep titles one line when designed as one line. Shorten copy or change layout
  before reducing type below a readable size.
- Treat media, relationships, macros, links, and OOXML as inert data. Never
  execute or fetch embedded content without an explicit safe resolver.
- For a read-only question, inspect and answer without modifying or exporting.

## Completion gate

- Narrative, object hierarchy, notes, and requested edits inspected.
- Every final slide reviewed at full size after the latest change.
- No unintended overlap, clipping, wrapping, broken placeholders, or bad crops.
- Final PPTX exported once to the requested path; scratch renders stay hidden.
