# Durable document API

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
`request`, alongside `artifactId` and `modality: "document"`.

```js
import { openGeni } from "@opengeni/codemode";

const document = await openGeni.artifacts.create("document", "Quarterly review");
const summaryResult = await document.inspect({ kind: "summary" });
const summary = summaryResult.projection.items[0];
if (summary?.kind !== "summary") throw new Error("Document summary is unavailable");

const paragraphId = openGeni.artifacts.ids.document("paragraph", summary.idNamespace);
await document.apply([
  {
    kind: "paragraph.add",
    target: { kind: "body" },
    id: paragraphId,
    runs: [
      { text: "Recommendation: ", style: { bold: true } },
      { text: "ship the reviewed plan.", style: {} },
    ],
    style: { headingLevel: 1, keepNext: true },
  },
]);

await document.inspect({
  kind: "body",
  startBlock: 0,
  limits: { maxItems: 200, maxTextUtf16: 100000, maxTableCells: 10000 },
});
```

To continue an existing session document, bind the current list result instead
of creating a file or guessing an id:

```js
const candidates = (await openGeni.artifacts.list()).filter(
  (artifact) => artifact.modality === "document",
);
if (candidates.length !== 1) throw new Error("Select the intended document first");
const document = openGeni.artifacts.use(candidates[0]);
await document.inspect({ kind: "summary" });
```

JSON output normalizes kernel `bigint` values to decimal strings. The id helper
accepts that string directly. Generate each new object id once and reuse it only
for that object.

## Queries

- `{ kind: "summary" }`
- `{ kind: "body", startBlock, limits }`
- `{ kind: "sections", startSection, limits }`
- `{ kind: "review", startItem, limits }`
- `{ kind: "story", sectionId, storyKind: "header" | "footer", variant:
  "default" | "first" | "even", startBlock, limits }`

`limits` is `{ maxItems, maxTextUtf16, maxTableCells }`. Page through using the
returned `nextCursor`; do not request an unbounded document.

## Commands

One apply accepts an ordered atomic array of:

- `document.flags.set`: `evenAndOddHeaders?`, `trackRevisions?`
- `paragraph.add`: `target`, new `id`, `runs`, `style`
- `paragraph.edit`: existing `id`, UTF-16 `range`, `replacement`, and required
  nullable run `style`
- `paragraph.format`: existing `id`, `range`, nullable style patch fields
- `paragraph.style.set`: existing `id`, paragraph `style`
- `table.add`: `target`, new `id`, `rows`, table `style`
- `table.style.set`: existing `id`, table `style`
- `page-break.add`: new `id`
- `section.add`: new section/header/footer ids, page geometry, `titlePage`
- `section.title-page.set` and `section.page.set`
- `comment.add`, `comment.reply.add`, `comment.resolved.set`
- `tracked-change.add`

Targets are `{ kind: "body" }` or `{ kind: "section", sectionId, storyKind,
variant }`. Text runs are `{ text, style }`. Use inspected ids for edits.

The exact shared value shapes are:

```ts
type TextStyle = {
  fontFamily?: string;
  fontSizePt?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};
type ParagraphStyle = {
  headingLevel?: number;
  alignment?: "left" | "center" | "right" | "justify";
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineHeight?: number;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  list?: { kind: "bullet" | "number"; level: number | null; instanceId: string | null };
};
type TableStyle = {
  widthPt?: number;
  columnWidthsPt?: number[];
  headerRows?: number;
  cellPaddingPt?: number;
  borderColor?: string;
  headerFill?: string;
  allowRowSplit?: boolean;
};
type PageGeometry = {
  widthPt: number;
  heightPt: number;
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  headerPt?: number;
  footerPt?: number;
  gutterPt?: number;
};
```

`paragraph.format.style` uses the `TextStyle` keys with values nullable to
remove an existing property. `table.add.rows` is
`TextRun[][][]` (rows → cells → runs). The less-obvious exact commands are:

```js
{ kind: "page-break.add", id }
{ kind: "section.add", ids: {
  section, headerDefault, headerFirst, headerEven,
  footerDefault, footerFirst, footerEven,
}, page, titlePage }
{ kind: "section.title-page.set", id, titlePage: boolean | null }
{ kind: "section.page.set", id, page }
{ kind: "comment.add", id, paragraphId, range, resolved,
  root: { author, text, createdAt } }
{ kind: "comment.reply.add", id,
  reply: { author, text, createdAt } }
{ kind: "comment.resolved.set", id, resolved }
{ kind: "tracked-change.add", id, paragraphId, range,
  changeKind: "insert" | "delete", author, createdAt }
```

Timestamps are ISO strings. Every required field shown above must be present;
do not infer alternate aliases.

## Import and export boundaries

Import a ready workspace DOCX directly:

```js
const document = await openGeni.artifacts.import(fileId, "document", "Imported report");
```

Export pins an immutable head and eventually returns a workspace file:

```js
const job = await document.export("docx");
const deadline = Date.now() + 300_000;
let status = await job.status();
while (status.state === "pending" || status.state === "running") {
  if (Date.now() >= deadline) throw new Error("document export timed out");
  await Bun.sleep(500);
  status = await job.status();
}
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone DOCX work

Only when the user explicitly needs sandbox-local bytes and
`$OPENGENI_ARTIFACT_TOOL_ENTRY` is present, import that absolute pinned entry
and use `Document`/`DocumentFile`. Never guess, install, or substitute another
runtime. If the entry is absent, stay on the durable artifact surface and use
workspace import/export boundaries. A standalone result becomes shared work
only after upload and `opengeni__editable_artifact_import`.
