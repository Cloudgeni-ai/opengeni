# OpenGeni API Workflows

This reference is intentionally pattern-level. Check the live service or source contracts for exact schemas before generating SDK code.

## Access Setup

Use one of these product credentials:

- Managed SaaS: create an OpenGeni API key in the web console and send `Authorization: Bearer <api-key>`.
- Configured/self-hosted: send the configured bearer key or delegated token chosen by the operator.
- Local development: the service may resolve a default dev subject/workspace without external auth.

Only add `x-opengeni-access-key` when the operator says the deployment shared-key boundary is enabled. It is not a replacement for product API keys in managed SaaS.

## Minimal Session Client

```ts
const baseUrl = process.env.OPENGENI_API_BASE_URL!;
const apiKey = process.env.OPENGENI_API_KEY!;

const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

const access = await fetch(`${baseUrl}/v1/access/me`, { headers }).then((r) => r.json());
const workspaceId = process.env.OPENGENI_WORKSPACE_ID ?? access.defaultWorkspaceId;

const created = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/sessions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    initialMessage: "Inspect the uploaded logs and summarize the failing deploy step.",
    tools: [{ kind: "mcp", id: "opengeni" }],
  }),
}).then((r) => r.json());

const events = new EventSource(`${baseUrl}/v1/workspaces/${workspaceId}/sessions/${created.id}/events/stream`);
events.addEventListener("agent.message.delta", (event) => {
  const payload = JSON.parse(event.data);
  process.stdout.write(payload.text ?? "");
});
```

If the runtime cannot attach `Authorization` headers to `EventSource`, use `fetch` streaming or a server-side proxy that injects the credential.

## Session Creation Options

