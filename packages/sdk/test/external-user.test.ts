import { expect, test } from "bun:test";
test("identity link SDK retains server actor and passes explicit confirmation without query secrets", async () => {
  const calls: { path: string; body: unknown; actor: string | null }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example",
    apiKey: "fixture-key",
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      expect(new URL(String(url)).search).toBe("");
      return Response.json({});
    },
  }).asUser("host-user");
  await client.beginIdentityLink("workspace/one", {
    permissions: ["sessions:read"],
    expiresAt: null,
  });
  await client.getIdentityLink("workspace/one", "link/one");
  await client.previewIdentityLink("workspace/one", "link/one", "x".repeat(43));
  await client.confirmIdentityLink("workspace/one", "link/one", {
    challenge: "x".repeat(43),
    expectedRevision: 1,
    permissions: ["sessions:read"],
  });
  await client.revokeIdentityLink("workspace/one", "link/one", 2);
  expect(calls.map((call) => call.path)).toEqual([
    "/v1/workspaces/workspace%2Fone/identity-links",
    "/v1/workspaces/workspace%2Fone/identity-links/link%2Fone",
    "/v1/workspaces/workspace%2Fone/identity-links/link%2Fone/preview",
    "/v1/workspaces/workspace%2Fone/identity-links/link%2Fone/confirm",
    "/v1/workspaces/workspace%2Fone/identity-links/link%2Fone/revoke",
  ]);
  expect(calls.every((call) => call.actor === calls[0]!.actor && call.actor !== null)).toBe(true);
  expect(calls[4]!.body).toEqual({ expectedRevision: 2 });
});
import { OpenGeniClient } from "../src/index";

test("linked actor selection is explicit and isolated from service and external clients", async () => {
  const actors: unknown[] = [];
  const service = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (_url, init) => {
      const header = new Headers(init?.headers).get("x-opengeni-external-actor");
      actors.push(header ? JSON.parse(decodeURIComponent(header)) : null);
      return Response.json({});
    },
  });
  const external = service.asUser("Person/CaseSensitive", { source: "product" });
  const linkId = crypto.randomUUID();
  const linked = external.asLinkedUser("Person/CaseSensitive", {
    source: "product",
    linkId,
    expectedLinkRevision: 2,
  });
  await linked.getIdentityLink("workspace", linkId);
  await external.getIdentityLink("workspace", linkId);
  await service.getIdentityLink("workspace", linkId);
  expect(actors).toEqual([
    {
      mode: "linked_native",
      identity: { externalId: "Person/CaseSensitive", source: "product" },
      linkId,
      expectedLinkRevision: 2,
    },
    { mode: "external", identity: { externalId: "Person/CaseSensitive", source: "product" } },
    null,
  ]);
  expect(linked.asUser("another")).not.toBe(linked);
  for (const revision of [0, -1, 1.5, NaN, Infinity]) {
    expect(() =>
      service.asLinkedUser("person", { linkId, expectedLinkRevision: revision }),
    ).toThrow();
  }
  expect(() =>
    service.asLinkedUser("person", { linkId: "not-a-link", expectedLinkRevision: 2 }),
  ).toThrow();
  expect(actors).toHaveLength(3);
});

