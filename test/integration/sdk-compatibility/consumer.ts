// Copied outside the monorepo for every published SDK. No workspace aliases,
// source imports, fetch stubs or compatibility flags may enter this consumer.
import assert from "node:assert/strict";

const fixture = JSON.parse(process.env.SDK_COMPATIBILITY_FIXTURE!);
const sdk = await import(process.env.SDK_COMPATIBILITY_MODULE || "@opengeni/sdk");
const label = process.env.SDK_COMPATIBILITY_VERSION!;
const client = new sdk.OpenGeniClient({ baseUrl: fixture.baseUrl, apiKey: fixture.token });
let proxy: ReturnType<typeof Bun.serve> | undefined;
let receiver: ReturnType<typeof Bun.serve> | undefined;
const streams = new AbortController();
let path = "package identity";
const step = (name: string) => {
  path = name;
  console.log(`[sdk ${label}] ${name}`);
};
async function drive(workspaceId: string, sessionId: string, eventId?: string) {
  const response = await fetch(`${fixture.controlUrl}/advance`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.controlToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspaceId, sessionId, eventId }),
    signal: AbortSignal.any([streams.signal, AbortSignal.timeout(60_000)]),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function until(
  actor: any,
  workspaceId: string,
  sessionId: string,
  after: number,
  type: string,
) {
  const events = [];
  for await (const event of actor.streamEvents(workspaceId, sessionId, {
    after,
    signal: AbortSignal.any([streams.signal, AbortSignal.timeout(60_000)]),
  })) {
    events.push(event);
    if (event.type === type) return events;
  }
  throw new Error(`Stream ended without ${type}`);
}

