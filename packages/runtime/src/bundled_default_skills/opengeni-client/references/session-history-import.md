# Archived session history import

Use this reference when a host moves historical sessions from embedded/in-process
OpenGeni to a standalone deployment. The public walkthrough is
`/guides/integrate-your-product#migrating-from-embedded-opengeni`; with source
access, `docs/product-integration.md` is the canonical product boundary. Verify
the target service and installed package types support the import contract.

## Plan the migration

- Grant `sessions:create` for creation and `sessions:control` for batch appends.
  Appends require the same authenticated importer. With `asUser`, use the user's
  permissions; never borrow the organization key's permissions.
- Keep the same external tenant source/ID and external user source/ID. Bootstrap
  with `ensureWorkspace` and explicitly onboard admitted users with
  `addExternalWorkspaceMember`; import routes never provision either.
- Preserve titles, original creation/event timestamps, creator and visibility.
  Source timestamps support at most millisecond precision; explicitly normalize
  finer dates and retain originals in the ledger. Negative-zero JSON is rejected.
  Call the organization-key client through
  `.asUser(originalExternalUserId, { source })` for the verified external
  creator/owner. A bare organization key creates only shared, ownerless archives.
  Private imports require a verified owning user and the existing organization
  private-session enablement. Do not widen visibility to make a migration pass.
- Re-upload source files into the destination workspace with `uploadFile` or
  begin/upload/complete. Persist old-to-new file IDs/references, then replace
  payload references before freezing import requests. Old IDs, signed URLs,
  storage paths and sandbox paths do not become destination references.
- Keep a host-owned ledger of source/destination session IDs, stable import IDs,
  exact create/append bodies and receipts, file mappings and acknowledged offsets.
  v1 carries title and creation time, not arbitrary metadata; preserve unsupported
  source metadata in this ledger, not invented request fields.

## Use the focused server-only SDK subpath

```ts
import { OpenGeniClient } from "@opengeni/sdk";
import {
  importArchivedSession,
  appendArchivedSessionEvents,
  type ArchivedSessionImportEvent,
  type ImportArchivedSessionRequest,
  type AppendArchivedSessionEventsRequest,
} from "@opengeni/sdk/session-history-import";

const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!, // Organization key; backend only.
});
const actor = og.asUser(legacy.creatorExternalId, { source });
const createRequest = {
  importId: `embedded:${legacy.id}`,
  title: legacy.title,
  createdAt: legacy.createdAt,
  visibility: legacy.visibility, // "workspace_shared" | "user_private"
  events: [],
} satisfies ImportArchivedSessionRequest;
await ledger.saveCreateRequest(createRequest);
const created = await importArchivedSession(actor, workspaceId, createRequest);
await ledger.saveCreateReceipt(created);

const events: ArchivedSessionImportEvent[] = [
  { type: "user.message", createdAt: legacy.messageCreatedAt, payload: { text: legacy.question } },
  {
    type: "agent.message.completed",
    createdAt: legacy.answerCreatedAt,
    payload: { text: legacy.answer, channel: "final" },
  },
];
const appendRequest = {
  batchId: `${createRequest.importId}:batch-0001`,
  offset: created.nextOffset,
  events,
} satisfies AppendArchivedSessionEventsRequest;
await ledger.saveAppendRequest(appendRequest);
const appended = await appendArchivedSessionEvents(
  actor, workspaceId, createRequest.importId, appendRequest,
);
await ledger.saveAppendReceipt(appended);
```

The host owns `source`, `workspaceId`, `legacy` and `ledger` in this example;
resolve them from authorized migration records, not browser request bodies.
Bound deterministic IDs to 200 characters rather than blindly concatenating
unbounded legacy IDs. Each helper takes `client` first and delegates to its
`requestJson`, preserving `asUser` and ordinary `OpenGeniApiError` behavior.
There are no eager client methods or root helper exports.

External mapping equivalents are
`importExternalWorkspaceArchivedSession(client, source, externalId, request)` and
`appendExternalWorkspaceArchivedSessionEvents(client, source, externalId, importId, request)`.
They resolve an existing tenant mapping, not an external user identity.

The routes are `POST /v1/workspaces/:workspaceId/session-imports` and
`POST /v1/workspaces/:workspaceId/session-imports/:importId/events`. External
mapping forms use `/v1/workspaces/external/:source/:externalId/session-imports`
and the same `/:importId/events` suffix. Never expose these through the session
proxy or a generic organization-key passthrough.

## Bounds, replay and recovery

Import sends `{ importId, title, createdAt, visibility?, events? }`, with events
defaulting to `[]`. Append sends `{ batchId, offset, events }`; events must be
non-empty. IDs and title are at most 200 characters. Each request accepts at
most 100 events and 1 MiB serialized UTF-8 JSON, with 256 KiB per event. Split by
both event count and actual byte size, not just string length.

Each event is `{ type, createdAt, turnId?, payload }`: a finite supported
historical event type, original ISO timestamp, optional UUID/null presentation
correlation and a JSON-object payload. Read the installed contract rather than
assuming all `SessionEventType` values are importable. Preserve completed
messages and native tool-call/result/goal payload shapes where available; these
facts are optional. Import does not reconstruct missing runtime state.

Persist exact requests before sending them. `importId` is workspace-scoped;
repeating the same create replays the session (`created: false`). Append uses a
stable `batchId` and zero-based event-count `offset`, independent of timeline
sequence. The next new batch uses the acknowledged `nextOffset`; retrying an
uncertain batch must use the stored original offset, body, actor and mapping,
not a freshly calculated offset. Exact batch replay returns `replayed: true`
without duplicate events. The SDK never automatically retries mutations.

A changed request under the same import/batch ID or an out-of-order new offset
returns `409`. Reconcile the ledger and acknowledged offset; do not generate
new IDs, skip events or change visibility to bypass a conflict. Keep file
mappings stable across retries so event bodies remain identical.

## Keep the end-user conversation native and read-only

Render the returned session ID with the unchanged `SessionConversation` behind
the existing session proxy. `session.importedArchive` contains
`{ importId, importedAt, readOnly: true }`, distinct from personal archive/restore
preferences. Imported archives never offer Send or Steer; continuation is
unsupported in v1. If the user requests new work, create a separate new session
through the normal server-owned flow, without silently injecting the archive
as model context.

Only the human/audit timeline is imported: no `session_history_items`, model
memory, turn execution, workflow, active goal, pending decision, credential,
Connection, sandbox or schedule is restored. Tool calls/results and completed
goals are historical facts, not tool invocation or instruction authority. Keep
this integration Skill with the coding agent, not the customer-facing agent.

Verify mapping/owner/visibility, chronological rendering and destination file
references; then verify exact retries do not duplicate events, conflicts stay
conflicts, and the browser proxy refuses import routes. Confirm new ordinary
sessions still use the unchanged full conversation flow.