test("host binding registry calls retain external actor, operation identity and observed generation", async () => {
  const calls: { path: string; method: string | undefined; body: unknown; actor: string | null }[] =
    [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return Response.json({});
    },
  }).asUser("host-owner", { source: "product" });
  const input = {
    operationId: crypto.randomUUID(),
    definition: {
      serverId: "mcp",
      destinationUrl: "https://mcp.example/tools",
      connectionRef: {
        authoritySource: "host" as const,
        connectionId: "opaque",
        providerDomain: "mcp.example",
      },
    },
  };
  await client.createHostMcpBinding("workspace/encoded", input);
  await client.getHostMcpBinding("workspace/encoded", "binding/encoded");
  await client.revokeHostMcpBinding("workspace/encoded", "binding/encoded", {
    expectedGeneration: 7,
  });
  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ["POST", "/v1/workspaces/workspace%2Fencoded/host-mcp-bindings"],
    ["GET", "/v1/workspaces/workspace%2Fencoded/host-mcp-bindings/binding%2Fencoded"],
    ["POST", "/v1/workspaces/workspace%2Fencoded/host-mcp-bindings/binding%2Fencoded/revoke"],
  ]);
  expect(calls[0]!.body).toEqual(input);
  expect(calls[2]!.body).toEqual({ expectedGeneration: 7 });
  const grantInput = {
    operationId: crypto.randomUUID(),
    bindingId: crypto.randomUUID(),
    expectedBindingGeneration: 1,
    grant: {
      scope: "user" as const,
      mode: "always" as const,
      context: "user_private" as const,
      workspaceSharedAcknowledged: false,
    },
  };
  await client.issueHostMcpDelegation("workspace/encoded", grantInput);
  await client.getHostMcpDelegation("workspace/encoded", "delegation/encoded");
  await client.revokeHostMcpDelegation("workspace/encoded", "delegation/encoded", {
    expectedGeneration: 2,
  });
  expect(calls.slice(3).map((call) => [call.method, call.path])).toEqual([
    ["POST", "/v1/workspaces/workspace%2Fencoded/host-mcp-delegations"],
    ["GET", "/v1/workspaces/workspace%2Fencoded/host-mcp-delegations/delegation%2Fencoded"],
    ["POST", "/v1/workspaces/workspace%2Fencoded/host-mcp-delegations/delegation%2Fencoded/revoke"],
  ]);
  expect(calls[3]!.body).toEqual(grantInput);
  expect(calls[5]!.body).toEqual({ expectedGeneration: 2 });
  const selectedStart = {
    initialMessage: "Start",
    selectedHostMcpDelegations: [
      { serverId: "mcp", delegationId: grantInput.operationId, generation: 1 },
    ],
  };
  await client.createSession("workspace/encoded", selectedStart);
  expect(calls[6]!.path).toBe("/v1/workspaces/workspace%2Fencoded/sessions");
  expect(calls[6]!.body).toEqual(selectedStart);
  const followup = {
    text: "Continue",
    clientEventId: crypto.randomUUID(),
    selectedHostMcpDelegations: selectedStart.selectedHostMcpDelegations,
  };
  await client.sendMessage("workspace", "session", followup);
  expect(calls[7]!.body).toEqual({
    type: "user.message",
    clientEventId: followup.clientEventId,
    payload: {
      text: followup.text,
      selectedHostMcpDelegations: followup.selectedHostMcpDelegations,
    },
  });
  await client.steerMessage("workspace", "session", followup);
  expect(calls[8]!.body).toEqual(followup);
  const schedule = {
    name: "Product task",
    schedule: { type: "manual" as const },
    agentConfig: { prompt: "Read product data" },
    selectedHostMcpDelegations: selectedStart.selectedHostMcpDelegations,
  };
  await client.createScheduledTask("workspace", schedule);
  expect(calls[9]!.body).toEqual(schedule);
  await client.updateScheduledTask("workspace", "task", { selectedHostMcpDelegations: [] });
  expect(calls[10]!.body).toEqual({ selectedHostMcpDelegations: [] });
  for (const call of calls)
    expect(JSON.parse(decodeURIComponent(call.actor!))).toMatchObject({
      mode: "external",
      identity: { externalId: "host-owner", source: "product" },
    });
});

test("generic MCP OAuth forwards the exact host return URL in external mode", async () => {
  let body: unknown;
  let actor: string | null = null;
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      actor = new Headers(init?.headers).get("x-opengeni-external-actor");
      return Response.json({});
    },
  }).asUser("host-user");
  const request = {
    mcpUrl: "https://mcp.example/tools",
    returnUrl: "https://HOST.example:443/Done?x=%2f#fragment",
  };
  await client.startConnectionOAuth("workspace", request);
  expect(body).toEqual(request);
  expect(actor).not.toBeNull();
});

test("external lifecycle preserves service scope, optimistic revision, operation ID and cancellation", async () => {
  const calls: { path: string; method: string | undefined; body: unknown; actor: string | null }[] =
    [];
  const client = new OpenGeniClient({
    baseUrl: "https://fixture.invalid",
    apiKey: "synthetic",
    fetch: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        actor: new Headers(init?.headers).get("x-opengeni-external-actor"),
      });
      return Response.json({});
    },
  });
  const request = {
    kind: "suspend" as const,
    expectedAuthorizationRevision: 7,
    operationId: crypto.randomUUID(),
  };
  await client.updateExternalIdentityMembership("org/one", "member/one", request);
  expect(calls).toEqual([
    {
      path: "/v1/organizations/org%2Fone/external-members/member%2Fone",
      method: "PATCH",
      body: request,
      actor: null,
    },
  ]);
  const abort = new AbortController();
  abort.abort();
  await expect(
    client.updateExternalIdentityMembership("org/one", "member/one", request, {
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("Connect disconnect forwards the observed version and rejects invalid versions before fetch", async () => {
  const urls: string[] = [];
  const transport = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    fetch: async (url) => {
      urls.push(String(url));
      return Response.json({});
    },
  }).connectTransport();
  await transport.disconnect("workspace", "account", { expectedVersion: 3 });
  expect(new URL(urls[0]!).searchParams.get("expectedVersion")).toBe("3");
  for (const expectedVersion of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      transport.disconnect("workspace", "account", { expectedVersion }),
    ).rejects.toThrow();
  }
  expect(urls).toHaveLength(1);
});

