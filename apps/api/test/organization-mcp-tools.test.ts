import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolGatewayInvokeResponse,
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import { outsideAgentReach, OUTSIDE_AGENT_GRANT_METADATA_KEY } from "@opengeni/core";

import { claimsStoredApproval } from "../src/mcp/stored-approval-claim";
import { createConnectionRateLimiter } from "../src/mcp/connection-rate-limit";
import {
  buildOrganizationMcpServer,
  type OrganizationActionContext,
} from "../src/organization-mcp";
import {
  NAMED_TOOLS,
  NAMED_TOOL_ALIASES,
  skillFrontmatterName,
  skillKey,
  toolApprovalUrl,
  waitState,
} from "../src/organization-mcp-tools";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const subjectId = "user:33333333-3333-4333-8333-333333333333";
const sessionId = "55555555-5555-4555-8555-555555555555";
const agentId = "66666666-6666-4666-8666-666666666666";

const full: OrganizationAccessPolicy = {
  preset: "full",
  permissions: organizationAccessPresetPermissions("full"),
  workspaceScope: { kind: "all" },
};

type Route = (request: Request, body: unknown) => Response | Promise<Response> | undefined;

function firstPartyAnswer(toolName: string, value: unknown, isError = false): Response {
  return Response.json(
    ToolGatewayInvokeResponse.parse({
      operationId: crypto.randomUUID(),
      tool: {
        version: 1,
        definitionDigest: "a".repeat(64),
        entry: {
          identity: { serverId: "opengeni", toolName },
          modelName: toolName,
          codemodePath: ["opengeni", toolName],
          inputSchema: { type: "object" },
          source: "opengeni",
          approval: "none",
        },
      },
      result: {
        content: [{ type: "text", text: JSON.stringify(value) }],
        ...(isError ? { isError: true } : {}),
      },
    }),
  );
}

async function connect(
  routes: Record<string, Route>,
  extra: Partial<OrganizationActionContext> = {},
  workspaces: Array<{ id: string; name: string }> = [{ id: workspaceId, name: "Team" }],
) {
  const seen: Array<{
    method: string;
    path: string;
    body: unknown;
    request: Request;
  }> = [];
  const server = buildOrganizationMcpServer({
    caller: {
      kind: "person",
      accountId: organizationId,
      subjectId,
      access: full,
    },
    origin: "https://api.example.test",
    publicOrigin: "https://app.example.test",
    outsideAgent: { appData: "viewer" },
    ...extra,
    dispatch: async (request) => {
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.clone().text();
      const body = text ? JSON.parse(text) : undefined;
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        body,
        request,
      });
      if (request.method === "GET" && url.pathname === "/v1/workspaces")
        return Response.json(workspaces);
      const key = `${request.method} ${url.pathname}`;
      if (key.endsWith("/tools/invoke")) {
        const toolName = (body as { target: { identity: { toolName: string } } }).target.identity
          .toolName;
        const handled = routes[`tool ${toolName}`]?.(request, body);
        if (handled) return await handled;
      }
      const handled = routes[key]?.(request, body);
      if (handled) return await handled;
      return Response.json({ error: { message: `no route ${key}` } }, { status: 404 });
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)
      .map((block) => block.text)
      .join("");
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain-text answers stay text.
    }
    return {
      isError: result.isError === true,
      value: value as Record<string, any>,
    };
  };
  return { client, call, seen };
}

