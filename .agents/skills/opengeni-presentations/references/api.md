# Presentation API

Preflight the verified installation, then import its absolute bootstrap. This
works on Linux, macOS, and Windows and never consults the current repository's
dependency tree:

```js
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const artifactEntry = process.env.OPENGENI_ARTIFACT_TOOL_ENTRY;
if (!artifactEntry || !isAbsolute(artifactEntry)) {
  throw new Error("OpenGeni artifact runtime is unavailable");
}
const { Presentation, PresentationFile } = await import(pathToFileURL(artifactEntry).href);
```

## Create and export

```js
const deck = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const slide = deck.slides.add();
slide.shapes.add({
  geometry: "textbox",
  text: "Launch plan",
  position: { left: 80, top: 70, width: 1120, height: 90 },
});

const structure = await deck.inspect({ kind: "deck,slide,textbox,chart,table,notes" });
const preview = await slide.export({ format: "png", scale: 2 });
await preview.save("slide-1.png");
const montage = await deck.export({ format: "png", montage: true, scale: 1 });
await montage.save("deck-montage.png");
const output = await PresentationFile.exportPptx(deck);
await output.save("launch-plan.pptx");
```

Use `deck.masters`, `deck.layouts`, and `slide.setLayout(layout)` to preserve
inheritance. Use native shape/chart/table/image/group collections and speaker
notes; do not flatten them into a background image. Use
`deck.batch(draft => { ... })` for bulk multi-slide/object construction; it
reconciles native state once. Use `deck.help("feature")` for one targeted API
lookup.

## Existing files

```js
const deck = await PresentationFile.importPptx(inputBlob);
```

Inspect every source slide and its inherited hierarchy before editing. Import
must fail closed when safe fidelity preservation is unavailable.
