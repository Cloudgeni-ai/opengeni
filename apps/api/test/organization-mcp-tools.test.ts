import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolGatewayInvokeResponse,
  organizationAccessPresetPermissions,
  type AccessGrant,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import { outsideAgentReach, OUTSIDE_AGENT_GRANT_METADATA_KEY } from "@opengeni/core";

import { claimsStoredApproval } from "../src/mcp/stored-approval-claim";
import {
  createConnectionRateLimiter,
  createSharedConnectionRateLimiter,
} from "../src/mcp/connection-rate-limit";
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
  toolsSearchApproval,
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

  test("skills_sync from a repository saves each Skill folder and reports the commit", async () => {
    const saves: Array<{ stableKey: string; reason: string }> = [];
    const { call } = await connect(
      {
        [`GET /v1/workspaces/${workspaceId}/skills/content`]: () =>
          Response.json({ skills: [], nextCursor: null }),
        [`POST /v1/workspaces/${workspaceId}/skills/content/save`]: (_request, body) => {
          saves.push(body as { stableKey: string; reason: string });
          return Response.json({
            outcome: "published",
            skillId: (body as { skillId: string }).skillId,
          });
        },
      },
      {
        readSkillRepository: async (url) => {
          expect(url).toBe("https://github.com/acme/skills/tree/main/skills");
          return {
            owner: "acme",
            repository: "skills",
            ref: "main",
            commit: "c".repeat(40),
            skills: [
              {
                path: "skills/release",
                files: [
                  { path: "SKILL.md", content: "---\nname: Release\ndescription: d\n---\nB" },
                ],
              },
            ],
            skipped: [{ path: "skills/big", reason: "It is too large." }],
            truncated: false,
          };
        },
      },
    );
    const result = await call("skills_sync", {
      direction: "repository",
      repository: "https://github.com/acme/skills/tree/main/skills",
    });
    expect(result.value.commit).toBe("c".repeat(40));
    expect(result.value.results).toEqual([
      expect.objectContaining({ name: "release", status: "created", path: "skills/release" }),
      { path: "skills/big", status: "invalid", error: "It is too large." },
    ]);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      stableKey: "release",
      reason: `Synced from acme/skills@${"c".repeat(12)}`,
    });
    // Without a repository the direction explains what's missing.
    const missing = await call("skills_sync", { direction: "repository" });
    expect(missing.isError).toBe(true);
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

