import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const routeUrl = new URL("../src/routes/browser-sessions.ts", import.meta.url);

// Module mocks live in an isolated process, as in the recording save fixture.
async function downloadSaveRouteFixture() {
  const routeHref = process.argv[2]!;
  const resolveFromApi = (name: string) => Bun.resolveSync(name, new URL("..", routeHref).pathname);
  const { mock } = await import("bun:test");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = (await import(resolveFromApi("hono"))) as typeof import("hono");
  const db = (await import(resolveFromApi("@opengeni/db"))) as typeof import("@opengeni/db");
  const core = (await import(resolveFromApi("@opengeni/core"))) as typeof import("@opengeni/core");
  const { testSettings } = (await import(
    resolveFromApi("@opengeni/testing")
  )) as typeof import("@opengeni/testing");
  const accountId = randomUUID(),
    workspaceId = randomUUID(),
    browserSessionId = randomUUID(),
    sourceSessionId = randomUUID(),
    machineId = randomUUID(),
    instanceId = randomUUID(),
    controllerGeneration = randomUUID(),
    downloadId = randomUUID(),
    operationId = randomUUID(),
    fileId = randomUUID(),
    uploadId = randomUUID();
  const grant = {
    accountId,
    workspaceId,
    subjectId: "synthetic-user",
    permissions: ["sessions:control", "files:upload"],
  };
  const placement = { kind: "connected_machine", sandboxId: machineId };
  const download = {
    id: downloadId,
    browserSessionId,
    controllerGeneration,
    targetId: null,
    filename: "large.bin",
    status: "completed",
    receivedBytes: 294 * 1024 * 1024,
    totalBytes: 294 * 1024 * 1024,
    sha256: "a".repeat(64),
    version: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    settledAt: "2026-01-01T00:01:00.000Z",
    failureCode: null,
  };
  const response = {
    download,
    destinationPath: "downloads/large.bin",
    fileId,
    operationId,
    replayed: false,
  };
  const saved = {
    operationId,
    browserSessionId,
    controllerGeneration,
    sourceSessionId,
    destinationPath: response.destinationPath,
    overwrite: false,
    fileId,
    uploadId,
    objectKey: `workspaces/${workspaceId}/files/${fileId}/original/large.bin`,
    safeFilename: "large.bin",
    contentType: "application/octet-stream",
    download,
    state: "prepared",
    response: null as typeof response | null,
  };
  const file = {
    id: fileId,
    objectKey: saved.objectKey,
    bucket: "test",
    status: "pending_upload",
    contentType: saved.contentType,
    sizeBytes: download.receivedBytes,
    sha256: download.sha256,
  };
  const upload = {
    id: uploadId,
    status: "pending",
    file,
    expiresAt: new Date(Date.now() + 60_000),
  };
  const events: string[] = [];
  mock.module(resolveFromApi("@opengeni/db"), () => ({
    ...db,
    getBrowserSessionControlRecord: async () => ({
      sourceSessionId,
      tokenGeneration: 1,
      controllerHostSandboxGroupId: null,
      networkRouteAuthority: null,
      session: {
        id: browserSessionId,
        workspaceId,
        lifecycle: "active",
        placement,
        controller: {
          controllerId: "opengeni-browserd",
          controllerGeneration,
          placementInstanceId: instanceId,
        },
        driverId: "opengeni.cdp.v1",
        engine: "chromium",
        headless: true,
        linkedComputerSessionId: null,
        networkRouteId: null,
      },
    }),
    getSession: async () => ({ id: sourceSessionId, workspaceId, activeSandboxId: machineId }),
    getSessionAuthorityProjection: async () => null,
    getBrowserDownloadPrivateOwner: async () => null,
    touchBrowserSessionController: async () => true,
    terminalizeStaleConnectedInteractionPlacement: async () => ({ sourcePlacementChanged: false }),
    findBrowserDownloadSave: async () => saved,
    prepareBrowserDownloadSave: async () => saved,
    getFileUpload: async () => upload,
    completeFileUpload: async () => {
      events.push("finalize");
      file.status = "ready";
      upload.status = "completed";
      return file;
    },
    dispatchBrowserDownloadSave: async () => {
      events.push("dispatch");
      saved.state = "dispatched";
      return { dispatchedNow: true };
    },
    completeBrowserDownloadSave: async () => {
      events.push("complete");
      saved.state = "completed";
      saved.response = response;
      return response;
    },
    recordAuditEvent: async () => undefined,
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async () => grant,
    requireSessionAuthorization: async () => ({}),
    requireLimit: async () => undefined,
    recordWorkspaceUsage: async () => undefined,
  }));
  let finished = false,
    legacy = false;
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path.split("/").at(-1)!);
      let data: unknown;
      if (request.method === "GET") data = download;
      else {
        const body = (await request.json()) as {
          operationId: string;
          downloadId: string;
          waitMs?: number;
        };
        if (body.operationId !== operationId || body.downloadId !== downloadId)
          throw new Error("wrong binding");
        if (path.endsWith("/uploads") && legacy)
          return Response.json(
            {
              protocolVersion: 1,
              ok: false,
              error: { code: "resource_not_found", message: "route not found", retryable: false },
            },
            { status: 404 },
          );
        const receipt = {
          operationId,
          downloadId,
          sizeBytes: download.receivedBytes,
          sha256: download.sha256,
          replayed: false,
        };
        if (path.endsWith("/uploads")) {
          if (body.waitMs !== 45_000) throw new Error("unbounded wait");
          data = { operationId, downloadId, receipt: finished ? receipt : null };
        } else data = receipt;
      }
      return Response.json({ protocolVersion: 1, ok: true, data });
    },
  });
  const channelHref = new URL("../sandbox/channel-a.ts", routeHref).href;
  const channel = await import(channelHref);
  const routed = async (
    _services: unknown,
    _context: unknown,
    callback: (handle: unknown) => Promise<unknown>,
  ) =>
    await callback({
      routingSession: {
        prime: async () => ({
          kind: "selfhosted",
          sandboxId: machineId,
          providerInstanceId: instanceId,
          session: {
            resolveExposedPort: async () => ({ host: "127.0.0.1", port: server.port, tls: false }),
          },
        }),
      },
      lease: null,
      service: {
        importWorkspaceFile: async (input: {
          destinationPath: string;
          sizeBytes: number;
          sha256: string;
        }) => {
          events.push("import");
          return input;
        },
      },
    });
  mock.module(channelHref, () => ({ ...channel, withChannelARead: routed, withChannelA: routed }));
  const { registerBrowserSessionRoutes } = await import(routeHref);
  const app = new Hono();
  app.onError((error, context) => context.json({ message: error.message }, 500));
  registerBrowserSessionRoutes(app, {
    settings: testSettings({ delegationSecret: "synthetic-controller-authority" }),
    db: {},
    bus: {},
    objectStorage: {
      bucket: "test",
      maxSinglePutSizeBytes: 5_000_000_000,
      createPutUrl: async () => ({
        url: "https://storage.example.test/file",
        requiredHeaders: {},
        expiresAt: upload.expiresAt,
      }),
      createGetUrl: async () => ({
        url: "https://storage.example.test/file",
        expiresAt: upload.expiresAt,
      }),
      fileExists: async () => true,
      headFile: async () => ({
        ContentLength: download.receivedBytes,
        ContentType: saved.contentType,
        Metadata: { sha256: download.sha256 },
      }),
    },
  } as never);
  const save = async (asyncResponse = true) => {
    const result = await app.request(
      `https://api.example.test/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/downloads/${downloadId}/save${asyncResponse ? "?respondAsync=true" : ""}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, destinationPath: saved.destinationPath }),
      },
    );
    return { status: result.status, body: (await result.json()) as Record<string, unknown> };
  };
  const reset = () => {
    saved.state = "prepared";
    saved.response = null;
    upload.status = "pending";
    file.status = "pending_upload";
    events.length = 0;
    paths.length = 0;
  };
  try {
    const pending = await save();
    const pendingState = {
      status: pending.status,
      state: pending.body.state,
      saveState: saved.state,
      events: [...events],
    };
    finished = true;
    const complete = await save();
    const replay = await save();
    const completed = {
      status: complete.status,
      replay: replay.status,
      destinationPath: complete.body.destinationPath,
      events: [...events],
    };
    reset();
    const synchronous = await save(false);
    const compatibility = { status: synchronous.status, paths: [...paths] };
    reset();
    legacy = true;
    const fallback = await save();
    console.log(
      JSON.stringify({
        pending: pendingState,
        completed,
        compatibility,
        fallback: { status: fallback.status, paths },
      }),
    );
  } finally {
    server.stop(true);
  }
}

test("bounded save progress preserves the operation until verified bytes are imported", async () => {
  const directory = await mkdtemp("/tmp/og-api-download-save-");
  const script = join(directory, "fixture.ts");
  await writeFile(script, `(${downloadSaveRouteFixture.toString()})()`, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--no-env-file", script, routeUrl.href], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.pending).toEqual({
      status: 202,
      state: "uploading",
      saveState: "prepared",
      events: [],
    });
    expect(result.completed).toEqual({
      status: 201,
      replay: 200,
      destinationPath: "downloads/large.bin",
      events: ["finalize", "dispatch", "import", "complete"],
    });
    expect(result.compatibility.status).toBe(201);
    expect(result.compatibility.paths.at(-1)).toBe("exports");
    expect(result.compatibility.paths).not.toContain("uploads");
    expect(result.fallback.status).toBe(201);
    expect(result.fallback.paths.slice(-2)).toEqual(["uploads", "exports"]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
