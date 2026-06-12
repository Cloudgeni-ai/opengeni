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
await client.sendMessage(workspaceId, sessionId, "Also check the nginx config");

// Steer: send + promote to the queue front + interrupt the running turn.
await client.steerMessage(workspaceId, sessionId, "Stop — prod is paging, look at that first");

// Manage the queue while it waits.
const turns = await client.listTurns(workspaceId, sessionId);
await client.updateQueuedTurn(workspaceId, sessionId, turnId, { prompt: "rewritten" });
await client.reorderQueuedTurns(workspaceId, sessionId, [turnB, turnA]);
await client.deleteQueuedTurn(workspaceId, sessionId, turnId);

// Control events.
await client.interrupt(workspaceId, sessionId, { reason: "stop and report" });
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

## Full API coverage

Every public endpoint group has typed methods:

| Group | Methods |
| --- | --- |
| Access + workspaces | `getAccessContext`, `listWorkspaces`, `createWorkspace`, `getWorkspace`, `updateWorkspace` |
| Sessions + events | `createSession`, `listSessions`, `getSession`, `listEvents`, `sendEvent`, `sendMessage`, `steerMessage`, `interrupt`, `sendApprovalDecision`, `streamEvents`, `openEventStream` |
| Turn queue | `listTurns`, `updateQueuedTurn`, `reorderQueuedTurns`, `deleteQueuedTurn` |
| Goal | `getGoal`, `updateGoal`, `pauseGoal`, `resumeGoal` |
| Scheduled tasks | `createScheduledTask`, `listScheduledTasks`, `getScheduledTask`, `updateScheduledTask`, `pauseScheduledTask`, `resumeScheduledTask`, `triggerScheduledTask`, `deleteScheduledTask`, `listScheduledTaskRuns` |
| Environments | `listEnvironments`, `createEnvironment`, `getEnvironment`, `updateEnvironment`, `deleteEnvironment`, `setEnvironmentVariable`, `deleteEnvironmentVariable` (values are write-only) |
| Files | `uploadFile`, `beginFileUpload`, `completeFileUpload`, `getFile`, `createFileDownloadUrl` |
| Documents | `createDocumentBase`, `listDocumentBases`, `getDocumentBase`, `addDocument`, `listDocuments`, `reindexDocument`, `searchDocuments` |
| Packs | `listPacks`, `registerPack`, `getPack`, `enablePack`, `deletePack`, `listPackInstallations` |
| Capabilities | `listCapabilities`, `createCapability`, `enableCapability`, `disableCapability`, `discoverMcpCapabilities` |
| GitHub | `getGitHubApp`, `githubConnectUrl`, `listGitHubRepositories`, `syncGitHubRepositories`, `createGitHubAppManifest` |
| API keys | `listApiKeys`, `createApiKey`, `deleteApiKey` |
| Billing | `getBilling`, `getBillingUsage`, `getBillingEntitlements`, `createBillingCheckout` |

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
