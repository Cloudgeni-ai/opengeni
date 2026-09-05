import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttemptToolEnvironment, digestAttemptToolCatalog } from "@opengeni/codemode";

const cliSource = join(import.meta.dir, "..", "src", "cli.ts");
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
  command: string[] = [process.execPath, cliSource],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command, ...args], {
    env: {
      ...process.env,
      OPENGENI_CODEMODE_URL: undefined,
      OPENGENI_CODEMODE_TOKEN: undefined,
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
      if (url.pathname.endsWith("/catalog")) {
        const { digest: _digest, ...unsigned } = catalog;
        catalog.digest = digestAttemptToolCatalog(unsigned);
        return Response.json(catalog);
      }
      if (request.method === "POST" && url.pathname.endsWith("/calls")) {
        const payload = (await request.json()) as {
          operationId: string;
          arguments: Record<string, unknown>;
        };
        storedOperation = operationFor(payload.operationId, payload.arguments);
        if (options.loseFirstPostResponse && !lostPost) {
          lostPost = true;
          return Response.json(
            {
              error: {
                message: "response lost after commit",
                outcomeUnknown: true,
              },
            },
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
  test.skipIf(!process.env.OPENGENI_OGTOOL_TEST_NATIVE_CLIENT)(
    "built native discovery matches actual ogtool stdout and JSON",
    async () => {
      const mock = codemodeServer();
      const environment = { OPENGENI_CODEMODE_URL: mock.url, OPENGENI_CODEMODE_TOKEN: "test" };
      const native = [process.env.OPENGENI_OGTOOL_TEST_NATIVE_CLIENT!, "codemode"];
      try {
        const template = mock.catalog.entries[0]!;
        mock.catalog.entries = Array.from({ length: 101 }, (_, index) => ({
          ...template,
          identity: { serverId: "docs", toolName: `tool${index}` },
          modelName: `tool${index}`,
          codemodePath: ["docs", `tool${index}`],
          description: `${"😀".repeat(160)} Needle 界`,
        }));
        for (const args of [
          ["list"],
          ["list", "--json"],
          ["list", "--full"],
          ["show", "docs.tool0"],
          ["list", "--json", "--limit=100", "--offset=7"],
          ["list", "--query=Needle 界", "--limit=2", "--offset=1"],
          ["list", "--json", "--query=needle"],
          ["list", "--json", "--offset=999"],
        ]) {
          const [js, rust] = await Promise.all([
            run(args, environment),
            run(args, environment, native),
          ]);
          expect(js.exitCode).toBe(0);
          expect(rust.exitCode).toBe(0);
          if (args.includes("--json") || args.includes("--full") || args[0] === "show") {
            expect(JSON.parse(rust.stdout)).toEqual(JSON.parse(js.stdout));
          } else expect(rust.stdout).toBe(js.stdout);
          if (args[0] === "list" && !args.includes("--full")) {
            expect(Buffer.byteLength(rust.stdout, "utf8")).toBeLessThanOrEqual(16_384);
            expect(Buffer.byteLength(js.stdout, "utf8")).toBeLessThanOrEqual(16_384);
          }
        }
        const controls = String.fromCharCode(
          ...Array.from({ length: 32 }, (_, index) => index),
          ...Array.from({ length: 33 }, (_, index) => 127 + index),
        );
        const payload = `Search\u001b]52;c;VEVTVA==\u0007 CSI\u001b[2J Back\u0008${controls}`;
        for (const field of ["description", "title"] as const) {
          for (const entry of mock.catalog.entries) {
            delete entry.description;
            delete entry.title;
            entry[field] = payload;
          }
          for (const args of [
            ["list"],
            ["list", "--json"],
            ["list", "--full"],
            ["show", "docs.tool0"],
            ["list", "--query", "\u001b]52"],
          ]) {
            const [js, rust] = await Promise.all([
              run(args, environment),
              run(args, environment, native),
            ]);
            expect(js.exitCode).toBe(0);
            expect(rust.exitCode).toBe(0);
            if (args.includes("--json") || args.includes("--full") || args[0] === "show") {
              expect(JSON.parse(rust.stdout)).toEqual(JSON.parse(js.stdout));
            } else {
              expect(rust.stdout).toBe(js.stdout);
              expect(js.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
              expect(js.stdout).toContain("Search\\u001b]52;c;VEVTVA==\\u0007");
              expect(Buffer.byteLength(js.stdout, "utf8")).toBeLessThanOrEqual(16_384);
            }
          }
        }
      } finally {
        mock.server.stop(true);
      }
    },
    30_000,
  );

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

  test("doctor and calls prefer an exact transient bearer over an ambient file", async () => {
    const stale = await tokenFile("stale-file-bearer");
    const mock = codemodeServer();
    try {
      const environment = {
        OPENGENI_CODEMODE_URL: mock.url,
        OPENGENI_CODEMODE_TOKEN: "direct-attempt-bearer",
        OPENGENI_CODEMODE_TOKEN_FILE: stale.path,
      };
      const doctorResult = await run(["doctor"], environment);
      expect(doctorResult.exitCode).toBe(0);
      expect(JSON.parse(doctorResult.stdout)).toMatchObject({
        ok: true,
        tokenMode: "environment",
        directTokenConfigured: true,
        directTokenNonempty: true,
      });
      expect(doctorResult.stdout).not.toContain("direct-attempt-bearer");

      expect((await run(["list"], environment)).exitCode).toBe(0);
      expect(mock.requests.map((request) => request.authorization)).toEqual([
        "Bearer direct-attempt-bearer",
      ]);
    } finally {
      mock.server.stop(true);
    }
  });

  test("lists the exact attempt-frozen catalog projection", async () => {
    const token = await tokenFile();
    const mock = codemodeServer();
    try {
      const result = await run(["list", "--full"], {
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

  test("compact discovery and show disclose only the requested detail", async () => {
    const mock = codemodeServer();
    const environment = { OPENGENI_CODEMODE_URL: mock.url, OPENGENI_CODEMODE_TOKEN: "test" };
    try {
      const text = await run(["list"], environment);
      expect(text).toEqual({
        exitCode: 0,
        stdout: "docs.search — Search docs\n# total: 1; offset: 0; nextOffset: none\n",
        stderr: "",
      });
      const compact = await run(["list", "--json"], environment);
      expect(compact.exitCode).toBe(0);
      expect(JSON.parse(compact.stdout)).toEqual({
        catalogDigest: mock.catalog.digest,
        total: 1,
        offset: 0,
        nextOffset: null,
        tools: [{ path: "docs.search", description: "Search docs" }],
      });
      for (const name of ["docs.search", "docs__search"]) {
        const shown = await run(["show", name], environment);
        expect(shown.exitCode).toBe(0);
        expect(JSON.parse(shown.stdout)).toEqual(
          JSON.parse((await run(["list", "--full"], environment)).stdout).tools[0],
        );
      }
      expect(mock.requests.every(({ method }) => method === "GET")).toBe(true);
    } finally {
      mock.server.stop(true);
    }
  });

  test("description bounds preserve multibyte code points and normalize whitespace", async () => {
    const mock = codemodeServer();
    const environment = { OPENGENI_CODEMODE_URL: mock.url, OPENGENI_CODEMODE_TOKEN: "test" };
    const entry = mock.catalog.entries[0]!;
    try {
      for (const [description, expected] of [
        ["  Search\n\t docs\u2003now  ", "Search docs now"],
        ["😀".repeat(160), "😀".repeat(160)],
        ["界😀".repeat(81), "界😀".repeat(79) + "界…"],
        ["", "Fallback title"],
      ]) {
        entry.description = description;
        entry.title = "Fallback title";
        const result = await run(["list", "--json"], environment);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          catalogDigest: mock.catalog.digest,
          total: 1,
          offset: 0,
          nextOffset: null,
          tools: [{ path: "docs.search", description: expected }],
        });
      }
      delete entry.description;
      delete entry.title;
      expect((await run(["list"], environment)).stdout).toBe(
        "docs.search\n# total: 1; offset: 0; nextOffset: none\n",
      );
      mock.catalog.entries = [];
      expect((await run(["list"], environment)).stdout).toBe(
        "# total: 0; offset: 0; nextOffset: none\n",
      );
      expect(JSON.parse((await run(["list", "--json"], environment)).stdout)).toEqual({
        catalogDigest: mock.catalog.digest,
        total: 0,
        offset: 0,
        nextOffset: null,
        tools: [],
      });
    } finally {
      mock.server.stop(true);
    }
  });

  test("discovery rejects invalid flags and arity before configuration or HTTP", async () => {
    for (const args of [
      ["list", "--full", "--json"],
      ["list", "--json", "--full"],
      ["list", "--full", "--full"],
      ["list", "--json", "--json"],
      ["list", "--unknown"],
      ["list", "extra"],
      ["show"],
      ["show", "docs.search", "extra"],
      ["show", "--full"],
      ["show", "docs.search", "--json"],
      ["list", "--full", "--offset", "0"],
      ["list", "--limit", "101"],
      ["list", "--query"],
      ["list", "--offset", "-1"],
    ]) {
      const result = await run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage:");
      expect(result.stderr).not.toContain("is required");
    }
    for (const args of [["--help"], ["list", "--help"], ["show", "--help"]]) {
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("ogtool list [--full | --json]");
      expect(result.stdout).toContain("ogtool show");
    }
  }, 30_000);

  test("actual compact stdout stays within 16 KiB for 4096 tools with maximum paths", async () => {
    const mock = codemodeServer();
    const environment = { OPENGENI_CODEMODE_URL: mock.url, OPENGENI_CODEMODE_TOKEN: "test" };
    try {
      const template = mock.catalog.entries[0]!;
      mock.catalog.entries = Array.from({ length: 4096 }, (_, index) => ({
        ...template,
        identity: { serverId: "docs", toolName: `tool${index}` },
        modelName: `tool${index}`,
        codemodePath: [...Array<string>(7).fill("x".repeat(128)), `t${index}`.padEnd(128, "x")],
        description: "😀".repeat(160),
      }));
      for (const flags of [[], ["--json"]]) {
        const first = await run(["list", ...flags, "--limit", "100"], environment);
        expect(first.exitCode).toBe(0);
        expect(Buffer.byteLength(first.stdout, "utf8")).toBeLessThanOrEqual(16_384);
        expect(first.stdout).toContain(mock.catalog.entries[0]!.codemodePath.join("."));
        if (flags.length) {
          const page = JSON.parse(first.stdout);
          expect(page.total).toBe(4096);
          expect(page.catalogDigest).toBe(mock.catalog.digest);
          expect(page.nextOffset).toBe(page.tools.length);
          expect(page.tools.length).toBeLessThan(100);
          const next = JSON.parse(
            (await run(["list", "--json", "--offset", String(page.nextOffset)], environment))
              .stdout,
          );
          expect(next.tools[0].path).toBe(
            mock.catalog.entries[page.nextOffset]!.codemodePath.join("."),
          );
        } else expect(first.stdout).toContain("# Continue with --offset");
      }
      const query = await run(
        ["list", "--json", "--query=t42", "--limit=1", "--offset=1"],
        environment,
      );
      expect(query.exitCode).toBe(0);
      const result = JSON.parse(query.stdout);
      expect(result.tools).toHaveLength(1);
      expect(result.offset).toBe(1);
      const noMatch = JSON.parse(
        (await run(["list", "--json", "--query", "absent"], environment)).stdout,
      );
      expect(noMatch.total).toBe(0);
      expect(noMatch.nextOffset).toBeNull();
      expect(noMatch.tools).toEqual([]);
    } finally {
      mock.server.stop(true);
    }
  }, 30_000);

  test("show fails closed for unknown, ambiguous, or oversized details", async () => {
    const mock = codemodeServer();
    const environment = { OPENGENI_CODEMODE_URL: mock.url, OPENGENI_CODEMODE_TOKEN: "test" };
    try {
      const unknown = await run(["show", "missing"], environment);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("Unknown Codemode tool");
      expect(unknown.stdout).toBe("");
      const entry = mock.catalog.entries[0]!;
      mock.catalog.entries.push({
        ...entry,
        identity: { serverId: "other", toolName: "tool" },
        modelName: "docs.search",
        codemodePath: ["other", "tool"],
      });
      const ambiguous = await run(["show", "docs.search"], environment);
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.stderr).toContain("Ambiguous");
      mock.catalog.entries.pop();
      entry.inputSchema = { type: "object", description: "" };
      const baseline = await run(["show", "docs.search"], environment);
      expect(baseline.exitCode).toBe(0);
      const remaining = 65_536 - Buffer.byteLength(baseline.stdout, "utf8");
      entry.inputSchema.description = "x".repeat(remaining);
      const exact = await run(["show", "docs.search"], environment);
      expect(exact.exitCode).toBe(0);
      expect(Buffer.byteLength(exact.stdout, "utf8")).toBe(65_536);
      entry.inputSchema.description += "x";
      const over = await run(["show", "docs.search"], environment);
      expect(over.exitCode).toBe(1);
      expect(over.stdout).toBe("");
      entry.inputSchema = { type: "object", description: "😀".repeat(17_000) };
      const oversized = await run(["show", "docs.search"], environment);
      expect(oversized.exitCode).toBe(1);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("exceed 65536 bytes");
      expect((await run(["list", "--full"], environment)).exitCode).toBe(0);
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
