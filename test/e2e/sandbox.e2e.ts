import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import {
  buildSandboxImage,
  freePort,
  runCommand,
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

describe("real Docker sandbox e2e", () => {
  let services: TestServices;
  let api: StartedProcess;
  let worker: StartedE2eWorkerTopology;

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
  }, 360_000);

  afterAll(async () => {
    await worker?.stop();
    await api?.stop();
    await services?.down();
  }, 60_000);

  test("runs SDK shell tool calls inside the real Docker sandbox", async () => {
    const create = await fetch(apiPath("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "verify sandbox cli tools",
        sandboxBackend: "docker",
      }),
    });
    expect(create.status).toBe(202);
    const session = (await create.json()) as { id: string };

    await waitFor(
      async () => {
        const events = await sessionEvents(session.id);
        return events.some(
          (event) =>
            event.type === "session.status.changed" &&
            (event.payload as { status?: string }).status === "idle",
        );
      },
      { timeoutMs: 180_000 },
    );

    const events = await sessionEvents(session.id);
    const toolOutputs = events
      .filter((event) => event.type === "agent.toolCall.output")
      .map((event) => JSON.stringify(event.payload ?? {}));
    expect(toolOutputs.some((output) => output.includes("sandbox-ok"))).toBe(true);
    expect(events.some((event) => event.type === "agent.message.completed")).toBe(true);
  }, 240_000);

  test("materializes uploaded file resources inside the real Docker sandbox", async () => {
    const upload = await fetch(apiPath("/files/uploads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "sandbox-file.txt",
        contentType: "text/plain",
        sizeBytes: "file-mounted-ok".length,
      }),
    });
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };
    const put = await fetch(uploadBody.putUrl, {
      method: "PUT",
      body: "file-mounted-ok",
      headers: uploadBody.requiredHeaders,
    });
    expect(put.ok).toBe(true);
    const complete = await fetch(apiPath(`/files/uploads/${uploadBody.uploadId}/complete`), {
      method: "POST",
    });
    expect(complete.ok).toBe(true);

    const create = await fetch(apiPath("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "verify mounted file",
        sandboxBackend: "docker",
        resources: [{ kind: "file", fileId: uploadBody.fileId }],
      }),
    });
    expect(create.status).toBe(202);
    const session = (await create.json()) as { id: string };

    await waitFor(
      async () => {
        const events = await sessionEvents(session.id);
        return events.some(
          (event) =>
            event.type === "session.status.changed" &&
            (event.payload as { status?: string }).status === "idle",
        );
      },
      { timeoutMs: 180_000 },
    );

    const events = await sessionEvents(session.id);
    expect(
      events
        .filter((event) => event.type === "agent.toolCall.output")
        .some((event) => JSON.stringify(event.payload ?? {}).includes("file-mounted-ok")),
    ).toBe(true);
  }, 240_000);

  test("views uploaded image resources from materialized sandbox files", async () => {
    const imageBytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const upload = await fetch(apiPath("/files/uploads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "sandbox-image.png",
        contentType: "image/png",
        sizeBytes: imageBytes.byteLength,
      }),
    });
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };
    const put = await fetch(uploadBody.putUrl, {
      method: "PUT",
      body: imageBytes,
      headers: uploadBody.requiredHeaders,
    });
    expect(put.ok).toBe(true);
    expect(
      (await fetch(apiPath(`/files/uploads/${uploadBody.uploadId}/complete`), { method: "POST" }))
        .ok,
    ).toBe(true);

    const create = await fetch(apiPath("/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "verify mounted image",
        sandboxBackend: "docker",
        resources: [{ kind: "file", fileId: uploadBody.fileId, mountPath: "files/e2e-image" }],
      }),
    });
    expect(create.status).toBe(202);
    const session = (await create.json()) as { id: string };

    await waitFor(
      async () => {
        const events = await sessionEvents(session.id);
        return events.some(
          (event) =>
            event.type === "session.status.changed" &&
            (event.payload as { status?: string }).status === "idle",
        );
      },
      { timeoutMs: 180_000 },
    );

    const events = await sessionEvents(session.id);
    const viewOutput = events.find(
      (event) =>
        event.type === "agent.toolCall.output" &&
        JSON.stringify(event.payload ?? {}).includes("sandbox-view-image"),
    );
    expect(JSON.stringify(viewOutput?.payload ?? {})).not.toContain("unable to read image");
    expect(JSON.stringify(viewOutput?.payload ?? {})).toContain("image");
  }, 240_000);

  test("sandbox image has required CLIs and no custom Azure login helper", async () => {
    const result = await runCommand(
      [
        "docker",
        "run",
        "--rm",
        "opengeni-sandbox:local",
        "bash",
        "-lc",
        [
          "terraform version >/dev/null",
          "checkov --version >/dev/null",
          "az version --output none",
          "gh --version >/dev/null",
          "git --version >/dev/null",
          "jq --version >/dev/null",
          "curl --version >/dev/null",
          "test -x /usr/local/bin/opengeni-git-askpass",
          "test ! -e /usr/local/bin/opengeni-azure-login",
        ].join(" && "),
      ],
      { timeoutMs: 120_000 },
    );
    expect(result.exitCode).toBe(0);
  }, 180_000);
});

async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const response = await fetch(apiPath(`/sessions/${sessionId}/events?limit=200`));
  expect(response.ok).toBe(true);
  return (await response.json()) as SessionEvent[];
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
    OPENGENI_TEMPORAL_TASK_QUEUE: `sandbox-e2e-${crypto.randomUUID()}`,
    OPENGENI_API_HOST: "127.0.0.1",
    OPENGENI_API_PORT: String(localApiPort),
    OPENGENI_PRODUCT_ACCESS_MODE: "local",
    OPENGENI_OPENAI_API_KEY: "test",
    OPENGENI_OPENAI_MODEL: "scripted-model",
    OPENGENI_SANDBOX_BACKEND: "docker",
    OPENGENI_DOCKER_IMAGE: "opengeni-sandbox:local",
    OPENGENI_DOCKER_NETWORK: services.dockerNetwork,
    OPENGENI_SANDBOX_PREPARATION_PROFILES: "none",
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
