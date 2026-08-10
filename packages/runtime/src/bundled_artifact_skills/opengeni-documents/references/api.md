# Durable document API

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
- `paragraph.edit`: existing `id`, UTF-16 `range`, `replacement`, optional run
  `style`
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

## Import and export boundaries

Import a ready workspace DOCX directly:

```js
const document = await openGeni.artifacts.import(fileId, "document", "Imported report");
```

Export pins an immutable head and eventually returns a workspace file:

```js
const job = await document.export("docx");
let status;
do {
  await Bun.sleep(500);
  status = await job.status();
} while (status.state === "pending" || status.state === "running");
if (status.state !== "succeeded" || !status.file) throw new Error(status.errorCode ?? "export failed");
console.log(status.file.fileId, status.file.sourceHeadSequence, status.file.sourceStateHash);
```

Do not export and re-import to continue editing.

## Explicit standalone DOCX work

Only for an explicitly local file boundary, locate the deployment-pinned
runtime, import its absolute `$OPENGENI_ARTIFACT_TOOL_ENTRY`, and use
`Document`/`DocumentFile`. Import only through that pinned entry. A standalone
result becomes shared work only after it is uploaded as a workspace file and
passed to `editable_artifact_import`.
