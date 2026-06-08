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

## Replay And Retry

- Persist the latest event sequence seen by the client.
- On reconnect, list events after the last known sequence before reopening the stream.
- Retry idempotent reads and stream reconnects with bounded backoff.
- Do not blindly retry session creation unless the API exposes an idempotency key for the operation in the current contract.
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
