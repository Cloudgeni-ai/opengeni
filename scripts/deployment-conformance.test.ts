import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, verifyDelegatedAccessToken } from "@opengeni/contracts";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "11111111-1111-4111-8111-111111111111";
const deploymentKey = "fixture-conformance-deployment-key";
const hostSecret = "fixture-conformance-host-signing-root";
const model = "deepseek-v4-flash-0731";

interface FixtureOptions {
  authMode?: "configuredToken" | "deploymentKey" | "managedSession" | "none";
  credential?: "deploymentKey" | "productToken" | "none";
  anonymousStatus?: number;
  defaultWorkspace?: boolean;
  workspaceListStatus?: number;
}

interface Fixture {
  token: string;
  requests: { path: string; method: string; deploymentKey: string | null; bearer: string | null }[];
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  run: (
    flags?: string[],
    env?: Record<string, string>,
    runAgent?: boolean,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function withApi(
  options: FixtureOptions,
  verify: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const token = await signDelegatedAccessToken(hostSecret, {
    accountId,
    workspaceId,
    subjectId: "user:conformance-fixture",
    principalKind: "human_session",
    permissions: ["workspace:read"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const requests: Fixture["requests"] = [];
  const sessions: Fixture["sessions"] = [];
  const tasks: Fixture["tasks"] = [];
  const authMode = options.authMode ?? "configuredToken";
  const credential = options.credential ?? "deploymentKey";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const key = request.headers.get("x-opengeni-access-key");
      const bearer = request.headers.get("authorization");
      requests.push({ path: url.pathname, method: request.method, deploymentKey: key, bearer });
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "fixture" });
      if (url.pathname === "/v1/config/client") return Response.json({ auth: { mode: authMode } });
      const tokenPayload = bearer?.startsWith("Bearer ")
        ? await verifyDelegatedAccessToken(hostSecret, bearer.slice("Bearer ".length))
        : null;
      const authenticated =
        credential === "none" ||
        (credential === "deploymentKey" && key === deploymentKey) ||
        (credential === "productToken" && tokenPayload?.workspaceId === workspaceId);
      if (!authenticated) {
        return Response.json(
          { error: "unauthorized" },
          { status: !key && !bearer ? (options.anonymousStatus ?? 401) : 401 },
        );
      }
      if (url.pathname === "/v1/access/me") {
        return Response.json({
          ...(options.defaultWorkspace === false ? {} : { defaultWorkspaceId: workspaceId }),
        });
      }
      if (url.pathname === "/v1/workspaces") {
        return Response.json([{ id: workspaceId }], { status: options.workspaceListStatus ?? 200 });
      }
      const prefix = `/v1/workspaces/${workspaceId}`;
      if (url.pathname === `${prefix}/sessions` && request.method === "POST") {
        sessions.push((await request.json()) as Record<string, unknown>);
        return Response.json({ id: crypto.randomUUID(), status: "running" });
      }
      if (url.pathname.endsWith("/events/stream")) {
        return new Response(
          "event: session.created\ndata: {}\n\nevent: turn.completed\ndata: {}\n\n",
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      if (url.pathname.endsWith("/events")) {
        return Response.json(
          ["session.created", "turn.started", "agent.message.completed", "turn.completed"].map(
            (type) => ({ type }),
          ),
        );
      }
      if (url.pathname === `${prefix}/scheduled-tasks` && request.method === "POST") {
        tasks.push((await request.json()) as Record<string, unknown>);
        return Response.json({ id: "33333333-3333-4333-8333-333333333333" });
      }
      if (url.pathname.endsWith("/trigger") || request.method === "DELETE") {
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/runs")) {
        return Response.json([
          { status: "dispatched", sessionId: "44444444-4444-4444-8444-444444444444" },
        ]);
      }
      if (url.pathname.startsWith(`${prefix}/sessions/`)) {
        return Response.json({ id: url.pathname.split("/").at(-1), status: "idle" });
      }
      return Response.json({ error: "unexpected fixture route" }, { status: 404 });
    },
  });
  try {
    await verify({
      token,
      requests,
      sessions,
      tasks,
      async run(flags = [], env = {}, runAgent = false) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "scripts/deployment-conformance.ts",
            "--base-url",
            String(server.url),
            "--json",
            "--skip-storage",
            "--skip-observability",
            "--timeout-seconds",
            "2",
            ...(runAgent ? [] : ["--skip-agent"]),
            ...flags,
          ],
          {
            cwd: repoRoot,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const timeout = setTimeout(() => child.kill(), 10_000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  } finally {
    server.stop(true);
  }
}

function check(output: string, id: string): { status: string; detail: string } {
  const parsed = JSON.parse(output) as {
    results: { id: string; status: string; detail: string }[];
  };
  const result = parsed.results.find((item) => item.id === id);
  expect(result).toBeDefined();
  return result!;
}

describe("deployment conformance configured authentication", () => {
  test("proves shared-key configured access and discovers an authenticated workspace", async () => {
    await withApi({ defaultWorkspace: false }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).ok).toBe(true);
      expect(check(result.stdout, "access-boundary").status).toBe("passed");
      expect(check(result.stdout, "workspace-discovery").status).toBe("passed");
      const access = fixture.requests.filter((request) => request.path === "/v1/access/me");
      expect(access.map((request) => request.deploymentKey)).toEqual([
        null,
        deploymentKey,
        deploymentKey,
      ]);
      expect(
        fixture.requests.find((request) => request.path === "/v1/workspaces")?.deploymentKey,
      ).toBe(deploymentKey);
      const config = fixture.requests.find((request) => request.path === "/v1/config/client");
      expect(config?.deploymentKey).toBeNull();
      expect(config?.bearer).toBeNull();
      expect(result.stdout + result.stderr).not.toContain(deploymentKey);
    });
  });

  test("accepts a genuinely signed product bearer against a host signing root", async () => {
    await withApi({ credential: "productToken" }, async (fixture) => {
      const result = await fixture.run([], { OPENGENI_CONFORMANCE_PRODUCT_TOKEN: fixture.token });
      expect(result.exitCode).toBe(0);
      expect(check(result.stdout, "access-boundary").status).toBe("passed");
      expect(check(result.stdout, "workspace-discovery").status).toBe("passed");
      const access = fixture.requests.filter((request) => request.path === "/v1/access/me");
      expect(access.map((request) => request.bearer)).toEqual([
        null,
        `Bearer ${fixture.token}`,
        `Bearer ${fixture.token}`,
      ]);
      expect(access.every((request) => request.deploymentKey === null)).toBe(true);
      expect(result.stdout + result.stderr).not.toContain(fixture.token);
      expect(result.stdout + result.stderr).not.toContain(hostSecret);
    });
  });

  test("rejects configured mode without an explicit credential", async () => {
    await withApi({}, async (fixture) => {
      const result = await fixture.run();
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("failed");
      expect(check(result.stdout, "access-boundary").detail).toContain(
        "--deployment-access-key or --product-token",
      );
      expect(JSON.parse(result.stdout).ok).toBe(false);
    });
  });

  test("rejects an advertised configured mode that allows anonymous access", async () => {
    await withApi({ credential: "none" }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("failed");
      expect(check(result.stdout, "access-boundary").detail).toContain("HTTP 200, expected 401");
    });
  });

  test("rejects a wrong deployment key rather than counting the advertised mode", async () => {
    await withApi({}, async (fixture) => {
      const wrongKey = "fixture-wrong-deployment-key";
      const result = await fixture.run(["--deployment-access-key", wrongKey]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("failed");
      expect(check(result.stdout, "access-boundary").detail).toContain("HTTP 401");
      expect(check(result.stdout, "workspace-discovery").status).toBe("failed");
      expect(result.stdout + result.stderr).not.toContain(wrongKey);
    });
  });

  test("a valid edge key cannot bypass a host that requires a signed product bearer", async () => {
    await withApi({ credential: "productToken" }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("failed");
      expect(check(result.stdout, "workspace-discovery").status).toBe("failed");
      expect(fixture.requests.every((request) => request.bearer === null)).toBe(true);
    });
  });

  test("rejects a product bearer signed by another host", async () => {
    await withApi({ credential: "productToken" }, async (fixture) => {
      const wrongToken = await signDelegatedAccessToken("fixture-other-host-root", {
        accountId,
        workspaceId,
        subjectId: "user:conformance-fixture",
        principalKind: "human_session",
        permissions: ["workspace:read"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const result = await fixture.run(["--product-token", wrongToken]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("failed");
      expect(result.stdout + result.stderr).not.toContain(wrongToken);
    });
  });

  test("successful authentication still requires a reachable workspace", async () => {
    await withApi({ defaultWorkspace: false, workspaceListStatus: 403 }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").status).toBe("passed");
      expect(check(result.stdout, "workspace-discovery").status).toBe("failed");
      expect(JSON.parse(result.stdout).ok).toBe(false);
    });
  });

  test("requires exactly HTTP 401 for anonymous configured access", async () => {
    await withApi({ anonymousStatus: 403 }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "access-boundary").detail).toContain("HTTP 403, expected 401");
    });
  });
});

describe("deployment conformance existing authentication modes", () => {
  test("retains deployment-key success and missing-key refusal", async () => {
    await withApi({ authMode: "deploymentKey" }, async (fixture) => {
      const success = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(success.exitCode).toBe(0);
      expect(check(success.stdout, "access-boundary").status).toBe("passed");
      const missing = await fixture.run();
      expect(missing.exitCode).toBe(1);
      expect(check(missing.stdout, "access-boundary").status).toBe("failed");
    });
  });

  test("retains managed bearer behavior and deployment-key mismatch refusal", async () => {
    await withApi({ authMode: "managedSession", credential: "productToken" }, async (fixture) => {
      const success = await fixture.run(["--product-token", fixture.token]);
      expect(success.exitCode).toBe(0);
      expect(check(success.stdout, "workspace-discovery").status).toBe("passed");
      const mismatch = await fixture.run(["--deployment-access-key", deploymentKey]);
      expect(mismatch.exitCode).toBe(1);
      expect(check(mismatch.stdout, "access-boundary").status).toBe("failed");
    });
  });

  test("retains local no-auth behavior", async () => {
    await withApi({ authMode: "none", credential: "none" }, async (fixture) => {
      const result = await fixture.run();
      expect(result.exitCode).toBe(0);
      expect(check(result.stdout, "access-boundary").status).toBe("passed");
      expect(check(result.stdout, "workspace-discovery").status).toBe("passed");
    });
  });
});

describe("deployment conformance explicit model selection", () => {
  for (const selection of ["unset", "environment", "flag", "equals-flag"] as const) {
    test(`sends only an explicit model to session and scheduled-task creation (${selection})`, async () => {
      await withApi({}, async (fixture) => {
        const flags = ["--deployment-access-key", deploymentKey];
        const env: Record<string, string> = {
          OPENGENI_OPENAI_MODEL: "fixture-unrelated-provider-model",
        };
        if (selection === "environment") env.OPENGENI_CONFORMANCE_MODEL = model;
        if (selection === "flag" || selection === "equals-flag") {
          env.OPENGENI_CONFORMANCE_MODEL = "fixture-overridden-model";
          flags.push(...(selection === "flag" ? ["--model", model] : [`--model=${model}`]));
        }
        const result = await fixture.run(flags, env, true);
        expect(result.exitCode).toBe(0);
        expect(fixture.sessions).toHaveLength(2);
        expect(fixture.tasks).toHaveLength(1);
        expect(check(result.stdout, "session-run").status).toBe("passed");
        expect(check(result.stdout, "mcp-tool-session").status).toBe("passed");
        expect(check(result.stdout, "scheduled-task").status).toBe("passed");
        const configurations = [
          ...fixture.sessions,
          fixture.tasks[0]!.agentConfig as Record<string, unknown>,
        ];
        for (const configuration of configurations) {
          if (selection === "unset") expect(Object.hasOwn(configuration, "model")).toBe(false);
          else expect(configuration.model).toBe(model);
          expect(configuration).not.toHaveProperty("OPENGENI_OPENAI_MODEL");
        }
      });
    });
  }

  test("rejects an empty explicit model before making requests", async () => {
    await withApi({}, async (fixture) => {
      const result = await fixture.run(["--model="]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--model requires a non-empty value");
      expect(fixture.requests).toHaveLength(0);
    });
  });
});
