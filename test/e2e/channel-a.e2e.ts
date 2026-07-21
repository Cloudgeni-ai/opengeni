// P4.4 — Channel-A structured services end-to-end through real HTTP + a REAL
// Docker sandbox box (the prove-it D2 slice: file browse + git diff + terminal,
// served client -> API -> box API-direct, no Temporal/worker in the path).
//
// Uses the docker/local sandbox backend (no Modal creds). The session create
// spins a real box; sandboxOwnershipEnabled=true makes the lease live so the
// Channel-A routes resume the box by id in-process and operate it. We assert:
//   - fs.write then fs.read round-trips text + binary,
//   - fs.list returns a coherent tree of a known dir,
//   - git status/diff on a staged change parse into structured hunks,
//   - terminal exec 'echo $DISPLAY' streams output (+ a sandbox.command.output.delta),
//   - the 400 (bad body) / 404 (missing session) discipline,
//   - the routes are served API-direct (the result is the HTTP response).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildSandboxImage,
  freePort,
  startE2eWorkerTopology,
  startProcess,
  startTestServices,
  type StartedE2eWorkerTopology,
  type StartedProcess,
  type TestServices,
  waitFor,
} from "@opengeni/testing";

const repoRoot = new URL("../..", import.meta.url).pathname;
let apiPort = 0;
let workspaceId = "";