test("Connect attempt transport preserves bodies, revisions and escaped identifiers", async () => {
  const calls: Array<{ path: string; method: string | undefined; body: unknown }> = [];
  const transport = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    apiKey: "synthetic",
    fetch: async (url, input) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: input?.method,
        body: input?.body ? JSON.parse(String(input.body)) : undefined,
      });
      return Response.json({ id: "attempt" });
    },
  })
    .asUser("host-user")
    .connectTransport();
  const begin = {
    providerId: "provider",
    ownership: "workspace" as const,
    returnUrl: "https://HOST.example:443/finish?x=%2f#fragment",
    idempotencyKey: "begin-once",
  };
  const advance = {
    expectedRevision: 2,
    idempotencyKey: "advance-once",
    action: { type: "retry" as const },
  };
  const cancel = { expectedRevision: 3, idempotencyKey: "cancel-once" };
  await transport.pending("space/one");
  await transport.begin("space/one", begin);
  await transport.get("space/one", "attempt/one");
  await transport.advance("space/one", "attempt/one", advance);
  await transport.cancel("space/one", "attempt/one", cancel);
  const root = "/v1/workspaces/space%2Fone/connect/attempts";
  expect(calls).toEqual([
    { path: root, method: "GET", body: undefined },
    { path: root, method: "POST", body: begin },
    { path: `${root}/attempt%2Fone`, method: "GET", body: undefined },
    { path: `${root}/attempt%2Fone/advance`, method: "POST", body: advance },
    { path: `${root}/attempt%2Fone/cancel`, method: "POST", body: cancel },
  ]);
});

test("Connect transport retains the actor, forwards cancellation and maps disconnect to local revocation", async () => {
  const calls: Array<{ path: string; method: string | undefined; headers: Headers }> = [];
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    apiKey: "synthetic",
    fetch: async (url, input) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: input?.method,
        headers: new Headers(input?.headers),
      });
      return Response.json([]);
    },
  }).asUser("host-user");
  const transport = client.connectTransport();
  await transport.catalog("workspace");
  await transport.accounts("workspace");
  await transport.disconnect("workspace", "connection");
  expect(calls.map((call) => [call.method, call.path])).toEqual([
    ["GET", "/v1/workspaces/workspace/connect/catalog"],
    ["GET", "/v1/workspaces/workspace/connect/accounts"],
    ["DELETE", "/v1/workspaces/workspace/connections/connection"],
  ]);
  expect(
    calls.every(
      (call) =>
        JSON.parse(decodeURIComponent(call.headers.get("x-opengeni-external-actor")!)).identity
          .externalId === "host-user",
    ),
  ).toBe(true);
  const abort = new AbortController();
  abort.abort();
  await expect(transport.pending("workspace", { signal: abort.signal })).rejects.toThrow();
  await expect(
    transport.disconnect("workspace", "connection", { signal: abort.signal }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(3);
});

test("Connect begin retains the exact host return URL and exposes durable reads", async () => {
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    apiKey: "synthetic-key",
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ id: "attempt" });
    },
  }).asUser("external");
  const request = {
    providerId: "provider",
    ownership: "workspace" as const,
    returnUrl: "https://HOST.example:443/finish?x=%2f#fragment",
    idempotencyKey: "once",
  };
  await client.beginConnect("workspace", request);
  await client.getConnectAttempt("workspace", "attempt");
  await client.listPendingConnectAttempts("workspace");
  expect(calls[0]?.body).toEqual(request);
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/v1/workspaces/workspace/connect/attempts",
    "/v1/workspaces/workspace/connect/attempts/attempt",
    "/v1/workspaces/workspace/connect/attempts",
  ]);
});

test("asUser isolates concurrent actor headers and leaves the service client unchanged", async () => {
  const requests: Headers[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    apiKey: "synthetic-key",
    fetch: async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return Response.json([]);
    },
  });
  const first = client.asUser("user:opaque/😀", { source: "host" });
  const second = client.asUser("other");
  await Promise.all([first.listWorkspaces(), second.listWorkspaces(), client.listWorkspaces()]);
  const actors = requests.map((headers) => headers.get("x-opengeni-external-actor"));
  expect(actors.filter((actor) => actor === null)).toHaveLength(1);
  expect(actors.filter(Boolean).map((actor) => JSON.parse(decodeURIComponent(actor!)))).toEqual([
    { mode: "external", identity: { externalId: "user:opaque/😀", source: "host" } },
    { mode: "external", identity: { externalId: "other", source: "default" } },
  ]);
  expect(requests.every((headers) => headers.get("authorization") === "Bearer synthetic-key")).toBe(
    true,
  );
});

test("asUser assertion cannot be replaced by case-variant custom headers", async () => {
  let headers!: Headers;
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    headers: () => ({ "X-OpenGeni-External-Actor": "wrong" }),
    fetch: async (_url, init) => {
      headers = new Headers(init?.headers);
      return Response.json([]);
    },
  });
  await client.asUser("correct").listWorkspaces();
  expect(
    JSON.parse(decodeURIComponent(headers.get("x-opengeni-external-actor")!)).identity.externalId,
  ).toBe("correct");
  expect(() => client.asUser("")).toThrow("Invalid");
  expect(() => client.asUser("😀".repeat(257))).toThrow("Invalid");
  expect(() => client.asUser("nul\0id")).toThrow("Invalid");
  expect(() => client.asUser("\uD800")).toThrow("Invalid");
});
