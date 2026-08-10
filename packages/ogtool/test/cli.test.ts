import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttemptToolEnvironment } from "@opengeni/codemode";

const cli = join(import.meta.dir, "..", "dist", "bin", "ogtool.cjs");
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
      OPENGENI_CODEMODE_URL: undefined,
      OPENGENI_CODEMODE_TOKEN_FILE: undefined,
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

type RecordedRequest = { method: string; path: string; authorization: string | null };

function codemodeServer(
  options: { failStatus?: number; outcomeUnknown?: boolean; loseFirstPostResponse?: boolean } = {},
) {
  const requests: RecordedRequest[] = [];
  const operationId = "66666666-6666-4666-8666-666666666666";
  const catalog = createAttemptToolEnvironment({
    scope: {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 1,
    },
    generation: 1,
    createdAt: new Date("2026-08-09T12:00:00.000Z"),
    definitions: [
      {
        identity: { serverId: "docs", toolName: "search" },
        modelName: "docs__search",
        description: "Search docs",
        inputSchema: { type: "object" },
        source: "docs",
        approval: "none",
        execute: async () => ({ content: [] }),
      },
    ],
  }).catalog;
  let storedOperation: Record<string, unknown> | null = null;
  let lostPost = false;
  const operationFor = (operationIdValue: string, argumentsValue: Record<string, unknown>) => {
    const terminalState = options.outcomeUnknown ? "outcome_unknown" : "completed";
    return {
      version: 1,
      operationId: operationIdValue,
      accountId: catalog.accountId,
      workspaceId: catalog.workspaceId,
      sessionId: catalog.sessionId,
      turnId: catalog.turnId,
      attemptId: catalog.attemptId,
      executionGeneration: 1,
      catalogDigest: catalog.digest,
      requestDigest: "b".repeat(64),
      identity: catalog.entries[0]!.identity,
      arguments: argumentsValue,
      caller: { kind: "codemode", subjectId: "agent:test" },
      state: terminalState,
      result:
        terminalState === "completed"
          ? { content: [{ type: "text", text: JSON.stringify(argumentsValue) }] }
          : null,
      errorCode: terminalState === "outcome_unknown" ? "tool_outcome_unknown" : null,
      errorMessage:
        terminalState === "outcome_unknown" ? "Inspect actual state before retrying." : null,
      createdAt: catalog.createdAt,
      claimedAt: catalog.createdAt,
      executionStartedAt: catalog.createdAt,
      completedAt: catalog.createdAt,
      updatedAt: catalog.createdAt,
    };
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
      });
      if (options.failStatus) {
        return Response.json(
          { error: { message: "mock Codemode failure" } },
          { status: options.failStatus },
        );
      }
      if (url.pathname.endsWith("/catalog")) return Response.json(catalog);
      if (request.method === "POST" && url.pathname.endsWith("/calls")) {
        const payload = (await request.json()) as {
          operationId: string;
          arguments: Record<string, unknown>;
        };
        storedOperation = operationFor(payload.operationId, payload.arguments);
        if (options.loseFirstPostResponse && !lostPost) {
          lostPost = true;
          return Response.json(
            { error: { message: "response lost after commit" } },
            { status: 503 },
          );
        }
        return Response.json({
          operation: storedOperation,
          dispatch: "terminal",
        });
      }
      if (request.method === "GET" && url.pathname.includes("/calls/") && storedOperation) {
        return Response.json(storedOperation);
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });
  return {
    server,
    requests,
    catalog,
    url: `http://127.0.0.1:${server.port}/codemode`,
    operationId,
  };
}

describe("ogtool CLI", () => {
  test("reports its package version without requiring Codemode", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion);
    expect(result.stderr).toBe("");
  });

  test("doctor reports configuration without exposing the bearer", async () => {
    const token = await tokenFile("never-print-this");
    const result = await run(["doctor"], {
      OPENGENI_CODEMODE_URL: "https://api.example.invalid/mcp",
      OPENGENI_CODEMODE_TOKEN_FILE: token.path,
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

  test("lists the exact attempt-frozen catalog projection", async () => {
    const token = await tokenFile();
    const mock = codemodeServer();
    try {
      const result = await run(["list"], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        catalogDigest: mock.catalog.digest,
        tools: [{ name: "docs__search", path: "docs.search", approval: "none" }],
      });
      expect(mock.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/codemode/catalog"],
      ]);
      expect(mock.requests.every((request) => request.authorization === "Bearer test-bearer")).toBe(
        true,
      );
    } finally {
      mock.server.stop(true);
    }
  });

  test("calls a tool by typed path with one idempotent durable operation", async () => {
    const token = await tokenFile();
    const mock = codemodeServer();
    try {
      const result = await run(["call", "docs.search", '{"answer":42}'], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).content[0].text).toContain('"answer":42');
      expect(mock.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/codemode/catalog"],
        ["POST", "/codemode/calls"],
      ]);
    } finally {
      mock.server.stop(true);
    }
  });

  test("generates declarations pinned to the exact catalog digest", async () => {
    const token = await tokenFile();
    const mock = codemodeServer();
    try {
      const result = await run(["declarations"], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Attempt catalog digest: ${mock.catalog.digest}`);
      expect(result.stdout).toContain("interface CodemodeGeneratedTools");
      expect(result.stdout).toContain("readonly docs:");
      expect(mock.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/codemode/catalog"],
      ]);
    } finally {
      mock.server.stop(true);
    }
  });

  test("recovers the caller-owned operation when a committed POST response is lost", async () => {
    const token = await tokenFile();
    const mock = codemodeServer({ loseFirstPostResponse: true });
    try {
      const result = await run(["call", "docs.search", '{"answer":42}'], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).content[0].text).toContain('"answer":42');
      expect(mock.requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/codemode/catalog"],
        ["POST", "/codemode/calls"],
        ["GET", expect.stringContaining("/codemode/calls/")],
      ]);
    } finally {
      mock.server.stop(true);
    }
  });

  test("rejects malformed arguments before sending a tool call", async () => {
    const token = await tokenFile();
    const mock = codemodeServer();
    try {
      const result = await run(["call", "docs.search", "[1,2]"], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("tool arguments must be a JSON object");
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.server.stop(true);
    }
  });

  test("returns a bounded generic HTTP failure", async () => {
    const token = await tokenFile();
    const mock = codemodeServer({ failStatus: 503 });
    try {
      const result = await run(["list"], {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mock Codemode failure");
    } finally {
      mock.server.stop(true);
    }
  });

  test("reads a renewed token on the next process", async () => {
    const token = await tokenFile("first");
    const mock = codemodeServer();
    try {
      const environment = {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN_FILE: token.path,
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
