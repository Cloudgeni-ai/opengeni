import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const routeUrl = new URL("../src/routes/browser-sessions.ts", import.meta.url);

/** Drives the recording save route in a separate process against a fake
 * controller and a fake store that shows the worker's fresh action log only
 * after a number of reads, as storage replicating in the background does. */
async function recordingSaveRouteFixture() {
  const routeHref = process.argv[2]!;
  const apiDirectory = new URL("..", routeHref).pathname;
  const resolveFromApi = (name: string) => Bun.resolveSync(name, apiDirectory);
  const { mock } = await import("bun:test");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = (await import(resolveFromApi("hono"))) as typeof import("hono");
  const { HTTPException: FixtureHTTPException } = (await import(
    resolveFromApi("hono/http-exception")
  )) as typeof import("hono/http-exception");
  const db = (await import(resolveFromApi("@opengeni/db"))) as typeof import("@opengeni/db");
  const core = (await import(resolveFromApi("@opengeni/core"))) as typeof import("@opengeni/core");
  const { testSettings: fixtureSettings } = (await import(
    resolveFromApi("@opengeni/testing")
  )) as typeof import("@opengeni/testing");
  const accountId = randomUUID(),
    workspaceId = randomUUID(),
    browserSessionId = randomUUID(),
    sourceSessionId = randomUUID(),
    machineId = randomUUID(),
    instanceId = randomUUID(),
    controllerGeneration = randomUUID(),
    recordingId = randomUUID(),
    artifactId = randomUUID(),
    subjectId = "synthetic-user";
  const grant = {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["sessions:control", "files:upload"],
  };
  const placement = { kind: "connected_machine", sandboxId: machineId };
  const videoKey = `workspaces/${workspaceId}/recordings/${recordingId}/prepared/track-0.mp4`;
  const actionLogKey = `workspaces/${workspaceId}/recordings/${recordingId}/prepared/track-0.actions.json`;
  const actionLog = new TextEncoder().encode('{"actions":[]}');
  // How many more reads of the action log storage misses, and how long ago
  // (by the database's clock) the video was made.
  let actionLogMisses = 0;
  let readyForMilliseconds = 0;
  let imports: string[] = [];
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
    touchBrowserSessionController: async () => true,
    terminalizeStaleConnectedInteractionPlacement: async () => ({ sourcePlacementChanged: false }),
    getSessionAuthorityProjection: async () => null,
    findBrowserRecording: async () => ({
      recording: { state: "ready", ownerSubjectId: subjectId, visibility: "workspace" },
      errorMessage: null,
    }),
    getBrowserRecordingVideo: async () => ({
      objectKey: videoKey,
      actionLogObjectKey: actionLogKey,
      bytes: 2_000,
      sha256: "a".repeat(64),
      durationMilliseconds: 3_000,
      width: 320,
      height: 200,
      frameCount: 2,
      readyForMilliseconds,
    }),
    recordAuditEvent: async () => undefined,
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async () => grant,
    requireSessionAuthorization: async () => ({}),
    requireLimit: async () => undefined,
  }));
  const summary = {
    recordingId,
    state: "stopped",
    startedAt: "2026-10-26T19:28:00.000Z",
    stoppedAt: "2026-10-26T19:28:30.000Z",
    stopReason: "requested",
    durationMs: 3_000,
    frameCount: 2,
    frameBytes: 2_048,
    actionCount: 1,
    bundle: null,
    streamError: null,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        request.method === "POST" &&
        path === `/v1/browser-sessions/${browserSessionId}/recordings/${recordingId}/stop`
      ) {
        return Response.json({ protocolVersion: 1, ok: true, data: summary });
      }
      return new Response("unexpected controller request", { status: 500 });
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
        importWorkspaceFile: async (input: { destinationPath: string; sha256: string }) => {
          imports.push(input.destinationPath);
          return { sha256: input.sha256 };
        },
      },
    });
  mock.module(channelHref, () => ({ ...channel, withChannelARead: routed, withChannelA: routed }));
  const artifactsHref = new URL("../sandbox-file-artifacts.ts", routeHref).href;
  const artifacts = await import(artifactsHref);
  mock.module(artifactsHref, () => ({
    ...artifacts,
    publishSandboxFileArtifact: async () => ({ artifact: { artifactId } }),
  }));
  const objectStorage = {
    getObjectBytes: async (key: string) => {
      if (key !== actionLogKey) return null;
      if (actionLogMisses > 0) {
        actionLogMisses -= 1;
        return null;
      }
      return { bytes: actionLog };
    },
    headObject: async (key: string) => (key === videoKey ? { ContentLength: 2_000 } : null),
    createGetUrl: async ({ key }: { key: string }) => ({
      url: `https://storage.example.test/${key}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  };
  const { registerBrowserSessionRoutes } = await import(routeHref);
  const app = new Hono();
  app.onError((error, context) => {
    const typed = error as { status?: number; code?: string; details?: unknown };
    return context.json(
      { message: error.message, code: typed.code ?? null, details: typed.details ?? null },
      (error instanceof FixtureHTTPException ? error.status : (typed.status ?? 500)) as never,
    );
  });
  registerBrowserSessionRoutes(app, {
    settings: fixtureSettings({ delegationSecret: "synthetic-controller-authority" }),
    db: {},
    bus: {},
    objectStorage,
    workflowClient: { startBrowserRecordingVideo: async () => undefined },
  } as never);
  const save = async () => {
    const response = await app.request(
      `https://api.example.test/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/recordings/${recordingId}/save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: "77777777-7777-4777-8777-777777777777" }),
      },
    );
    const body = (await response.json()) as Record<string, any>;
    return {
      status: response.status,
      state: body.state ?? null,
      artifactId: body.video?.artifactId === artifactId ? "published" : null,
      code: body.code ?? null,
      details: body.details ?? null,
      message: response.status >= 500 ? body.message : null,
    };
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const results: Record<string, unknown> = {};
    // The worker's action log is not readable yet when the save first asks:
    // storage misses every read of that poll, then the first of the next.
    actionLogMisses = 9;
    readyForMilliseconds = 2_000;
    imports = [];
    results.lagging = [await save(), await save()];
    results.laggingImports = imports;
    // Long after the video was made, storage still cannot show it.
    actionLogMisses = 1_000;
    readyForMilliseconds = 60_000;
    imports = [];
    results.unreadable = await save();
    results.unreadableImports = imports;
    console.log(JSON.stringify(results));
  } finally {
    console.error = originalError;
    await server.stop(true);
  }
}

