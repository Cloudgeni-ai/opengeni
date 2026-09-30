import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { testSettings } from "@opengeni/testing";
import { RunMcpCredentialError, RunMcpCredentials } from "../src/mcp-run-credentials";
import { normalizeRunCredentialsResolution } from "../src/sandbox/run-credentials";
import { buildOpenGeniAgent, prepareAgentTools } from "../src/index";

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
};
const target = { id: "custom", url: "https://product.example/mcp" };
const secret = "provider-secret-never-persist";

function material(server = target.id, expiresAt?: string) {
  return normalizeRunCredentialsResolution(
    {
      status: "ok",
      ...scope,
      environment: {},
      mcp: [{ server, headers: { Authorization: secret }, ...(expiresAt ? { expiresAt } : {}) }],
    },
    scope,
    new Date("2026-09-30T08:00:00Z"),
  );
}

describe("attempt-local MCP credentials", () => {
  test("merges case-insensitively, renews live, and restores static headers on expiry", () => {
    let now = Date.parse("2026-09-30T08:00:00Z");
    const credentials = new RunMcpCredentials([target], { now: () => now });
    const staticInit = { headers: { authorization: "static", "x-static": "yes" } };
    credentials.replace(material(target.url, "2026-09-30T08:10:00Z"));
    const first = credentials.requestInit(target, target.url, staticInit)!;
    expect(new Headers(first.headers).get("authorization")).toBe(secret);
    expect(new Headers(first.headers).get("x-static")).toBe("yes");
    expect(staticInit.headers.authorization).toBe("static");
    credentials.replace({
      expiresAt: null,
      mcp: [
        {
          server: target.id,
          headers: { AUTHORIZATION: "renewed" },
          expiresAt: "2026-09-30T08:20:00Z",
        },
      ],
    });
    expect(
      new Headers(credentials.requestInit(target, target.url, staticInit)!.headers).get(
        "authorization",
      ),
    ).toBe("renewed");
    now = Date.parse("2026-09-30T08:20:00Z");
    expect(credentials.requestInit(target, target.url, staticInit)).toBe(staticInit);
    credentials.replace(null);
    expect(credentials.requestInit(target, target.url, staticInit)).toBe(staticInit);
    expect(JSON.stringify(credentials)).not.toContain(secret);
  });

  test("rejects ambiguous, unmatched, duplicate aliases and changed destinations without secrets", () => {
    const credentials = new RunMcpCredentials([target]);
    for (const value of [
      { expiresAt: null, mcp: [{ server: "missing", headers: { Authorization: secret } }] },
      {
        expiresAt: null,
        mcp: [
          { server: target.id, headers: { Authorization: secret } },
          { server: target.url, headers: { Authorization: secret } },
        ],
      },
    ]) {
      try {
        credentials.replace(value);
        throw new Error("expected target validation");
      } catch (error) {
        expect(error).toBeInstanceOf(RunMcpCredentialError);
        expect(String(error)).not.toContain(secret);
      }
    }
    expect(() =>
      new RunMcpCredentials([target, { id: "other", url: target.url }]).replace(
        material(target.url),
      ),
    ).toThrow("ambiguous");
    credentials.replace(material());
    expect(() => credentials.requestInit(target, "https://elsewhere.example/mcp")).toThrow(
      "destination changed",
    );
    expect(() => credentials.assertRemoteTargets([])).toThrow("selected remote");
  });

  test("cancellation fences a staged or late renewal", () => {
    const abort = new AbortController();
    const credentials = new RunMcpCredentials([target], { signal: abort.signal });
    const apply = credentials.prepare(material());
    abort.abort();
    expect(apply).toThrow();
    expect(() => credentials.requestInit(target, target.url)).toThrow();
  });

  test("normal finalization drops secrets and rejects late request or renewal state", () => {
    const credentials = new RunMcpCredentials([target]);
    credentials.replace(material());
    const lateApply = credentials.prepare(material());
    credentials.close();
    credentials.close();
    expect(credentials.has(target.id)).toBe(false);
    expect(lateApply).toThrow("closed");
    expect(() => credentials.replace(material())).toThrow("closed");
    expect(() => credentials.requestInit(target, target.url)).toThrow("closed");
  });

  test("later renewals cannot expand from session attachments to selected workspace servers", () => {
    const credentials = new RunMcpCredentials([target]);
    const workspaceTarget = { id: "workspace-only", url: "https://other.example/mcp" };
    credentials.assertRemoteTargets([target, workspaceTarget]);
    expect(() =>
      credentials.replace({
        expiresAt: null,
        mcp: [{ server: workspaceTarget.id, headers: { authorization: secret } }],
      }),
    ).toThrow("unmatched");
    credentials.excludeLocalTarget(target.id);
    expect(() => credentials.replace(material())).toThrow("unmatched");
  });

  test("route narrowing fences a renewal staged before asynchronous sandbox writes", () => {
    const credentials = new RunMcpCredentials([target]);
    const apply = credentials.prepare(material());
    credentials.assertRemoteTargets([]);
    expect(apply).toThrow("selected remote");
  });

  test("uses the earlier run or entry expiry", () => {
    const now = Date.parse("2026-09-30T08:00:00Z");
    const credentials = new RunMcpCredentials([target], { now: () => now });
    expect(() => credentials.replace({ ...material(), expiresAt: new Date(now) })).toThrow(
      "expired",
    );
    expect(() => credentials.replace(material(target.id, "2026-09-30T07:59:00Z"))).toThrow(
      "expired",
    );
  });

  test("shared validation rejects unsafe material with value-free errors", () => {
    const invalid = [
      [{ server: "custom", headers: { Host: secret } }],
      [{ server: "custom", headers: { "content-length": secret } }],
      [{ server: "custom", headers: { "bad name": secret } }],
      [{ server: "custom", headers: { authorization: secret, Authorization: secret } }],
      [{ server: "custom", headers: { authorization: `${secret}\r\nx-evil: yes` } }],
      [{ server: "custom", headers: { authorization: secret.repeat(2000) } }],
      [{ server: "custom", headers: { authorization: secret }, expiresAt: "tomorrow" }],
      [
        { server: "custom", headers: { authorization: secret } },
        { server: "custom", headers: { authorization: secret } },
      ],
      Array.from({ length: 33 }, (_, i) => ({
        server: String(i),
        headers: { authorization: secret },
      })),
      [
        {
          server: "custom",
          headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, secret])),
        },
      ],
      [
        {
          server: "custom",
          headers: Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`x-${i}`, "x".repeat(16384)]),
          ),
        },
      ],
    ];
    for (const mcp of invalid) {
      try {
        normalizeRunCredentialsResolution({ status: "ok", ...scope, environment: {}, mcp }, scope);
        throw new Error("expected validation failure");
      } catch (error) {
        expect(String(error)).toContain("run MCP credential");
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});

