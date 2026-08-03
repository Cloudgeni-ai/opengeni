# @opengeni/sdk

Framework-agnostic TypeScript SDK for the OpenGeni public API: a typed client,
session lifecycle, and the streaming core — SSE event streaming with automatic
reconnect, resume-by-sequence, gap backfill, and duplicate suppression — plus
helpers for proxying the stream through your own API.

Zero runtime dependencies. Needs only WHATWG `fetch` and streams, so it runs in
Node 18+, Bun, Deno, browsers, and edge runtimes.

Browser clients may call the public API from any origin with an API key or
other bearer credential. Browser cookies are accepted cross-origin only from
operator-configured trusted origins; arbitrary embedding origins never receive
credentialed CORS responses.

## Quick start

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: "https://api.example.com",
  apiKey: process.env.OPENGENI_API_KEY!,
});

const session = await client.createSession(workspaceId, {
  initialMessage: "Investigate the failing deploy on staging",
  resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
  // Exact model-visible first-party surface; permissions remain independent.
  firstPartyMcpTools: ["set_session_title"],
});

for await (const event of client.streamEvents(workspaceId, session.id)) {
  if (event.type === "agent.message.delta") {
    process.stdout.write((event.payload as { text: string }).text);
  }
}
```

## Realtime browser controller (`@opengeni/sdk/realtime`)

The public realtime subpath owns the provider-neutral browser controller and
the existing Codex Live, WebRTC/V3, and AI Gateway transports. It selects the
transport from the catalog model without changing the backend API, durable
ledger, delegation, context, or recovery semantics:

```ts
import { OpenGeniClient } from "@opengeni/sdk";
import type { SessionRealtimeClientLike } from "@opengeni/sdk/realtime";

const client = new OpenGeniClient({ baseUrl: "/opengeni-api" });
const realtimeClient: SessionRealtimeClientLike = client;
const catalog = await realtimeClient.getWorkspaceRealtimeModelCatalog(workspaceId);
const model = catalog.models.find((candidate) => candidate.available)?.id;
if (!model) throw new Error("No realtime model is available");

// Lazy import keeps the base SDK entry safe for server and non-realtime hosts.
const { createSessionRealtimeController } = await import("@opengeni/sdk/realtime");
const controller = createSessionRealtimeController({
  client: realtimeClient,
  workspaceId,
  sessionId,
  model,
  remoteAudio,
});

const unsubscribe = controller.subscribe((snapshot) => {
  console.log(snapshot.status, snapshot.microphone, snapshot.diagnostic);
});
await controller.start();