test("the save route waits out storage that does not show a fresh action log yet, then saves it", async () => {
  const directory = await mkdtemp("/tmp/og-api-recording-save-");
  const script = join(directory, "synthetic-recording-save-route.ts");
  await writeFile(script, `(${recordingSaveRouteFixture.toString()})()`, { mode: 0o600 });
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
    const none = { artifactId: null, code: null, details: null, message: null };
    expect(JSON.parse(stdout)).toEqual({
      // The first poll finds the video made but its action log not readable
      // yet, so it answers 202 and is asked again; the next poll saves both.
      lagging: [
        { ...none, status: 202, state: "encoding" },
        { ...none, status: 201, state: null, artifactId: "published" },
      ],
      laggingImports: [
        "recordings/browser-2026-10-26T19-28-00Z.mp4",
        "recordings/browser-2026-10-26T19-28-00Z.actions.json",
      ],
      // Past the window it stops waiting and says why nothing was saved.
      unreadable: {
        status: 503,
        state: null,
        artifactId: null,
        code: "upstream_unavailable",
        details: { code: "browser_recording_output_unreadable" },
        message:
          "The recording's video was made, but storage still cannot read it back, so nothing was saved to the workspace. Stop the recording again later, before its browser session ends, to save it.",
      },
      unreadableImports: [],
    });
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
