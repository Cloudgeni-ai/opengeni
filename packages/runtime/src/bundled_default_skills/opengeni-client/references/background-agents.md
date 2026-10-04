# Background agents

Server-side work uses the same workspaces the proxy creates. Translate the
product's ids first:

```ts
const workspaceId = await og.workspaceId({ tenant: team.id }); // or { user: user.id }
```

Ask the user for schedule details (day, time, time zone, where results go)
only when the requested feature is itself scheduled, and say why.

## A chat started by the server

Create the session as the user, with a stable idempotency key, so it appears in
their chat list. Opengeni adds the user to the workspace if needed:

```ts
const session = await og.client
  .asUser(user.id, { source: og.source })
  .createSession(workspaceId, {
    initialMessage: `Summarize ticket ${ticket.id}.`,
    idempotencyKey: `ticket-summary:${ticket.id}`,
    agent: { identity, capabilities: "none" },
    sandboxBackend: "none",
  });
```

Render it with `SessionConversation`; see [Existing chat UI](existing-chat-ui.md).
For a text reply without UI (a bot, an email), the chat facade is shorter:

```ts
const chat = await og.chat({ tenant: team.id, user: user.id, conversation: `ticket:${ticket.id}` });
const reply = await chat.send("Summarize this ticket.");
```

## Schedules

```ts
await og.client.createScheduledTask(workspaceId, {
  name: "Morning digest",
  schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
  agentConfig: {
    prompt: "Summarize yesterday's new tickets and flag anything urgent.",
    agent: { capabilities: { from: "none", knowledge: true } },
    tools: [{ kind: "mcp", id: serverId }],
  },
});
```

No user is present to refresh a per-user token, so scheduled agents reach the
product through a workspace OpenAPI Integration or MCP connection selected by
id in `tools`; see [Tools and auth](tools-and-auth.md#openapi-integrations).
Writes need `autoApprovedTools`, since nobody is there to approve them. Results
go back through the product's own tools.

## Jobs with no user

Attribute automation to a named service instead of inventing a user:

```ts
await og.client.asService("acme:reports", { jobId: job.id }).createSession(workspaceId, {
  initialMessage: "Summarize the latest report changes.",
  idempotencyKey: `reports:${job.id}`,
  tools: [{ kind: "mcp", id: serverId }],
});
```

`asService` records who started the work; it grants no extra permissions.

## Knowing when work finishes

Subscribe a signed webhook to `turn.completed`, `turn.failed`,
`session.requiresAction`, or `session.humanInput.requested`. One organization
webhook covers every tenant workspace:

```ts
import {
  createOrganizationWebhook,
  verifyWebhookEvent,
} from "@opengeni/sdk/workspace-integrations";

const organizationId = await og.resolveOrganizationId(); // read from the API key
const { secret } = await createOrganizationWebhook(og.client, organizationId, {
  url: "https://app.example.com/api/opengeni-events",
  eventTypes: ["turn.completed", "session.requiresAction"],
  workspaceFilter: null,
});

// In the receiver, with the exact raw body:
const { event } = await verifyWebhookEvent({ body, headers: request.headers, secret });
```

Store the secret once. Delivery is at least once and unordered: dedupe on
`event.id`, then read the session for current state. For one workspace,
`og.client.createWorkspaceWebhook(workspaceId, { url, eventTypes })` does the
same.
