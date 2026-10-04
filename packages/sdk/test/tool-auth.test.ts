import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  OpenGeniClient,
  createSessionProxyHandler,
  type SessionProxyHandlerOptions,
} from "../src/index";
import {
  deriveToolTokenKey,
  mintToolToken,
  TOOL_TOKEN_ISSUER,
  TOOL_TOKEN_KEY_LABEL,
  ToolRequestError,
  verifyToolRequest,
} from "../src/tool-auth";
import { SESSION_ID, WORKSPACE_ID } from "./helpers";

const PRODUCT = "https://product.example.test";
const API = "https://api.example.test";
const TOOL_URL = `${PRODUCT}/api/mcp`;
const SECRET = "og_org_key_for_tests";
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";

// Both sides read the tool server URL from the environment by default.
let previousToolServerUrl: string | undefined;
beforeAll(() => {
  previousToolServerUrl = process.env.OPENGENI_TOOL_SERVER_URL;
  process.env.OPENGENI_TOOL_SERVER_URL = TOOL_URL;
});
afterAll(() => {
  if (previousToolServerUrl === undefined) delete process.env.OPENGENI_TOOL_SERVER_URL;
  else process.env.OPENGENI_TOOL_SERVER_URL = previousToolServerUrl;
});

const identity = {
  audience: TOOL_URL,
  user: "u_42",
  tenant: "acme",
  workspaceId: WORKSPACE_ID,
  source: "northwind",
  secret: SECRET,
};

