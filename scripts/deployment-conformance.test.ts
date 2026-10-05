import { describe, expect, test } from "bun:test";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  verifyDelegatedAccessToken,
} from "@opengeni/contracts";
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
  storageCors?: "restricted" | "wildcard" | "echo-foreign" | "deny-allowed" | "foreign-5xx";
  configRevision?: string | null;
  responseRevision?: string;
  mutationResponseRevision?: string;
  forceMutationContractRefusal?: boolean;
  sessionCreateStatus?: number;
}

interface Fixture {
  token: string;
  baseUrl: string;
  requests: {
    path: string;
    method: string;
    deploymentKey: string | null;
    bearer: string | null;
    origin: string | null;
    contractRevision: string | null;
  }[];
  sessions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  run: (
    flags?: string[],
    env?: Record<string, string>,
    runAgent?: boolean,
    runStorage?: boolean,
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
  let objectContent = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const key = request.headers.get("x-opengeni-access-key");
      const bearer = request.headers.get("authorization");
      const origin = request.headers.get("origin");
      const contractRevision = request.headers.get(OPENGENI_API_CONTRACT_HEADER);
      requests.push({
        path: url.pathname,
        method: request.method,
        deploymentKey: key,
        bearer,
        origin,
        contractRevision,
      });
      if (url.pathname === "/fixture-object") {
        if (request.method === "OPTIONS") {
          const allowed = origin === server.url.origin;
          if (options.storageCors === "foreign-5xx" && !allowed) {
            return new Response("private-cors-error-body", { status: 500 });
          }
          const allowedOrigin =
            options.storageCors === "wildcard"
              ? "*"
              : options.storageCors === "echo-foreign" ||
                  (allowed && options.storageCors !== "deny-allowed")
                ? origin
                : null;
          return new Response(null, {
            status: allowedOrigin ? 204 : 403,
            headers: allowedOrigin
              ? {
                  "access-control-allow-origin": allowedOrigin,
                  "access-control-allow-methods": "PUT",
                }
              : {},
          });
        }
        if (request.method === "PUT") {
          objectContent = await request.text();
          return new Response(null, { status: 201 });
        }
        return new Response(objectContent);
      }
      if (url.pathname === "/healthz") return Response.json({ ok: true, service: "fixture" });
      const apiJson = (data: unknown, init: ResponseInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set(
          OPENGENI_API_CONTRACT_HEADER,
          request.method === "POST" && url.pathname.endsWith("/sessions")
            ? (options.mutationResponseRevision ??
                options.responseRevision ??
                OPENGENI_API_CONTRACT_REVISION)
            : (options.responseRevision ?? OPENGENI_API_CONTRACT_REVISION),
        );
        return Response.json(data, { ...init, headers });
      };
      if (url.pathname === "/v1/config/client")
        return apiJson({
          auth: { mode: authMode },
          ...(options.configRevision === null
            ? {}
            : {
                apiContractRevision: options.configRevision ?? OPENGENI_API_CONTRACT_REVISION,
              }),
        });
      const tokenPayload = bearer?.startsWith("Bearer ")
        ? await verifyDelegatedAccessToken(hostSecret, bearer.slice("Bearer ".length))
        : null;
      const authenticated =
        credential === "none" ||
        (credential === "deploymentKey" && key === deploymentKey) ||
        (credential === "productToken" && tokenPayload?.workspaceId === workspaceId);
      if (!authenticated) {
        return apiJson(
          { error: "unauthorized" },
          { status: !key && !bearer ? (options.anonymousStatus ?? 401) : 401 },
        );
      }
      // Match production's shared-key mutation fence. Bearer integrations have
      // separate admission semantics; every conformance API request still
      // claims the canonical release revision, never a mutable advertised one.
      if (
        url.pathname.startsWith("/v1/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
        contractRevision !== OPENGENI_API_CONTRACT_REVISION &&
        !bearer?.startsWith("Bearer ")
      ) {
        return apiJson(
          { code: "API_CONTRACT_CHANGED", apiContractRevision: OPENGENI_API_CONTRACT_REVISION },
          { status: 409 },
        );
      }
      if (
        options.forceMutationContractRefusal &&
        request.method === "POST" &&
        url.pathname.endsWith("/sessions")
      ) {
        return apiJson(
          { code: "API_CONTRACT_CHANGED", apiContractRevision: "fixture-advertised-revision" },
          { status: 409 },
        );
      }
      if (url.pathname === "/v1/access/me") {
        return apiJson({
          ...(options.defaultWorkspace === false ? {} : { defaultWorkspaceId: workspaceId }),
        });
      }
      if (url.pathname === "/v1/workspaces") {
        return apiJson([{ id: workspaceId }], { status: options.workspaceListStatus ?? 200 });
      }
      const prefix = `/v1/workspaces/${workspaceId}`;
      if (url.pathname === `${prefix}/files/uploads` && request.method === "POST") {
        return apiJson({
          putUrl: new URL("/fixture-object", server.url).href,
          uploadId: "fixture-upload",
          fileId: "fixture-file",
          requiredHeaders: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === `${prefix}/files/uploads/fixture-upload/complete`) {
        return apiJson({ ok: true });
      }
      if (url.pathname === `${prefix}/files/fixture-file/download-url`) {
        return apiJson({ url: new URL("/fixture-object", server.url).href });
      }
      if (url.pathname === `${prefix}/sessions` && request.method === "POST") {
        if (options.sessionCreateStatus)
          return apiJson(
            { error: "fixture session creation failed" },
            { status: options.sessionCreateStatus },
          );
        sessions.push((await request.json()) as Record<string, unknown>);
        return apiJson({ id: crypto.randomUUID(), status: "running" });
      }
      if (url.pathname.endsWith("/events/stream")) {
        return new Response(
          "event: session.created\ndata: {}\n\nevent: turn.completed\ndata: {}\n\n",
          {
            headers: {
              "content-type": "text/event-stream",
              [OPENGENI_API_CONTRACT_HEADER]:
                options.responseRevision ?? OPENGENI_API_CONTRACT_REVISION,
            },
          },
        );
      }
      if (url.pathname.endsWith("/events")) {
        return apiJson(
          ["session.created", "turn.started", "agent.message.completed", "turn.completed"].map(
            (type) => ({ type }),
          ),
        );
      }
      if (url.pathname === `${prefix}/scheduled-tasks` && request.method === "POST") {
        tasks.push((await request.json()) as Record<string, unknown>);
        return apiJson({ id: "33333333-3333-4333-8333-333333333333" });
      }
      if (url.pathname.endsWith("/trigger") || request.method === "DELETE") {
        return apiJson({ ok: true });
      }
      if (url.pathname.endsWith("/runs")) {
        return apiJson([
          { status: "dispatched", sessionId: "44444444-4444-4444-8444-444444444444" },
        ]);
      }
      if (url.pathname.startsWith(`${prefix}/sessions/`)) {
        return apiJson({ id: url.pathname.split("/").at(-1), status: "idle" });
      }
      return apiJson({ error: "unexpected fixture route" }, { status: 404 });
    },
  });
  try {
    await verify({
      token,
      baseUrl: String(server.url),
      requests,
      sessions,
      tasks,
      async run(flags = [], env = {}, runAgent = false, runStorage = false) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            "scripts/deployment-conformance.ts",
            "--base-url",
            String(server.url),
            "--json",
            ...(runStorage ? [] : ["--skip-storage"]),
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

describe("deployment conformance API contract admission", () => {
  test("speaks the shared canonical revision to a production-style mutation fence", async () => {
    await withApi({ storageCors: "wildcard" }, async (fixture) => {
      for (const revision of [undefined, "fixture-stale-revision"]) {
        const response = await fetch(
          new URL(`/v1/workspaces/${workspaceId}/sessions`, fixture.baseUrl),
          {
            method: "POST",
            headers: {
              "x-opengeni-access-key": deploymentKey,
              "content-type": "application/json",
              ...(revision ? { [OPENGENI_API_CONTRACT_HEADER]: revision } : {}),
            },
            body: JSON.stringify({ initialMessage: "rejected fixture mutation" }),
          },
        );
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe("API_CONTRACT_CHANGED");
      }
      const start = fixture.requests.length;
      const result = await fixture.run(["--deployment-access-key", deploymentKey], {}, true, true);
      expect(result.exitCode).toBe(0);
      expect(check(result.stdout, "api-contract").status).toBe("passed");
      const requests = fixture.requests.slice(start);
      expect(
        requests
          .filter((request) => request.path.startsWith("/v1/"))
          .every((request) => request.contractRevision === OPENGENI_API_CONTRACT_REVISION),
      ).toBe(true);
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(requests.some((request) => request.path.endsWith("/events/stream"))).toBe(true);
      expect(
        requests
          .filter((request) => request.path === "/fixture-object")
          .every((request) => request.contractRevision === null),
      ).toBe(true);
      expect(fixture.sessions).toHaveLength(2);
      expect(fixture.tasks).toHaveLength(1);
    });
  });

  for (const [name, options] of [
    ["different client-config revision", { configRevision: "fixture-advertised-revision" }],
    ["missing client-config revision", { configRevision: null }],
    ["different read-response revision", { responseRevision: "fixture-advertised-revision" }],
  ] as const) {
    test(`blocks mutations when the handshake is not canonical (${name})`, async () => {
      await withApi(options, async (fixture) => {
        const result = await fixture.run(
          ["--deployment-access-key", deploymentKey],
          {},
          true,
          true,
        );
        expect(result.exitCode).toBe(1);
        expect(check(result.stdout, "api-contract").status).toBe("failed");
        expect(fixture.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
        expect(fixture.sessions).toHaveLength(0);
        expect(fixture.tasks).toHaveLength(0);
        expect(fixture.requests.some((request) => request.path.includes("/sessions/null"))).toBe(
          false,
        );
      });
    });
  }

  for (const [name, options] of [
    ["changed mutation response", { mutationResponseRevision: "fixture-advertised-revision" }],
    ["409 contract refusal", { forceMutationContractRefusal: true }],
  ] as const) {
    test(`never retries writes or adopts an advertised revision (${name})`, async () => {
      await withApi(options, async (fixture) => {
        const result = await fixture.run(
          ["--deployment-access-key", deploymentKey],
          {},
          true,
          true,
        );
        expect(result.exitCode).toBe(1);
        const mutations = fixture.requests.filter((request) => request.method !== "GET");
        expect(mutations).toHaveLength(1);
        expect(mutations[0]?.contractRevision).toBe(OPENGENI_API_CONTRACT_REVISION);
        expect(check(result.stdout, "session-run").status).toBe("failed");
        expect(check(result.stdout, "event-replay").status).toBe("skipped");
        expect(check(result.stdout, "sse-replay").status).toBe("skipped");
        expect(fixture.requests.some((request) => request.path.includes("/sessions/null"))).toBe(
          false,
        );
        expect(result.stdout).not.toContain("fixture-advertised-revision");
      });
    });
  }

  test("skips dependent replay probes when session creation returns no id", async () => {
    await withApi({ sessionCreateStatus: 502 }, async (fixture) => {
      const result = await fixture.run(
        ["--deployment-access-key", deploymentKey, "--skip-scheduled-tasks"],
        {},
        true,
      );
      expect(result.exitCode).toBe(1);
      expect(check(result.stdout, "session-run").status).toBe("failed");
      expect(check(result.stdout, "event-replay").status).toBe("skipped");
      expect(check(result.stdout, "sse-replay").status).toBe("skipped");
      expect(fixture.requests.some((request) => request.path.includes("/sessions/null"))).toBe(
        false,
      );
      expect(
        fixture.requests.some(
          (request) => request.path.endsWith("/events") || request.path.endsWith("/events/stream"),
        ),
      ).toBe(false);
    });
  });
});

describe("deployment conformance restricted browser CORS", () => {
  for (const selector of ["flag", "equals-flag", "environment"]) {
    test(`allows the selected edge origin and denies a foreign origin (${selector})`, async () => {
      await withApi({ storageCors: "restricted" }, async (fixture) => {
        const flags = ["--deployment-access-key", deploymentKey, "--deny-foreign-browser-origin"];
        const env: Record<string, string> = {};
        if (selector === "flag") flags.push("--browser-origin", fixture.baseUrl);
        else if (selector === "equals-flag") flags.push(`--browser-origin=${fixture.baseUrl}`);
        else env.OPENGENI_CONFORMANCE_BROWSER_ORIGIN = fixture.baseUrl;
        const result = await fixture.run(flags, env, false, true);
        expect(result.exitCode).toBe(0);
        expect(check(result.stdout, "object-storage").status).toBe("passed");
        expect(check(result.stdout, "object-storage").detail).toContain(
          "foreign browser origin denied",
        );
        const preflights = fixture.requests.filter((request) => request.method === "OPTIONS");
        expect(preflights).toHaveLength(2);
        expect(preflights[0]?.origin).toBe(new URL(fixture.baseUrl).origin);
        expect(preflights[1]?.origin).toMatch(/^https:\/\/.+\.foreign-conformance\.invalid$/);
        expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
        expect(preflights.every((request) => !request.deploymentKey && !request.bearer)).toBe(true);
      });
    });
  }

  for (const storageCors of ["wildcard", "echo-foreign", "foreign-5xx", "deny-allowed"] as const) {
    test(`does not count a broken restricted CORS boundary as conformance (${storageCors})`, async () => {
      await withApi({ storageCors }, async (fixture) => {
        const result = await fixture.run(
          [
            "--deployment-access-key",
            deploymentKey,
            "--browser-origin",
            fixture.baseUrl,
            "--deny-foreign-browser-origin",
          ],
          {},
          false,
          true,
        );
        expect(result.exitCode).toBe(1);
        expect(check(result.stdout, "object-storage").status).toBe("failed");
        expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
        expect(result.stdout + result.stderr).not.toContain("private-cors-error-body");
      });
    });
  }

  test("preserves the generic random-origin upload probe when no origin is selected", async () => {
    await withApi({ storageCors: "wildcard" }, async (fixture) => {
      const result = await fixture.run(["--deployment-access-key", deploymentKey], {}, false, true);
      expect(result.exitCode).toBe(0);
      const preflights = fixture.requests.filter((request) => request.method === "OPTIONS");
      expect(preflights).toHaveLength(1);
      expect(preflights[0]?.origin).toMatch(/^https:\/\/.+\.sdk-conformance\.invalid$/);
    });
  });

  test("requires a real explicit origin before opting into foreign-origin denial", async () => {
    await withApi({}, async (fixture) => {
      for (const flags of [
        ["--deny-foreign-browser-origin"],
        ["--browser-origin", "https://edge.example.test/path"],
        ["--browser-origin", "https://user:private@edge.example.test"],
        ["--browser-origin", "https://edge.example.test?private=1"],
        ["--browser-origin", "not-an-origin"],
      ]) {
        const result = await fixture.run(flags);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("--browser-origin");
      }
      expect(fixture.requests).toHaveLength(0);
    });
  });
});

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
