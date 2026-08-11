import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OpenGeniClient,
  browserFrameSocketUrl,
  computerFrameSocketUrl,
  decodeBrowserFrameMessage,
  decodeComputerFrameMessage,
  type AttachedBrowserDevice,
  type BrowserFrameMetadata,
  type BrowserIdentity,
  type BrowserRevision,
  type BrowserSession,
  type ComputerSession,
  type ComputerFrameMetadata,
} from "../src";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const BROWSER_SESSION_ID = "00000000-0000-4000-8000-000000000003";
const BROWSER_IDENTITY_ID = "00000000-0000-4000-8000-000000000007";
const BROWSER_REVISION_ID = "00000000-0000-4000-8000-000000000008";
const ATTACHED_BROWSER_ID = "00000000-0000-4000-8000-000000000012";
const COMPUTER_SESSION_ID = "00000000-0000-4000-8000-000000000014";
const NETWORK_ROUTE_ID = "00000000-0000-4000-8000-000000000019";
const SITE_AUTH_CONNECTION_ID = "00000000-0000-4000-8000-000000000020";
const AUTH_RUN_ID = "00000000-0000-4000-8000-000000000021";
const INTERVENTION_ID = "00000000-0000-4000-8000-000000000022";
const BROWSER_DOWNLOAD_ID = "00000000-0000-4000-8000-000000000023";
const BROWSER_DOWNLOAD_SAVE_OPERATION_ID = "00000000-0000-4000-8000-000000000024";
const BROWSER_DOWNLOAD_FILE_ID = "00000000-0000-4000-8000-000000000025";

function attachedBrowser(): AttachedBrowserDevice {
  return {
    id: ATTACHED_BROWSER_ID,
    accountId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE_ID,
    enrollmentId: "00000000-0000-4000-8000-000000000013",
    name: "Primary Chrome",
    profileLabel: "cloudgeni.ai",
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
    extensionVersion: "1.0.0",
    platform: "macos",
    architecture: "arm64",
    state: "connected",
    connectionGeneration: "bridge-1",
    inventoryRevision: 7,
    tabCount: 3,
    capabilities: {
      tabInventory: true,
      debuggerAttachment: true,
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: true,
    },
    lastSeenAt: "2026-08-10T10:00:00.000Z",
    disconnectedAt: null,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}

function browserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: BROWSER_SESSION_ID,
    accountId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE_ID,
    name: "Research",
    lifecycle: "active",
    placement: {
      kind: "sandbox_group",
      sandboxGroupId: "00000000-0000-4000-8000-000000000005",
    },
    controller: {
      controllerId: "opengeni-browserd",
      controllerGeneration: "controller-1",
      placementInstanceId: "placement-1",
    },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    engineVersion: "151",
    headless: true,
    identityId: null,
    baseRevisionId: null,
    networkRouteId: null,
    linkedComputerSessionId: null,
    capabilities: {
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      tabs: true,
      downloads: true,
      uploads: true,
      clipboard: false,
      permissions: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: false,
      privateCheckpoint: true,
      identityPublication: false,
      parallelTargets: true,
    },
    associations: [
      {
        sessionId: SOURCE_SESSION_ID,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "user:1",
        lastUsedAt: "2026-08-09T10:00:00.000Z",
      },
    ],
    createdBySubjectId: "user:1",
    createdAt: "2026-08-09T10:00:00.000Z",
    lastUsedAt: "2026-08-09T10:00:00.000Z",
    failureCode: null,
    ...overrides,
  };
}

function computerSession(overrides: Partial<ComputerSession> = {}): ComputerSession {
  return {
    id: COMPUTER_SESSION_ID,
    accountId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE_ID,
    name: "Linux desktop",
    lifecycle: "active",
    placement: {
      kind: "sandbox_group",
      sandboxGroupId: "00000000-0000-4000-8000-000000000005",
    },
    controller: {
      controllerId: "opengeni-interactiond",
      controllerGeneration: "controller-2",
      placementInstanceId: "placement-1",
    },
    platform: "linux",
    adapter: "opengeni.atspi-x11.v1",
    seatId: "seat-1",
    displayId: ":101",
    capabilities: {
      semanticObservation: true,
      appDiscovery: true,
      appLaunch: true,
      windowCapture: true,
      screenCapture: true,
      semanticActions: true,
      pointerInput: true,
      keyboardInput: true,
      clipboard: true,
      backgroundActions: true,
      parallelApps: true,
    },
    associations: [
      {
        sessionId: SOURCE_SESSION_ID,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "user:1",
        lastUsedAt: "2026-08-10T10:00:00.000Z",
      },
    ],
    createdBySubjectId: "user:1",
    createdAt: "2026-08-10T10:00:00.000Z",
    lastUsedAt: "2026-08-10T10:00:00.000Z",
    failureCode: null,
    ...overrides,
  };
}