function bearer(token: string, url = TOOL_URL): Request {
  return new Request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRequestError);
    expect((error as ToolRequestError).status).toBe(401);
    return (error as ToolRequestError).code;
  }
  throw new Error("expected verification to fail");
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Independent HS256 signer, as a Python/Rails verifier would compute the key. */
function signIndependently(payload: Record<string, unknown>, alg = "HS256"): string {
  const key = createHmac("sha256", SECRET).update(TOOL_TOKEN_KEY_LABEL).digest();
  const head = `${b64url({ alg, typ: "JWT" })}.${b64url(payload)}`;
  return `${head}.${createHmac("sha256", key).update(head).digest("base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TOOL_TOKEN_ISSUER,
    aud: TOOL_URL,
    sub: "u_42",
    workspace_id: WORKSPACE_ID,
    source: "northwind",
    iat: now,
    exp: now + 60,
    ...overrides,
  };
}

describe("tool tokens", () => {
  test("mint and verify round-trip through Web and Node requests", async () => {
    const token = await mintToolToken(identity);
    const verified = await verifyToolRequest(bearer(token), { secret: SECRET });
    expect(verified).toMatchObject({
      user: "u_42",
      tenant: "acme",
      workspaceId: WORKSPACE_ID,
      source: "northwind",
    });
    // Express: originalUrl keeps the mount path; query strings are ignored.
    const node = await verifyToolRequest(
      {
        headers: { authorization: `Bearer ${token}` },
        originalUrl: "/api/mcp?x=1",
        url: "/",
      },
      { secret: SECRET },
    );
    expect(node.user).toBe("u_42");
  });

  test("the documented derivation verifies with any standard HS256 implementation", async () => {
    const token = await mintToolToken(identity);
    const [head, payload, signature] = token.split(".");
    const key = createHmac("sha256", SECRET).update(TOOL_TOKEN_KEY_LABEL).digest();
    expect(createHmac("sha256", key).update(`${head}.${payload}`).digest("base64url")).toBe(
      signature!,
    );
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      iss: "opengeni-session-proxy",
      aud: TOOL_URL,
      sub: "u_42",
      tenant: "acme",
      workspace_id: WORKSPACE_ID,
    });
    // And the reverse: an independently signed token verifies.
    const external = await verifyToolRequest(bearer(signIndependently(claims())), {
      secret: SECRET,
    });
    expect(external.user).toBe("u_42");
    expect(external.tenant).toBeUndefined();
  });

  test("expired, forged, wrong-secret, and malformed tokens are 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      await rejectionCode(
        verifyToolRequest(bearer(signIndependently(claims({ exp: now - 1 }))), {
          secret: SECRET,
        }),
      ),
    ).toBe("token_expired");
    const token = await mintToolToken(identity);
    expect(await rejectionCode(verifyToolRequest(bearer(token), { secret: "other" }))).toBe(
      "token_invalid",
    );
    const [head, , signature] = token.split(".");
    const forged = `${head}.${b64url(claims({ sub: "admin" }))}.${signature}`;
    expect(await rejectionCode(verifyToolRequest(bearer(forged), { secret: SECRET }))).toBe(
      "token_invalid",
    );
    const none = `${b64url({ alg: "none" })}.${b64url(claims())}.`;
    expect(await rejectionCode(verifyToolRequest(bearer(none), { secret: SECRET }))).toBe(
      "token_missing",
    );
    expect(
      await rejectionCode(
        verifyToolRequest(bearer(signIndependently(claims(), "HS512")), {
          secret: SECRET,
        }),
      ),
    ).toBe("token_malformed");
    expect(
      await rejectionCode(
        verifyToolRequest(bearer(signIndependently(claims({ iss: "someone-else" }))), {
          secret: SECRET,
        }),
      ),
    ).toBe("token_invalid");
    expect(
      await rejectionCode(
        verifyToolRequest(bearer(signIndependently(claims({ sub: "" }))), {
          secret: SECRET,
        }),
      ),
    ).toBe("token_invalid");
    expect(await rejectionCode(verifyToolRequest(new Request(TOOL_URL), { secret: SECRET }))).toBe(
      "token_missing",
    );
    expect(await rejectionCode(verifyToolRequest(bearer("a.b.c"), { secret: SECRET }))).toBe(
      "token_malformed",
    );
    const response = new ToolRequestError("token_missing").toResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("audience is the exact tool server URL, from the option or OPENGENI_TOOL_SERVER_URL", async () => {
    const token = await mintToolToken(identity);
    // The request URL does not matter (tunnels rewrite hosts); the configured URL does.
    expect(
      (await verifyToolRequest(bearer(token, "http://127.0.0.1:3000/x"), { secret: SECRET })).user,
    ).toBe("u_42");
    expect(
      (
        await verifyToolRequest(bearer(token), {
          secret: SECRET,
          audience: TOOL_URL,
        })
      ).user,
    ).toBe("u_42");
    for (const audience of [`${PRODUCT}/api/admin`, "https://other.example.test/api/mcp"]) {
      expect(
        await rejectionCode(verifyToolRequest(bearer(token), { secret: SECRET, audience })),
      ).toBe("token_audience");
    }
    const other = await mintToolToken({ ...identity, audience: `${PRODUCT}/api/other` });
    expect(await rejectionCode(verifyToolRequest(bearer(other), { secret: SECRET }))).toBe(
      "token_audience",
    );
    delete process.env.OPENGENI_TOOL_SERVER_URL;
    try {
      await expect(verifyToolRequest(bearer(token), { secret: SECRET })).rejects.toBeInstanceOf(
        TypeError,
      );
    } finally {
      process.env.OPENGENI_TOOL_SERVER_URL = TOOL_URL;
    }
  });

  test("deriveToolTokenKey is the key non-Node verifiers use, not the org key", async () => {
    const hex = await deriveToolTokenKey(SECRET);
    expect(hex).toBe(createHmac("sha256", SECRET).update(TOOL_TOKEN_KEY_LABEL).digest("hex"));
    const [head, payload, signature] = (await mintToolToken(identity)).split(".");
    expect(
      createHmac("sha256", Buffer.from(hex, "hex"))
        .update(`${head}.${payload}`)
        .digest("base64url"),
    ).toBe(signature!);
  });

  test("a token too large for OpenGeni's header limit fails at mint time", async () => {
    await expect(mintToolToken({ ...identity, user: "u".repeat(4000) })).rejects.toThrow(
      /header limit/,
    );
  });

  describe("secret defaults", () => {
    let previous: string | undefined;
    beforeEach(() => {
      previous = process.env.OPENGENI_API_KEY;
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.OPENGENI_API_KEY;
      else process.env.OPENGENI_API_KEY = previous;
    });

    test("OPENGENI_API_KEY is the default secret on both sides", async () => {
      process.env.OPENGENI_API_KEY = SECRET;
      const token = await mintToolToken({ ...identity, secret: undefined });
      expect((await verifyToolRequest(bearer(token), { secret: SECRET })).user).toBe("u_42");
      expect((await verifyToolRequest(bearer(token))).user).toBe("u_42");
    });

    test("a missing secret is a setup error, not a 401", async () => {
      delete process.env.OPENGENI_API_KEY;
      await expect(verifyToolRequest(bearer("x.y.z"))).rejects.toBeInstanceOf(TypeError);
      expect(() =>
        createSessionProxyHandler(new OpenGeniClient({ baseUrl: API, apiKey: "k" }), {
          resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u" }),
          toolServer: { url: TOOL_URL },
        }),
      ).toThrow(TypeError);
    });
  });

  test("ttl defaults to 24 hours and is bounded", async () => {
    const { expiresAt } = await verifyToolRequest(bearer(await mintToolToken(identity)), {
      secret: SECRET,
    });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    await expect(mintToolToken({ ...identity, ttlSeconds: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(mintToolToken({ ...identity, ttlSeconds: 700_000 })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

type Recorded = { method: string; path: string; body: any };

function proxySetup(overrides: Partial<SessionProxyHandlerOptions> = {}) {
  const requests: Recorded[] = [];
  let currentUser = "u_42";
  const upstream = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = request.method === "GET" ? "" : await request.text();
    requests.push({
      method: request.method,
      path,
      body: text ? JSON.parse(text) : undefined,
    });
    const sessionPath = `/v1/workspaces/${WORKSPACE_ID}/sessions/`;
    if (request.method === "GET" && path.startsWith(sessionPath)) {
      const id = path.slice(sessionPath.length);
      return Response.json({
        id,
        workspaceId: WORKSPACE_ID,
        createdBy: { kind: "subject", subjectId: "subject-u42" },
        mcpServers:
          id === SESSION_ID
            ? [
                {
                  id: "app",
                  url: TOOL_URL,
                  headerNames: ["authorization"],
                  credentialVersion: 1,
                },
              ]
            : [],
      });
    }
    if (path === "/v1/access/me") {
      return Response.json({
        subjectId: currentUser === "u_42" ? "subject-u42" : `subject-${currentUser}`,
        accountGrants: [],
        workspaceGrants: [],
      });
    }
    if (path === `/v1/workspaces/${WORKSPACE_ID}/sessions` && request.method === "POST") {
      return Response.json({ session: { id: SESSION_ID } });
    }
    return Response.json({
      id: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      status: "idle",
    });
  };
  const service = new OpenGeniClient({
    baseUrl: API,
    apiKey: "og_org_key",
    fetch: upstream,
  });
  const handler = createSessionProxyHandler(service, {
    resolve: () => ({
      workspaceId: WORKSPACE_ID,
      user: currentUser,
      source: "northwind",
    }),
    createSession: ({ initialMessage }) => ({ initialMessage }),
    toolServer: {
      url: TOOL_URL,
      secret: SECRET,
      approvals: { ask: ["renamePost"] },
    },
    ...overrides,
  });
  const browser = new OpenGeniClient({
    baseUrl: `${PRODUCT}/api/opengeni`,
    fetch: async (input, init) => await handler(new Request(input, init)),
  });
  const writes = () => requests.filter((request) => request.method !== "GET");
  const signInAs = (user: string) => {
    currentUser = user;
  };
  return { requests, writes, browser, handler, signInAs };
}

function tokenOf(headers: Record<string, string> | undefined): string {
  const value = headers?.Authorization ?? "";
  expect(value.startsWith("Bearer ")).toBe(true);
  return value.slice("Bearer ".length);
}

describe("session proxy toolServer", () => {
  test("create attaches the tool server with a per-user token and write approvals", async () => {
    const { writes, browser } = proxySetup();
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "hi",
    } as never);
    const body = writes()[0]!.body;
    expect(body.tools).toBeUndefined(); // workspace defaults preserved
    expect(body.mcpServers).toHaveLength(1);
    const server = body.mcpServers[0];
    expect(server).toMatchObject({
      id: "app",
      url: TOOL_URL,
      requireApproval: ["renamePost"],
    });
    const verified = await verifyToolRequest(bearer(tokenOf(server.headers)), {
      secret: SECRET,
    });
    expect(verified).toMatchObject({
      user: "u_42",
      workspaceId: WORKSPACE_ID,
      source: "northwind",
    });
  });

  test("explicit tools get an eager ref; host servers are kept; collisions fail", async () => {
    const { writes, browser } = proxySetup({
      createSession: ({ initialMessage }) => ({
        initialMessage,
        tools: [{ kind: "mcp", id: "crm" }],
        mcpServers: [{ id: "crm", url: "https://crm.example.test/mcp" }],
      }),
      toolServer: {
        url: TOOL_URL,
        secret: SECRET,
        id: "posts",
        approvals: { ask: true },
      },
    });
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "hi",
    } as never);
    const body = writes()[0]!.body;
    expect(body.tools).toEqual([
      { kind: "mcp", id: "crm" },
      { kind: "mcp", id: "posts", eager: true },
    ]);
    expect(body.mcpServers.map((server: { id: string }) => server.id)).toEqual(["crm", "posts"]);
    expect(body.mcpServers[1].requireApproval).toBe(true);

    const collision = proxySetup({
      createSession: ({ initialMessage }) => ({
        initialMessage,
        mcpServers: [{ id: "app", url: "https://other.example.test/mcp" }],
      }),
    });
    const response = await collision.handler(
      new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialMessage: "hi" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(collision.writes()).toHaveLength(0);
  });

  test("send, steer, submit, approval, and answer each rotate a fresh token", async () => {
    const { writes, requests, browser } = proxySetup();
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi" });
    await browser.steerMessage(WORKSPACE_ID, SESSION_ID, "now");
    await browser.submitComposerDraft(WORKSPACE_ID, SESSION_ID, {
      text: "draft",
      annotations: [],
      resources: [],
      model: "m",
      reasoningEffort: "medium",
      latencyMode: "standard",
      expectedDraftRevision: 1,
      clientEventId: "c1",
      delivery: "send",
    });
    await browser.sendEvent(WORKSPACE_ID, SESSION_ID, {
      type: "user.approvalDecision",
      clientEventId: "a1",
      payload: { approvalId: "call-1", decision: "approve" },
    } as never);
    await browser.sendEvent(WORKSPACE_ID, SESSION_ID, {
      type: "user.humanInputResponse",
      clientEventId: "h1",
      payload: {
        requestId: "r1",
        response: { outcome: "answered", answers: [] },
      },
    } as never);
    const bodies = writes().map((request) => request.body);
    const updates = [
      bodies[0].payload.mcpCredentialUpdates,
      bodies[1].mcpCredentialUpdates,
      bodies[2].mcpCredentialUpdates,
      bodies[3].payload.mcpCredentialUpdates,
      bodies[4].payload.mcpCredentialUpdates,
    ];
    for (const update of updates) {
      expect(update).toHaveLength(1);
      expect(update[0].id).toBe("app");
      const verified = await verifyToolRequest(bearer(tokenOf(update[0].headers)), {
        secret: SECRET,
      });
      expect(verified.user).toBe("u_42");
    }
    // The attachment lookup and the creator subject are cached.
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
  });

  test("in a shared chat, tools keep acting as the chat's creator", async () => {
    const { writes, browser, signInAs } = proxySetup({ chats: "shared" });
    signInAs("u_7");
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi from a teammate" });
    expect(writes()[0]!.body.payload.mcpCredentialUpdates).toBeUndefined();
    signInAs("u_42");
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi from the creator" });
    expect(writes()[1]!.body.payload.mcpCredentialUpdates).toHaveLength(1);
  });

  test("sessions without this tool server are not rotated; host rotations win", async () => {
    const { writes, browser } = proxySetup({
      beforeForwardMessage: () => ({
        mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer host" } }],
      }),
    });
    await browser.sendMessage(WORKSPACE_ID, OTHER_SESSION, { text: "hi" });
    expect(writes()[0]!.body.payload.mcpCredentialUpdates).toEqual([
      { id: "crm", headers: { Authorization: "Bearer host" } },
    ]);
    await browser.sendMessage(WORKSPACE_ID, SESSION_ID, { text: "hi" });
    expect(
      writes()[1]!.body.payload.mcpCredentialUpdates.map((update: { id: string }) => update.id),
    ).toEqual(["crm", "app"]);

    const hostOwned = proxySetup({
      beforeForwardMessage: () => ({
        mcpCredentialUpdates: [{ id: "app", headers: { Authorization: "Bearer host" } }],
      }),
    });
    await hostOwned.browser.sendMessage(WORKSPACE_ID, SESSION_ID, {
      text: "hi",
    });
    expect(hostOwned.writes()[0]!.body.payload.mcpCredentialUpdates).toEqual([
      { id: "app", headers: { Authorization: "Bearer host" } },
    ]);
  });

  test("tool server configuration is validated at startup", () => {
    const service = new OpenGeniClient({ baseUrl: API, apiKey: "k" });
    const resolve = () => ({ workspaceId: WORKSPACE_ID, user: "u" });
    for (const toolServer of [
      { url: "http://localhost:3000/api/mcp", secret: SECRET },
      { url: "/api/mcp", secret: SECRET },
      { url: TOOL_URL, secret: SECRET, id: "bad id" },
      { url: TOOL_URL, secret: SECRET, approvals: { ask: [""] } },
    ]) {
      expect(() =>
        createSessionProxyHandler(service, {
          resolve,
          toolServer: toolServer as never,
        }),
      ).toThrow(TypeError);
    }
  });
});

describe("a product MCP server built with the official MCP SDK", () => {
  const posts = new Map([
    ["p1", { id: "p1", owner: "u_42", title: "Launch plan" }],
    ["p2", { id: "p2", owner: "u_7", title: "Someone else's draft" }],
  ]);

  // What the docs show: verify, then scope every tool to the verified user.
  async function mcp(request: Request): Promise<Response> {
    let user: string;
    try {
      ({ user } = await verifyToolRequest(request, { secret: SECRET }));
    } catch (error) {
      if (error instanceof ToolRequestError) return error.toResponse();
      throw error;
    }
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    server.registerTool(
      "searchPosts",
      {
        description: "Search the user's posts",
        inputSchema: { query: z.string() },
      },
      async ({ query }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              [...posts.values()].filter(
                (post) => post.owner === user && post.title.toLowerCase().includes(query),
              ),
            ),
          },
        ],
      }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(request);
  }

  function rpc(token: string | null, body: unknown): Request {
    return new Request(TOOL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  test("the attached token calls tools as the proxy-resolved user only", async () => {
    // OpenGeni presents exactly the header the proxy attached on create.
    const { writes, browser } = proxySetup();
    await browser.createSession(WORKSPACE_ID, {
      initialMessage: "hi",
    } as never);
    const token = tokenOf(writes()[0]!.body.mcpServers[0].headers);

    const listed = await mcp(rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(listed.status).toBe(200);
    expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "searchPosts",
    ]);
    const called = await mcp(
      rpc(token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "searchPosts", arguments: { query: "" } },
      }),
    );
    const result = await called.json();
    expect(JSON.parse(result.result.content[0].text)).toEqual([
      { id: "p1", owner: "u_42", title: "Launch plan" },
    ]);

    const anonymous = await mcp(rpc(null, { jsonrpc: "2.0", id: 3, method: "tools/list" }));
    expect(anonymous.status).toBe(401);
  });
});
