import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "bin", "ogtool.cjs");
const packageVersion = (
  (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version: string }
).version;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function run(
  args: string[],
  environment: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["node", cli, ...args], {
    env: {
      ...process.env,
      OPENGENI_TOOLSPACE_URL: undefined,
      OPENGENI_TOOLSPACE_TOKEN_FILE: undefined,
      OPENGENI_OGTOOL_PACKAGE_SPEC: undefined,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function tokenFile(value = "test-bearer"): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "opengeni-ogtool-test-"));
  temporaryRoots.push(root);
  const path = join(root, "token");
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  return { root, path };
}

type RecordedRequest = { method: string; authorization: string | null; sessionId: string | null };

function mcpServer(options: { eventStreamList?: boolean; failStatus?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      requests.push({
        method: payload.method,
        authorization: request.headers.get("authorization"),
        sessionId: request.headers.get("mcp-session-id"),
      });
      if (options.failStatus) {
        return new Response("mock upstream failure", { status: options.failStatus });
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (payload.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "session-1" } },
        );
      }
      const result =
        payload.method === "tools/list"
          ? { tools: [{ name: "example", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: JSON.stringify(payload.params) }] };
      const response = { jsonrpc: "2.0", id: payload.id, result };
      if (options.eventStreamList && payload.method === "tools/list") {
        return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(response);
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}/mcp` };
}

describe("ogtool CLI", () => {
  test("reports its package version without requiring Toolspace", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
    expect(result.stderr).toBe("");
  });

  test("doctor reports configuration without exposing the bearer", async () => {
    const token = await tokenFile("never-print-this");
    const result = await run(["doctor"], {
      OPENGENI_TOOLSPACE_URL: "https://api.example.invalid/mcp",
      OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      OPENGENI_OGTOOL_PACKAGE_SPEC: "@opengeni/ogtool@0.1.0",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      tokenFileReadable: true,
      tokenFileNonempty: true,
      packageSpec: "@opengeni/ogtool@0.1.0",
    });
    expect(result.stdout).not.toContain("never-print-this");
  });

  test("lists tools over Streamable HTTP and carries the negotiated session", async () => {
    const token = await tokenFile();
    const mock = mcpServer();
    try {
      const result = await run(["list"], {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        tools: [{ name: "example", inputSchema: { type: "object" } }],
      });
      expect(mock.requests.map((request) => request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(mock.requests.every((request) => request.authorization === "Bearer test-bearer")).toBe(
        true,
      );
      expect(mock.requests[0]?.sessionId).toBeNull();
      expect(mock.requests.slice(1).every((request) => request.sessionId === "session-1")).toBe(
        true,
      );
    } finally {
      mock.server.stop(true);
    }
  });

  test("parses event-stream MCP responses", async () => {
    const token = await tokenFile();
    const mock = mcpServer({ eventStreamList: true });
    try {
      const result = await run(["tools/list"], {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).tools[0].name).toBe("example");
    } finally {
      mock.server.stop(true);
    }
  });

  test("calls a tool with an object payload", async () => {
    const token = await tokenFile();
    const mock = mcpServer();
    try {
      const result = await run(["call", "example", '{"answer":42}'], {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).content[0].text).toContain('"answer":42');
    } finally {
      mock.server.stop(true);
    }
  });

  test("rejects malformed arguments before sending a tool call", async () => {
    const token = await tokenFile();
    const mock = mcpServer();
    try {
      const result = await run(["call", "example", "[1,2]"], {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tool arguments must be a JSON object");
      expect(mock.requests.map((request) => request.method)).not.toContain("tools/call");
    } finally {
      mock.server.stop(true);
    }
  });

  test("returns a bounded generic HTTP failure", async () => {
    const token = await tokenFile();
    const mock = mcpServer({ failStatus: 503 });
    try {
      const result = await run(["list"], {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Toolspace HTTP 503: mock upstream failure");
    } finally {
      mock.server.stop(true);
    }
  });

  test("reads a renewed token on the next process", async () => {
    const token = await tokenFile("first");
    const mock = mcpServer();
    try {
      const environment = {
        OPENGENI_TOOLSPACE_URL: mock.url,
        OPENGENI_TOOLSPACE_TOKEN_FILE: token.path,
      };
      expect((await run(["list"], environment)).exitCode).toBe(0);
      await writeFile(token.path, "second\n", { mode: 0o600 });
      expect((await run(["list"], environment)).exitCode).toBe(0);
      expect(mock.requests.some((request) => request.authorization === "Bearer first")).toBe(true);
      expect(mock.requests.some((request) => request.authorization === "Bearer second")).toBe(true);
    } finally {
      mock.server.stop(true);
    }
  });
});