describe("BrowserSession SDK", () => {
  test("reads the exact private browser clipboard as a scoped resource", async () => {
    const clipboard = {
      browserSessionId: BROWSER_SESSION_ID,
      controllerGeneration: "controller-1",
      revision: 3,
      text: "private browser text",
      source: "copy" as const,
      sourceTargetId: "target-1",
      updatedAt: "2026-08-10T10:00:01.000Z",
    };
    const calls: string[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        calls.push(String(input));
        return json(clipboard);
      },
    });

    expect(
      await client.interaction.browsers.session(WORKSPACE_ID, BROWSER_SESSION_ID).clipboard.read(),
    ).toEqual(clipboard);
    expect(calls).toEqual([
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/clipboard`,
    ]);
  });

  test("lists and explicitly saves private browser-produced files as resources", async () => {
    const download = {
      id: BROWSER_DOWNLOAD_ID,
      browserSessionId: BROWSER_SESSION_ID,
      controllerGeneration: "controller-1",
      targetId: "target-1",
      filename: "report.pdf",
      status: "completed" as const,
      receivedBytes: 42,
      totalBytes: 42,
      sha256: "a".repeat(64),
      version: 2,
      startedAt: "2026-08-10T10:00:00.000Z",
      settledAt: "2026-08-10T10:00:01.000Z",
      failureCode: null,
    };
    const calls: string[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return url.endsWith(`/${BROWSER_DOWNLOAD_ID}/save`)
          ? json(
              {
                download,
                destinationPath: "downloads/report.pdf",
                fileId: BROWSER_DOWNLOAD_FILE_ID,
                operationId: BROWSER_DOWNLOAD_SAVE_OPERATION_ID,
                replayed: false,
              },
              201,
            )
          : url.endsWith(`/${BROWSER_DOWNLOAD_ID}`)
            ? json(download)
            : json({
                browserSessionId: BROWSER_SESSION_ID,
                controllerGeneration: "controller-1",
                downloads: [download],
              });
      },
    });

    const browser = client.interaction.browsers.session(WORKSPACE_ID, BROWSER_SESSION_ID);
    expect((await browser.downloads.list()).downloads).toEqual([download]);
    expect(await browser.downloads.download(BROWSER_DOWNLOAD_ID).get()).toEqual(download);
    expect(
      await browser.downloads
        .download(BROWSER_DOWNLOAD_ID)
        .saveToWorkspace("downloads/report.pdf", {
          operationId: BROWSER_DOWNLOAD_SAVE_OPERATION_ID,
        }),
    ).toMatchObject({
      destinationPath: "downloads/report.pdf",
      fileId: BROWSER_DOWNLOAD_FILE_ID,
      operationId: BROWSER_DOWNLOAD_SAVE_OPERATION_ID,
    });
    expect(JSON.stringify(download)).not.toContain("/tmp/");
    expect(calls).toEqual([
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/downloads`,
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/downloads/${BROWSER_DOWNLOAD_ID}`,
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/downloads/${BROWSER_DOWNLOAD_ID}/save`,
    ]);
  });

  test("discovers live attached browser endpoints independently from saved identities", async () => {
    const device = attachedBrowser();
    const calls: string[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return url.endsWith(`/${ATTACHED_BROWSER_ID}`)
          ? json(device)
          : json({ revision: 9, devices: [device] });
      },
    });

    expect(
      (
        await client.interaction.attachedBrowsers.list(WORKSPACE_ID, {
          includeDisconnected: true,
        })
      ).devices,
    ).toEqual([device]);
    expect(
      await client.interaction.attachedBrowsers.device(WORKSPACE_ID, ATTACHED_BROWSER_ID).get(),
    ).toEqual(device);
    expect(calls).toEqual([
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/attached-browsers?includeDisconnected=true`,
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/attached-browsers/${ATTACHED_BROWSER_ID}`,
    ]);
  });

  test("routes the typed public methods without exposing controller authority", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const session = browserSession();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.endsWith("/browser-sessions") && method === "GET") {
          return json({ revision: 4, sessions: [session] });
        }
        if (url.endsWith(`/browser-sessions/${BROWSER_SESSION_ID}/targets`) && method === "POST") {
          return json({
            id: "target-1",
            browserSessionId: BROWSER_SESSION_ID,
            controllerGeneration: "controller-1",
            targetGeneration: "target-1-generation",
            documentGeneration: "document-1",
            kind: "page",
            title: "OpenGeni",
            url: "https://opengeni.ai/",
            selected: true,
            attached: true,
            createdAt: "2026-08-09T10:00:00.000Z",
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    const resource = await client.interaction.browsers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
    });
    const target = await resource.tabs.open("https://opengeni.ai/");

    expect(resource.id).toBe(BROWSER_SESSION_ID);
    expect(target.id).toBe("target-1");
    expect(calls).toEqual([
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions`,
        method: "GET",
        body: null,
      },
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/targets`,
        method: "POST",
        body: { url: "https://opengeni.ai/" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("controller-1");
  });

  test("opens a new browser only when no live associated BrowserSession exists", async () => {
    const operationId = "00000000-0000-4000-8000-000000000006";
    const calls: Array<{ method: string; body: unknown }> = [];
    const session = browserSession();
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, body });
        if (method === "GET") return json({ revision: 0, sessions: [] });
        return json({
          session,
          operation: {
            operationId,
            resourceKind: "browser_session",
            resourceId: session.id,
            kind: "create",
            state: "completed",
            replayed: false,
            error: null,
            createdAt: session.createdAt,
            dispatchedAt: session.createdAt,
            settledAt: session.createdAt,
          },
        });
      },
    });

    const resource = await client.interaction.browsers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
      operationId,
      initialUrl: "https://example.com/",
      headless: false,
      placement: { kind: "attached_device", deviceId: ATTACHED_BROWSER_ID },
    });

    expect(resource.id).toBe(BROWSER_SESSION_ID);
    expect(calls[1]).toEqual({
      method: "POST",
      body: {
        operationId,
        sessionId: SOURCE_SESSION_ID,
        initialUrl: "https://example.com/",
        headless: false,
        placement: { kind: "attached_device", deviceId: ATTACHED_BROWSER_ID },
      },
    });
  });

  test("carries an exact linked ComputerSession and placement through currentOrOpen", async () => {
    const operationId = "00000000-0000-4000-8000-000000000016";
    const placement = {
      kind: "sandbox_group" as const,
      sandboxGroupId: "00000000-0000-4000-8000-000000000005",
    };
    const session = browserSession({
      headless: false,
      placement,
      networkRouteId: NETWORK_ROUTE_ID,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      capabilities: { ...browserSession().capabilities, linkedComputer: true },
    });
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, body });
        if (method === "GET") return json({ revision: 0, sessions: [] });
        return json({
          session,
          operation: lifecycleOperation(operationId, "create"),
        });
      },
    });

    await client.interaction.browsers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
      operationId,
      headless: false,
      placement,
      networkRouteId: NETWORK_ROUTE_ID,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
    });

    expect(calls[1]).toEqual({
      method: "POST",
      body: {
        operationId,
        sessionId: SOURCE_SESSION_ID,
        headless: false,
        placement,
        networkRouteId: NETWORK_ROUTE_ID,
        linkedComputerSessionId: COMPUTER_SESSION_ID,
      },
    });
  });

  test("resumes the current suspended browser instead of opening another", async () => {
    const operationId = "00000000-0000-4000-8000-000000000006";
    const suspended = browserSession({
      lifecycle: "suspended",
      controller: null,
    });
    const active = browserSession();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.endsWith("/browser-sessions") && method === "GET") {
          return json({ revision: 4, sessions: [suspended] });
        }
        if (url.endsWith(`/browser-sessions/${BROWSER_SESSION_ID}/resume`)) {
          return json({
            session: active,
            operation: lifecycleOperation(operationId, "resume"),
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    const resource = await client.interaction.browsers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
      operationId,
    });

    expect(resource.id).toBe(BROWSER_SESSION_ID);
    expect(calls).toEqual([
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions`,
        method: "GET",
        body: null,
      },
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/resume`,
        method: "POST",
        body: { operationId },
      },
    ]);
  });

  test("exposes explicit suspend and resume lifecycle operations", async () => {
    const suspendOperationId = "00000000-0000-4000-8000-000000000010";
    const resumeOperationId = "00000000-0000-4000-8000-000000000011";
    const suspended = browserSession({
      lifecycle: "suspended",
      controller: null,
    });
    const active = browserSession();
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, body });
        return url.endsWith("/suspend")
          ? json({
              session: suspended,
              operation: lifecycleOperation(suspendOperationId, "suspend"),
            })
          : json({
              session: active,
              operation: lifecycleOperation(resumeOperationId, "resume"),
            });
      },
    });
    const resource = client.interaction.browsers.session(WORKSPACE_ID, BROWSER_SESSION_ID);

    expect((await resource.suspend({ operationId: suspendOperationId })).session.lifecycle).toBe(
      "suspended",
    );
    expect((await resource.resume({ operationId: resumeOperationId })).session.lifecycle).toBe(
      "active",
    );
    expect(calls).toEqual([
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/suspend`,
        body: { operationId: suspendOperationId },
      },
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/resume`,
        body: { operationId: resumeOperationId },
      },
    ]);
  });

  test("exposes immutable identities and revision publication as typed resources", async () => {
    const operationId = "00000000-0000-4000-8000-000000000009";
    const identity = browserIdentity();
    const revision = browserRevision();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.endsWith("/browser-identities?includeArchived=true")) {
          return json({ revision: 3, identities: [identity] });
        }
        if (url.endsWith("/browser-identities") && method === "POST") {
          return json({ identity, operationId, replayed: false }, 201);
        }
        if (url.endsWith(`/browser-identities/${BROWSER_IDENTITY_ID}/revisions`)) {
          return json({ identity, revisions: [revision] });
        }
        if (url.endsWith(`/browser-identities/${BROWSER_IDENTITY_ID}`)) return json(identity);
        if (url.endsWith(`/browser-sessions/${BROWSER_SESSION_ID}/revisions`)) {
          return json({
            identity: {
              ...identity,
              defaultRevisionId: revision.id,
              headGeneration: 1,
            },
            revision,
            outcome: "saved_as_default",
            replayed: false,
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    expect(
      (
        await client.interaction.identities.list(WORKSPACE_ID, {
          includeArchived: true,
        })
      ).identities,
    ).toEqual([identity]);
    const resource = await client.interaction.identities.create(WORKSPACE_ID, {
      operationId,
      name: identity.name,
    });
    expect(await resource.get()).toEqual(identity);
    expect((await resource.revisions()).revisions).toEqual([revision]);
    const published = await client.interaction.browsers
      .session(WORKSPACE_ID, BROWSER_SESSION_ID)
      .publishRevision({
        operationId,
        identityId: identity.id,
        expectedHeadGeneration: 0,
      });
    expect(published.revision).toEqual(revision);
    expect(JSON.stringify(published)).not.toContain("objectKey");
    expect(calls.map(({ method, body }) => ({ method, body }))).toEqual([
      { method: "GET", body: null },
      { method: "POST", body: { operationId, name: identity.name } },
      { method: "GET", body: null },
      { method: "GET", body: null },
      {
        method: "POST",
        body: {
          operationId,
          identityId: identity.id,
          expectedHeadGeneration: 0,
        },
      },
    ]);
  });

  test("exposes network, site-auth, auth-run, and intervention resources end to end", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.includes("/network-routes?")) return json({ revision: 1, routes: [] });
        if (url.endsWith("/network-routes") && method === "POST") {
          return json({
            route: { id: NETWORK_ROUTE_ID },
            operationId: "route-create",
            replayed: false,
          });
        }
        if (url.endsWith(`/network-routes/${NETWORK_ROUTE_ID}`)) {
          return json({
            route: { id: NETWORK_ROUTE_ID },
            operationId: "route-update",
            replayed: false,
          });
        }
        if (url.includes("/site-auth-connections?")) {
          return json({ revision: 1, connections: [] });
        }
        if (url.endsWith("/site-auth-connections") && method === "POST") {
          return json({
            connection: { id: SITE_AUTH_CONNECTION_ID },
            operationId: "auth-create",
            replayed: false,
          });
        }
        if (url.endsWith(`/site-auth-connections/${SITE_AUTH_CONNECTION_ID}`)) {
          return json({
            connection: { id: SITE_AUTH_CONNECTION_ID },
            operationId: "auth-update",
            replayed: false,
          });
        }
        if (url.includes("/auth-runs?")) return json({ runs: [] });
        if (url.endsWith(`/browser-sessions/${BROWSER_SESSION_ID}/auth-runs`)) {
          return json({ run: { id: AUTH_RUN_ID }, operationId: "auth-start", replayed: false });
        }
        if (url.endsWith(`/auth-runs/${AUTH_RUN_ID}/report`)) {
          return json({ run: { id: AUTH_RUN_ID }, operationId: "auth-report", replayed: false });
        }
        if (url.endsWith(`/auth-runs/${AUTH_RUN_ID}/protected-fill`)) {
          return json({
            run: { id: AUTH_RUN_ID },
            status: "working",
            operationId: "auth-fill",
            replayed: false,
          });
        }
        if (url.endsWith(`/auth-runs/${AUTH_RUN_ID}/external-auth/interactive`)) {
          return json({
            authRunId: AUTH_RUN_ID,
            url: "https://auth.example.test/hosted",
            expiresAt: null,
          });
        }
        if (url.endsWith(`/auth-runs/${AUTH_RUN_ID}/external-auth`)) {
          return json({
            run: { id: AUTH_RUN_ID },
            status: "needs_human",
            operationId: "auth-external",
            replayed: false,
          });
        }
        if (url.endsWith(`/auth-runs/${AUTH_RUN_ID}/verify`)) {
          return json({ run: { id: AUTH_RUN_ID }, operationId: "auth-verify", replayed: false });
        }
        if (url.includes("/interaction-interventions?")) return json({ interventions: [] });
        if (url.endsWith("/interaction-interventions") && method === "POST") {
          return json({
            intervention: { id: INTERVENTION_ID },
            operationId: "intervention-create",
            replayed: false,
          });
        }
        if (url.endsWith(`/interaction-interventions/${INTERVENTION_ID}/resolve`)) {
          return json({
            intervention: { id: INTERVENTION_ID },
            operationId: "intervention-resolve",
            replayed: false,
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    await client.interaction.networkRoutes.list(WORKSPACE_ID, { includeArchived: true });
    const route = await client.interaction.networkRoutes.create(WORKSPACE_ID, {
      operationId: "route-create",
      name: "Oslo direct",
      configuration: { kind: "direct" },
      consistency: {
        dns: "placement",
        expectedPublicIp: null,
        expectedRegion: "NO",
        locale: "nb-NO",
        timezone: "Europe/Oslo",
        geolocation: null,
        webRtc: "default",
        stability: "session",
      },
    });
    await route.update({ operationId: "route-update", expectedVersion: 1, name: "Norway" });

    await client.interaction.siteAuthConnections.list(WORKSPACE_ID, { includeArchived: true });
    const siteAuth = await client.interaction.siteAuthConnections.create(WORKSPACE_ID, {
      operationId: "auth-create",
      name: "Example",
      accountLabel: "work",
      origins: ["https://example.test"],
      loginUrl: "https://example.test/login",
      verificationUrlPrefixes: ["https://example.test/app"],
      authorities: [],
      methods: [],
      preferredIdentityId: null,
      preferredPlacement: null,
      preferredNetworkRouteId: NETWORK_ROUTE_ID,
      healthPolicy: { mode: "on_use", intervalSeconds: null, automaticRepair: false },
    });
    await siteAuth.update({
      operationId: "auth-update",
      expectedVersion: 1,
      accountLabel: "work account",
    });

    const browser = client.interaction.browsers.session(WORKSPACE_ID, BROWSER_SESSION_ID);
    await browser.auth.list({ includeSettled: true });
    const run = await browser.auth.start({
      operationId: "auth-start",
      siteAuthConnectionId: SITE_AUTH_CONNECTION_ID,
      targetId: "target-1",
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
    });
    await run.report({ operationId: "auth-report", expectedVersion: 1, state: "working" });
    await run.protectedFill({
      operationId: "auth-fill",
      expectedVersion: 2,
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      expectedFrameId: null,
      authorityId: "password-authority",
      fields: [{ fieldId: "password", locator: { kind: "ref", ref: "e2" } }],
      submit: { type: "press", key: "Enter" },
    });
    await run.advanceExternal({
      operationId: "auth-external",
      expectedVersion: 3,
      action: "start",
    });
    await run.openExternalFlow({
      operationId: "auth-interactive",
      expectedVersion: 4,
    });
    await run.verify({ operationId: "auth-verify", expectedVersion: 3 });

    await client.interaction.interventions.list(WORKSPACE_ID, {
      resourceKind: "browser_session",
      resourceId: BROWSER_SESSION_ID,
      includeSettled: true,
    });
    const intervention = await client.interaction.interventions.create(WORKSPACE_ID, {
      operationId: "intervention-create",
      resourceKind: "browser_session",
      resourceId: BROWSER_SESSION_ID,
      targetId: "target-1",
      expectedControllerGeneration: "controller-1",
      expectedTargetGeneration: "target-generation-1",
      expectedDocumentGeneration: "document-generation-1",
      kind: "mfa",
      reason: "Complete security-key verification",
      authRunId: AUTH_RUN_ID,
    });
    await intervention.resolve({
      operationId: "intervention-resolve",
      expectedVersion: 1,
      outcome: "completed",
    });

    expect(
      calls.map(({ url, method }) => `${method} ${url.replace("https://api.example.test", "")}`),
    ).toEqual([
      `GET /v1/workspaces/${WORKSPACE_ID}/network-routes?includeArchived=true`,
      `POST /v1/workspaces/${WORKSPACE_ID}/network-routes`,
      `PATCH /v1/workspaces/${WORKSPACE_ID}/network-routes/${NETWORK_ROUTE_ID}`,
      `GET /v1/workspaces/${WORKSPACE_ID}/site-auth-connections?includeArchived=true`,
      `POST /v1/workspaces/${WORKSPACE_ID}/site-auth-connections`,
      `PATCH /v1/workspaces/${WORKSPACE_ID}/site-auth-connections/${SITE_AUTH_CONNECTION_ID}`,
      `GET /v1/workspaces/${WORKSPACE_ID}/auth-runs?browserSessionId=${BROWSER_SESSION_ID}&includeSettled=true`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs/${AUTH_RUN_ID}/report`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs/${AUTH_RUN_ID}/protected-fill`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs/${AUTH_RUN_ID}/external-auth`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs/${AUTH_RUN_ID}/external-auth/interactive`,
      `POST /v1/workspaces/${WORKSPACE_ID}/browser-sessions/${BROWSER_SESSION_ID}/auth-runs/${AUTH_RUN_ID}/verify`,
      `GET /v1/workspaces/${WORKSPACE_ID}/interaction-interventions?resourceKind=browser_session&resourceId=${BROWSER_SESSION_ID}&includeSettled=true`,
      `POST /v1/workspaces/${WORKSPACE_ID}/interaction-interventions`,
      `POST /v1/workspaces/${WORKSPACE_ID}/interaction-interventions/${INTERVENTION_ID}/resolve`,
    ]);
  });
});

describe("ComputerSession SDK", () => {
  test("reads the exact native ComputerSession clipboard as a scoped resource", async () => {
    const clipboard = {
      computerSessionId: COMPUTER_SESSION_ID,
      controllerGeneration: "controller-2",
      text: "native clipboard",
      truncated: false,
      observedAt: "2026-08-10T10:00:01.000Z",
    };
    const calls: string[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        calls.push(String(input));
        return json(clipboard);
      },
    });

    expect(
      await client.interaction.computers
        .session(WORKSPACE_ID, COMPUTER_SESSION_ID)
        .clipboard.read(),
    ).toEqual(clipboard);
    expect(calls).toEqual([
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/computer-sessions/${COMPUTER_SESSION_ID}/clipboard`,
    ]);
  });

  test("discovers an associated workspace computer and routes causal native actions", async () => {
    const session = computerSession();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, method, body });
        if (url.endsWith("/computer-sessions")) {
          return json({ revision: 8, sessions: [session] });
        }
        if (url.endsWith(`/computer-sessions/${COMPUTER_SESSION_ID}/actions`)) {
          return json({
            protocolVersion: 1,
            operationId: "00000000-0000-4000-8000-000000000015",
            computerSessionId: COMPUTER_SESSION_ID,
            controllerGeneration: "controller-2",
            targetId: "window-1",
            state: "completed",
            dispatchedAt: "2026-08-10T10:01:00.000Z",
            settledAt: "2026-08-10T10:01:00.100Z",
            observation: null,
            error: null,
          });
        }
        throw new Error(`unexpected request ${method} ${url}`);
      },
    });

    const resource = await client.interaction.computers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
    });
    const receipt = await resource.act({
      operationId: "00000000-0000-4000-8000-000000000015",
      targetId: "window-1",
      expectedTargetGeneration: "target-3",
      expectedObservationId: "observation-5",
      expectedFrameId: null,
      action: {
        type: "semantic",
        locator: { kind: "ref", ref: "e1" },
        action: "invoke",
      },
    });

    expect(resource.id).toBe(COMPUTER_SESSION_ID);
    expect(receipt.state).toBe("completed");
    expect(calls).toEqual([
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/computer-sessions`,
        method: "GET",
        body: null,
      },
      {
        url: `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/computer-sessions/${COMPUTER_SESSION_ID}/actions`,
        method: "POST",
        body: {
          operationId: "00000000-0000-4000-8000-000000000015",
          targetId: "window-1",
          expectedTargetGeneration: "target-3",
          expectedObservationId: "observation-5",
          expectedFrameId: null,
          action: {
            type: "semantic",
            locator: { kind: "ref", ref: "e1" },
            action: "invoke",
          },
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("controller-2");
  });

  test("opens a placement-selected computer only when no associated one exists", async () => {
    const operationId = "00000000-0000-4000-8000-000000000016";
    const session = computerSession();
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, body });
        if (method === "GET") return json({ revision: 0, sessions: [] });
        return json({
          session,
          operation: {
            operationId,
            resourceKind: "computer_session",
            resourceId: session.id,
            kind: "create",
            state: "completed",
            replayed: false,
            error: null,
            createdAt: session.createdAt,
            dispatchedAt: session.createdAt,
            settledAt: session.createdAt,
          },
        });
      },
    });

    const resource = await client.interaction.computers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
      operationId,
      name: "Test desktop",
      placement: {
        kind: "sandbox_group",
        sandboxGroupId: "00000000-0000-4000-8000-000000000005",
      },
    });

    expect(resource.id).toBe(COMPUTER_SESSION_ID);
    expect(calls).toEqual([
      { method: "GET", body: null },
      {
        method: "POST",
        body: {
          operationId,
          sessionId: SOURCE_SESSION_ID,
          name: "Test desktop",
          placement: {
            kind: "sandbox_group",
            sandboxGroupId: "00000000-0000-4000-8000-000000000005",
          },
        },
      },
    ]);
  });

  test("does not pretend a suspended ComputerSession can resume", async () => {
    const operationId = "00000000-0000-4000-8000-000000000017";
    const suspended = computerSession({ lifecycle: "suspended" });
    const replacement = computerSession({
      id: "00000000-0000-4000-8000-000000000018",
      name: "Replacement desktop",
    });
    const calls: Array<{ method: string; body: unknown }> = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      fetch: async (_input, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ method, body });
        if (method === "GET") return json({ revision: 1, sessions: [suspended] });
        return json({
          session: replacement,
          operation: {
            operationId,
            resourceKind: "computer_session",
            resourceId: replacement.id,
            kind: "create",
            state: "completed",
            replayed: false,
            error: null,
            createdAt: replacement.createdAt,
            dispatchedAt: replacement.createdAt,
            settledAt: replacement.createdAt,
          },
        });
      },
    });

    const resource = await client.interaction.computers.currentOrOpen({
      workspaceId: WORKSPACE_ID,
      associationSessionId: SOURCE_SESSION_ID,
      operationId,
    });

    expect(resource.id).toBe(replacement.id);
    expect(calls).toEqual([
      { method: "GET", body: null },
      { method: "POST", body: { operationId, sessionId: SOURCE_SESSION_ID } },
    ]);
  });
});