describe("organization MCP app and file saving", () => {
  const appId = "88888888-8888-4888-8888-888888888888";
  const v1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const v2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const base = `/v1/workspaces/${workspaceId}/published-artifacts`;
  const receipt = (revision: number, versionId: string, replayed = false) =>
    Response.json({
      artifact: { id: appId, title: "Board", visibility: "private" },
      version: { id: versionId, revision },
      replayed,
    });
  const detail = (current: { id: string; revision: number }) =>
    Response.json({
      artifact: { id: appId, currentVersion: current },
      versions: [
        { id: v2, revision: 2 },
        { id: v1, revision: 1 },
      ],
    });

  test("app_save creates a private app, and a retry reuses the same key", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { call } = await connect({
      [`POST ${base}`]: (_request, body) => {
        bodies.push(body as Record<string, unknown>);
        return receipt(1, v1, bodies.length > 1);
      },
    });
    const first = await call("app_save", { name: "Board", html: "<h1>Board</h1>" });
    expect(first.isError).toBe(false);
    expect(first.value).toMatchObject({
      appId,
      version: 1,
      link: `https://app.example.test/workspaces/${workspaceId}/apps/${appId}`,
      replayed: false,
    });
    expect(bodies[0]).toMatchObject({
      title: "Board",
      html: "<h1>Board</h1>",
      visibility: "private",
    });
    const again = await call("app_save", { name: "Board", html: "<h1>Board</h1>" });
    expect(again.value.replayed).toBe(true);
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
  });

  test("app_save saves a new version on the current one and defines collections", async () => {
    const published: Array<Record<string, unknown>> = [];
    const defined: string[] = [];
    const { call } = await connect({
      [`GET ${base}/${appId}`]: () => detail({ id: v1, revision: 1 }),
      [`POST ${base}/${appId}/versions`]: (_request, body) => {
        published.push(body as Record<string, unknown>);
        return receipt(2, v2);
      },
      [`PUT ${base}/${appId}/data/collections/tasks`]: (request) => {
        defined.push(new URL(request.url).pathname);
        return Response.json({ name: "tasks" });
      },
    });
    const saved = await call("app_save", {
      appId,
      html: "<h1>v2</h1>",
      collections: { tasks: { accessMode: "shared" } },
    });
    expect(saved.isError).toBe(false);
    expect(saved.value).toMatchObject({
      appId,
      version: 2,
      collections: [{ name: "tasks", ok: true }],
    });
    expect(published[0]).toMatchObject({ html: "<h1>v2</h1>", expectedCurrentVersionId: v1 });
    expect(defined).toHaveLength(1);
  });

  test("app_save says nothing was saved when the caller's own key was already used", async () => {
    const { call } = await connect({
      [`GET ${base}/${appId}`]: () => detail({ id: v2, revision: 2 }),
      [`POST ${base}/${appId}/versions`]: () =>
        Response.json(
          {
            code: "WORKSPACE_ARTIFACT_CONFLICT",
            message: "Idempotency key was already used for a different operation",
          },
          { status: 409 },
        ),
    });
    const retried = await call("app_save", {
      appId,
      html: "<h1>v2</h1>",
      idempotencyKey: "save-1",
    });
    expect(retried.isError).toBe(true);
    expect(retried.value.error).toContain("nothing was saved");
  });

  test("app_save recognises a retry whose first try already saved the version", async () => {
    const html = "<h1>v2</h1>";
    const posted: Array<Record<string, unknown>> = [];
    const { call } = await connect({
      [`GET ${base}/${appId}`]: () =>
        Response.json({
          artifact: {
            id: appId,
            currentVersion: {
              id: v2,
              revision: 2,
              sizeBytes: new TextEncoder().encode(html).byteLength,
              createdBySubjectId: subjectId,
              createdAt: new Date().toISOString(),
            },
          },
          versions: [
            { id: v2, revision: 2 },
            { id: v1, revision: 1 },
          ],
        }),
      [`POST ${base}/${appId}/versions`]: (_request, body) => {
        posted.push(body as Record<string, unknown>);
        return receipt(2, v2, true);
      },
    });
    const retried = await call("app_save", { appId, html });
    expect(retried.value).toMatchObject({ appId, version: 2, replayed: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ expectedCurrentVersionId: v1 });
  });

  test("app_save rolls back to a version by its number", async () => {
    const rolled: Array<Record<string, unknown>> = [];
    const { call } = await connect({
      [`GET ${base}/${appId}`]: () => detail({ id: v2, revision: 2 }),
      [`POST ${base}/${appId}/rollback`]: (_request, body) => {
        rolled.push(body as Record<string, unknown>);
        return receipt(3, v1);
      },
    });
    const result = await call("app_save", { appId, rollbackTo: 1 });
    expect(result.isError).toBe(false);
    expect(rolled[0]).toMatchObject({ versionId: v1, expectedCurrentVersionId: v2 });
    expect((await call("app_save", { appId, rollbackTo: 9 })).isError).toBe(true);
  });

  test("app_save passes on the refusal when the person can't manage the app", async () => {
    const { call } = await connect({
      [`GET ${base}/${appId}`]: () => detail({ id: v1, revision: 1 }),
      [`POST ${base}/${appId}/versions`]: () =>
        Response.json(
          {
            code: "WORKSPACE_ARTIFACT_OWNER_REQUIRED",
            message: "Only the app's owner can change it",
          },
          { status: 403 },
        ),
    });
    const refused = await call("app_save", { appId, html: "<p>x</p>" });
    expect(refused.isError).toBe(true);
    expect(refused.value.error).toBe("Only the app's owner can change it");
  });

  test("app_save uploads a multi-file build and creates the app from it", async () => {
    const uploadId = "99999999-9999-4999-8999-999999999990";
    const put: Array<{ url: string; body: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      put.push({ url: String(input), body: new TextDecoder().decode(init?.body as Uint8Array) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const created: Array<Record<string, unknown>> = [];
      const { call } = await connect({
        [`POST ${base}/uploads`]: () =>
          Response.json({
            uploadId,
            html: { putUrl: "https://storage.example.test/html", requiredHeaders: {} },
            source: { putUrl: "https://storage.example.test/source", requiredHeaders: {} },
            assets: { putUrl: "https://storage.example.test/assets", requiredHeaders: {} },
          }),
        [`POST ${base}`]: (_request, body) => {
          created.push(body as Record<string, unknown>);
          return receipt(1, v1);
        },
      });
      const saved = await call("app_save", {
        name: "Board",
        files: [
          { path: "index.html", content: '<script src="app.js"></script>' },
          { path: "app.js", content: "console.log(1)" },
        ],
      });
      expect(saved.isError).toBe(false);
      expect(created[0]).toMatchObject({ uploadId });
      expect(created[0]!.html).toBeUndefined();
      expect(put.map((entry) => entry.url)).toEqual([
        "https://storage.example.test/html",
        "https://storage.example.test/assets",
        "https://storage.example.test/source",
      ]);
      expect(JSON.parse(put[2]!.body)).toEqual({
        entrypoint: "index.html",
        files: [
          { path: "index.html", content: '<script src="app.js"></script>' },
          { path: "app.js", content: "console.log(1)" },
        ],
      });
      expect(JSON.parse(put[1]!.body).files[0]).toEqual({
        path: "app.js",
        base64: Buffer.from("console.log(1)").toString("base64"),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("app_save finds the app a multi-file retry's first try created", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    try {
      let uploads = 0;
      const created: string[] = [];
      const { call } = await connect({
        [`POST ${base}/uploads`]: () => {
          uploads += 1;
          return Response.json({
            uploadId: `99999999-9999-4999-8999-99999999999${uploads}`,
            html: { putUrl: "https://storage.example.test/html" },
            assets: { putUrl: "https://storage.example.test/assets" },
          });
        },
        [`POST ${base}`]: (_request, body) => {
          created.push((body as { idempotencyKey: string }).idempotencyKey);
          return created.length === 1
            ? receipt(1, v1)
            : Response.json(
                {
                  code: "WORKSPACE_ARTIFACT_CONFLICT",
                  message: "Idempotency key was already used for different publication input",
                },
                { status: 409 },
              );
        },
        [`GET /v1/workspaces/${workspaceId}/artifact-catalog`]: () =>
          Response.json({
            items: [
              {
                id: appId,
                kind: "site",
                title: "Board",
                ownedByViewer: true,
                createdAt: new Date().toISOString(),
              },
            ],
            nextCursor: null,
          }),
      });
      const files = [
        { path: "index.html", content: "<p>x</p>" },
        { path: "app.css", content: "p{}" },
      ];
      await call("app_save", { name: "Board", files });
      const retried = await call("app_save", { name: "Board", files });
      expect(retried.isError).toBe(false);
      expect(retried.value).toMatchObject({ appId, replayed: true });
      expect(created[1]).toBe(created[0]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /** An app the tests share: who can see it changes with each visibility call. */
  const sharedApp = (visibility: "private" | "workspace", calls: string[]) => {
    const state = { visibility };
    return {
      [`GET ${base}/${appId}`]: () =>
        Response.json({ artifact: { id: appId, visibility: state.visibility }, versions: [] }),
      [`PUT ${base}/${appId}/visibility`]: (_request: Request, body: unknown) => {
        state.visibility = (body as { visibility: "private" | "workspace" }).visibility;
        calls.push(`visibility ${state.visibility}`);
        return Response.json({ artifact: { id: appId } });
      },
    };
  };

  test("app_publish shares with the workspace and publishes publicly with fixes", async () => {
    const calls: string[] = [];
    const { call } = await connect({
      ...sharedApp("private", calls),
      [`GET ${base}/${appId}/publication`]: () =>
        Response.json(
          { error: { code: "not_found", message: "This app is not published" } },
          { status: 404 },
        ),
      [`PUT ${base}/${appId}/publication`]: (_request, body) => {
        calls.push(`publication ${(body as { access: string }).access}`);
        return Response.json({
          url: "https://board.apps.example.test/",
          hostname: "board.apps.example.test",
          access: "public",
          status: "active",
          warnings: [
            {
              code: "site_data_guest_read",
              message: "Visitors can't read tasks",
              suggestion: "Let guests read tasks",
              fix: { kind: "site_data_guest_access", collection: "tasks", guestAccess: "read" },
            },
          ],
        });
      },
      [`POST ${base}/${appId}/publication/fixes`]: () => {
        calls.push("fix");
        return Response.json({
          url: "https://board.apps.example.test/",
          status: "active",
          warnings: [],
        });
      },
    });
    const shared = await call("app_publish", { appId, access: "workspace" });
    expect(shared.isError).toBe(false);
    expect(shared.value.publication).toBeUndefined();
    const open = await call("app_publish", { appId, access: "public", hostname: "board" });
    expect(open.value.publication.warnings).toHaveLength(1);
    expect(open.value.nextStep).toContain("fixes");
    const fixed = await call("app_publish", {
      appId,
      access: "public",
      fixes: [{ kind: "site_data_guest_access", collection: "tasks", guestAccess: "read" }],
    });
    expect(fixed.value.publication.warnings).toHaveLength(0);
    expect(calls).toEqual([
      "visibility workspace",
      "publication public",
      "publication public",
      "fix",
    ]);
    const ignored = await call("app_publish", {
      appId,
      access: "workspace",
      fixes: [{ kind: "site_data_guest_access", collection: "tasks", guestAccess: "read" }],
    });
    expect(ignored.value.fixesIgnored).toContain("isn't published");
  });

  test("app_publish only_me narrows who can see it, then takes it off the web", async () => {
    const calls: string[] = [];
    const { call } = await connect({
      ...sharedApp("workspace", calls),
      [`GET ${base}/${appId}/publication`]: () =>
        Response.json({ access: "public", status: "active", warnings: [] }),
      [`PUT ${base}/${appId}/publication`]: (_request, body) => {
        calls.push(`publication ${(body as { status: string }).status}`);
        return Response.json({ status: "unpublished" });
      },
    });
    const result = await call("app_publish", { appId, access: "only_me" });
    expect(result.value).toMatchObject({ access: "only_me" });
    expect(calls).toEqual(["visibility private", "publication unpublished"]);
  });

  test("app_publish changes nothing when it can't read the publication or isn't the owner", async () => {
    const calls: string[] = [];
    let publicationRead = 500;
    const { call } = await connect({
      ...sharedApp("workspace", calls),
      [`GET ${base}/${appId}/publication`]: () =>
        publicationRead === 500
          ? Response.json({ error: { message: "Database unavailable" } }, { status: 500 })
          : Response.json({ access: "public", status: "active", warnings: [] }),
      [`PUT ${base}/${appId}/publication`]: () => {
        calls.push("publication");
        return Response.json({ status: "unpublished" });
      },
    });
    const unread = await call("app_publish", { appId, access: "only_me" });
    expect(unread.isError).toBe(true);
    expect(calls).toEqual([]);
    publicationRead = 200;
    const notOwner = await connect({
      [`GET ${base}/${appId}`]: () =>
        Response.json({ artifact: { id: appId, visibility: "workspace" }, versions: [] }),
      [`GET ${base}/${appId}/publication`]: () =>
        Response.json({ access: "public", status: "active", warnings: [] }),
      [`PUT ${base}/${appId}/visibility`]: () =>
        Response.json(
          { code: "WORKSPACE_ARTIFACT_OWNER_REQUIRED", message: "Only the owner can do this" },
          { status: 403 },
        ),
      [`PUT ${base}/${appId}/publication`]: () => {
        calls.push("publication");
        return Response.json({ status: "unpublished" });
      },
    });
    const refused = await notOwner.call("app_publish", { appId, access: "only_me" });
    expect(refused.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("app_publish puts visibility back when the public publication fails", async () => {
    const calls: string[] = [];
    const { call } = await connect({
      ...sharedApp("private", calls),
      [`GET ${base}/${appId}/publication`]: () =>
        Response.json({ error: { message: "not published" } }, { status: 404 }),
      [`PUT ${base}/${appId}/publication`]: () =>
        Response.json({ error: { message: "That hostname is taken." } }, { status: 409 }),
    });
    const result = await call("app_publish", { appId, access: "public", hostname: "board" });
    expect(result.isError).toBe(true);
    expect(result.value.error).toBe("That hostname is taken. Nothing changed.");
    expect(calls).toEqual(["visibility workspace", "visibility private"]);
  });

  test("file_save uploads a private file once and a retry returns it", async () => {
    const fileId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const uploadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sha256 = new Bun.CryptoHasher("sha256").update("# Report").digest("hex");
    const stored: Array<Record<string, unknown>> = [];
    const begun: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    try {
      const { call } = await connect({
        [`GET /v1/workspaces/${workspaceId}/files`]: () =>
          Response.json({ files: stored, nextCursor: null }),
        [`POST /v1/workspaces/${workspaceId}/files/uploads`]: (_request, body) => {
          begun.push(body as Record<string, unknown>);
          return Response.json({
            fileId,
            uploadId,
            putUrl: "https://storage.example.test/file",
            requiredHeaders: {},
            expiresAt: new Date().toISOString(),
            maxSizeBytes: 1000,
          });
        },
        [`POST /v1/workspaces/${workspaceId}/files/uploads/${uploadId}/complete`]: () => {
          const file = {
            id: fileId,
            filename: "report.md",
            sizeBytes: 8,
            sha256,
            status: "ready",
            ownerSubjectId: subjectId,
            createdAt: new Date().toISOString(),
          };
          stored.push(file);
          return Response.json({ file });
        },
      });
      const first = await call("file_save", { name: "report.md", content: "# Report" });
      expect(first.isError).toBe(false);
      expect(first.value).toMatchObject({
        fileId,
        link: `https://app.example.test/workspaces/${workspaceId}/artifacts/files/${fileId}`,
        replayed: false,
      });
      expect(begun[0]).toMatchObject({ scope: "personal", contentType: "text/markdown", sha256 });
      const again = await call("file_save", { name: "report.md", content: "# Report" });
      expect(again.value).toMatchObject({ fileId, replayed: true });
      expect(begun).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("file_save hands out an upload URL for a large file", async () => {
    const { call } = await connect({
      [`POST /v1/workspaces/${workspaceId}/files/uploads`]: () =>
        Response.json({
          fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          uploadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          putUrl: "https://storage.example.test/file",
          requiredHeaders: { "x-goog-meta-a": "b" },
          expiresAt: new Date().toISOString(),
          maxSizeBytes: 100_000_000,
        }),
    });
    const result = await call("file_save", { name: "video.mp4", sizeBytes: 50_000_000 });
    expect(result.value).toMatchObject({
      uploadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      putUrl: "https://storage.example.test/file",
    });
    expect(result.value.nextStep).toContain("uploadId");
  });

  test("a read-only connection can't save an app", async () => {
    const { call, seen } = await connect(
      {},
      {
        caller: {
          kind: "person",
          accountId: organizationId,
          subjectId,
          access: {
            preset: "read_only",
            permissions: organizationAccessPresetPermissions("read_only"),
            workspaceScope: { kind: "all" },
          },
        },
      },
    );
    const refused = await call("app_save", { name: "Board", html: "<p>x</p>" });
    expect(refused.isError).toBe(true);
    expect(seen.some((entry) => entry.method === "POST")).toBe(false);
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
    const connectionId = crypto.randomUUID();
    expect(
      outsideAgentReach({
        metadata: {
          [OUTSIDE_AGENT_GRANT_METADATA_KEY]: { appData: "viewer", connectionId },
        },
      }),
    ).toEqual({ appData: "viewer", connectionId });
    // Anything but a connection id is dropped, never recorded as a writer.
    expect(
      outsideAgentReach({
        metadata: {
          [OUTSIDE_AGENT_GRANT_METADATA_KEY]: { appData: "viewer", connectionId: "user:x" },
        },
      }),
    ).toEqual({ appData: "viewer" });
  });

  test("a connected agent's app data writes are recorded as its connection", async () => {
    const { siteDataActor, siteDataPrincipal } = await import("../src/site-data/service");
    const connectionId = crypto.randomUUID();
    const person = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "user:person",
      permissions: [],
    } as unknown as AccessGrant;
    const connected = {
      ...person,
      metadata: { [OUTSIDE_AGENT_GRANT_METADATA_KEY]: { appData: "viewer", connectionId } },
    } as AccessGrant;
    expect(siteDataActor(connected, "user:person")).toBe(`agent:connection:${connectionId}`);
    // The record stays the person's.
    expect(siteDataPrincipal(connected, "user:person")).toBe("user:user:person");
    expect(siteDataActor(person, "user:person")).toBe("user:user:person");
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

  test("tools_search approvals follow tool settings", () => {
    expect(toolsSearchApproval({ approval: "none" })).toEqual({
      approval: "none",
      approvalSource: "tool",
    });
    expect(toolsSearchApproval({ approval: "human" })).toEqual({
      approval: "human",
      approvalSource: "tool",
    });
    // A connection-backed tool the settings allow, ask for or block.
    expect(
      toolsSearchApproval({
        approval: "policy",
        permission: { decision: "allow", fromSetting: false },
      }),
    ).toEqual({ approval: "none", approvalSource: "tool" });
    expect(
      toolsSearchApproval({
        approval: "human",
        permission: { decision: "ask", fromSetting: true },
      }),
    ).toEqual({ approval: "human", approvalSource: "policy" });
    expect(
      toolsSearchApproval({
        approval: "policy",
        permission: { decision: "block", fromSetting: true },
      }),
    ).toEqual({ approval: "blocked", approvalSource: "policy" });
  });

  test("the shared limiter counts in the shared store and falls back to this process", async () => {
    const seen: unknown[] = [];
    let down = false;
    const fallbacks: unknown[] = [];
    const limiter = createSharedConnectionRateLimiter({
      capacity: 1,
      refillPerSecond: 1 / 3_600,
      admitShared: async (input) => {
        if (down) throw new Error("database unreachable");
        seen.push(input);
        return 7;
      },
      onFallback: (error) => fallbacks.push(error),
    });
    expect(await limiter.admit({ accountId: "acc", key: "connection:a" })).toBe(7);
    expect(seen).toEqual([
      { accountId: "acc", key: "connection:a", capacity: 1, refillPerSecond: 1 / 3_600 },
    ]);
    down = true;
    expect(await limiter.admit({ accountId: "acc", key: "connection:a" })).toBe(0);
    expect(await limiter.admit({ accountId: "acc", key: "connection:a" })).toBeGreaterThan(0);
    // Told once, not on every call that falls back.
    expect(fallbacks).toHaveLength(1);
  });
});
