# Document API

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
const { Document, DocumentFile, DocumentTextRun } = await import(
  pathToFileURL(artifactEntry).href,
);
```

## Create and export

```js
const document = Document.create();
document.blocks.addHeading("Quarterly review", 1);
document.blocks.addParagraph([
  new DocumentTextRun("Recommendation: ", { bold: true }),
  new DocumentTextRun("ship the reviewed plan."),
]);

const structure = await document.inspect({ kind: "document,section,paragraph,table" });
const preview = await document.render({ format: "png", scale: 2 });
await preview.save("document-preview.png");
const output = await DocumentFile.exportDocx(document);
await output.save("review.docx");
```

Use `document.sections`, section header/footer stories, real paragraph/list
styles, `document.comments`, and `document.changes` rather than encoding
structure in text. Use `document.batch(draft => { ... })` for many sequential
block/object mutations; it reconciles native state once. Use
`document.help("feature")` for one targeted API lookup.

## Existing files

```js
const document = await DocumentFile.importDocx(inputBlob);
```

Import is bounded and intentionally fails on unsupported fidelity-bearing
features. Inspect and render before editing; preserve the source file separately.