test("real SDK transport applies headers before discovery and sees live renewal without reconnect", async () => {
  const seen: Array<{ method: string; authorization: string | null }> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({ method: request.method, authorization: request.headers.get("authorization") });
      const server = new McpServer({ name: "provider", version: "1.0.0" });
      server.registerTool("read", { inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "ok" }],
      }));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const remote = { id: "custom", url: `http://127.0.0.1:${provider.port}/mcp` };
  let now = Date.now();
  const credentials = new RunMcpCredentials([remote], { now: () => now });
  credentials.replace({
    expiresAt: null,
    mcp: [
      {
        server: remote.id,
        headers: { Authorization: secret },
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    ],
  });
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [{ ...remote, headers: { authorization: "static" } }],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: remote.id }], {
    ...scope,
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    runMcpCredentials: credentials,
  });
  try {
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.authorization === secret)).toBe(true);
    expect(JSON.stringify(prepared.attemptToolCatalog)).not.toContain(secret);
    const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (candidate) => candidate.type === "function" && candidate.name === "custom__read",
    );
    if (!tool || tool.type !== "function") throw new Error("MCP tool missing");
    credentials.replace({
      expiresAt: null,
      mcp: [
        {
          server: remote.url,
          headers: { authorization: "renewed" },
          expiresAt: new Date(now + 60_000).toISOString(),
        },
      ],
    });
    await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-renewed" } } as never);
    expect(seen.at(-1)?.authorization).toBe("renewed");
    now += 60_000;
    await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-expired" } } as never);
    expect(seen.at(-1)?.authorization).toBe("static");
  } finally {
    await prepared.close();
    for (const transport of transports) await transport.close();
    provider.stop(true);
  }
});

test("credentialed HTTP failures never expose an echoed secret in required MCP errors or logs", async () => {
  const remote = { id: target.id, url: "http://127.0.0.1:9/mcp" };
  const credentials = new RunMcpCredentials([remote]);
  credentials.replace(material());
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [remote] });
  let requests = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args);
  };
  try {
    let rejected: unknown;
    try {
      await prepareAgentTools(settings, [{ kind: "mcp", id: target.id }], {
        runMcpCredentials: credentials,
        mcpFetchImpl: async () => {
          requests += 1;
          return new Response(secret, { status: 500 });
        },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toContain("MCP");
    expect(String(rejected)).not.toContain(secret);
    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(requests).toBeGreaterThan(0);
  } finally {
    console.warn = originalWarn;
  }
});

test("unselected and local MCP targets fail before any connection", async () => {
  const credentials = new RunMcpCredentials([target]);
  credentials.replace(material());
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [target] });
  let requests = 0;
  const mcpFetchImpl = async () => {
    requests += 1;
    return new Response(null, { status: 500 });
  };
  await expect(
    prepareAgentTools(settings, [], { runMcpCredentials: credentials, mcpFetchImpl }),
  ).rejects.toThrow("selected remote");
  await expect(
    prepareAgentTools(settings, [{ kind: "mcp", id: target.id }], {
      runMcpCredentials: credentials,
      mcpFetchImpl,
      localMcpServers: [{ id: target.id, server: {} as never }],
    }),
  ).rejects.toThrow("selected remote");
  expect(requests).toBe(0);
});

test("credentialed 403 challenge fields cannot leak through native auth-needed events", async () => {
  const remote = { id: target.id, url: "http://127.0.0.1:9/mcp" };
  const credentials = new RunMcpCredentials([remote]);
  credentials.replace(material());
  const notices: unknown[] = [];
  const connectionRef = { providerDomain: "product.example", kind: "oauth2" as const };
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [{ ...remote, connectionRef }],
  });
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: target.id }], {
    runMcpCredentials: credentials,
    workspaceId: scope.workspaceId,
    resolveCredential: async () => ({
      status: "ok",
      connectionId: crypto.randomUUID(),
      headers: { authorization: "native" },
    }),
    onAuthNeeded: (notice) => {
      notices.push(notice);
    },
    mcpFetchImpl: async () =>
      new Response(secret, {
        status: 403,
        headers: {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${secret}", resource="${secret}", error_description="${secret}"`,
        },
      }),
  });
  try {
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices)).toContain("insufficient_scope");
    expect(JSON.stringify(notices)).not.toContain(secret);
    expect(JSON.stringify(prepared.attemptToolCatalog)).not.toContain(secret);
  } finally {
    await prepared.close();
  }
});