// Later:
await controller.stop();
unsubscribe();
controller.close();
```

`SessionRealtimeClientLike` is the exact proxy-friendly backend surface:
catalog, begin, Codex/Gateway negotiation, activation, heartbeat, ledger sync,
and end. Existing `OpenGeniClient` methods remain the implementation. Current
Codex-named controller and transport exports remain available as compatibility
aliases, but new integrations should use the provider-neutral names.

Do not put API credentials in browser bundles. Browser hosts should either use
the deployment's normal browser authentication or expose these same methods
through a tenant-scoped, same-origin proxy. The SDK does not move persistence,
prompt construction, context processing, delegation, or provider credentials
out of `apps/api`, `apps/worker`, or `packages/db`.

## Workspace artifacts

Workspace artifacts are generic, immutable HTML publications. The SDK does not
assign product types such as app, page, dashboard, or gallery. List pages are
bounded and expose both `truncated` and an opaque `nextCursor` so callers never
mistake a partial page for the complete workspace catalog.

The initial web renderer supports semantic HTML, inline CSS, CSS-only
interactions, and inline SVG. It removes JavaScript, event handlers, forms,
embeds, external URLs, and other active or navigation-capable markup before
rendering. Executable artifacts require a later, stronger isolation boundary.

```ts
let cursor: string | undefined;
do {
  const page = await client.listWorkspaceArtifacts(workspaceId, {
    limit: 50,
    ...(cursor ? { cursor } : {}),
  });
  for (const artifact of page.artifacts) console.log(artifact.title);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Creation and publication require a caller-supplied idempotency key. Reuse the
same key only to retry the same logical mutation. Agent-authored versions also
return the exact source session, turn, attempt, and execution generation that
published them. Version and event history are bounded; inspect
`versionsTruncated` and `eventsTruncated` on the detail response.

Omit `firstPartyMcpTools` for the complete OpenGeni tool catalog. An explicit
`[]` exposes no broad first-party tools; attached resources and separately
selected `files`/`docs` MCP servers are unaffected.

## MCP tool output normalization

MCP transports and event stores can represent the same tool result as a direct
object, JSON text, a text content block, or nested `result`,
`structuredContent`, and `content` envelopes. Use the shared zero-dependency
normalizer when an embedding host needs one stable interpretation:

```ts
import { normalizeMcpOutput } from "@opengeni/sdk";

const normalized = normalizeMcpOutput(toolOutput);

normalized.value; // canonical machine-readable value
normalized.text; // presentation text
normalized.isError; // preserved across recognized nested envelopes
normalized.raw; // original evidence
```

Malformed text and unknown objects pass through without throwing. Envelope
recognition is deliberately conservative: an ordinary domain object is not
unwrapped merely because it has a field named `result`.

## Error handling

Non-2xx responses throw `OpenGeniApiError` with stable transport metadata:
`status`, optional `code`, `retryable`, optional `correlationId`,
`outcomeUnknown`, and a bounded structured `body`. The SDK sends a fresh bounded
correlation ID on each API request and includes the safe returned reference in
the display message.

```ts
import { OpenGeniApiError } from "@opengeni/sdk";

try {
  await client.sendMessage(workspaceId, sessionId, input);
} catch (error) {
  if (error instanceof OpenGeniApiError && error.outcomeUnknown) {
    // Reconcile durable state, then retry only with input.clientEventId unchanged.
  }
  throw error;
}
```

Error bodies are read only when they are JSON and no larger than 16 KiB; raw
gateway HTML/plain text and oversized bodies are discarded. A controlled typed
API rejection has `outcomeUnknown: false`. A raw `502`/`503`/`504` or an
unexpected successful non-JSON response to a mutation has `outcomeUnknown:
true` because the mutation might already have been accepted. Never turn that
condition into a new operation by changing its idempotency key.

## Streaming guarantees

`client.streamEvents(...)` (and the underlying `streamSessionEvents`) delivers
each session event **exactly once, in order**, anchored on the per-session
contiguous `sequence` number:

- Reconnects transparently on transient drops (network failures, 5xx, 429),
  resuming from the last seen sequence via `?after=`.
- Suppresses duplicates when server replay overlaps what was already seen.
- Backfills any gap observed on a live connection from the durable replay
  endpoint (`GET .../events?after=`) before yielding newer events.
- Ends gracefully when the provided `AbortSignal` aborts; throws on
  non-retryable failures (e.g. 401/403/404).

Use `client.listEventPage(...)` when monitoring another session. A call without
a cursor is safe by default: it returns a newest-first-selected (but
ascending-in-response) semantic tail, uses bounded `summary` payloads, and omits
raw message/reasoning/command/PTY deltas. The page returns exact
`coveredSequence`, `nextBefore`/`nextAfter`, byte, truncation, and projection
metadata. Filters can select canonical event types or the `control`, `terminal`,
`failure`, `checkpoint`, `tool_receipt`, and `provider_account` semantic classes;
`latest` is an exclusive typed lookup that returns the newest event in exactly
the requested class. It cannot be combined with any type or class include/exclude
filter, so an unrelated newer event cannot displace the requested result and an
exclusion cannot remove it.

For callback-loss recovery, `latest` selects authoritative current/legacy rows
by durable session `sequence` across distinct turns; explicit `late_rejected` and
`duplicate` callbacks never compete with current truth. `turnGeneration` remains
metadata and is interpreted only within its turn/retry scope. Use
`resultMode: "compact"` to receive one bounded result-bearing completion,
failure, checkpoint, or receipt without creating another model turn. The
`receipt` spelling aliases `tool_receipt`, and a missing event returns `null`.
The compact result includes exact source/generation/covered-sequence facts and
bounded text/output/result/failure/checkpoint/receipt values. Retained-output
storage and full-evidence retrieval are separate contracts from this event
projection.

```ts
const terminal = await client.listEventPage(workspaceId, sessionId, {
  latest: "terminal",
  payloadMode: "summary",
});

const recovered = await client.getLatestEventResult(workspaceId, sessionId, {
  latest: "terminal",
});

const older = await client.listEventPage(workspaceId, sessionId, {
  before: terminal.nextBefore ?? undefined,
  includeClasses: ["failure", "checkpoint"],
  payloadMode: "none",
});
```

Use explicit `mode: "forensic", payloadMode: "full"` with `after`/`before` for
exact retained audit replay. “Full” means the exact durable audit projection;
it cannot restore source bytes that the audit boundary never retained. REST/SDK
pages remain count- and byte-bounded, so continue with the returned cursor. The
convenience `client.listEvents(...)` returns only the page's event array. Pass
`compact: true` for forensic history windows that do not need individual delta
fragments; delta runs may be coalesced and expose `payload.coalescedUntil` as
the true last sequence for stream resume cursors.

```ts
const controller = new AbortController();
for await (const event of client.streamEvents(workspaceId, sessionId, {
  after: lastSeenSequence,
  signal: controller.signal,
  onStateChange: (state) => console.log("stream:", state),
})) {
  // ...
}
```

## Messages, the turn queue, and steering

Messages sent while a turn is running **queue by default** — visible,
editable, reorderable, and deletable until the worker claims them. Steering is
the explicit alternative: deliver now by interrupting the running turn.

```ts
// Queue (default): stacks behind the running turn.
await client.sendMessage(workspaceId, sessionId, {
  text: "Also check the nginx config",
  clientEventId: crypto.randomUUID(),
});

// Steer: send + promote to the queue front + interrupt the running turn.
await client.steerMessage(workspaceId, sessionId, {
  text: "Stop — prod is paging, look at that first",
  clientEventId: crypto.randomUUID(),
});

// Manage the server-authoritative queue while it waits.
const queue = await client.getQueue(workspaceId, sessionId);
const waiting = queue.items.at(-1)!;
await client.moveQueueItem(workspaceId, sessionId, waiting.id, {
  expectedQueueVersion: queue.version,
  beforeTurnId: queue.items[0]?.id ?? null,
  clientEventId: crypto.randomUUID(),
});
await client.editQueueItem(workspaceId, sessionId, waiting.id, {
  expectedTurnVersion: waiting.version,
  expectedDraftRevision: 0,
  replaceDraft: false,
  clientEventId: crypto.randomUUID(),
});

// Pause/Resume is recursive workstream control; it creates no queue row.
await client.pauseSession(workspaceId, sessionId, {
  reason: "hold this workstream",
  expectedControlEtag: queue.effectiveControl.controlEtag,
});
const paused = await client.getQueue(workspaceId, sessionId);
await client.resumeSession(workspaceId, sessionId, {
  expectedControlEtag: paused.effectiveControl.controlEtag,
});
// Cancel is irreversible: it drains and fences this session subtree.
await client.cancelSession(workspaceId, sessionId, {
  reason: "host record deleted",
  clientEventId: crypto.randomUUID(),
});
await client.sendApprovalDecision(workspaceId, sessionId, { approvalId, decision: "approve" });
```

## Session tool policy and native web search

Omitting `tools` when creating a top-level session selects the current
workspace-default capability policy, including the built-in `files` server.
Passing `tools`, including `[]`, is an intentional fixed narrowing and can
therefore disable file-download access for that session. OpenGeni's own web UI
keeps `files` enabled as a hidden default, while API and embedded clients retain
exact control over the explicit list. Supported Responses providers attach
their native bounded web-search tool independently of this MCP policy.

Existing explicit sessions are not widened when a new default capability is
introduced. Opt one in explicitly with the current optimistic-concurrency
version; the audited change takes effect on its next attempt:

```ts
const session = await client.getSession(workspaceId, sessionId);
const updated = await client.updateSessionToolPolicy(workspaceId, sessionId, {
  mode: "workspace_default",
  expectedVersion: session.toolPolicyVersion,
});
```

To keep a fixed allow-list, replace both connected MCP servers and individual
OpenGeni tools atomically:

```ts
await client.updateSessionToolPolicy(workspaceId, sessionId, {
  mode: "explicit",
  tools,
  firstPartyMcpTools,
  expectedVersion: session.toolPolicyVersion,
});
```

Follow-up Send and Steer requests inherit this session policy and cannot carry
a private one-turn tool override. `tool_search` discovers deferred MCP schemas;
it is not public web search.

## Goals

```ts
const goal = await client.getGoal(workspaceId, sessionId); // counters: autoContinuations, noProgressStreak
await client.pauseGoal(workspaceId, sessionId, { rationale: "manual review" });
await client.resumeGoal(workspaceId, sessionId); // resets counters, re-arms continuations
```

## Files

`uploadFile` wraps the three-step flow (begin → signed PUT → complete) in one
call; the lower-level steps are exported for resumable/custom flows.

Browser hosts need no storage credentials or per-application registration.
OpenGeni authorizes the workspace request and returns a short-lived,
object-scoped signed URL; operators must configure the private object store to
allow CORS from `*` so any product embedding the SDK can use that URL.

```ts
const file = await client.uploadFile(workspaceId, {
  filename: "incident-notes.md",
  contentType: "text/markdown",
  data: notes, // string | Blob | ArrayBuffer | Uint8Array
});
const { url } = await client.createFileDownloadUrl(workspaceId, file.id);
```

## Connected Machines (bring-your-own-compute)

A session can run on an enrolled **Connected Machine** — a user's own computer —
instead of a platform-managed sandbox. Two `createSession` fields target one:

- **`targetSandboxId`** (uuid) — the machine to run on (a `MachineView.sandboxId`
  from `listMachines`). It seeds the session's active-sandbox pointer at
  creation, so the first turn lands on that machine.
- **`workingDir`** (host path) — the directory the agent runs under on that
  machine. **Only valid together with `targetSandboxId`** — `workingDir` alone is
  a **422**. Omit it and the session runs under the machine's default workspace
  root. Repos attached to a machine session are **not cloned** (the machine uses
  its own git auth).

```ts
const { machines } = await client.listMachines(workspaceId);
const box = machines.find((m) => m.kind === "selfhosted" && m.state === "online");

const session = await client.createSession(workspaceId, {
  initialMessage: "Run the test suite and fix what's red",
  targetSandboxId: box!.sandboxId, // seeds the active-sandbox pointer at create
  workingDir: "/home/me/projects/app", // requires targetSandboxId, else 422
});

// Re-point a running session's active sandbox (or "session"/"default" to swap
// back to its own managed box):
await client.swapActiveSandbox(workspaceId, session.id, { target: box!.sandboxId });
```

Discovery (`listMachines`, `machineMetricsSeries`), the active-sandbox swap, and
the enrollment methods (`mintEnrollToken`, `lookupDeviceEnrollment`,
`approveDeviceEnrollment`, `denyDeviceEnrollment`) are covered in the
[Connected Machines guide](../../docs/connected-machines.md).

## Full API coverage

Every public endpoint group has typed methods:

| Group | Methods |
| --- | --- |
| Access + workspaces | `getAccessContext`, `listWorkspaces`, `createWorkspace`, `getWorkspace`, `updateWorkspace` |
| Sessions + events | `createSession`, `listSessions`, `getSession`, `updateSession`, `listEvents`, `sendEvent`, `sendMessage`, `steerMessage`, `pauseSession`, `resumeSession`, `cancelSession`, `sendApprovalDecision`, `streamEvents`, `openEventStream` |
| Machines (bring-your-own-compute) | `listMachines`, `machineMetricsSeries`, `swapActiveSandbox`, `mintEnrollToken`, `lookupDeviceEnrollment`, `approveDeviceEnrollment`, `denyDeviceEnrollment` |
| Turn queue | `getQueue`, `moveQueueItem`, `editQueueItem`, `steerQueueItem`, `deleteQueueItem` |
| Goal | `getGoal`, `updateGoal`, `pauseGoal`, `resumeGoal` |
| Scheduled tasks | `createScheduledTask`, `listScheduledTasks`, `getScheduledTask`, `updateScheduledTask`, `pauseScheduledTask`, `resumeScheduledTask`, `triggerScheduledTask`, `deleteScheduledTask`, `listScheduledTaskRuns` |
| Variable sets | `listVariable sets`, `createVariable set`, `getVariable set`, `updateVariable set`, `deleteVariable set`, `setVariable setVariable`, `deleteVariable setVariable` (values are write-only) |
| Files | `uploadFile`, `beginFileUpload`, `completeFileUpload`, `getFile`, `createFileDownloadUrl` |
| Documents | `createDocumentBase`, `listDocumentBases`, `getDocumentBase`, `addDocument`, `listDocuments`, `reindexDocument`, `searchDocuments`, `searchKnowledge` (effective organization + workspace + immutable initiating-user personal scope) |
| Packs | `listPacks`, `registerPack`, `getPack`, `enablePack`, `deletePack`, `listPackInstallations` |
| Capabilities | `listCapabilities`, `createCapability`, `enableCapability`, `disableCapability`, `discoverMcpCapabilities` |
| GitHub | `getGitHubApp`, `githubConnectUrl`, `listGitHubRepositories`, `syncGitHubRepositories`, `createGitHubAppManifest` |
| API keys | `listApiKeys`, `createApiKey`, `deleteApiKey` |
| Billing | `getBilling`, `getBillingUsage`, `getBillingEntitlements`, `createBillingCheckout` |

### Protocol routes (deliberately not in the SDK)

Some endpoints are wire protocols for specific counterparts, not client
surface, and are intentionally absent from the SDK: machine-agent enrollment
device flow and NATS auth-callout, viewer/stream internals beyond minting,
OAuth/GitHub browser callbacks, Stripe webhooks, the MCP transports themselves
(`/v1/workspaces/:id/mcp`, `/mcp/docs` — speak MCP to those), and the install
script routes. If you find yourself calling one of these raw from a product,
reconsider — they can change with their counterpart, not with the SDK.

## Compatibility

Clients and servers are compatible within the same **major** release-train
version; evolution is additive within a major and both sides are tolerant
readers. Official server builds expose `serverVersion` on `/healthz` and
`/v1/config/client`. Full policy: `docs/architecture.md` §3.10.

## Proxy through your own API

Keep your OpenGeni API key on your server and re-emit the stream to your own
browser clients. The re-emitted wire format is identical to OpenGeni's SSE
stream, so the browser side can consume it with this same SDK (or a plain
`EventSource`), including resume via `?after=` / `Last-Event-ID`:

```ts
// Your server (Hono, Next.js route handler, Bun.serve, workers, ...):
import { OpenGeniClient, proxySessionEventStream } from "@opengeni/sdk";

const client = new OpenGeniClient({ baseUrl, apiKey });

export function GET(request: Request): Response {
  // authenticate *your* user, resolve their session id, then:
  return proxySessionEventStream(client, workspaceId, sessionId, {
    after: request, // honors ?after= and Last-Event-ID from the browser
    signal: request.signal, // browser disconnect tears down the upstream stream
  });
}
```

For custom layers, the pieces are exported individually:
`sessionEventsToSseStream`, `sessionEventsToSseResponse`, `formatSseEvent`,
`resumeSequenceFromRequest`, and `parseSseStream`.

## Types

The SDK ships hand-written mirrors of the public wire shapes (sessions, turns,
events, resource/tool refs) so it carries no runtime dependency on the server
packages. `test/contract-parity.test.ts` pins them to `@opengeni/contracts`,
so contract drift fails the repo gate instead of shipping. `SessionEvent.type`
is an open union: unknown event types from newer servers flow through instead
of breaking older SDK consumers.