describe("Channel-A structured services e2e (real Docker box, API-direct)", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedE2eWorkerTopology;
  let sessionId = "";

  beforeAll(async () => {
    await buildSandboxImage("opengeni-sandbox:local", repoRoot);
    services = await startTestServices({ temporal: true, objectStorage: true });
    await services.migrate();
    apiPort = await freePort();
    const env = stackEnv(services, apiPort);
    api = await startProcess(["bun", "apps/api/src/index.ts"], {
      cwd: repoRoot,
      env,
      ready: async () =>
        (await fetch(`http://127.0.0.1:${apiPort}/healthz`).catch(() => null))?.ok === true,
      timeoutMs: 45_000,
    });
    workspaceId = await discoverWorkspaceId();
    worker = await startE2eWorkerTopology({
      cwd: repoRoot,
      env,
    });
    await waitFor(() => worker.ready(), {
      timeoutMs: 90_000,
      describe: () => worker.logs(),
    });

    // Create a session on a real Docker box; wait until idle so the box is warm
    // and the lease materialized. The scripted model writes a file (so the box's
    // workspace has content), then finishes.
    const create = await fetch(apiPath("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "set up channel-a fixture",
        sandboxBackend: "docker",
      }),
    });
    expect(create.status).toBe(202);
    sessionId = ((await create.json()) as { id: string }).id;
    await waitFor(
      async () => {
        const events = await sessionEvents(sessionId);
        return events.some(
          (e) =>
            e.type === "session.status.changed" &&
            (e.payload as { status?: string }).status === "idle",
        );
      },
      { timeoutMs: 180_000 },
    );
  }, 360_000);

  afterAll(async () => {
    await worker?.stop();
    await api?.stop();
    await services?.down();
  }, 60_000);

  test("fs.write then fs.read round-trips text API-direct", async () => {
    const write = await channelA("/fs/write", {
      path: "channel-a.txt",
      content: "hello from channel-a\n",
    });
    expect(write.status).toBe(200);
    const wb = (await write.json()) as { path: string; sizeBytes: number; revision: number };
    expect(wb.path).toBe("channel-a.txt");
    expect(wb.revision).toBeGreaterThanOrEqual(1);

    const read = await channelA("/fs/read", { path: "channel-a.txt" });
    expect(read.status).toBe(200);
    const rb = (await read.json()) as { content: string; encoding: string; isBinary: boolean };
    expect(rb.content).toBe("hello from channel-a\n");
    expect(rb.encoding).toBe("utf8");
    expect(rb.isBinary).toBe(false);
  }, 60_000);

  test("fs.write then fs.read round-trips a binary file (base64)", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const write = await channelA("/fs/write", {
      path: "blob.bin",
      encoding: "base64",
      content: bytes.toString("base64"),
    });
    expect(write.status).toBe(200);
    const read = await channelA("/fs/read", { path: "blob.bin", encoding: "base64" });
    const rb = (await read.json()) as { content: string; isBinary: boolean };
    expect(rb.isBinary).toBe(true);
    expect(Buffer.from(rb.content, "base64").equals(bytes)).toBe(true);
  }, 60_000);

  test("fs.list returns a coherent tree of a known directory", async () => {
    await channelA("/fs/write", { path: "tree/a.txt", content: "a" });
    await channelA("/fs/write", { path: "tree/sub/b.txt", content: "b" });
    const list = await channelA("/fs/list", { path: "tree", depth: 3 });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      root: { path: string; children?: { path: string; type: string; children?: unknown[] }[] };
    };
    const paths: string[] = [];
    const walk = (n: {
      path: string;
      children?: { path: string; type: string; children?: unknown[] }[];
    }): void => {
      paths.push(n.path);
      n.children?.forEach((ch) => walk(ch as never));
    };
    walk(body.root as never);
    expect(paths).toContain("tree/a.txt");
    expect(paths).toContain("tree/sub");
    expect(paths).toContain("tree/sub/b.txt");
  }, 60_000);

  test("git status + diff on a staged change parse into structured hunks", async () => {
    // Build a repo with a staged modification via terminal exec + fs.write.
    await channelA("/terminal/exec", {
      command:
        "git init -q && git config user.email t@t.io && git config user.name t && git config commit.gpgsign false",
      cwd: "repo",
    });
    await channelA("/fs/write", { path: "repo/code.txt", content: "alpha\nbeta\ngamma\n" });
    await channelA("/terminal/exec", {
      command: "git add code.txt && git commit -q -m base",
      cwd: "repo",
    });
    await channelA("/fs/write", {
      path: "repo/code.txt",
      content: "alpha\nbeta CHANGED\ngamma\ndelta\n",
    });
    await channelA("/terminal/exec", { command: "git add code.txt", cwd: "repo" });

    const status = await channelA("/git/status", { path: "repo" });
    expect(status.status).toBe(200);
    const sb = (await status.json()) as {
      isRepo: boolean;
      files: { path: string; index: string | null }[];
    };
    expect(sb.isRepo).toBe(true);
    expect(sb.files.some((f) => f.path === "code.txt" && f.index === "modified")).toBe(true);

    const diff = await channelA("/git/diff", { path: "repo", staged: true });
    expect(diff.status).toBe(200);
    const db = (await diff.json()) as {
      files: {
        path: string;
        hunks: { lines: { type: string; oldNo: number | null; newNo: number | null }[] }[];
        additions: number;
      }[];
    };
    const file = db.files.find((f) => f.path === "code.txt");
    expect(file).toBeDefined();
    expect(file!.additions).toBeGreaterThan(0);
    expect(file!.hunks.length).toBeGreaterThanOrEqual(1);
    const lines = file!.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.type === "add" && l.newNo !== null && l.oldNo === null)).toBe(true);
    expect(lines.some((l) => l.type === "del")).toBe(true);
  }, 120_000);

  test("terminal exec 'echo $DISPLAY' streams output + a sandbox.command.output.delta", async () => {
    const res = await channelA("/terminal/exec", {
      command: "echo display=$DISPLAY; echo channel_a_terminal_marker",
      cwd: "",
    });
    expect(res.status).toBe(200);
    const rb = (await res.json()) as { stdout: string; exitCode: number };
    expect(rb.stdout).toContain("channel_a_terminal_marker");
    expect(rb.exitCode).toBe(0);
    // the buffered output is also published on A1 (the firehose) so other viewers see it.
    await waitFor(
      async () => {
        const events = await sessionEvents(sessionId);
        return events.some(
          (e) =>
            e.type === "sandbox.command.output.delta" &&
            JSON.stringify(e.payload ?? {}).includes("channel_a_terminal_marker"),
        );
      },
      { timeoutMs: 20_000 },
    );
  }, 60_000);

  test("400 on a malformed body; 404 on a missing session", async () => {
    // fs.read requires a `path` — an empty body is a 400 (explicit, not a 500).
    const bad = await fetch(apiPath(`/sessions/${sessionId}/fs/read`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const missing = await fetch(apiPath(`/sessions/00000000-0000-4000-8000-0000000000ff/fs/list`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    expect(missing.status).toBe(404);
  }, 30_000);

  async function channelA(suffix: string, body: unknown): Promise<Response> {
    return await fetch(apiPath(`/sessions/${sessionId}${suffix}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});

async function sessionEvents(sessionId: string): Promise<{ type: string; payload: unknown }[]> {
  const response = await fetch(apiPath(`/sessions/${sessionId}/events?limit=400`));
  expect(response.ok).toBe(true);
  return (await response.json()) as { type: string; payload: unknown }[];
}

async function discoverWorkspaceId(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${apiPort}/v1/access/me`);
  expect(response.ok).toBe(true);
  const context = (await response.json()) as { defaultWorkspaceId?: string };
  expect(typeof context.defaultWorkspaceId).toBe("string");
  return context.defaultWorkspaceId!;
}

function apiPath(path: string): string {
  return `http://127.0.0.1:${apiPort}/v1/workspaces/${workspaceId}${path}`;
}

function stackEnv(services: TestServices, localApiPort: number): Record<string, string> {
  return {
    OPENGENI_ENVIRONMENT: "test",
    OPENGENI_DATABASE_URL: services.databaseUrl,
    OPENGENI_NATS_URL: services.natsUrl,
    OPENGENI_TEMPORAL_HOST: services.temporalHost,
    OPENGENI_TEMPORAL_NAMESPACE: "default",
    OPENGENI_TEMPORAL_TASK_QUEUE: `channel-a-e2e-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(localApiPort),
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "docker",
    OPENGENI_DOCKER_IMAGE: "opengeni-sandbox:local",
    OPENGENI_DOCKER_NETWORK: services.dockerNetwork,
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
    // Channel-A rides the lease (the viewer holder warms/holds the box); the flag
    // must be ON for the routes to be live (else they 404).
    OPENGENI_SANDBOX_OWNERSHIP_ENABLED: "true",
    OPENGENI_OBJECT_STORAGE_ENDPOINT: services.objectStorageEndpoint!,
    OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT: services.objectStorageSandboxEndpoint!,
    OPENGENI_OBJECT_STORAGE_BUCKET: "opengeni-files",
    OPENGENI_OBJECT_STORAGE_REGION: "us-east-1",
    OPENGENI_OBJECT_STORAGE_S3_PROVIDER: "Minio",
    OPENGENI_OBJECT_STORAGE_ACCESS_KEY_ID: "minioadmin",
    OPENGENI_OBJECT_STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    OPENGENI_OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
    OPENGENI_TEST_SCENARIO: "sandbox",
  };
}
