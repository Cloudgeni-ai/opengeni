import { describe, expect, test } from "bun:test";
import { OpenGeni } from "../src/chat";
import { OpenGeniSetupError } from "../src/errors";
import type { Chats } from "../src/chats";
import { fakeServer, ORGANIZATION_ID } from "./chat-helpers";

describe("chat facade chats and agent", () => {
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