describe("organization MCP named tools", () => {
  test("lists every named tool with the generic ones; aliases work but aren't listed", async () => {
    const { client, call } = await connect({
      [`GET /v1/workspaces/${workspaceId}/artifact-catalog`]: () => Response.json({ items: [] }),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const spec of NAMED_TOOLS) expect(names).toContain(spec.name);
    for (const alias of Object.keys(NAMED_TOOL_ALIASES)) expect(names).not.toContain(alias);
    expect(names).toContain("opengeni_action_call");
    expect((await call("sites_list", {})).isError).toBe(false);
  });

  test("uses the only workspace, the connection's default, or lists the choices", async () => {
    const two = [
      { id: workspaceId, name: "Team" },
      { id: otherWorkspaceId, name: "Other" },
    ];
    const agents = {
      [`GET /v1/workspaces/${workspaceId}/agents`]: () => Response.json([]),
    };
    const ambiguous = await connect(agents, {}, two);
    const refused = await ambiguous.call("agents_list", {});
    expect(refused.isError).toBe(true);
    expect(refused.value.workspaces).toHaveLength(2);
    let saved: string | null = null;
    const withDefault = await connect(
      agents,
      {
        connection: {
          id: "77777777-7777-4777-8777-777777777777",
          settings: {
            defaultWorkspaceId: workspaceId,
            appDataAccess: "viewer",
          },
          setDefaultWorkspace: async (id) => {
            saved = id;
          },
        },
      },
      two,
    );
    expect((await withDefault.call("agents_list", {})).isError).toBe(false);
    const used = await withDefault.call("workspace_use", {
      workspaceId: otherWorkspaceId,
    });
    expect(used.value.defaultWorkspace.id).toBe(otherWorkspaceId);
    expect(saved).toBe(otherWorkspaceId);
    const unknown = await withDefault.call("workspace_use", {
      workspaceId: "99999999-9999-4999-8999-999999999999",
    });
    expect(unknown.isError).toBe(true);
  });

  test("delegate resolves the agent by name, repeats the same key on a retry, and uses the default visibility", async () => {
    const created: unknown[] = [];
    const { call } = await connect({
      [`GET /v1/workspaces/${workspaceId}/agents`]: () =>
        Response.json({ agents: [{ id: agentId, name: "Reviewer" }] }),
      [`GET /v1/workspaces/${workspaceId}/session-tenancy/capabilities`]: () =>
        Response.json({
          activated: true,
          canCreatePrivate: false,
          reason: "managed_session_required",
          defaultVisibility: "private",
        }),
      [`POST /v1/workspaces/${workspaceId}/sessions`]: (_request, body) => {
        created.push(body);
        return Response.json({ session: { id: sessionId } }, { status: 201 });
      },
    });
    const args = {
      message: "Review the open PR",
      agent: "reviewer",
      repository: "acme/app",
      branch: "feature",
    };
    const first = await call("delegate", args);
    const second = await call("delegate", args);
    expect(first.isError).toBe(false);
    expect(first.value).toMatchObject({
      sessionId,
      workspaceId,
      cursor: 0,
      visibility: "workspace",
      url: `https://app.example.test/workspaces/${workspaceId}/sessions/${sessionId}`,
    });
    expect(second.value.idempotencyKey).toBe(first.value.idempotencyKey);
    expect(created[0]).toMatchObject({
      initialMessage: "Review the open PR",
      agentId,
      visibility: "workspace",
      idempotencyKey: first.value.idempotencyKey,
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/acme/app",
          ref: "feature",
        },
      ],
    });
  });

  test("delegate names the agents when the name matches none, and says a retry is safe on errors", async () => {
    const { call } = await connect({
      [`GET /v1/workspaces/${workspaceId}/agents`]: () =>
        Response.json([{ id: agentId, name: "Reviewer" }]),
      [`GET /v1/workspaces/${workspaceId}/session-tenancy/capabilities`]: () =>
        Response.json({
          defaultVisibility: "workspace",
          canCreatePrivate: true,
        }),
      [`POST /v1/workspaces/${workspaceId}/sessions`]: () =>
        Response.json({ error: { message: "Out of credit" } }, { status: 402 }),
    });
    const missing = await call("delegate", { message: "x", agent: "Writer" });
    expect(missing.isError).toBe(true);
    expect(missing.value.available).toEqual([{ id: agentId, name: "Reviewer" }]);
    const broke = await call("delegate", { message: "x" });
    expect(broke.isError).toBe(true);
    expect(broke.value).toMatchObject({ status: 402, retrySafe: true });
    expect(String(broke.value.error)).toContain("credit");
  });

  test("wait_for is done only when the turn finished with a final answer", async () => {
    let events: unknown[] = [];
    const { call, seen } = await connect({
      "tool session_wait": () =>
        firstPartyAnswer("session_wait", {
          changed: events.length ? [{ sessionId, latestSequence: 9, events }] : [],
          timedOut: events.length === 0,
        }),
    });
    const running = await call("wait_for", { sessionId, cursor: 3 });
    expect(running.value).toMatchObject({
      state: "running",
      done: false,
      cursor: 3,
    });
    const invoke = seen.at(-1)!.body as { arguments: Record<string, unknown> };
    expect(invoke.arguments).toMatchObject({
      targets: [{ sessionId, afterSequence: 3 }],
      waitFor: "completion",
      maxWaitSeconds: 50,
    });
    events = [
      {
        sequence: 9,
        type: "turn.completed",
        status: "completed",
        text: "All done.",
      },
    ];
    const done = await call("wait_for", { sessionId, cursor: 3 });
    expect(done.value).toMatchObject({
      state: "done",
      done: true,
      finalAnswer: "All done.",
      cursor: 9,
    });
    expect((await call("wait_for", { sessionId, maxWaitSeconds: 51 })).isError).toBe(true);
  });

  test("tool_call returns an approval link for an approval-gated tool, and asks for the stored approval", async () => {
    const { call, seen } = await connect({
      [`POST /v1/workspaces/${workspaceId}/tools/invoke`]: () =>
        Response.json(
          {
            error: {
              code: "conflict",
              message: "tool_gateway_approval_required",
              retryable: false,
              outcomeUnknown: false,
              details: { code: "tool_gateway_approval_required" },
            },
          },
          { status: 409 },
        ),
    });
    const operationId = "88888888-8888-4888-8888-888888888888";
    const result = await call("tool_call", {
      serverId: "mail",
      toolName: "send",
      arguments: { to: "a@example.test" },
      operationId,
    });
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({
      needsApproval: true,
      operationId,
      retrySafe: true,
    });
    const url = new URL(result.value.approvalUrl);
    expect(url.origin + url.pathname).toBe(
      `https://app.example.test/workspaces/${workspaceId}/tool-approval`,
    );
    expect(JSON.parse(Buffer.from(url.hash.slice(1), "base64url").toString())).toEqual({
      serverId: "mail",
      toolName: "send",
      arguments: { to: "a@example.test" },
      operationId,
    });
    expect(claimsStoredApproval(seen.at(-1)!.request)).toBe(true);
  });

  test("skills_sync uploads Personal Skills, skips unchanged ones and reports each result", async () => {
    const unchangedFiles = [
      {
        path: "SKILL.md",
        content: "---\nname: Same\ndescription: d\n---\nBody",
      },
    ];
    const saves: unknown[] = [];
    const { call } = await connect({
      [`GET /v1/workspaces/${workspaceId}/skills/content`]: () =>
        Response.json({
          skills: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              stableKey: "same",
              scope: "user",
              scopeVersion: 2,
              activeRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              title: "Same",
              description: "d",
              status: "active",
            },
          ],
          nextCursor: null,
        }),
      [`GET /v1/workspaces/${workspaceId}/skills/content/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`]:
        () =>
          Response.json({
            files: unchangedFiles,
            scope: "user",
            status: "active",
          }),
      [`POST /v1/workspaces/${workspaceId}/skills/content/save`]: (_request, body) => {
        saves.push(body);
        return Response.json({
          outcome: "pending",
          skillId: (body as { skillId: string }).skillId,
        });
      },
    });
    const result = await call("skills_sync", {
      direction: "upload",
      skills: [
        { files: unchangedFiles },
        {
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: New Skill\ndescription: d\n---\nB",
            },
          ],
        },
        { files: [{ path: "SKILL.md", content: "no frontmatter" }] },
      ],
    });
    expect(result.value.scope).toBe("user");
    expect(result.value.results.map((each: { status: string }) => each.status)).toEqual([
      "unchanged",
      "pending_review",
      "invalid",
    ]);
    expect(saves).toHaveLength(1);
    // A new Skill's head starts at scope version 1, with no active revision.
    expect(saves[0]).toMatchObject({
      scope: "user",
      stableKey: "new-skill",
      expectedRevisionId: null,
      expectedScopeVersion: 1,
    });
    // A retry saves with the same operation and Skill ids, so it replays.
    await call("skills_sync", {
      direction: "upload",
      skills: [
        {
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: New Skill\ndescription: d\n---\nB",
            },
          ],
        },
      ],
    });
    expect((saves[1] as { operationId: string }).operationId).toBe(
      (saves[0] as { operationId: string }).operationId,
    );
  });

  test("session_send keeps its key when the chat moved on, and returns the turn to wait for", async () => {
    let lastSequence = 10;
    const keys: string[] = [];
    const { call } = await connect({
      "tool session_get": () => firstPartyAnswer("session_get", { lastSequence }),
      "tool session_queue_message": (_request, body) => {
        keys.push((body as { arguments: { idempotencyKey: string } }).arguments.idempotencyKey);
        // Sending appends events: a retry reads a later sequence.
        lastSequence += 3;
        return firstPartyAnswer("session_queue_message", {
          outcome: keys.length > 1 ? "replayed" : "queued",
          resource: { type: "session_turn", id: "turn-follow-up" },
        });
      },
    });
    const sent = await call("session_send", { sessionId, message: "Also add tests." });
    expect(sent.value).toMatchObject({ cursor: 10, turnId: "turn-follow-up" });
    const again = await call("session_send", { sessionId, message: "Also add tests." });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // Already sent: wait from the start so its turn's end isn't missed.
    expect(again.value).toMatchObject({ replayed: true, cursor: 0, turnId: "turn-follow-up" });
  });

  test("a connection over its rate limit runs nothing", async () => {
    const { call, seen } = await connect({}, { admit: () => 7 });
    const refused = await call("workspaces_list", {});
    expect(refused.isError).toBe(true);
    expect(String(refused.value)).toContain("7 seconds");
    expect(seen).toHaveLength(0);
  });
});

