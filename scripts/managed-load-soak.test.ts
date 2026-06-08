import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./managed-load-soak.ts", import.meta.url).pathname;

describe("managed load soak script", () => {
  it("creates structured load-soak evidence against a fake managed API", async () => {
    let sessionsCreated = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          return json({ ok: true });
        }
        if (url.pathname === "/v1/access/me") {
          return authorized(request) ? json({ defaultWorkspaceId: "ws-test" }) : json({ error: "unauthorized" }, 401);
        }
        if (url.pathname === "/v1/workspaces/ws-test/sessions" && request.method === "POST") {
          sessionsCreated += 1;
          return json({ id: `session-${sessionsCreated}`, status: "queued" }, 201);
        }
        const match = url.pathname.match(/^\/v1\/workspaces\/ws-test\/sessions\/(.+)$/);
        if (match) {
          return authorized(request) ? json({ id: match[1], status: "idle" }) : json({ error: "unauthorized" }, 401);
        }
        return json({ error: "not found" }, 404);
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "opengeni-load-soak-"));
      const outFile = join(dir, "load-soak.json");
      const result = await runScript([
        scriptPath,
        "--base-url", `http://127.0.0.1:${server.port}`,
        "--workspace-id", "ws-test",
        "--token", "test-token",
        "--out-file", outFile,
        "--duration-seconds", "0.2",
        "--max-sessions", "2",
        "--concurrency", "1",
        "--health-interval-ms", "20",
        "--poll-interval-ms", "25",
      ]);

      expect(result.status).toBe(0);
      const payload = JSON.parse(readFileSync(outFile, "utf8"));
      expect(payload.ok).toBe(true);
      expect(payload.checks[0].id).toBe("load-soak");
      expect(payload.checks[0].metrics.sessionsCompleted).toBe(2);
      expect(payload.checks[0].metrics.requests).toBeGreaterThan(2);
    } finally {
      await server.stop();
    }
  }, 15_000);
});

async function runScript(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

function authorized(request: Request): boolean {
  return request.headers.get("authorization") === "Bearer test-token";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