try {
  if (label !== "current") {
    const manifest = await Bun.file(
      new URL("node_modules/@opengeni/sdk/package.json", import.meta.url),
    ).json();
    assert.equal(manifest.version, label);
    assert.ok(import.meta.resolve("@opengeni/sdk").includes("/node_modules/@opengeni/sdk/dist/"));
  }

  step("organization key / workspace create and idempotent tenant mapping");
  const source = "sdk-compatibility";
  const workspaceInput = {
    name: `SDK ${label}`,
    externalSource: source,
    externalId: crypto.randomUUID(),
  };
  const workspace = await client.createWorkspace(workspaceInput);
  const ensured = await client.ensureWorkspace(workspaceInput);
  assert.equal(ensured.workspace.id, workspace.id);
  assert.equal(ensured.created, false);
  assert.equal((await client.getWorkspace(workspace.id)).name, workspaceInput.name);

  step("asUser / external member / session create");
  const user = crypto.randomUUID();
  const identity = await client.addExternalWorkspaceMember(workspace.id, {
    identity: { externalId: user, source },
    permissions: fixture.permissions,
    operationId: crypto.randomUUID(),
  });
  const actor = client.asUser(user, { source });
  assert.equal((await actor.getAccessContext()).subjectId, identity.subjectId);

  step("workspace registration / signed credential-provider and webhook callbacks");
  let credentialSecret = "";
  let webhookSecret = "";
  const credentials: any[] = [];
  const deliveries: any[] = [];
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      try {
        if (new URL(request.url).pathname === "/credentials") {
          const input = await sdk.verifyCredentialProviderRequest({
            body,
            headers: request.headers,
            secret: credentialSecret,
          });
          assert.equal(input.workspaceId, workspace.id);
          assert.equal(input.initiatingHumanSubjectId, identity.subjectId);
          assert.equal(input.initiatorContext.kind, "human");
          assert.ok(["provision", "renewal"].includes(input.purpose));
          assert.deepEqual(input.mcpServers, [{ id: "crm", url: fixture.mcpUrl }]);
          credentials.push(input);
          return Response.json({
            status: "ok",
            mcp: [
              {
                url: fixture.mcpUrl,
                headers: { Authorization: fixture.mcpToken },
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              },
            ],
          });
        }
        const verified = await sdk.verifyWebhookEvent({
          body,
          headers: request.headers,
          secret: webhookSecret,
        });
        assert.equal(verified.event.type, "turn.completed");
        assert.equal(verified.event.workspaceId, workspace.id);
        assert.equal(typeof verified.event.sessionId, "string");
        assert.equal(typeof verified.event.data, "object");
        assert.equal(verified.event.id, request.headers.get("opengeni-event-id"));
        assert.ok(verified.deliveryId);
        deliveries.push(verified.event);
        return new Response(null, { status: 204 });
      } catch (error) {
        console.error(`[sdk ${label}] callback rejected`, error);
        return new Response("callback rejected", { status: 401 });
      }
    },
  });
  const provider = await client.putWorkspaceCredentialProvider(workspace.id, {
    url: `${receiver.url.origin}/credentials`,
  });
  credentialSecret = provider.secret;
  assert.ok(credentialSecret);
  const webhook = await client.createWorkspaceWebhook(workspace.id, {
    url: `${receiver.url.origin}/webhook`,
    eventTypes: ["turn.completed"],
  });
  webhookSecret = webhook.secret;
  assert.ok(webhookSecret);

  step("published session proxy / strict browser config / create receipt");
  const handler = sdk.createSessionProxyHandler(client, {
    resolve: () => ({ workspaceId: workspace.id, user, source }),
  });
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, fetch: handler });
  const browser = new sdk.OpenGeniClient({ baseUrl: proxy.url.origin, apiContract: "strict" });
  await browser.getClientConfig();
  const requestedId = crypto.randomUUID();
  const created = await actor.createSession(workspace.id, {
    requestedSessionId: requestedId,
    idempotencyKey: crypto.randomUUID(),
    initialMessage: "Search the customer documents after approval",
    model: "scripted-model",
    sandboxBackend: "docker",
    tools: [{ kind: "mcp", id: "crm", eager: true }],
    mcpServers: [{ id: "crm", name: "CRM", url: fixture.mcpUrl, requireApproval: true }],
  });
  const sessionId = created.id;
  assert.equal(sessionId, requestedId);
  assert.equal(typeof created.initialTurnId, "string");
  assert.equal((await actor.getSession(workspace.id, sessionId)).id, sessionId);

  step("SSE / real worker / approval blocks tool callback");
  const waiting = until(browser, workspace.id, sessionId, 0, "session.requiresAction");
  void waiting.catch(() => {});
  const first = await drive(workspace.id, sessionId);
  assert.equal(first.status, "requires_action");
  assert.equal(first.calls, 0);
  assert.ok(credentials.length > 0, "worker must call the registered credential provider");
  const initialEvents = await waiting;
  const requiresAction = initialEvents.find((event) => event.type === "session.requiresAction");
  const approvalId = requiresAction.payload.approvals[0].id;

  step("approval decision / MCP callback / streamed completion");
  const approved = await browser.sendApprovalDecision(workspace.id, sessionId, {
    approvalId,
    decision: "approve",
    clientEventId: crypto.randomUUID(),
  });
  const completed = until(
    browser,
    workspace.id,
    sessionId,
    requiresAction.sequence,
    "turn.completed",
  );
  void completed.catch(() => {});
  const resumed = await drive(workspace.id, sessionId, approved.id);
  assert.equal(resumed.status, "idle");
  assert.equal(resumed.webhooks.failed, 0);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].turnId, created.initialTurnId);
  assert.equal(resumed.calls, 1, "approved MCP tool must execute exactly once");
  const completionEvents = await completed;
  assert.ok(completionEvents.some((event) => event.type === "agent.message.completed"));
  const all = await actor.listEvents(workspace.id, sessionId, { after: 0, limit: 200 });
  assert.ok(all.some((event: any) => event.type === "turn.completed"));
  assert.ok(all.some((event: any) => event.type === "user.approvalDecision"));
  const cursor = completionEvents.at(-1).sequence;

  step("follow-up message / idempotency / SSE resume");
  const message = { text: "Follow up", clientEventId: crypto.randomUUID() };
  const accepted = await actor.sendMessage(workspace.id, sessionId, message);
  assert.equal((await actor.sendMessage(workspace.id, sessionId, message)).id, accepted.id);
  const followup = until(actor, workspace.id, sessionId, cursor, "turn.completed");
  void followup.catch(() => {});
  assert.equal((await drive(workspace.id, sessionId)).status, "idle");
  const followupEvents = await followup;
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[0].id, deliveries[1].id);
  assert.ok(followupEvents.every((event) => event.sequence > cursor));
  assert.equal(new Set(followupEvents.map((event) => event.sequence)).size, followupEvents.length);

  step("files / signed upload / complete / download");
  const text = `published SDK ${label}`;
  const file = await actor.uploadFile(workspace.id, {
    filename: "compatibility.txt",
    contentType: "text/plain",
    data: text,
  });
  assert.equal((await actor.getFile(workspace.id, file.id)).id, file.id);
  const download = await actor.createFileDownloadUrl(workspace.id, file.id);
  assert.equal(await fetch(download.url).then((response) => response.text()), text);
  const artifact = await actor.getRetainedArtifact(workspace.id, file.id);
  assert.equal(artifact.available, true);
  assert.equal(artifact.artifactId, file.id);
  const retained = await actor.downloadRetainedArtifact(workspace.id, artifact);
  assert.equal(new TextDecoder().decode(retained.bytes), text);

  step("workspace API key / least-privilege errors / revocation");
  const key = await client.createApiKey(workspace.id, {
    name: "SDK reader",
    permissions: ["workspace:read", "sessions:read"],
  });
  const reader = new sdk.OpenGeniClient({ baseUrl: fixture.baseUrl, apiKey: key.token });
  assert.equal((await reader.getSession(workspace.id, sessionId)).id, sessionId);
  await assert.rejects(
    reader.sendMessage(workspace.id, sessionId, "forbidden"),
    (error: any) => error.status === 403,
  );
  await assert.rejects(
    actor.getSession(workspace.id, crypto.randomUUID()),
    (error: any) => error.status === 404,
  );
  await client.deleteApiKey(workspace.id, key.apiKey.id);
  await assert.rejects(reader.getWorkspace(workspace.id), (error: any) => error.status === 401);
  console.log(`[sdk ${label}] PASS all customer paths`);
} catch (error) {
  console.error(`[sdk ${label}] FAIL ${path}`, error);
  process.exitCode = 1;
} finally {
  streams.abort();
  proxy?.stop(true);
  receiver?.stop(true);
}