describe("organization MCP named tool helpers", () => {
  test("waitState reads completion events", () => {
    expect(waitState([]).state).toBe("running");
    expect(waitState([{ sequence: 1, type: "turn.failed" }]).state).toBe("failed");
    expect(waitState([{ sequence: 1, type: "session.humanInput.requested" }]).state).toBe(
      "needs_attention",
    );
    // Waiting for capacity needs nobody.
    expect(waitState([{ sequence: 1, type: "turn.capacity_waiting" }]).state).toBe("running");
    // A follow-up's own turn: the turn that was running when it was sent
    // finishing isn't its answer.
    const earlier = { sequence: 4, type: "turn.completed", turnId: "turn-a", text: "old" };
    expect(waitState([earlier], "turn-b").state).toBe("running");
    expect(
      waitState(
        [earlier, { sequence: 6, type: "turn.completed", turnId: "turn-b", text: "new" }],
        "turn-b",
      ).event?.text,
    ).toBe("new");
    // Merged into a later turn: that turn's answer counts.
    expect(
      waitState(
        [
          { sequence: 7, type: "turn.superseded", turnId: "turn-b" },
          { sequence: 8, type: "turn.completed", turnId: "turn-c", text: "merged" },
        ],
        "turn-b",
      ).event?.text,
    ).toBe("merged");
    // Merged in one answer, finished in the next: the next call follows no turn.
    expect(
      waitState([{ sequence: 7, type: "turn.superseded", turnId: "turn-b" }], "turn-b"),
    ).toEqual({
      state: "running",
    });
  });

  test("Skill names and approval links", () => {
    expect(skillFrontmatterName('---\nname: "My Skill"\ndescription: x\n---\n')).toBe("My Skill");
    expect(skillFrontmatterName("no frontmatter")).toBeNull();
    expect(skillKey(" My  Skill! ")).toBe("my-skill");
    expect(
      toolApprovalUrl("https://app.example.test", workspaceId, {
        serverId: "s",
        toolName: "t",
        arguments: { big: "x".repeat(20_000) },
        operationId: crypto.randomUUID(),
      }),
    ).toBeNull();
  });

  test("outside agent reach only narrows and defaults to viewer", () => {
    expect(outsideAgentReach({ metadata: {} })).toBeNull();
    expect(outsideAgentReach(null)).toBeNull();
    expect(
      outsideAgentReach({
        metadata: { [OUTSIDE_AGENT_GRANT_METADATA_KEY]: {} },
      }),
    ).toEqual({
      appData: "viewer",
    });
    expect(
      outsideAgentReach({
        metadata: {
          [OUTSIDE_AGENT_GRANT_METADATA_KEY]: { appData: "manager" },
        },
      }),
    ).toEqual({ appData: "manager" });
  });

  test("the connection rate limiter refills and bounds its keys", () => {
    let now = 0;
    const limiter = createConnectionRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxKeys: 2,
      now: () => now,
    });
    expect(limiter.admit("a")).toBe(0);
    expect(limiter.admit("a")).toBe(0);
    expect(limiter.admit("a")).toBeGreaterThan(0);
    now += 1_000;
    expect(limiter.admit("a")).toBe(0);
    limiter.admit("b");
    limiter.admit("c");
    // "a" was evicted: it starts full again.
    expect(limiter.admit("a")).toBe(0);
  });
});
