# Durable presentation API

## Direct tools and CodeMode

The model-facing direct tool family is `opengeni__editable_artifact_list`,
`opengeni__editable_artifact_create`, `opengeni__editable_artifact_import`,
`opengeni__editable_artifact_get`, `opengeni__editable_artifact_inspect`,
`opengeni__editable_artifact_apply`, `opengeni__editable_artifact_export`, and
`opengeni__editable_artifact_export_status`. Complex work uses the authored
facade over those same calls:

Direct `opengeni__editable_artifact_apply` calls require `expectedHeadSequence` and
`expectedStateHash` from the inspection that informed the edit. A mismatch is a
conflict: inspect again and recompute. The CodeMode facade carries this fence
automatically.

For a direct `opengeni__editable_artifact_inspect` call, pass the query below as
`request`, alongside `artifactId` and `modality: "presentation"`.

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

To continue an existing session deck, bind the current list result instead of
creating a file or guessing an id:

```js
const candidates = (await openGeni.artifacts.list()).filter(
  (artifact) => artifact.modality === "presentation",
);
if (candidates.length !== 1) throw new Error("Select the intended deck first");
const deck = openGeni.artifacts.use(candidates[0]);
await deck.inspect({
  kind: "slide-catalog",
  startSlide: 0,
  maxSlides: 100,
  maxTextBytes: 100000,
  maxBytes: 1048576,
});
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
transform.

The exact shared value shapes are:

```ts
type Fill = { kind: "none" } | { kind: "solid"; color: number };
type Line = { fill: Fill; width: number; dash: "solid" | "dash" | "dot" };
type Rect = { x: number; y: number; width: number; height: number };
type Transform = { rotation: number; flipHorizontal: boolean; flipVertical: boolean };
type Owner = { kind: "master" | "layout" | "slide"; id: string };
type TextStyle = {
  fontFamily: string;
  fontSizeCentipoints: number;
  color: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  language: string | null;
};
type RichText = {
  paragraphs: Array<{
    alignment: "left" | "center" | "right" | "justify";
    runs: Array<{ text: string; style: TextStyle }>;
  }>;
  verticalAlignment: "top" | "middle" | "bottom";
};
```

Creation and insertion commands use these exact forms:

```js
{ kind: "master.create", id, name, background }
{ kind: "layout.create", id, name, masterId: string | null, background }
{ kind: "slide.create", id, index, title, layoutId: string | null, background }
{ kind: "node.insert", owner, parentId: string | null, index,
  node: { id, name, bounds, transform, content } }
```

The remaining mutation shapes are:

```js
{ kind: "master.delete" | "layout.delete" | "slide.delete", id }
{ kind: "slide.title.set", id, title }
{ kind: "slide.layout.set", id, layoutId: string | null }
{ kind: "slide.notes.set", id, notes: RichText }
{ kind: "node.delete", id }
{ kind: "node.move", id, newParentId: string | null, index }
{ kind: "node.bounds.set", id, bounds: Rect }
{ kind: "node.transform.set", id, transform: Transform }
{ kind: "node.content.set", id, content }
{ kind: "presentation.size.set", size: { width, height } }
```

`content` is exactly one of:

```js
{ kind: "shape", geometry: "text-box" | "rectangle" | "rounded-rectangle" |
  "ellipse" | "triangle" | "right-arrow" | "line",
  fill, line, text: RichText | null,
  placeholder: { kind: string, index: number | null } | null }
{ kind: "group", childOffsetX, childOffsetY, childExtentWidth,
  childExtentHeight, children: string[] }
{ kind: "connector", connectorKind: "straight" | "elbow" | "curved",
  start: { nodeId: string | null, x, y },
  end: { nodeId: string | null, x, y }, line }
{ kind: "chart", chartType: "bar" | "line" | "area" | "pie" |
  "doughnut" | "scatter" | "bubble" | "radar", title: RichText,
  series: Array<{ name, categories: string[], values: number[],
    xValues: number[], bubbleSizes: number[] }>, hasLegend }
{ kind: "table", rows: Array<Array<null | {
  text: RichText, fill, rowSpan, columnSpan
}>>, columnWidths: number[], rowHeights: number[], line }
```

The current agent surface cannot upload new presentation media. Do not author
or replace a `media` node, and never invent a digest; imported media remains
preserved when using structural, bounds, transform, and unrelated edits.

## Import and export boundaries

```js
const deck = await openGeni.artifacts.import(fileId, "presentation", "Imported deck");
const job = await deck.export("pptx");
const deadline = Date.now() + 300_000;
let status = await job.status();
while (status.state === "pending" || status.state === "running") {
  if (Date.now() >= deadline) throw new Error("presentation export timed out");
  await Bun.sleep(500);
  status = await job.status();
}
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone PPTX work

Only when the user explicitly needs sandbox-local bytes and
`$OPENGENI_ARTIFACT_TOOL_ENTRY` is present, import that absolute pinned entry
and use `Presentation`/`PresentationFile`. Never guess, install, or substitute
another runtime. If the entry is absent, stay on the durable artifact surface
and use workspace import/export boundaries. A standalone result becomes shared
work only after upload and `opengeni__editable_artifact_import`.
