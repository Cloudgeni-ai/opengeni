// Build the native binary first; require it explicitly for native verification.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary =
  process.env.OPENGENI_NATIVE_CODEMODE_FIXTURE ??
  resolve(
    import.meta.dir,
    `../../../agent/target/debug/opengeni-agent${process.platform === "win32" ? ".exe" : ""}`,
  );
if (process.env.OPENGENI_REQUIRE_NATIVE_CODEMODE_TEST === "1" && !existsSync(binary)) {
  throw new Error("Required native Codemode binary was not built");
}

async function fixture(input: { args: string[]; stdin?: Uint8Array | string; cwd: string }) {
  const calls: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === "/codemode/catalog") {
        return Response.json({
          attemptId: "11111111-1111-4111-8111-111111111111",
          digest: "a".repeat(64),
          entries: [
            {
              identity: { serverId: "demo", toolName: "write" },
              modelName: "demo__write",
              codemodePath: ["demo", "write"],
              inputSchema: { type: "object" },
              source: "mcp",
              approval: "none",
            },
          ],
        });
      }
      if (path === "/codemode/calls" && request.method === "POST") {
        calls.push(await request.json());
        return Response.json({
          dispatch: "terminal",
          operation: {
            state: "completed",
            result: { content: [{ type: "text", text: "accepted" }], _meta: {} },
          },
        });
      }
      return new Response("unexpected request", { status: 404 });
    },
  });
  const child = Bun.spawn([binary, "codemode", "call", "demo.write", ...input.args], {
    cwd: input.cwd,
    env: {
      OPENGENI_CODEMODE_URL: `http://127.0.0.1:${server.port}/codemode`,
      OPENGENI_CODEMODE_TOKEN: "synthetic-attempt-bearer",
    },
    stdin:
      typeof input.stdin === "string"
        ? new TextEncoder().encode(input.stdin)
        : (input.stdin ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, calls, requests };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await server.stop(true);
  }
}

test.skipIf(!existsSync(binary)).each(["stdin", "file"] as const)(
  "native CLI submits multi-megabyte UTF-8 JSON from %s without putting it on argv",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-codemode-input "));
    const argumentsValue = { content: "Synthetic ø🙂\n".repeat(200_000) };
    const json = JSON.stringify(argumentsValue);
    try {
      await writeFile(join(root, "arguments with spaces.json"), json);
      const result = await fixture({
        cwd: root,
        args: [source === "stdin" ? "-" : "@arguments with spaces.json", "--full"],
        ...(source === "stdin" ? { stdin: json } : {}),
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).content[0].text).toBe("accepted");
      expect(result.requests).toEqual(["GET /codemode/catalog", "POST /codemode/calls"]);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]!.arguments).toEqual(argumentsValue);
      expect(result.calls[0]!.catalogDigest).toBe("a".repeat(64));
      expect(result.calls[0]!.identity).toEqual({ serverId: "demo", toolName: "write" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test.skipIf(!existsSync(binary))(
  "native CLI preserves inline JSON and the default object without reading stdin",
  async () => {
    for (const args of [[], ['{"query":"inline"}']]) {
      const result = await fixture({ cwd: tmpdir(), args, stdin: "not JSON and not requested" });
      expect(result.code).toBe(0);
      expect(result.calls[0]!.arguments).toEqual(args.length ? { query: "inline" } : {});
    }
  },
);

test.skipIf(!existsSync(binary))(
  "native CLI rejects unreadable or invalid inputs before network access without echoing contents",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "opengeni-codemode-invalid-"));
    try {
      const privateText = "synthetic-sensitive-content";
      await writeFile(join(root, "invalid.json"), privateText);
      await writeFile(join(root, "invalid-utf8.json"), new Uint8Array([0xff]));
      for (const input of [
        { args: ["-"], stdin: privateText },
        { args: ["-"], stdin: "[]" },
        { args: ["-"], stdin: "" },
        { args: ["-"], stdin: new Uint8Array([0xff]) },
        { args: ["@invalid.json"] },
        { args: ["@invalid-utf8.json"] },
        { args: ["@missing.json"] },
        { args: ["@"] },
      ]) {
        const result = await fixture({ cwd: root, ...input });
        expect(result.code).not.toBe(0);
        expect(result.requests).toHaveLength(0);
        expect(result.stderr).toContain("tool arguments");
        expect(result.stderr).not.toContain(privateText);
        expect(result.stderr).not.toContain(root);
        expect(result.stdout).toBe("");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
