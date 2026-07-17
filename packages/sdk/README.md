# @opengeni/sdk

Framework-agnostic TypeScript SDK for the OpenGeni public API: a typed client,
session lifecycle, and the streaming core — SSE event streaming with automatic
reconnect, resume-by-sequence, gap backfill, and duplicate suppression — plus
helpers for proxying the stream through your own API.

Zero runtime dependencies. Needs only WHATWG `fetch` and streams, so it runs in
Node 18+, Bun, Deno, browsers, and edge runtimes.

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
});

for await (const event of client.streamEvents(workspaceId, session.id)) {
  if (event.type === "agent.message.delta") {
    process.stdout.write((event.payload as { text: string }).text);
  }
}
```

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

Use `client.listEvents(workspaceId, sessionId, { before, after, limit })` for
durable replay pages. `before` is an exclusive sequence cursor that returns the
newest matching page, still ordered ascending in the response. Pass
`compact: true` for history windows that do not need individual delta fragments;
delta runs may be coalesced and expose `payload.coalescedUntil` as the true last
sequence for stream resume cursors.

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
await client.sendApprovalDecision(workspaceId, sessionId, { approvalId, decision: "approve" });
```

## Goals

```ts
const goal = await client.getGoal(workspaceId, sessionId); // counters: autoContinuations, noProgressStreak
await client.pauseGoal(workspaceId, sessionId, { rationale: "manual review" });
await client.resumeGoal(workspaceId, sessionId); // resets counters, re-arms continuations
```

## Files

`uploadFile` wraps the three-step flow (begin → signed PUT → complete) in one
call; the lower-level steps are exported for resumable/custom flows.

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
| Sessions + events | `createSession`, `listSessions`, `getSession`, `updateSession`, `listEvents`, `sendEvent`, `sendMessage`, `steerMessage`, `pauseSession`, `resumeSession`, `sendApprovalDecision`, `streamEvents`, `openEventStream` |
| Machines (bring-your-own-compute) | `listMachines`, `machineMetricsSeries`, `swapActiveSandbox`, `mintEnrollToken`, `lookupDeviceEnrollment`, `approveDeviceEnrollment`, `denyDeviceEnrollment` |
| Turn queue | `getQueue`, `moveQueueItem`, `editQueueItem`, `steerQueueItem`, `deleteQueueItem` |
| Goal | `getGoal`, `updateGoal`, `pauseGoal`, `resumeGoal` |
| Scheduled tasks | `createScheduledTask`, `listScheduledTasks`, `getScheduledTask`, `updateScheduledTask`, `pauseScheduledTask`, `resumeScheduledTask`, `triggerScheduledTask`, `deleteScheduledTask`, `listScheduledTaskRuns` |
| Variable sets | `listVariable sets`, `createVariable set`, `getVariable set`, `updateVariable set`, `deleteVariable set`, `setVariable setVariable`, `deleteVariable setVariable` (values are write-only) |
| Files | `uploadFile`, `beginFileUpload`, `completeFileUpload`, `getFile`, `createFileDownloadUrl` |
| Documents | `createDocumentBase`, `listDocumentBases`, `getDocumentBase`, `addDocument`, `listDocuments`, `reindexDocument`, `searchDocuments` |
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