describe("browser frame wire", () => {
  test("builds the scoped socket URL and validates a complete PNG frame", () => {
    const socketUrl = browserFrameSocketUrl(
      {
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targetId: "target-1",
        stream: {
          kind: "direct_websocket",
          url: "https://viewer.example.test/v1/frames?grant=opaque",
          protocols: ["opengeni.browser.v1", "opengeni.auth.secret"],
        },
        expiresAt: "2026-08-09T10:02:00.000Z",
      },
      { quality: 60, maxWidth: 900, everyNthFrame: 2 },
    );
    expect(socketUrl).toBe(
      "wss://viewer.example.test/v1/frames?grant=opaque&quality=60&maxWidth=900&everyNthFrame=2",
    );

    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const metadata: BrowserFrameMetadata = {
      frameId: "frame-1",
      browserSessionId: BROWSER_SESSION_ID,
      controllerGeneration: "controller-1",
      targetId: "target-1",
      targetGeneration: "target-generation-1",
      documentGeneration: "document-generation-1",
      sequence: 1,
      mediaType: "image/png",
      width: 1,
      height: 1,
      deviceScaleFactor: 1,
      scrollX: 0,
      scrollY: 0,
      capturedAt: "2026-08-09T10:00:00.000Z",
    };
    const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
    const message = new Uint8Array(4 + encodedMetadata.byteLength + png.byteLength);
    new DataView(message.buffer).setUint32(0, encodedMetadata.byteLength, false);
    message.set(encodedMetadata, 4);
    message.set(png, 4 + encodedMetadata.byteLength);

    expect(decodeBrowserFrameMessage(message)).toEqual({
      ...metadata,
      data: png,
    });

    const wrong = new TextEncoder().encode(JSON.stringify({ ...metadata, width: 2 }));
    const wrongMessage = new Uint8Array(4 + wrong.byteLength + png.byteLength);
    new DataView(wrongMessage.buffer).setUint32(0, wrong.byteLength, false);
    wrongMessage.set(wrong, 4);
    wrongMessage.set(png, 4 + wrong.byteLength);
    expect(() => decodeBrowserFrameMessage(wrongMessage)).toThrow(
      "browser frame image dimensions do not match metadata",
    );
  });
});

