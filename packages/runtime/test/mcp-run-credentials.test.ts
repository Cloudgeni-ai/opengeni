import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { testSettings } from "@opengeni/testing";
import { RunMcpCredentials } from "../src/mcp-run-credentials";
import { normalizeRunCredentialsResolution } from "../src/sandbox/run-credentials";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  selectedSessionRemoteMcpTargets,
} from "../src/index";

const scope = {
  accountId: crypto.randomUUID(),
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
};
const target = { id: "custom", url: "https://product.example/mcp" };
const secret = "provider-secret-never-persist";

function material(url = target.url, expiresAt?: string) {
  return normalizeRunCredentialsResolution(
    {
      status: "ok",
      ...scope,
      environment: {},
      mcp: [{ url, headers: { Authorization: secret }, ...(expiresAt ? { expiresAt } : {}) }],
    },
    scope,
    new Date("2026-09-30T08:00:00Z"),
  );
}

describe("attempt-local MCP credentials", () => {
  test("native connection targets never enter provider selection or credential ownership", () => {
    const native = {
      ...target,
      connectionRef: {
        providerDomain: "product.example",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
    };
    const settings = testSettings({ mcpServers: [native] });
    expect(
      selectedSessionRemoteMcpTargets(settings, [target], [{ kind: "mcp", id: target.id }]),
    ).toEqual([]);
    const credentials = new RunMcpCredentials([native]);
    credentials.replace(material());
    expect(credentials.has(native.id)).toBe(false);
  });

  test("native request boundary drops stale provider grants without overriding any headers", () => {
    const credentials = new RunMcpCredentials([target]);
    credentials.replace({
      expiresAt: null,
      mcp: [
        {
          url: target.url,
          headers: { Authorization: secret, "x-api-key": "provider-key" },
        },
      ],
    });
    const native = {
      ...target,
      connectionRef: { providerDomain: "product.example" },
    };
    const request = { headers: { Authorization: "Bearer native-A", "x-native": "yes" } };
    expect(credentials.requestInit(native, native.url, request)).toBe(request);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer native-A");
    expect(new Headers(request.headers).get("x-api-key")).toBeNull();
    expect(credentials.has(native.id)).toBe(false);
    const staleRenewal = credentials.prepare(material());
    staleRenewal();
    expect(credentials.has(native.id)).toBe(false);
  });

  test("native preparation narrowing fences a renewal staged before route resolution", () => {
    const credentials = new RunMcpCredentials([target]);
    credentials.replace(material());
    const staged = credentials.prepare(material());
    credentials.assertRemoteTargets([
      { ...target, connectionRef: { providerDomain: "product.example" } },
    ]);
    staged();
    expect(credentials.has(target.id)).toBe(false);
  });

  test("reusing a product server id at a different URL never receives product headers", () => {
    const attacker = { id: "product-capabilities", url: "https://evil.example/mcp" };
    const credentials = new RunMcpCredentials([attacker]);
    credentials.replace({
      expiresAt: null,
      mcp: [{ url: "https://product.example/mcp", headers: { Authorization: secret } }],
    });
    const request = { headers: { "x-existing": "ordinary" } };
    expect(credentials.requestInit(attacker, attacker.url, request)).toBe(request);
    expect(new Headers(request.headers).get("authorization")).toBeNull();
    expect(credentials.has(attacker.id)).toBe(false);
  });

  test("callback selection retains exact selected attachments, never workspace or local routes", () => {
    const local = { id: "local-api", url: "https://local.example/mcp" };
    const unselected = { id: "unselected", url: "https://unselected.example/mcp" };
    const workspace = { id: "workspace", url: "https://workspace.example/mcp" };
    const rewritten = { id: "rewritten", url: "https://changed.example/mcp" };
    const settings = testSettings({
      mcpServers: [target, local, unselected, workspace, rewritten],
    });
    const selected = [target, local, workspace, rewritten].map(({ id }) => ({
      kind: "mcp" as const,
      id,
    }));
    expect(
      selectedSessionRemoteMcpTargets(
        settings,
        [target, local, unselected, { ...rewritten, url: "https://original.example/mcp" }],
        selected,
        [{ id: local.id }],
      ),
    ).toEqual([target]);
    expect(selectedSessionRemoteMcpTargets(settings, [], selected)).toEqual([]);
    expect(selectedSessionRemoteMcpTargets(settings, [target], [])).toEqual([]);
  });

  test("mixed skipped renewal entries do not disable another valid grant", () => {
    const other = { id: "other", url: "https://other.example/mcp" };
    const credentials = new RunMcpCredentials([target, other]);
    credentials.replace({
      expiresAt: null,
      mcp: [
        { url: target.url, headers: { authorization: "initial" } },
        { url: other.url, headers: { authorization: "other-initial" } },
      ],
    });
    credentials.replace({
      expiresAt: null,
      mcp: [
        { url: target.url, headers: { authorization: "renewed" } },
        { url: "https://unselected.example/mcp", headers: { authorization: secret } },
      ],
    });
    expect(
      new Headers(credentials.requestInit(target, target.url)!.headers).get("authorization"),
    ).toBe("renewed");
    expect(
      new Headers(credentials.requestInit(other, other.url)!.headers).get("authorization"),
    ).toBe("other-initial");
  });

  test("merges case-insensitively, renews live, and fails closed on expiry or revocation", () => {
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
          url: target.url,
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
    expect(() => credentials.requestInit(target, target.url, staticInit)).toThrow(
      "authentication unavailable",
    );
    credentials.replace(null);
    expect(() => credentials.requestInit(target, target.url, staticInit)).toThrow(
      "authentication unavailable",
    );
    credentials.replace(material(target.url, "2026-09-30T08:30:00Z"));
    expect(
      new Headers(credentials.requestInit(target, target.url, staticInit)!.headers).get(
        "authorization",
      ),
    ).toBe(secret);
    expect(JSON.stringify(credentials)).not.toContain(secret);
  });

  test("skips ambiguous and unmatched targets and rejects changed destinations without secrets", () => {
    const credentials = new RunMcpCredentials([target]);
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args) => {
      warnings.push(args);
    };
    try {
      credentials.replace({
        expiresAt: null,
        mcp: [{ url: "https://missing.example/mcp", headers: { Authorization: secret } }],
      });
      expect(credentials.has(target.id)).toBe(false);
      const ambiguous = new RunMcpCredentials([target, { id: "other", url: target.url }]);
      ambiguous.replace(material());
      expect(ambiguous.has(target.id)).toBe(false);
      expect(JSON.stringify(warnings)).not.toContain(secret);
      expect(JSON.stringify(warnings)).not.toContain("missing.example");
      expect(warnings).toHaveLength(2);
    } finally {
      console.warn = warn;
    }
    credentials.replace(material());
    expect(() => credentials.requestInit(target, "https://elsewhere.example/mcp")).toThrow(
      "destination changed",
    );
    credentials.assertRemoteTargets([]);
    expect(credentials.has(target.id)).toBe(false);
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
    credentials.replace({
      expiresAt: null,
      mcp: [{ url: workspaceTarget.url, headers: { authorization: secret } }],
    });
    expect(credentials.has(workspaceTarget.id)).toBe(false);
    credentials.excludeLocalTarget(target.id);
    credentials.replace(material());
    expect(credentials.has(target.id)).toBe(false);
  });

  test("route narrowing fences a renewal staged before asynchronous sandbox writes", () => {
    const credentials = new RunMcpCredentials([target]);
    const apply = credentials.prepare(material());
    credentials.assertRemoteTargets([]);
    apply();
    expect(credentials.has(target.id)).toBe(false);
  });

  test("uses the earlier run or entry expiry", () => {
    const now = Date.parse("2026-09-30T08:00:00Z");
    const credentials = new RunMcpCredentials([target], { now: () => now });
    credentials.replace({ ...material(), expiresAt: new Date(now) });
    expect(() => credentials.assertAvailable(target.id)).toThrow("authentication unavailable");
    credentials.replace({
      expiresAt: null,
      mcp: [
        {
          url: target.url,
          headers: { authorization: secret },
          expiresAt: "2026-09-30T07:59:00Z",
        },
      ],
    });
    expect(() => credentials.assertAvailable(target.id)).toThrow("authentication unavailable");
  });

  test("shared validation rejects unsafe material with value-free errors", () => {
    const invalid = [
      [{ url: target.url, headers: { Host: secret } }],
      [{ url: target.url, headers: { "content-length": secret } }],
      [{ url: target.url, headers: { "mcp-session-id": secret } }],
      [{ url: target.url, headers: { "MCP-PROTOCOL-VERSION": secret } }],
      [{ url: target.url, headers: { "content-type": secret } }],
      [{ url: target.url, headers: { Accept: secret } }],
      [{ url: target.url, headers: { "bad name": secret } }],
      [{ url: target.url, headers: { authorization: secret, Authorization: secret } }],
      [{ url: target.url, headers: { authorization: `${secret}\r\nx-evil: yes` } }],
      [{ url: target.url, headers: { authorization: secret.repeat(2000) } }],
      [{ url: target.url, headers: { authorization: secret }, expiresAt: "tomorrow" }],
      [{ server: "custom", headers: { authorization: secret } }],
      [
        { server: "custom", headers: { authorization: secret } },
        { server: "custom", headers: { authorization: secret } },
      ],
      Array.from({ length: 33 }, (_, i) => ({
        url: `https://product.example/${i}`,
        headers: { authorization: secret },
      })),
      [
        {
          url: target.url,
          headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-${i}`, secret])),
        },
      ],
      [
        {
          url: target.url,
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

test.each([true, false])(
  "real SDK transport fails closed on expiry and heals with renewal (attempt gateway: %s)",
  async (withAttemptGateway) => {
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
          url: remote.url,
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
      ...(withAttemptGateway
        ? {
            ...scope,
            turnId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
            executionGeneration: 1,
          }
        : {}),
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
            url: remote.url,
            headers: { authorization: "renewed" },
            expiresAt: new Date(now + 60_000).toISOString(),
          },
        ],
      });
      await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-renewed" } } as never);
      expect(seen.at(-1)?.authorization).toBe("renewed");
      now += 60_000;
      const beforeExpiry = seen.length;
      const expired = await tool.invoke(new RunContext(), "{}", {
        toolCall: { callId: "call-expired" },
      } as never);
      expect(JSON.stringify(expired)).toContain("authentication unavailable");
      expect(seen).toHaveLength(beforeExpiry);
      credentials.replace({
        expiresAt: null,
        mcp: [{ url: remote.url, headers: { authorization: "healed" } }],
      });
      await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-healed" } } as never);
      expect(seen.at(-1)?.authorization).toBe("healed");
    } finally {
      await prepared.close();
      for (const transport of transports) await transport.close();
      provider.stop(true);
    }
  },
);

test("credentialed HTTP failures never expose an echoed secret in required MCP errors or logs", async () => {
  const remote = { id: target.id, url: "http://127.0.0.1:9/mcp" };
  const credentials = new RunMcpCredentials([remote]);
  credentials.replace(material(remote.url));
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

test("real transport never sends provider credentials to a server whose ID impersonates the URL", async () => {
  const seen: Array<{ path: string; authorization: string | null }> = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      });
      const server = new McpServer({ name: "target", version: "1.0.0" });
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
  const product = { id: "product", url: `http://127.0.0.1:${provider.port}/product` };
  const attacker = { id: product.url, url: `http://127.0.0.1:${provider.port}/attacker` };
  const credentials = new RunMcpCredentials([product, attacker]);
  credentials.replace({
    expiresAt: null,
    mcp: [{ url: product.url, headers: { authorization: secret } }],
  });
  let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | undefined;
  try {
    prepared = await prepareAgentTools(
      testSettings({ sandboxBackend: "none", mcpServers: [product, attacker] }),
      [product, attacker].map(({ id }) => ({ kind: "mcp" as const, id, eager: true })),
      { runMcpCredentials: credentials },
    );
    const intended = seen.filter((entry) => entry.path === "/product");
    const malicious = seen.filter((entry) => entry.path === "/attacker");
    expect(intended.length).toBeGreaterThan(0);
    expect(malicious.length).toBeGreaterThan(0);
    expect(intended.every((entry) => entry.authorization === secret)).toBe(true);
    expect(malicious.every((entry) => entry.authorization === null)).toBe(true);
  } finally {
    await prepared?.close();
    for (const transport of transports) await transport.close();
    provider.stop(true);
  }
});

test("unselected and local MCP targets skip credentials without failing session preparation", async () => {
  const credentials = new RunMcpCredentials([target]);
  credentials.replace(material());
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [target] });
  let requests = 0;
  const mcpFetchImpl = async () => {
    requests += 1;
    return new Response(null, { status: 500 });
  };
  const empty = await prepareAgentTools(settings, [], {
    runMcpCredentials: credentials,
    mcpFetchImpl,
  });
  await empty.close();
  const local = await prepareAgentTools(settings, [{ kind: "mcp", id: target.id }], {
    runMcpCredentials: credentials,
    mcpFetchImpl,
    localMcpServers: [
      {
        id: target.id,
        server: {
          name: "local",
          connect: async () => {},
          close: async () => {},
          listTools: async () => [],
        } as never,
      },
    ],
  });
  await local.close();
  expect(requests).toBe(0);
});

test("native 403 recovery preserves its bearer and never sends discarded provider material", async () => {
  const remote = { id: target.id, url: "http://127.0.0.1:9/mcp" };
  const credentials = new RunMcpCredentials([remote]);
  credentials.replace(material(remote.url));
  const notices: unknown[] = [];
  const authorizations: Array<string | null> = [];
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
    mcpFetchImpl: async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(secret, {
        status: 403,
        headers: {
          "www-authenticate": 'Bearer error="insufficient_scope", scope="read"',
        },
      });
    },
  });
  try {
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices)).toContain("insufficient_scope");
    expect(authorizations.length).toBeGreaterThan(0);
    expect([...new Set(authorizations)]).toEqual(["native"]);
    expect(credentials.has(remote.id)).toBe(false);
    expect(JSON.stringify(notices)).toContain("read");
    expect(JSON.stringify(notices)).not.toContain(secret);
    expect(JSON.stringify(prepared.attemptToolCatalog)).not.toContain(secret);
  } finally {
    await prepared.close();
  }
});
