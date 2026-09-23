# `@opengeni/codemode`

OpenGeni's canonical attempt-frozen programmatic tool surface. It compiles one
catalog from the exact tools admitted to an execution attempt and dispatches
both model MCP calls and sandbox Codemode calls through the same opaque tool
identities and executors.

The package owns deterministic catalog projection, normalized unique JavaScript
paths with path-prefix collisions rejected during catalog creation, catalog
digests, stale-catalog fencing, approval classification, and result-shape
preservation. It does not discover MCP servers, resolve
credentials, persist attempts, or bypass host authorization; callers provide
the already-admitted definitions and one authorization hook.

`modelName` and `codemodePath` are projections only. Execution authority is
always the exact `{ serverId, toolName }` identity in the frozen catalog.

Inside an OpenGeni sandbox the worker supplies `OPENGENI_CODEMODE_URL` and a
renewed bearer file. The package exposes one lazy namespace over that exact
attempt catalog:

```ts
import { tools } from "@opengeni/codemode";

const sessions = await tools.opengeni.sessions_list({ status: "running" });
const hits = await tools.slack.search({ query: "release blocker" });
```

Generate digest-pinned project declarations from the live attempt catalog with
`ogtool declarations opengeni-codemode.d.ts`. Runtime schema validation remains
authoritative when a script outlives a catalog generation.

When submission receives the structured `codemode_catalog_stale` response, the
client refreshes the catalog once, re-resolves the requested identity or
namespace path, and retries with the same caller-owned operation id. The API
emits that code only before creating an operation. Ambiguous transport failures
may be reconciled by operation id only when the recovered row exactly matches
the requested attempt scope, catalog digest, tool identity, and canonical
arguments. Deterministic HTTP conflicts are returned directly and never adopt an
existing operation during initial admission. Once the API has returned the exact
operation, a later wake-notification failure resumes from an exact journal read;
it still rejects any mismatched operation. If that recovery read is unavailable,
the client returns `outcomeUnknown: true` with the exact operation id so the
caller can reconcile without generating a second identity. The API also treats
its post-dispatch journal refresh as best-effort and returns the already-admitted
operation if that refresh is unavailable. The database serializes concurrent
first submissions of one operation id, so identical races converge to one
creation plus one replay rather than a unique-constraint failure. No response
after operation creation triggers a catalog retry. While a journaled operation
remains queued or running, the client periodically re-notifies the dispatcher
with the same operation id. A live claim is not replayed; an expired claim is
either reclaimed before execution or durably settled outcome-unknown after the
execution marker. Public
`CodemodeTransportError` identity and its `codemode_transport_error`
compatibility code remain unchanged; the stable API detail is exposed as
`remoteCode`.

The bearer is reread for every request. Namespace paths are resolved against
the signed catalog and never parsed into authority from flattened model names.
For Browser/Computer work, the authored facade wraps those same atomic entries:

```ts
import { openGeni } from "@opengeni/codemode";

const browser = await openGeni.browsers.open({ initialUrl: "http://127.0.0.1:3000" });
const tab = await browser.tabs.selected();
const page = await tab.observe(); // Compact refs and explicit omission counts.
const buttons = await tab.read({ role: "button", nameContains: "Save", limit: 5 });
const email = await tab.read({ mode: "dom", dom: { kind: "element", locator: { kind: "css", selector: "#email" }, attributes: ["placeholder"] } });
await tab.getByRole("button", { name: "Save" }).click();
const still = await tab.screenshot({ quality: 40 });
console.log(still.path); // Open this local PNG/JPEG/WebP with view_image.

const computer = await openGeni.computers.open();
const app = await computer.apps.focused();
await app.getByRole("button", { name: "1" }).invoke();
```

`tab.observeFull()` retrieves the complete accessibility snapshot when compact
refs or a focused `tab.read()` query are insufficient. The default focused read
searches accessibility; `mode: "dom"` returns bounded text, editable values,
safe attributes, or counts. Sensitive fields are redacted. DOM CSS reads accept
simple tag, class, id, descendant, and child selectors; attribute and pseudo
selectors are rejected to prevent secret-value probing. Browser image blocks
are bounded below the Code Mode journal limit; for an oversized screenshot,
capture the viewport or lower JPEG quality.

Both surfaces return the same durable tool receipts. Human approval, catalog
generation, operation idempotency, and outcome-unknown behavior remain enforced
by the shared attempt executor. Catalog, approval, authorization, input
validation, and argument-sensitive connector-policy prepare complete before the
durable execution-start marker. The prepared call performs connector begin at
the executor boundary and completion afterward, so model MCP and Codemode share
one lifecycle while invalid, blocked, Ask, or unavailable-policy calls settle
before provider execution. Human-gated model calls additionally require the
attempt host's exact approved SDK invocation context; calling the environment
directly cannot bypass approval. The dispatcher keeps its claim alive during
gateway preparation and reuses a deterministic durable tool-created event if a
pre-execution claim is reclaimed.

`tab.screenshot({ fullPage?: boolean, saveTo?: string })` calls the same atomic
`interaction.browser.screenshot` tool and writes its image block to a private
local file. It returns the absolute path, MIME type, byte count, and small frame
metadata, without printing base64 pixels. Use the agent's `view_image` tool on
that path to inspect the still. `saveTo` writes to an exact caller-chosen path
and refuses to overwrite an existing file. `CodemodeClient.callPath` remains
available when code needs the complete MCP result, including image blocks.
Default image paths are private OS scratch files; later image calls remove this
client's scratch directories older than 24 hours. Use `saveTo` when a file must
remain available longer; that path is caller-owned and never pruned by Code Mode.
The generated `tools.*` namespace normally returns structured output directly.
When a typed tool returns image blocks, it instead returns
`{ structuredContent, images, otherContent }`: `images` contains local paths,
and `otherContent` preserves text and other non-image blocks. Generated
declarations express this union. Open `images[n].path` with `view_image`.
The facade and typed wrapper keep base64 out of program output; raw `callPath`
retains it and should not be printed wholesale.

`CodemodeCallOptions.signal` cancels only the caller's HTTP/polling observation.
It does not request server cancellation and cannot prove that an operation
stopped. The attempt/turn lifecycle remains the only cancellation authority; a
caller that aborts after submission must reconcile with the same operation id.

Editable artifacts use the same path. The object remains in OpenGeni; files are
only explicit import/export boundaries:

```ts
import { openGeni } from "@opengeni/codemode";

const workbook = await openGeni.artifacts.create("spreadsheet", "Forecast");
const sheetId = openGeni.artifacts.ids.stable();
await workbook.apply([
  { kind: "sheet.create", sheetId, name: "Inputs", after: null },
  {
    kind: "cells.set",
    sheet: { kind: "created-in-batch", sheetId, createCommandIndex: 0 },
    anchor: { row: 0, column: 0 },
    rows: 2,
    columns: 2,
    cells: ["Metric", "Value", "Revenue", 120],
  },
]);
```