describe("computer frame wire", () => {
  test("builds the direct socket URL and verifies the native frame digest", async () => {
    const socketUrl = computerFrameSocketUrl(
      {
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-2",
        targetId: "window-1",
        stream: {
          kind: "direct_websocket",
          url: "https://viewer.example.test/v1/computer-frames?grant=opaque",
          protocols: ["opengeni.computer.v1", "opengeni.auth.secret"],
        },
        expiresAt: "2026-08-10T10:02:00.000Z",
      },
      { format: "png", quality: 80, maxWidth: 1_200 },
    );
    expect(socketUrl).toBe(
      "wss://viewer.example.test/v1/computer-frames?grant=opaque&format=png&quality=80&maxWidth=1200",
    );

    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const metadata: ComputerFrameMetadata = {
      frameId: "computer-frame-1",
      computerSessionId: COMPUTER_SESSION_ID,
      controllerGeneration: "controller-2",
      targetId: "window-1",
      targetGeneration: "target-generation-1",
      sequence: 3,
      mediaType: "image/png",
      width: 1,
      height: 1,
      capturedAt: "2026-08-10T10:00:00.000Z",
      sha256: createHash("sha256").update(png).digest("hex"),
    };
    const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
    const message = new Uint8Array(4 + encodedMetadata.byteLength + png.byteLength);
    new DataView(message.buffer).setUint32(0, encodedMetadata.byteLength, false);
    message.set(encodedMetadata, 4);
    message.set(png, 4 + encodedMetadata.byteLength);

    expect(await decodeComputerFrameMessage(message)).toEqual({ ...metadata, data: png });
    message[message.byteLength - 1] = message[message.byteLength - 1]! ^ 1;
    await expect(decodeComputerFrameMessage(message)).rejects.toThrow(
      "computer frame digest does not match image",
    );
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lifecycleOperation(
  operationId: string,
  kind: "create" | "resume" | "suspend",
): {
  operationId: string;
  resourceKind: "browser_session";
  resourceId: string;
  kind: "create" | "resume" | "suspend";
  state: "completed";
  replayed: false;
  error: null;
  createdAt: string;
  dispatchedAt: string;
  settledAt: string;
} {
  const now = "2026-08-09T10:00:00.000Z";
  return {
    operationId,
    resourceKind: "browser_session",
    resourceId: BROWSER_SESSION_ID,
    kind,
    state: "completed",
    replayed: false,
    error: null,
    createdAt: now,
    dispatchedAt: now,
    settledAt: now,
  };
}

function browserIdentity(): BrowserIdentity {
  return {
    id: BROWSER_IDENTITY_ID,
    accountId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE_ID,
    name: "Signed in work",
    status: "active",
    defaultRevisionId: null,
    headGeneration: 0,
    revisionCount: 0,
    createdBySubjectId: "user:1",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };
}

function browserRevision(): BrowserRevision {
  return {
    id: BROWSER_REVISION_ID,
    accountId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE_ID,
    identityId: BROWSER_IDENTITY_ID,
    parentRevisionId: null,
    ordinal: 1,
    sourceBrowserSessionId: BROWSER_SESSION_ID,
    manifestDigest: "a".repeat(64),
    components: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        kind: "chromium_profile",
        format: "opengeni.chromium-profile.v1+gzip+aes-256-gcm",
        artifactDigest: "b".repeat(64),
        sizeBytes: 1_024,
        materialization: {
          portability: "portable",
          reason: null,
          platform: "linux",
          architecture: "x64",
          engine: "chromium",
          engineVersion: "151",
          driverId: "opengeni.cdp.v1",
          driverSchemaVersion: 1,
          profileCrypto: "chromium_basic",
          providerId: null,
          placement: null,
        },
      },
    ],
    createdBySubjectId: "user:1",
    createdAt: "2026-08-09T10:01:00.000Z",
  };
}