Beyond `initialMessage`/`tools`/`resources`, the create body (`POST /v1/workspaces/:workspaceId/sessions`, the SDK's `createSession(workspaceId, request)`) chooses where the session runs:

- `sandboxBackend` — pick the managed sandbox execution backend; omit for the deployment default.
- `targetSandboxId` (uuid) — run the session on an enrolled **Connected Machine** (a user-owned machine) instead of a managed sandbox. It seeds the session's active-sandbox pointer at creation so the first turn routes to that machine; an invalid/unowned/offline target fails the create.
- `workingDir` — the host path the machine runs the session under (the base for its agent cwd, terminal, and file dock). **Only valid together with `targetSandboxId`** — sending `workingDir` alone is a 422. Omit it to use the machine's default working directory.
- `sandbox` — shared-sandbox placement for managed sandboxes, a three-way union: `"shared"` (join the creating session's box; a top-level `"shared"` is a 422), `"new"` (mint a fresh box), or `{ groupId }` (join a specific sibling group in the same workspace). Omitted resolves a context-dependent default server-side.
- `idempotencyKey` (1–200 chars) — a workspace-scoped CREATE idempotency key (see below).

`targetSandboxId`/`workingDir` are the managed-sandbox-vs-Connected-Machine choice; `sandboxBackend` and the `sandbox` placement union only apply to managed sandboxes. To move a session onto a different machine *after* creation, use the active-sandbox swap (below) — not `updateSession`, whose only field is the session `title`.

## Replay And Retry

- Persist the latest event sequence seen by the client.
- On reconnect, list events after the last known sequence before reopening the stream.
- Retry idempotent reads and stream reconnects with bounded backoff.
- Session creation exposes a workspace-scoped `idempotencyKey` (distinct from the per-call `clientEventId`): forward a stable value so concurrent/retried creates of the same logical session collapse to a single session. Without it every create is independent, so a blind retry can double-create — keep sending a stable key when you retry.
- Treat unknown event types as extensible timeline entries, not client crashes.

## Files

The usual flow is:

1. `POST /v1/workspaces/:workspaceId/files/uploads`
2. `PUT` bytes to the returned signed object-storage URL with the required headers.
3. Complete the upload through the returned workspace upload endpoint.
4. Attach the file resource to a session, follow-up turn, or scheduled task only after it is ready.

Never attach a file id from another workspace. Correct behavior is no data leak: 403 when the credential has no workspace grant, 404 when the resource is not in the granted workspace.

## Documents And Search

Use document bases when the product needs indexed/searchable knowledge rather than one-off file attachments. Create or select a base, add documents from uploaded files/text, wait for indexing, then use either the search route or a configured document-search MCP tool.

## GitHub Repositories

For private repos, use the workspace GitHub repository list before attaching a resource. A valid repository resource normally includes clone URL, ref, mount path, GitHub installation id, and GitHub repository id from OpenGeni's listing response. The worker mints short-lived GitHub App tokens for selected repositories and should not persist clone credentials in session manifests.

Do not ask customers to paste GitHub App private keys into their client integration. Managed SaaS uses the OpenGeni-owned app; self-hosted operators configure their own app server-side.

## Connected Machines And Enrollment

A Connected Machine is a user-owned machine enrolled into a workspace and used as first-class primary compute (no cloud box behind it; it uses its own git auth; repos are not cloned onto it). `selfhosted` is the internal `sandboxBackend` enum value for such a machine.

Discover and target machines:

- `GET /v1/workspaces/:workspaceId/machines` — list the workspace's machines (each with its derived state, latest metrics, and shared-session count) plus the active-sandbox pointer. Pass `?sessionId=` for an in-session view that also includes the session's own group box. SDK: `listMachines(workspaceId, { sessionId })`.
- `GET /v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series?window=15m|1h|6h|24h` — the downsampled (~1/min) metrics history. SDK: `machineMetricsSeries(workspaceId, enrollmentId, { window })`.
- Create a session with `targetSandboxId` (a machine's `sandboxId` from the list) plus an optional `workingDir` to run on it.
- `POST /v1/workspaces/:workspaceId/sessions/:sessionId/active-sandbox` with `{ target }` — swap the session's active sandbox mid-conversation; `target` is a machine's `sandboxId`, or `"session"`/`"default"` to return to the session's own group box. The response echoes `swapped`, `activeSandboxId`, `activeEpoch`, and a `reason` when a target is refused. SDK: `swapActiveSandbox(workspaceId, sessionId, { target })`.

Enroll a machine (the client-driven parts):

- Interactive device flow: the machine's own agent starts and polls the flow agent-side (unauthenticated). A workspace operator resolves the pending request by user code with `POST /v1/enrollments/device/lookup` (no workspace in the path — the server resolves it from the code, then authorizes `enrollments:read`), then `POST /v1/workspaces/:workspaceId/enrollments/device/approve` (the loud consent step; `allowScreenControl` opts into screen control) or `.../device/deny`. SDK: `lookupDeviceEnrollment(userCode)`, `approveDeviceEnrollment(workspaceId, { userCode, allowScreenControl })`, `denyDeviceEnrollment(workspaceId, { userCode })`.
- Headless / fleet: `POST /v1/workspaces/:workspaceId/enrollments/token` mints a short-TTL SECRET enroll token (surface it once with a copy-now warning); the machine's agent redeems it agent-side at `POST /v1/enrollments/token/exchange`. SDK: `mintEnrollToken(workspaceId, { allowScreenControl })`.
- `POST /v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke` removes a machine. Approving, minting, and revoking all require `enrollments:manage`; listing needs `enrollments:read`.

Never distribute an OpenGeni credential to a Connected Machine or try to inject git tokens into it — the machine authenticates to git with its own credentials. Device start/poll and token exchange are agent-side calls, not client SDK methods.

## Billing And Limits

Managed SaaS uses prepaid Stripe credits and local usage/cost accounting. Client behavior should be simple:

- Show billing/credit status from `/v1/billing` when the user has billing permission.
- Stop costly writes/runs when the API returns a credit/limit denial.
- Preserve read/export paths when writes are blocked.
- Surface top-up links from OpenGeni; do not call Stripe directly from a customer agent unless OpenGeni explicitly returns a Stripe URL.

## Generated Customer Skills

When generating a customer-specific agent skill that teaches their coding agents how to call OpenGeni:

- Include only their non-secret base URL, workspace naming convention, and safe API examples.
- Tell the agent to read API keys from the customer's secret manager or environment, never from the skill.
- Keep the skill versioned with their integration code and add a quick smoke command that calls `/v1/config/client` and `/v1/access/me`.
- Note that session/schedule APIs exist today; first-class agent-definition APIs are roadmap until the live service exposes them.
