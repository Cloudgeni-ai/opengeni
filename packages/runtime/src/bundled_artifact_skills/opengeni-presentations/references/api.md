# Durable presentation API

## Direct tools and CodeMode

The direct tool family is `editable_artifact_list`, `editable_artifact_create`,
`editable_artifact_import`, `editable_artifact_get`, `editable_artifact_inspect`,
`editable_artifact_apply`, `editable_artifact_export`, and
`editable_artifact_export_status`. Complex work uses the authored facade over those same
calls:

Direct `editable_artifact_apply` calls require `expectedHeadSequence` and
`expectedStateHash` from the inspection that informed the edit. A mismatch is a
conflict: inspect again and recompute. The CodeMode facade carries this fence
automatically.

```js
import { openGeni } from "@opengeni/codemode";

const deck = await openGeni.artifacts.create("presentation", "Launch plan");
const slideId = openGeni.artifacts.ids.stable();
const titleId = openGeni.artifacts.ids.stable();
await deck.apply([
  {
    kind: "slide.create",
    id: slideId,
    index: 0,
    title: "Launch plan",
    layoutId: null,
    background: { kind: "solid", color: 0xffffffff },
  },
  {
    kind: "node.insert",
    owner: { kind: "slide", id: slideId },
    parentId: null,
    index: 0,
    node: {
      id: titleId,
      name: "Title",
      bounds: { x: 80, y: 70, width: 1120, height: 90 },
      transform: { rotation: 0, flipHorizontal: false, flipVertical: false },
      content: {
        kind: "shape",
        geometry: "text-box",
        fill: { kind: "none" },
        line: { fill: { kind: "none" }, width: 0, dash: "solid" },
        placeholder: null,
        text: {
          verticalAlignment: "middle",
          paragraphs: [{
            alignment: "left",
            runs: [{
              text: "Launch plan",
              style: {
                fontFamily: "Inter",
                fontSizeCentipoints: 3200,
                color: 0x111827ff,
                bold: true,
                italic: false,
                underline: false,
                language: "en-US",
              },
            }],
          }],
        },
      },
    },
  },
]);
```

Coordinates and slide size use the canonical presentation coordinate space;
inspect an imported deck before assuming its dimensions. Colors are unsigned
32-bit RGBA values.

## Queries

- `{ kind: "metadata", maxBytes }`
- `{ kind: "slide-catalog", startSlide, maxSlides, maxTextBytes, maxBytes }`
- `{ kind: "editor-slide", slideId, maxNodes, maxTextBytes, maxBytes }`
- `{ kind: "resolved-slide", slideId, maxNodes, maxBytes }`
- `{ kind: "viewport", owner, viewport, maxNodes, maxBytes }`
- `{ kind: "hit-test", owner, x, y, maxNodes, maxBytes }`

Page through catalogs using `nextSlide`. `editor-slide` is the normal complete
editing projection: slide facts, notes, inherited sources, ordered nodes,
bounds, transforms, and content.

## Commands

One apply accepts an ordered atomic array of:

- `master.create`, `layout.create`, `slide.create`
- `master.delete`, `layout.delete`, `slide.delete`
- `slide.title.set`, `slide.layout.set`, `slide.notes.set`
- `node.insert`, `node.delete`, `node.move`
- `node.bounds.set`, `node.transform.set`, `node.content.set`
- `presentation.size.set`

Node content kinds are `shape`, `group`, `connector`, `chart`, `table`, and
`media`. Preserve the inspected node content when changing only bounds or
transform. Never invent a media digest: media bytes must already exist in the
artifact's trusted blob domain.

## Import and export boundaries

```js
const deck = await openGeni.artifacts.import(fileId, "presentation", "Imported deck");
const job = await deck.export("pptx");
let status;
do {
  await Bun.sleep(500);
  status = await job.status();
} while (status.state === "pending" || status.state === "running");
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone PPTX work

Only for an explicitly local file boundary, locate the deployment-pinned
runtime, import its absolute `$OPENGENI_ARTIFACT_TOOL_ENTRY`, and use
`Presentation`/`PresentationFile`. Import only through that pinned entry. A
standalone result becomes shared work only after it is uploaded as a workspace
file and passed to `editable_artifact_import`.
