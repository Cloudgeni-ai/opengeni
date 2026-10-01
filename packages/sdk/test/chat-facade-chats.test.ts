import { describe, expect, test } from "bun:test";
import { OpenGeni } from "../src/chat";
import { OpenGeniApiError, OpenGeniSetupError } from "../src/errors";
import type { Chats } from "../src/chats";
import type { ChatOptions } from "../src/chat";
import type { CreateSessionRequest } from "../src/types";
import { fakeServer, ORGANIZATION_ID } from "./chat-helpers";

describe("chat facade chats and agent", () => {
  function legacyServer(canonical = false) {
    const server = fakeServer();
    const attempts: CreateSessionRequest[] = [];
    const makeFacade = () =>
      new OpenGeni({
        apiKey: "og_test",
        organizationId: ORGANIZATION_ID,
        baseUrl: "https://api.test",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/v1/config/client")
            throw new Error("Older server has no admission config.");
          if (request.method === "POST" && path.endsWith("/sessions")) {
            const body = (await request.json()) as CreateSessionRequest;
            attempts.push(body);
            if (body.agent !== undefined)
              return Response.json(
                {
                  ...(canonical
                    ? {
                        code: "SESSION_CREATE_REJECTED",
                        message: "Agent configuration is not enabled.",
                        details: { code: "agent_config_not_enabled" },
                      }
                    : {
                        error: {
                          code: "agent_config_not_enabled",
                          message: "Agent configuration is not enabled.",
                        },
                      }),
                },
                { status: 422 },
              );
          }
          return server.fetch(input, init);
        },
      });
    return { server, attempts, makeFacade };
  }

  test.each([
    [undefined, false],
    ["alice", false],
    [undefined, true],
    ["alice", true],
  ] as const)(
    "implicit renderer retries once and caches rejection (user=%s, canonical=%s)",
    async (user, canonical) => {
      const legacy = legacyServer(canonical);
      const og = legacy.makeFacade();
      const first = await og.chat({ tenant: "acme", user, conversation: "1" });
      const alreadyOpened = await og.chat({ tenant: "acme", user, conversation: "2" });
      await first.send("hi");
      expect(legacy.attempts).toHaveLength(2);
      expect(legacy.attempts[0]!.agent).toEqual({ renderer: "markdown" });
      expect(legacy.attempts[1]).not.toHaveProperty("agent");
      const { agent: _agent, ...initial } = legacy.attempts[0]!;
      expect(legacy.attempts[1]).toEqual(initial);
      expect(legacy.server.creates[0]).toMatchObject(
        user
          ? { visibility: "private", agentAccess: "session", memoryScope: "user" }
          : { visibility: "workspace", agentAccess: "session", memoryScope: "off" },
      );
      await alreadyOpened.send("next");
      expect(legacy.attempts).toHaveLength(3);
      expect(legacy.attempts[2]).not.toHaveProperty("agent");
      const fresh = legacy.makeFacade();
      await (await fresh.chat({ tenant: "acme", user, conversation: "3" })).send("fresh");
      expect(legacy.attempts).toHaveLength(5);
      expect(legacy.attempts[3]!.agent).toEqual({ renderer: "markdown" });
      expect(legacy.attempts[4]).not.toHaveProperty("agent");
    },
  );

  test("canonical explicit-agent 422 preserves envelope details and never strips configuration", async () => {
    const legacy = legacyServer(true);
    const og = legacy.makeFacade();
    const chat = await og.chat({
      tenant: "acme",
      conversation: "1",
      agent: { renderer: "markdown" },
    });
    let failure: unknown;
    try {
      await chat.send("hi");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 422,
      code: "SESSION_CREATE_REJECTED",
      details: { code: "agent_config_not_enabled" },
      retryable: false,
    });
    expect((failure as Error).message).toContain("OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true");
    expect(legacy.attempts).toHaveLength(1);
    expect(legacy.attempts[0]!.agent).toEqual({ renderer: "markdown" });
  });

  test.each([
    { agent: { identity: "Acme", capabilities: "none" } },
    { agent: { renderer: "markdown" } },
    { create: { agent: { renderer: "opengeni" } } },
    { create: { agent: { instructions: "Brief" } } },
    { agent: {} },
  ] satisfies Partial<ChatOptions>[])(
    "explicit agent config never falls back, even after cached rejection (%j)",
    async (fields) => {
      const legacy = legacyServer();
      const og = legacy.makeFacade();
      await (await og.chat({ tenant: "acme", conversation: "implicit" })).send("warm");
      const start = legacy.attempts.length;
      const chat = await og.chat({ tenant: "acme", conversation: "explicit", ...fields });
      let failure: unknown;
      try {
        await chat.send("explicit");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenGeniApiError);
      expect(failure).toMatchObject({
        status: 422,
        code: "agent_config_not_enabled",
        retryable: false,
      });
      expect((failure as Error).message).toContain("OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED=true");
      expect((failure as Error).message).toContain("deployment operator");
      expect(legacy.attempts).toHaveLength(start + 1);
      expect(legacy.attempts.at(-1)!.agent).toMatchObject(fields.agent ?? fields.create!.agent!);
      expect(legacy.server.creates).toHaveLength(1);
    },
  );

  test("no-user omission preserves legacy defaults on an admitting server; explicit shared remains shared", async () => {
    const server = fakeServer();
    await (await server.og.chat({ tenant: "acme", conversation: "legacy" })).send("hi");
    expect(server.creates[0]).toMatchObject({
      visibility: "workspace",
      agentAccess: "session",
      memoryScope: "off",
      agent: { renderer: "markdown" },
    });
    await (
      await server.og.chat({ tenant: "acme", conversation: "shared", chats: "shared" })
    ).send("hi");
    expect(server.creates[1]).toMatchObject({
      visibility: "workspace",
      agentAccess: "workspace",
      memoryScope: "workspace",
    });
    await (
      await server.og.chat({
        tenant: "acme",
        conversation: "legacy-reach",
        agentAccess: "workspace",
      })
    ).send("hi");
    expect(server.creates[2]).toMatchObject({
      visibility: "workspace",
      agentAccess: "workspace",
      memoryScope: "workspace",
    });
    await (
      await server.og.chat({
        tenant: "acme",
        conversation: "overrides",
        memory: false,
        create: {
          visibility: "workspace",
          agentAccess: "workspace",
          memoryScope: "workspace",
        },
      })
    ).send("hi");
    expect(server.creates[3]).toMatchObject({
      visibility: "workspace",
      agentAccess: "workspace",
      memoryScope: "workspace",
    });
  });

  test("explicit private without a user is a clear error before any request", async () => {
    const server = fakeServer();
    const result = server.og.chat({ tenant: "acme", conversation: "private", chats: "private" });
    await expect(result).rejects.toMatchObject({ code: "chats_requires_user" });
    await expect(result).rejects.toThrow('chats: "private" requires an authenticated product user');
    expect(server.requests).toHaveLength(0);
  });

  test.each([
    { code: "agent_config_not_enabled", status: 503 },
    { code: "agent_config_invalid", status: 422 },
  ])("only the exact admission 422 triggers implicit fallback (%j)", async (error) => {
    const server = fakeServer();
    let creates = 0;
    const og = new OpenGeni({
      apiKey: "og_test",
      organizationId: ORGANIZATION_ID,
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/sessions")) {
          creates += 1;
          return Response.json({ error }, { status: error.status });
        }
        return server.fetch(input, init);
      },
    });
    await expect(
      (await og.chat({ tenant: "acme", conversation: "1" })).send("hi"),
    ).rejects.toMatchObject(error);
    expect(creates).toBe(1);
  });

  test("the fallback is attempted only once when even the agent-free request is refused", async () => {
    const server = fakeServer();
    const bodies: CreateSessionRequest[] = [];
    const og = new OpenGeni({
      apiKey: "og_test",
      organizationId: ORGANIZATION_ID,
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/sessions")) {
          bodies.push((await request.json()) as CreateSessionRequest);
          return Response.json({ code: "agent_config_not_enabled" }, { status: 422 });
        }
        return server.fetch(input, init);
      },
    });
    await expect(
      (await og.chat({ tenant: "acme", conversation: "1" })).send("hi"),
    ).rejects.toMatchObject({
      status: 422,
      code: "agent_config_not_enabled",
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("agent");
  });

  test.each([
    [undefined, "private", "session", "user"],
    ["private", "private", "session", "user"],
    ["shared", "workspace", "workspace", "workspace"],
  ] as const)(
    "maps %s exactly and defaults to markdown",
    async (chats, visibility, agentAccess, memoryScope) => {
      const server = fakeServer();
      await (
        await server.og.chat({ tenant: "acme", user: "alice", conversation: "1", chats })
      ).send("hi");
      expect(server.creates[0]).toMatchObject({
        visibility,
        agentAccess,
        memoryScope,
        agent: { renderer: "markdown" },
      });
      expect(server.creates[0]).not.toHaveProperty("chats");
    },
  );

  test("agent and raw create overrides win field by field, while undefined keeps defaults", async () => {
    const server = fakeServer();
    await (
      await server.og.chat({
        tenant: "acme",
        user: "alice",
        conversation: "1",
        chats: "shared",
        agent: {
          identity: "Acme",
          capabilities: "none",
          instructions: "Brief",
          renderer: "opengeni",
        },
        create: {
          visibility: "private",
          agentAccess: "session",
          memoryScope: "off",
          agent: { identity: "Override" },
        },
      })
    ).send("hi");
    expect(server.creates[0]).toMatchObject({
      visibility: "private",
      agentAccess: "session",
      memoryScope: "off",
      agent: {
        identity: "Override",
        capabilities: "none",
        instructions: "Brief",
        renderer: "opengeni",
      },
    });
    await (
      await server.og.chat({
        tenant: "acme",
        user: "alice",
        conversation: "2",
        agentAccess: "user",
        memory: false,
        agent: { capabilities: "none", identity: "Acme", instructions: "Brief" },
        create: {
          visibility: undefined,
          agentAccess: undefined,
          memoryScope: undefined,
          agent: {
            renderer: undefined,
            capabilities: undefined,
            identity: null,
            instructions: undefined,
          },
        },
      })
    ).send("hi");
    expect(server.creates[1]).toMatchObject({
      visibility: "private",
      agentAccess: "user",
      memoryScope: "off",
      agent: { renderer: "markdown", capabilities: "none", identity: null, instructions: "Brief" },
    });
  });

  test("isolated facade provisions the user workspace before acting as that user", async () => {
    const server = fakeServer();
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const og = new OpenGeni({
      apiKey: "og_test",
      organizationId: ORGANIZATION_ID,
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/external-members")) {
          requests.push({ path, body: (await request.json()) as Record<string, unknown> });
          return Response.json({});
        }
        return server.fetch(input, init);
      },
    });
    await (
      await og.chat({ tenant: "acme", user: "alice", conversation: "1", chats: "isolated" })
    ).send("hi");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.identity).toEqual({ source: "app", externalId: "alice" });
    expect(server.creates[0]).toMatchObject({
      visibility: "private",
      agentAccess: "session",
      memoryScope: "user",
    });
    await og.sessions.list({ tenant: "acme", user: "alice", chats: "isolated" });
    expect(requests).toHaveLength(1);
    await expect(
      og.chat({ workspaceId: "id", user: "alice", conversation: "2", chats: "isolated" }),
    ).rejects.toThrow("tenant");
    await expect(og.chat({ tenant: "acme", conversation: "2", chats: "isolated" })).rejects.toThrow(
      "authenticated",
    );
  });

  test("private setting failure surfaces from lazy facade create as OpenGeniSetupError", async () => {
    const server = fakeServer();
    const og = new OpenGeni({
      apiKey: "og_test",
      organizationId: ORGANIZATION_ID,
      baseUrl: "https://api.test",
      fetch: (input, init) =>
        new Request(input, init).method === "POST"
          ? Promise.resolve(
              Response.json(
                { code: "SESSION_TENANCY_NOT_ACTIVATED", message: "Disabled" },
                { status: 409 },
              ),
            )
          : server.fetch(input, init),
    });
    await expect(
      (
        await og.chat({
          tenant: "acme",
          user: "alice",
          conversation: "1",
          chats: "private" as Chats,
        })
      ).send("hi"),
    ).rejects.toBeInstanceOf(OpenGeniSetupError);
  });
});
