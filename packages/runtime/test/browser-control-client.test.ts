import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  type BrowserObservation,
  type BrowserTarget,
  type ComputerActionReceipt,
  type ComputerObservation,
  type ComputerTarget,
} from "@opengeni/contracts";
import {
  BrowserControlClient,
  BrowserControlProtocolError,
  BrowserControlRequestError,
  BrowserControlTransportError,
  BrowserControlUnsupportedError,
  provisionBrowserControlClient,
  type BrowserControlPlacementSession,
} from "../src/sandbox/browser-control-client";

const adminToken = `admin.${"a".repeat(48)}`;
const controlToken = `control.${"c".repeat(48)}`;
const viewToken = `view.${"v".repeat(48)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("BrowserControlClient", () => {
  test("uses a cached controller endpoint without requiring provider exec", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe(`Bearer ${adminToken}`);
        return success({ origins: ["https://app.opengeni.test"] });
      },
    });
    const session: BrowserControlPlacementSession = {
      resolveExposedPort: async () => ({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        path: "/",
        query: "",
      }),
    };
    try {
      const client = new BrowserControlClient(session, { adminToken });
      expect(await client.addAllowedOrigins(["https://app.opengeni.test"])).toEqual([
        "https://app.opengeni.test",
      ]);
      await expect(provisionBrowserControlClient(session, { adminToken })).rejects.toBeInstanceOf(
        BrowserControlUnsupportedError,
      );
    } finally {
      server.stop(true);
    }
  });

  test("joins a prefixed provider proxy path and forwards non-Authorization headers", async () => {
    const sandboxId = randomUUID();
    const prefix = `/v1/sandboxes/${sandboxId}/proxy/7682`;
    let hostFetches = 0;
    const browserSessionId = randomUUID();
    const server = Bun.serve({
      port: 0,
      fetch() {
        hostFetches += 1;
        return success({ origins: ["https://app.opengeni.test"] });
      },
    });
    const session: BrowserControlPlacementSession = {
      resolveExposedPort: async () => ({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        path: prefix,
        query: "",
        headers: {
          "OPEN-SANDBOX-API-KEY": "preview-key",
          authorization: "Bearer must-not-win",
        },
      }),
    };
    try {
      const client = new BrowserControlClient(session, { adminToken });
      await expect(client.addAllowedOrigins(["https://app.opengeni.test"])).rejects.toBeInstanceOf(
        BrowserControlTransportError,
      );
      expect(hostFetches).toBe(0);
      expect(
        await client.frameStreamUrl({ browserSessionId, controllerGeneration: "g1" }, "target-1"),
      ).toBe(
        `ws://127.0.0.1:${server.port}${prefix}/v1/browser-sessions/${browserSessionId}/targets/target-1/frames`,
      );
      expect(
        await client.computerRfbStreamUrl(
          { computerSessionId: browserSessionId, controllerGeneration: "g1" },
          "screen-1",
        ),
      ).toBe(
        `ws://127.0.0.1:${server.port}${prefix}/v1/computer-sessions/${browserSessionId}/targets/screen-1/rfb`,
      );
    } finally {
      server.stop(true);
    }
  });

  test("uses in-box exec for prefixed proxy JSON instead of host-fetch", async () => {
    let hostFetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        hostFetches += 1;
        return success({ origins: ["https://app.opengeni.test"] });
      },
    });
    const session: BrowserControlPlacementSession = {
      resolveExposedPort: async () => ({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        path: `/v1/sandboxes/${randomUUID()}/proxy/7682`,
        query: "",
      }),
      exec: async () => {
        throw new Error("in-box curl path");
      },
    };
    try {
      const client = new BrowserControlClient(session, { adminToken });
      await expect(client.addAllowedOrigins(["https://app.opengeni.test"])).rejects.toThrow(
        "browser controller request transport failed",
      );
      expect(hostFetches).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("host-fetches JSON through an OSEP-0011 signed URI with the browserd Bearer", async () => {
    const prefix = "/sbx-1/7682/s6ph0/sigsigsig";
    let hostFetches = 0;
    let authorization: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        hostFetches += 1;
        authorization = request.headers.get("authorization");
        expect(new URL(request.url).pathname).toBe(`${prefix}/v1/origins`);
        return success({ origins: ["https://app.opengeni.test"] });
      },
    });
    const session: BrowserControlPlacementSession = {
      resolveExposedPort: async () => ({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        path: prefix,
        query: "",
      }),
      exec: async () => {
        throw new Error("must not fall back to in-box curl");
      },
    };
    try {
      const client = new BrowserControlClient(session, { adminToken });
      expect(await client.addAllowedOrigins(["https://app.opengeni.test"])).toEqual([
        "https://app.opengeni.test",
      ]);
      expect(hostFetches).toBe(1);
      expect(authorization).toBe(`Bearer ${adminToken}`);
    } finally {
      server.stop(true);
    }
  });

  test("signed Channel B never falls back to in-box curl when mint fails", async () => {
    let execCalls = 0;
    const session: BrowserControlPlacementSession = {
      requireHostFetchController: true,
      resolveExposedPort: async () => {
        throw new Error("getSignedEndpoint failed");
      },
      exec: async () => {
        execCalls += 1;
        throw new Error("must not fall back to in-box curl");
      },
    };
    const client = new BrowserControlClient(session, { adminToken });
    await expect(client.addAllowedOrigins(["https://app.opengeni.test"])).rejects.toBeInstanceOf(
      BrowserControlTransportError,
    );
    expect(execCalls).toBe(0);
  });

  test("signed Channel B never curls a lifecycle proxy URL", async () => {
    let execCalls = 0;
    const session: BrowserControlPlacementSession = {
      requireHostFetchController: true,
      resolveExposedPort: async () => ({
        host: "127.0.0.1",
        port: 18090,
        tls: false,
        path: `/v1/sandboxes/${randomUUID()}/proxy/7682`,
        query: "",
      }),
      exec: async () => {
        execCalls += 1;
        throw new Error("must not fall back to in-box curl");
      },
    };
    const client = new BrowserControlClient(session, { adminToken });
    await expect(client.addAllowedOrigins(["https://app.opengeni.test"])).rejects.toThrow(
      "signed Channel B cannot use the lifecycle proxy",
    );
    expect(execCalls).toBe(0);
  });

  test("serializes bounded remote-provider launch authority without returning it", async () => {
    const browserSessionId = randomUUID();
    const controllerGeneration = "provider-controller-1";
    let wire: Record<string, unknown> | null = null;
    const target = browserTarget(browserSessionId, controllerGeneration);
    const observation = browserObservation(target);
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        wire = (await request.json()) as Record<string, unknown>;
        return success({ browserSessionId, controllerGeneration, observation }, 201);
      },
    });
    const placement = await localPlacement({ placementPrivateWrites: true });
    try {
      const client = new BrowserControlClient(placement.session, {
        adminToken,
        port: server.port,
      });
      const created = await client.createSession({
        browserSessionId,
        controllerGeneration,
        tokenGeneration: 1,
        controlToken,
        viewToken,
        headed: false,
        transport: {
          kind: "external_provider",
          providerId: "browserbase",
          placementId: "default",
          authority: { apiKey: "browserbase-private-key" },
        },
        networkRoute: {
          routeId: "22222222-2222-4222-8222-222222222222",
          routeVersion: 4,
          authorityDigest: `ogr.${"m".repeat(43)}`,
          kind: "managed",
          consistency: {
            dns: "provider",
            expectedPublicIp: null,
            expectedRegion: "NO",
            locale: "nb-NO",
            timezone: "Europe/Oslo",
            geolocation: {
              latitude: 59.9139,
              longitude: 10.7522,
              accuracyMeters: 25,
            },
            webRtc: "disable_non_proxied_udp",
            stability: "session",
          },
          providerRoute: {
            providerId: "browserbase",
            routeId: "default",
            egressClass: "residential",
            region: "NO",
          },
        },
      });
      expect(wire).toMatchObject({
        transport: {
          kind: "external_provider",
          providerId: "browserbase",
          placementId: "default",
          authority: { apiKey: "browserbase-private-key" },
        },
        networkRoute: {
          routeVersion: 4,
          kind: "managed",
          consistency: { dns: "provider", expectedRegion: "NO" },
          providerRoute: {
            providerId: "browserbase",
            routeId: "default",
            egressClass: "residential",
            region: "NO",
          },
        },
      });
      expect(JSON.stringify(created)).not.toContain("browserbase-private-key");
    } finally {
      server.stop(true);
    }
  });

  test("drives the typed placement protocol without putting credentials in shell commands", async () => {
    const browserSessionId = randomUUID();
    const workspaceId = randomUUID();
    const stateOperationId = randomUUID();
    const workspaceFileOperationId = randomUUID();
    const workspaceFileId = randomUUID();
    const protectedAuthOperationId = randomUUID();
    const externalAuthOperationId = randomUUID();
    const authRunId = randomUUID();
    const controllerGeneration = "controller-1";
    const linkedComputerSessionId = randomUUID();
    const restoreKey = Buffer.alloc(32, 9);
    const restoreAad = Buffer.from("restore-authority", "utf8");
    let createRequest: Record<string, unknown> | null = null;
    const target = browserTarget(browserSessionId, controllerGeneration);
    const observation = browserObservation(target);
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${adminToken}` &&
          request.headers.get("authorization") !== `Bearer ${controlToken}` &&
          request.headers.get("authorization") !== `Bearer ${viewToken}`
        ) {
          return failure(401, "permission_denied", "no authority");
        }
        const url = new URL(request.url);
        if (url.pathname === "/v1/origins" && request.method === "PUT") {
          const body = (await request.json()) as { origins: string[] };
          return success({ origins: body.origins });
        }
        if (url.pathname === "/v1/browser-sessions" && request.method === "POST") {
          createRequest = (await request.json()) as Record<string, unknown>;
          return success({ browserSessionId, controllerGeneration, observation }, 201);
        }
        if (url.pathname.endsWith("/state-captures") && request.method === "POST") {
          const body = (await request.json()) as {
            operationId: string;
            objectKey: string;
          };
          return success({
            operationId: body.operationId,
            browserSessionId,
            controllerGeneration,
            objectKey: body.objectKey,
            format: BROWSER_PROFILE_ARTIFACT_FORMAT,
            artifactDigest: "a".repeat(64),
            contentDigest: "b".repeat(64),
            sizeBytes: 1_024,
            fileCount: 4,
            profileBytes: 512,
            manifest: {
              schemaVersion: 1,
              browserSessionId,
              controllerGeneration,
              capturedAt: "2026-08-10T12:00:00.000Z",
              engine: "chromium",
              engineVersion: "140.0.0.0",
              driverId: "opengeni.cdp.v1",
              driverSchemaVersion: 1,
              profileCrypto: "chromium_basic",
              platform: "linux",
              architecture: "x64",
              tabs: [{ url: "https://example.test/", selected: true }],
            },
          });
        }
        if (url.pathname.endsWith("/targets") && request.method === "GET") {
          return success([target]);
        }
        if (url.pathname.endsWith("/clipboard") && request.method === "GET") {
          return success({
            browserSessionId,
            controllerGeneration,
            revision: 1,
            text: "private browser clipboard",
            source: "copy",
            sourceTargetId: target.id,
            updatedAt: "2026-08-10T12:00:00.000Z",
          });
        }
        if (url.pathname.endsWith("/protected-auth-fills") && request.method === "POST") {
          const body = (await request.json()) as { operationId: string };
          return success({
            protocolVersion: 1,
            operationId: body.operationId,
            browserSessionId,
            controllerGeneration,
            targetId: target.id,
            state: "completed",
            dispatchedAt: "2026-08-10T12:00:00.000Z",
            settledAt: "2026-08-10T12:00:01.000Z",
            observation: { target, status: "submitted" },
            error: null,
          });
        }
        if (url.pathname.endsWith("/external-auth") && request.method === "POST") {
          const body = (await request.json()) as {
            operationId: string;
            authRunId: string;
          };
          expect(body).toMatchObject({
            operationId: externalAuthOperationId,
            authRunId,
          });
          return success({
            state: "needs_human",
            externalAction: {
              kind: "human",
              label: "Complete sign-in securely",
              expiresAt: null,
            },
            interactiveUrl: null,
            failureCode: null,
            profileLoaded: false,
          });
        }
        if (url.pathname.endsWith("/workspace-files") && request.method === "POST") {
          const body = (await request.json()) as {
            operationId: string;
            files: Array<{ fileId: string }>;
          };
          return success({
            operationId: body.operationId,
            fileIds: body.files.map((file) => file.fileId),
            replayed: false,
          });
        }
        if (
          url.pathname.endsWith(`/protected-auth-operations/${protectedAuthOperationId}`) &&
          request.method === "GET"
        ) {
          return success({
            protocolVersion: 1,
            operationId: protectedAuthOperationId,
            browserSessionId,
            controllerGeneration,
            targetId: target.id,
            state: "completed",
            dispatchedAt: "2026-08-10T12:00:00.000Z",
            settledAt: "2026-08-10T12:00:01.000Z",
            observation: { target, status: "submitted" },
            error: null,
          });
        }
        if (url.pathname === "/v1/failure") {
          return failure(409, "controller_stale", "controller moved");
        }
        if (url.pathname === "/v1/malformed") {
          return Response.json({ nope: true });
        }
        return failure(404, "resource_not_found", "missing");
      },
    });
    const placement = await localPlacement();
    try {
      const client = new BrowserControlClient(placement.session, {
        adminToken,
        port: server.port,
      });
      expect(await client.addAllowedOrigins(["https://app.opengeni.test/"])).toEqual([
        "https://app.opengeni.test",
      ]);
      const created = await client.createSession({
        browserSessionId,
        controllerGeneration,
        tokenGeneration: 1,
        controlToken,
        viewToken,
        headed: true,
        transport: { kind: "managed", engine: "chromium" },
        linkedComputer: {
          computerSessionId: linkedComputerSessionId,
          controllerGeneration: "computer-controller-1",
        },
        networkRoute: {
          routeId: randomUUID(),
          routeVersion: 3,
          authorityDigest: `ogr.${"r".repeat(43)}`,
          kind: "proxy",
          consistency: {
            dns: "proxy",
            expectedPublicIp: null,
            expectedRegion: "NO",
            locale: "nb-NO",
            timezone: "Europe/Oslo",
            geolocation: {
              latitude: 59.9139,
              longitude: 10.7522,
              accuracyMeters: 25,
            },
            webRtc: "disable_non_proxied_udp",
            stability: "session",
          },
          proxyUrl: "http://route-user:route-password@proxy.test:8443/",
        },
        initialUrl: "https://example.test/",
        restore: {
          objectKey: `workspaces/${workspaceId}/browser-state/revisions/${stateOperationId}/chromium-profile.ogbs`,
          format: BROWSER_PROFILE_ARTIFACT_FORMAT,
          artifactDigest: "a".repeat(64),
          contentDigest: "b".repeat(64),
          manifestDigest: "c".repeat(64),
          sizeBytes: 1_024,
          dataKey: restoreKey,
          aad: restoreAad,
          materialization: {
            portability: "portable",
            reason: null,
            platform: "linux",
            architecture: "x64",
            engine: "chromium",
            engineVersion: "140.0.0.0",
            driverId: "opengeni.cdp.v1",
            driverSchemaVersion: 1,
            profileCrypto: "chromium_basic",
            providerId: null,
            placement: null,
          },
          download: {
            url: "https://state.example.test/object?signature=read-private",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
      expect(created).toEqual({
        browserSessionId,
        controllerGeneration,
        observation,
      });
      expect(createRequest).toMatchObject({
        transport: { kind: "managed", engine: "chromium" },
        linkedComputer: {
          computerSessionId: linkedComputerSessionId,
          controllerGeneration: "computer-controller-1",
        },
        restore: {
          dataKeyBase64: restoreKey.toString("base64"),
          aadBase64: restoreAad.toString("base64"),
          manifestDigest: "c".repeat(64),
        },
        networkRoute: {
          routeVersion: 3,
          authorityDigest: `ogr.${"r".repeat(43)}`,
          kind: "proxy",
          proxyUrl: "http://route-user:route-password@proxy.test:8443/",
          consistency: {
            dns: "proxy",
            expectedRegion: "NO",
            locale: "nb-NO",
            timezone: "Europe/Oslo",
          },
        },
      });
      const stateKey = Buffer.alloc(32, 7);
      const stateAad = Buffer.from("state-aad", "utf8");
      const stateReceipt = await client.captureState({
        browserSessionId,
        controllerGeneration,
        operationId: stateOperationId,
        afterCapture: "restart",
        objectKey: `workspaces/${workspaceId}/browser-state/${stateOperationId}.ogbs`,
        dataKey: stateKey,
        aad: stateAad,
        upload: {
          url: "https://state.example.test/object?signature=private",
          requiredHeaders: {
            "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
          },
          expiresAt: "2026-08-10T12:05:00.000Z",
        },
      });
      expect(stateReceipt).toMatchObject({
        operationId: stateOperationId,
        browserSessionId,
        controllerGeneration,
        artifactDigest: "a".repeat(64),
      });
      const browserSession = client.sessionClient({
        reference: { browserSessionId, controllerGeneration },
        controlToken,
        viewToken,
      });
      expect(await browserSession.listTargets()).toEqual([target]);
      expect(await browserSession.readClipboard()).toMatchObject({
        browserSessionId,
        revision: 1,
        text: "private browser clipboard",
        source: "copy",
      });
      expect(
        await browserSession.stageWorkspaceFiles({
          operationId: workspaceFileOperationId,
          files: [
            {
              fileId: workspaceFileId,
              safeFilename: "fixture.txt",
              sizeBytes: 12,
              sha256: "d".repeat(64),
              download: {
                url: "https://files.example.test/object?signature=private",
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            },
          ],
        }),
      ).toEqual({
        operationId: workspaceFileOperationId,
        fileIds: [workspaceFileId],
        replayed: false,
      });
      const protectedAuthCommand = {
        protocolVersion: 1 as const,
        operationId: protectedAuthOperationId,
        browserSessionId,
        controllerGeneration,
        targetId: target.id,
        expectedTargetGeneration: target.targetGeneration,
        expectedDocumentGeneration: target.documentGeneration!,
        expectedFrameId: observation.frameId!,
        actor: { kind: "system" as const, subjectId: "credential-broker" },
        authorityId: "password-authority",
        credentialVersion: 1,
        allowedOrigins: ["https://example.test"],
        fields: [
          {
            fieldId: "password",
            locator: { kind: "css" as const, selector: "#password" },
            purpose: "password" as const,
            value: "placement-private-password",
          },
        ],
        submit: { type: "press" as const, key: "Enter" },
      };
      expect(await browserSession.protectedAuthFill(protectedAuthCommand)).toMatchObject({
        operationId: protectedAuthOperationId,
        state: "completed",
      });
      expect(await browserSession.protectedAuthReceipt(protectedAuthOperationId)).toMatchObject({
        operationId: protectedAuthOperationId,
        state: "completed",
      });
      expect(
        await browserSession.externalAuth({
          browserSessionId,
          controllerGeneration,
          operationId: externalAuthOperationId,
          authRunId,
          adapterId: "kernel",
          connectionId: "managed-auth-1",
          action: "start",
        }),
      ).toMatchObject({
        state: "needs_human",
        interactiveUrl: null,
      });
      expect(
        await client.frameStreamUrl({ browserSessionId, controllerGeneration }, target.id),
      ).toBe(
        `ws://127.0.0.1:${server.port}/v1/browser-sessions/${browserSessionId}/targets/${target.id}/frames?provider=fixture`,
      );
      expect(
        await client.frameStreamUrl({ browserSessionId, controllerGeneration }, target.id, {
          format: "jpeg",
          quality: 76,
          maxWidth: 1_280,
          maxHeight: 720,
          everyNthFrame: 2,
        }),
      ).toBe(
        `ws://127.0.0.1:${server.port}/v1/browser-sessions/${browserSessionId}/targets/${target.id}/frames?provider=fixture&format=jpeg&quality=76&maxWidth=1280&maxHeight=720&everyNthFrame=2`,
      );
      await expect(
        client.requestForSession({
          method: "GET",
          path: "/v1/failure",
          token: controlToken,
        }),
      ).rejects.toMatchObject<Partial<BrowserControlRequestError>>({
        name: "BrowserControlRequestError",
        status: 409,
        error: {
          code: "controller_stale",
          message: "controller moved",
          retryable: false,
        },
      });
      await expect(
        client.requestForSession({
          method: "GET",
          path: "/v1/malformed",
          token: controlToken,
        }),
      ).rejects.toBeInstanceOf(BrowserControlProtocolError);

      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
      expect(placement.commands.every((command) => !command.includes(controlToken))).toBe(true);
      expect(placement.commands.every((command) => !command.includes(viewToken))).toBe(true);
      expect(
        placement.commands.every((command) => !command.includes("placement-private-password")),
      ).toBe(true);
      expect(placement.commands.every((command) => !command.includes("route-password"))).toBe(true);
      expect(
        placement.commands.every((command) => !command.includes(restoreKey.toString("base64"))),
      ).toBe(true);
      expect(
        placement.commands.every((command) => !command.includes(restoreAad.toString("base64"))),
      ).toBe(true);
      expect(placement.writes.every((entry) => !entry.content.includes(adminToken))).toBe(true);
      expect(placement.writes.every((entry) => !entry.content.includes("route-password"))).toBe(
        true,
      );
      expect(placement.finalizations).toBe(0);
      for (const path of placement.writes.map((entry) => dirname(entry.path))) {
        if (!path.includes("opengeni-private/browser-control-client")) continue;
        await expect(stat(path)).rejects.toThrow();
      }
    } finally {
      server.stop(true);
    }
  });

  test("drives ComputerSessions through the same placement controller", async () => {
    const computerSessionId = randomUUID();
    const operationId = randomUUID();
    const controllerGeneration = "computer-controller-1";
    const target = computerTarget(computerSessionId, controllerGeneration);
    const observation = computerObservation(target);
    const receipt = computerReceipt(operationId, observation);
    const clipboard = {
      computerSessionId,
      controllerGeneration,
      text: "fixture clipboard",
      truncated: false,
      observedAt: "2026-08-10T12:00:00.000Z",
    };
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push({
          path: `${request.method} ${url.pathname}`,
          authorization: request.headers.get("authorization"),
        });
        if (url.pathname === "/v1/computer-sessions" && request.method === "POST") {
          return success(
            {
              computerSessionId,
              controllerGeneration,
              platform: "linux",
              adapter: "opengeni.linux.atspi-x11.v1",
              seatId: "seat-1",
              displayId: ":101",
              capabilities: computerCapabilities(),
              targets: [target],
            },
            201,
          );
        }
        if (url.pathname.endsWith("/view-grants") && request.method === "POST") {
          const body = (await request.json()) as {
            grantId: string;
            expiresAt: string;
          };
          return success(body, 201);
        }
        if (url.pathname.endsWith("/targets") && request.method === "GET") {
          return success([target]);
        }
        if (url.pathname.endsWith("/observation") && request.method === "GET") {
          return success(observation);
        }
        if (url.pathname.endsWith("/clipboard") && request.method === "GET") {
          return success(clipboard);
        }
        if (url.pathname.endsWith("/actions") && request.method === "POST") {
          return success(receipt);
        }
        if (url.pathname.endsWith(`/operations/${operationId}`) && request.method === "GET") {
          return success(receipt);
        }
        if (url.pathname.endsWith("/heartbeat") && request.method === "POST") {
          return success({ alive: true });
        }
        if (url.pathname.endsWith("/end") && request.method === "POST") {
          return success({ ended: true });
        }
        return failure(404, "resource_not_found", "missing");
      },
    });
    const placement = await localPlacement();
    try {
      const client = new BrowserControlClient(placement.session, {
        adminToken,
        port: server.port,
      });
      const reference = { computerSessionId, controllerGeneration };
      expect(
        await client.createComputerSession({
          ...reference,
          tokenGeneration: 1,
          controlToken,
          viewToken,
        }),
      ).toEqual({
        ...reference,
        platform: "linux",
        adapter: "opengeni.linux.atspi-x11.v1",
        seatId: "seat-1",
        displayId: ":101",
        capabilities: computerCapabilities(),
        targets: [target],
      });
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const grantId = randomUUID();
      expect(
        await client.createComputerViewGrant(reference, {
          grantId,
          token: viewToken,
          expiresAt,
        }),
      ).toEqual({ grantId, expiresAt });
      const session = client.computerSessionClient({
        reference,
        controlToken,
        viewToken,
      });
      expect(await session.listTargets()).toEqual([target]);
      expect(await session.observe(target.id)).toEqual(observation);
      expect(await session.readClipboard()).toEqual(clipboard);
      expect(
        await session.action({
          protocolVersion: 1,
          operationId,
          ...reference,
          targetId: target.id,
          expectedTargetGeneration: target.targetGeneration,
          expectedObservationId: null,
          expectedFrameId: null,
          actor: { kind: "human", subjectId: "user-1" },
          action: { type: "keyboard", action: "type", value: "hello" },
        }),
      ).toEqual(receipt);
      expect(await session.receipt(operationId)).toEqual(receipt);
      await session.heartbeat();
      expect(await client.computerFrameStreamUrl(reference, target.id)).toBe(
        `ws://127.0.0.1:${server.port}/v1/computer-sessions/${computerSessionId}/targets/${target.id}/frames?provider=fixture`,
      );
      expect(
        await client.computerFrameStreamUrl(reference, target.id, {
          format: "png",
          maxWidth: 640,
          maxHeight: 360,
          everyNthFrame: 3,
        }),
      ).toBe(
        `ws://127.0.0.1:${server.port}/v1/computer-sessions/${computerSessionId}/targets/${target.id}/frames?provider=fixture&format=png&maxWidth=640&maxHeight=360&everyNthFrame=3`,
      );
      await client.endComputerSession(reference, { removeState: true });

      expect(requests).toEqual(
        expect.arrayContaining([
          {
            path: "POST /v1/computer-sessions",
            authorization: `Bearer ${adminToken}`,
          },
          {
            path: `GET /v1/computer-sessions/${computerSessionId}/targets`,
            authorization: `Bearer ${viewToken}`,
          },
          {
            path: `GET /v1/computer-sessions/${computerSessionId}/clipboard`,
            authorization: `Bearer ${viewToken}`,
          },
          {
            path: `POST /v1/computer-sessions/${computerSessionId}/actions`,
            authorization: `Bearer ${controlToken}`,
          },
        ]),
      );
      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
      expect(placement.commands.every((command) => !command.includes(controlToken))).toBe(true);
      expect(placement.commands.every((command) => !command.includes(viewToken))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("atomically installs the placement credential before controller startup", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return failure(401, "permission_denied", "no authority");
        }
        const body = (await request.json()) as { origins: string[] };
        return success({ origins: body.origins });
      },
    });
    const placement = await localPlacement({ fakeControllerStartup: true });
    const root = join(placement.root, "authority");
    const tokenFile = join(root, "admin-token");
    try {
      const provisioned = await provisionBrowserControlClient(placement.session, {
        adminToken,
        adminTokenFile: tokenFile,
        allowedOrigins: ["https://app.opengeni.test"],
        port: server.port,
      });
      expect(provisioned.server.port).toBe(server.port);
      expect((await readFile(tokenFile, "utf8")).trim()).toBe(adminToken);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect(placement.commands.some((command) => command.includes("opengeni-browserd-up"))).toBe(
        true,
      );
      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
      expect(placement.finalizations).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a managed write is aborted and settled before cleanup can run", async () => {
    let execCalls = 0;
    let writeSettled = false;
    let lateWrite = false;
    let cleanupSawSettledWrite = false;
    const session: BrowserControlPlacementSession = {
      exec: async ({ cmd }) => {
        execCalls += 1;
        if (cmd.includes("rm -f")) cleanupSawSettledWrite = writeSettled;
        return { output: "OPENGENI_BROWSER_CONTROL_CLIENT_OK", exitCode: 0 };
      },
      writePlacementPrivate: async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            lateWrite = true;
          }, 120);
          const abort = (): void => {
            clearTimeout(timer);
            writeSettled = true;
            reject(signal?.reason ?? new Error("write aborted"));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
    };
    const startedAt = Date.now();
    await expect(
      provisionBrowserControlClient(session, {
        adminToken,
        timeoutMs: 10_000,
        deadlineAtMs: Date.now() + 40,
      }),
    ).rejects.toThrow("provisioning deadline was reached");
    await Bun.sleep(140);
    expect(execCalls).toBe(2);
    expect(writeSettled).toBe(true);
    expect(cleanupSawSettledWrite).toBe(true);
    expect(lateWrite).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("managed provisioning recomputes the remaining absolute budget for every command", async () => {
    const placement = await localPlacement({ fakeControllerStartup: true });
    const yields: number[] = [];
    const innerExec = placement.session.exec!;
    placement.session.exec = async (args) => {
      yields.push(args.yieldTimeMs ?? 0);
      await Bun.sleep(10);
      return await innerExec(args);
    };
    await provisionBrowserControlClient(placement.session, {
      adminToken,
      timeoutMs: 2_000,
      deadlineAtMs: Date.now() + 500,
    });
    expect(yields.length).toBeGreaterThanOrEqual(3);
    const workYields = yields.slice(0, -1);
    expect(workYields.at(-1)!).toBeLessThan(workYields[0]!);
    expect(workYields.every((value, index) => index === 0 || value <= workYields[index - 1]!)).toBe(
      true,
    );
    // Temporary-token cleanup owns a fresh reserve and therefore is not
    // constrained by the already-consumed work deadline.
    expect(yields.at(-1)!).toBeGreaterThan(workYields.at(-1)!);
  });

  test("cancellation aborts and settles native controller ensure", async () => {
    const cancellation = new AbortController();
    let ensureCalls = 0;
    let ensureSettled = false;
    let lateSidecar = false;
    const session: BrowserControlPlacementSession = {
      exec: async () => ({ output: "", exitCode: 0 }),
      writeFile: async () => {
        throw new Error("native provisioning must not write controller authority files");
      },
      ensureBrowserControl: async (_request, options) => {
        ensureCalls += 1;
        return await new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            lateSidecar = true;
          }, 120);
          const abort = (): void => {
            clearTimeout(timer);
            ensureSettled = true;
            reject(options?.signal?.reason ?? new Error("native ensure aborted"));
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    setTimeout(() => cancellation.abort(new Error("native provisioning cancelled")), 20);
    const startedAt = Date.now();
    await expect(
      provisionBrowserControlClient(session, {
        adminToken,
        timeoutMs: 10_000,
        deadlineAtMs: Date.now() + 5_000,
        signal: cancellation.signal,
        nativeAuthority: {
          scopeId: `workspace:attached:${randomUUID()}`,
          scopeGeneration: "connection-1",
        },
      }),
    ).rejects.toThrow("native provisioning cancelled");
    await Bun.sleep(140);
    expect(ensureCalls).toBe(1);
    expect(ensureSettled).toBe(true);
    expect(lateSidecar).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("uses the standard exec and writeStdin surface when writeFile is unavailable", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return failure(401, "permission_denied", "no authority");
        }
        const body = (await request.json()) as { origins: string[] };
        return success({ origins: body.origins });
      },
    });
    const placement = await localPlacement({
      confinePrivateReads: true,
      fakeControllerStartup: true,
      streamWrites: true,
    });
    const tokenFile = join(placement.root, "streamed-authority", "admin-token");
    try {
      await provisionBrowserControlClient(placement.session, {
        adminToken,
        adminTokenFile: tokenFile,
        allowedOrigins: ["https://app.opengeni.test"],
        port: server.port,
      });

      expect(placement.session.writeFile).toBeUndefined();
      expect((await readFile(tokenFile, "utf8")).trim()).toBe(adminToken);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect(placement.stdinWrites).toHaveLength(1);
      expect(
        placement.stdinWrites.some((value) =>
          Buffer.from(value, "base64").toString("utf8").includes(adminToken),
        ),
      ).toBe(true);
      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("falls back to streamed private writes for the Modal workspace-escape diagnostic", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return failure(401, "permission_denied", "no authority");
        }
        const body = (await request.json()) as { origins: string[] };
        return success({ origins: body.origins });
      },
    });
    const placement = await localPlacement({
      fakeControllerStartup: true,
      streamWrites: true,
    });
    placement.session.writeFile = async () => {
      throw new Error('Sandbox path "/tmp" escapes the workspace root.');
    };
    const tokenFile = join(placement.root, "modal-authority", "admin-token");
    try {
      await provisionBrowserControlClient(placement.session, {
        adminToken,
        adminTokenFile: tokenFile,
        allowedOrigins: ["https://app.opengeni.test"],
        port: server.port,
      });

      expect((await readFile(tokenFile, "utf8")).trim()).toBe(adminToken);
      expect(placement.stdinWrites).toHaveLength(1);
      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("uses the SDK execCommand banner and writeStdin surface when exec is unavailable", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return failure(401, "permission_denied", "no authority");
        }
        const body = (await request.json()) as { origins: string[] };
        return success({ origins: body.origins });
      },
    });
    const placement = await localPlacement({
      confinePrivateReads: true,
      fakeControllerStartup: true,
      streamWrites: true,
    });
    const exec = placement.session.exec!;
    const writeStdin = placement.session.writeStdin!;
    placement.session.execCommand = async (args) => execBanner(await exec(args));
    placement.session.writeStdin = async (args) =>
      execBanner({ output: await writeStdin(args), exitCode: 0 });
    delete placement.session.exec;
    const tokenFile = join(placement.root, "exec-command-authority", "admin-token");
    try {
      await provisionBrowserControlClient(placement.session, {
        adminToken,
        adminTokenFile: tokenFile,
        allowedOrigins: ["https://app.opengeni.test"],
        port: server.port,
      });

      expect(placement.session.exec).toBeUndefined();
      expect((await readFile(tokenFile, "utf8")).trim()).toBe(adminToken);
      expect(placement.stdinWrites).toHaveLength(1);
      expect(placement.commands.every((command) => !command.includes(adminToken))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("managed placement controller execs use the provider-valid workspace root", async () => {
    const workdirs: Array<string | undefined> = [];
    const placement = await localPlacement({ fakeControllerStartup: true });
    const inner = placement.session.exec!;
    placement.session.exec = async (args) => {
      workdirs.push(args.workdir);
      return inner(args);
    };
    await provisionBrowserControlClient(placement.session, {
      adminToken: `ogb_${"a".repeat(48)}`,
    });
    expect(workdirs.length).toBeGreaterThan(0);
    expect(workdirs.every((workdir) => workdir === "/workspace")).toBe(true);
  });

  test("connected placement controller execs retain the native tmp cwd", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${adminToken}`) {
          return failure(401, "permission_denied", "no authority");
        }
        const body = (await request.json()) as { origins: string[] };
        return success({ origins: body.origins });
      },
    });
    const workdirs: Array<string | undefined> = [];
    const placement = await localPlacement();
    const inner = placement.session.exec!;
    placement.session.exec = async (args) => {
      workdirs.push(args.workdir);
      return await inner(args);
    };
    placement.session.ensureBrowserControl = async () => ({
      port: server.port,
      sidecarGeneration: "native-sidecar-1",
    });
    try {
      const provisioned = await provisionBrowserControlClient(placement.session, {
        adminToken,
        nativeAuthority: {
          scopeId: `workspace:attached:${randomUUID()}`,
          scopeGeneration: "connection-1",
        },
      });
      expect(await provisioned.client.addAllowedOrigins(["https://app.opengeni.test"])).toEqual([
        "https://app.opengeni.test",
      ]);
      expect(workdirs.length).toBeGreaterThan(0);
      expect(workdirs.every((workdir) => workdir === "/tmp")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("uses agent-supervised sidecar and typed browser relay on connected machines", async () => {
    const ensured: unknown[] = [];
    const opened: unknown[] = [];
    const openedComputers: unknown[] = [];
    const session: BrowserControlPlacementSession = {
      async exec() {
        throw new Error("native provisioning must not shell out");
      },
      async writeFile() {
        throw new Error("native provisioning must not install credentials through files");
      },
      async ensureBrowserControl(request) {
        ensured.push(request);
        return { port: 31_337, sidecarGeneration: "sidecar-1" };
      },
      async openBrowserFrames(request) {
        opened.push(request);
        return {
          channel: {
            channelId: "browser-channel-1",
            workspaceId: "11111111-1111-1111-1111-111111111111",
            agentId: "agent-1",
            kind: 3,
            port: 20_001,
          },
          endpoint: {
            host: "relay.example.test",
            port: 443,
            tls: true,
            path: "/stream",
            query: "ws=1&agent=agent-1&port=20001&channel=browser-channel-1",
          },
        };
      },
      async openComputerFrames(request) {
        openedComputers.push(request);
        return {
          channel: {
            channelId: "computer-channel-1",
            workspaceId: "11111111-1111-1111-1111-111111111111",
            agentId: "agent-1",
            kind: 3,
            port: 20_002,
          },
          endpoint: {
            host: "relay.example.test",
            port: 443,
            tls: true,
            path: "/stream",
            query: "ws=1&agent=agent-1&port=20002&channel=computer-channel-1",
          },
        };
      },
    };
    const nativeAuthority = {
      scopeId: "workspace:attached:device-1",
      scopeGeneration: "connection-1",
    };
    const provisioned = await provisionBrowserControlClient(session, {
      adminToken,
      nativeAuthority,
      allowedOrigins: ["https://app.opengeni.test"],
    });
    expect(provisioned.server).toEqual({
      port: 31_337,
      marker: "agent:sidecar-1",
    });
    expect(ensured).toEqual([
      {
        ...nativeAuthority,
        adminToken,
        allowedOrigins: ["https://app.opengeni.test"],
      },
    ]);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const relay = await provisioned.client.openRelayedFrameStream({
      reference: {
        browserSessionId: randomUUID(),
        controllerGeneration: "controller-1",
      },
      targetId: "target-1",
      viewToken,
      expiresAt,
      stream: { quality: 55, everyNthFrame: 2 },
    });
    expect(relay?.channel).toMatchObject({
      channelId: "browser-channel-1",
      kind: 3,
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      ...nativeAuthority,
      targetId: "target-1",
      viewToken,
      format: "jpeg",
      quality: 55,
      maxWidth: 1_440,
      maxHeight: 900,
      everyNthFrame: 2,
    });

    const computerSessionId = randomUUID();
    const computerRelay = await provisioned.client.openRelayedComputerFrameStream({
      reference: { computerSessionId, controllerGeneration: "controller-2" },
      targetId: "window-1",
      viewToken,
      expiresAt,
      stream: { format: "png", maxWidth: 1_200 },
    });
    expect(computerRelay?.channel).toMatchObject({
      channelId: "computer-channel-1",
      kind: 3,
    });
    expect(openedComputers).toEqual([
      expect.objectContaining({
        ...nativeAuthority,
        computerSessionId,
        controllerGeneration: "controller-2",
        targetId: "window-1",
        viewToken,
        format: "png",
        quality: 70,
        maxWidth: 1_200,
        maxHeight: 4_096,
        everyNthFrame: 1,
      }),
    ]);
  });
});

function execBanner(result: {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
}): string {
  const output =
    result.output ??
    [result.stdout, result.stderr]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  return [
    "Chunk ID: fixture",
    result.sessionId === undefined
      ? `Process exited with code ${result.exitCode ?? 0}`
      : `Process running with session ID ${result.sessionId}`,
    "Wall time: 0.1 seconds",
    "Process output:",
    "Output:",
    output,
  ].join("\n");
}

async function localPlacement(
  options: {
    confinePrivateReads?: boolean;
    fakeControllerStartup?: boolean;
    placementPrivateWrites?: boolean;
    streamWrites?: boolean;
  } = {},
): Promise<{
  root: string;
  session: BrowserControlPlacementSession;
  commands: string[];
  writes: Array<{ path: string; content: string }>;
  stdinWrites: string[];
  finalizations: number;
}> {
  const root = `/tmp/og-browser-client-test-${randomUUID()}`;
  roots.push(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fixture = {
    root,
    commands: [] as string[],
    writes: [] as Array<{ path: string; content: string }>,
    stdinWrites: [] as string[],
    finalizations: 0,
    session: {} as BrowserControlPlacementSession,
  };
  let nextStreamId = 1;
  const streams = new Map<number, ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>>();
  fixture.session = {
    async exec({ cmd }) {
      fixture.commands.push(cmd);
      if (options.fakeControllerStartup && cmd.includes("opengeni-browserd-up")) {
        return {
          output: "OPENGENI_BROWSERD_UP port=fixture",
          stdout: "OPENGENI_BROWSERD_UP port=fixture",
          stderr: "",
          exitCode: 0,
        };
      }
      const child = Bun.spawn(["bash", "-lc", cmd], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (options.streamWrites && cmd.includes("dd bs=1 count=")) {
        const sessionId = nextStreamId++;
        streams.set(sessionId, child);
        return { output: "", stdout: "", stderr: "", sessionId };
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { output: `${stdout}${stderr}`, stdout, stderr, exitCode };
    },
    ...(options.streamWrites
      ? {
          async writeStdin({ sessionId, chars = "" }) {
            const child = streams.get(sessionId);
            if (!child) return `write_stdin failed: session not found: ${sessionId}`;
            fixture.stdinWrites.push(chars);
            child.stdin.write(chars);
            await child.stdin.flush();
            const [stdout, stderr] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ]);
            streams.delete(sessionId);
            return `${stdout}${stderr}`;
          },
        }
      : {
          async writeFile({ path, content, createParents }) {
            if (createParents) await mkdir(dirname(path), { recursive: true });
            const value = typeof content === "string" ? content : new TextDecoder().decode(content);
            fixture.writes.push({ path, content: value });
            await writeFile(path, content);
            return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
          },
        }),
    ...(options.placementPrivateWrites
      ? {
          async writePlacementPrivate({ path, content, createParents }) {
            if (!path.startsWith("/tmp/opengeni-private/")) {
              throw new TypeError("placement-private path is invalid");
            }
            if (createParents) await mkdir(dirname(path), { recursive: true });
            const value = typeof content === "string" ? content : new TextDecoder().decode(content);
            fixture.writes.push({ path, content: value });
            await writeFile(path, content, { mode: 0o600 });
            return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
          },
        }
      : {}),
    async readFile({ path, maxBytes }) {
      if (options.confinePrivateReads && path.includes("opengeni-private/browser-control-client")) {
        throw new Error("fixture confines native reads to its workspace");
      }
      const value = await readFile(path);
      return maxBytes === undefined ? value : value.subarray(0, maxBytes);
    },
    async resolveExposedPort(port) {
      return { host: "127.0.0.1", port, path: "/", query: "provider=fixture" };
    },
    async finalizeOpStreamOps() {
      fixture.finalizations += 1;
    },
  };
  return fixture;
}

function browserTarget(browserSessionId: string, controllerGeneration: string): BrowserTarget {
  return {
    id: "target-1",
    browserSessionId,
    controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    kind: "page",
    title: "Fixture",
    url: "https://example.test/",
    selected: true,
    attached: true,
    createdAt: "2026-08-09T12:00:00.000Z",
  };
}

function browserObservation(target: BrowserTarget): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: "observation-1",
    browserSessionId: target.browserSessionId,
    target,
    frameId: "frame-1",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: "2026-08-09T12:00:00.000Z",
  };
}

function computerCapabilities() {
  return {
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
  } as const;
}

function computerTarget(computerSessionId: string, controllerGeneration: string): ComputerTarget {
  return {
    id: "window-1",
    computerSessionId,
    controllerGeneration,
    targetGeneration: "target-generation-1",
    kind: "window",
    applicationId: "org.opengeni.Fixture",
    processId: 42,
    title: "Fixture",
    bounds: { x: 10, y: 20, width: 640, height: 480 },
    focused: true,
  };
}

function computerObservation(target: ComputerTarget): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId: "computer-observation-1",
    computerSessionId: target.computerSessionId,
    target,
    frameId: "computer-frame-1",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    observedAt: "2026-08-10T12:00:00.000Z",
  };
}

function computerReceipt(
  operationId: string,
  observation: ComputerObservation,
): ComputerActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    computerSessionId: observation.computerSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    state: "completed",
    dispatchedAt: "2026-08-10T12:00:00.000Z",
    settledAt: "2026-08-10T12:00:01.000Z",
    observation,
    error: null,
  };
}

function success(data: unknown, status = 200): Response {
  return Response.json(
    { protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION, ok: true, data },
    { status },
  );
}

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    {
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      ok: false,
      error: { code, message, retryable: false },
    },
    { status },
  );
}
