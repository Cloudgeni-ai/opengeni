import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  BrowserTarget,
} from "@opengeni/contracts";
import {
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  BrowserControlServer,
  BrowserSupervisor,
  ComputerSupervisor,
  LatestBrowserFrameSubscription,
  decodeBrowserFrameMessage,
  decodeBrowserFrameMetadataHeader,
  type BrowserImageFrame,
  type BrowserStateUploadAuthority,
  type BrowserSupervisorDriver,
  type BrowserSupervisorDriverContext,
  type BrowserSupervisorOptions,
} from "../src";

const adminToken = `admin.${"a".repeat(48)}`;
const controlToken = `control.${"c".repeat(48)}`;
const viewToken = `view.${"v".repeat(48)}`;
const rotatedControlToken = `control.${"d".repeat(48)}`;
const rotatedViewToken = `view.${"w".repeat(48)}`;
const grantedViewToken = `grant.${"g".repeat(48)}`;
const allowedOrigin = "https://app.opengeni.test";

describe("BrowserControlServer", () => {
  test("delivers the exact private network route only to the browser supervisor", async () => {
    let browserContext: BrowserSupervisorDriverContext | null = null;
    await withServer(
      async ({ server, reference }) => {
        const route = proxyRoute();
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference, { networkRoute: route }),
        });
        expect(created.status).toBe(201);
        expect(browserContext?.networkRoute).toEqual(route);
        expect(await created.text()).not.toContain("proxy-password");
      },
      {
        onBrowserContext: (context) => {
          browserContext = context;
        },
      },
    );
  });

  test("preserves the exact managed browser engine at the controller boundary", async () => {
    let browserContext: BrowserSupervisorDriverContext | null = null;
    await withServer(
      async ({ server, reference }) => {
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference, {
            transport: { kind: "managed", engine: "lightpanda" },
          }),
        });
        expect(created.status).toBe(201);
        expect(browserContext?.transport).toEqual({ kind: "managed", engine: "lightpanda" });
      },
      {
        onBrowserContext: (context) => {
          browserContext = context;
        },
      },
    );
  });

  test("delivers remote-provider authority only to the browser supervisor", async () => {
    let browserContext: BrowserSupervisorDriverContext | null = null;
    await withServer(
      async ({ server, reference }) => {
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference, {
            transport: {
              kind: "external_provider",
              providerId: "kernel",
              placementId: "default",
              authority: {
                apiKey: "kernel-private-key",
                endpoint: "https://kernel.example.test",
              },
              timeoutSeconds: 7_200,
              stealth: true,
            },
          }),
        });
        expect(created.status).toBe(201);
        expect(browserContext?.transport).toMatchObject({
          kind: "external_provider",
          providerId: "kernel",
          placementId: "default",
          authority: {
            apiKey: "kernel-private-key",
            endpoint: "https://kernel.example.test",
          },
          timeoutSeconds: 7_200,
          stealth: true,
        });
        expect(await created.text()).not.toContain("kernel-private-key");
      },
      {
        onBrowserContext: (context) => {
          browserContext = context;
        },
      },
    );
  });

  test("delivers one provider-managed route beside private provider authority", async () => {
    let browserContext: BrowserSupervisorDriverContext | null = null;
    await withServer(
      async ({ server, reference }) => {
        const route = managedRoute();
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference, {
            transport: {
              kind: "external_provider",
              providerId: "kernel",
              placementId: "default",
              authority: { apiKey: "kernel-private-key" },
            },
            networkRoute: route,
          }),
        });
        expect(created.status).toBe(201);
        expect(browserContext?.networkRoute).toEqual(route);
        expect(await created.text()).not.toContain("kernel-private-key");
      },
      {
        onBrowserContext: (context) => {
          browserContext = context;
        },
      },
    );
  });

  test("resolves a linked ComputerSession into the browser launch environment", async () => {
    const computerSessionId = randomUUID();
    let browserContext: BrowserSupervisorDriverContext | null = null;
    await withServer(
      async ({ server, reference }) => {
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference, {
            headed: true,
            linkedComputer: {
              computerSessionId,
              controllerGeneration: "computer-controller-1",
            },
          }),
        });
        expect(created.status).toBe(201);
        expect(browserContext?.launchEnvironment).toMatchObject({
          DISPLAY: ":101",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/computer-bus",
        });
      },
      {
        linkedComputer: {
          computerSessionId,
          controllerGeneration: "computer-controller-1",
          environment: {
            DISPLAY: ":101",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/computer-bus",
          },
        },
        onBrowserContext: (context) => {
          browserContext = context;
        },
      },
    );
  });

  test("enforces admin/control/view authority, origin policy, and monotonic rotation", async () => {
    await withServer(async ({ server, reference }) => {
      expect(
        (
          await request(server, "/v1/browser-sessions", {
            method: "POST",
            body: createBody(reference),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server, "/v1/browser-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
            origin: "https://evil.test",
          })
        ).status,
      ).toBe(403);
      const preflight = await fetch(`${server.url}/v1/browser-sessions`, {
        method: "OPTIONS",
        headers: {
          origin: allowedOrigin,
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const created = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        origin: allowedOrigin,
        body: createBody(reference),
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      const createdBody = await json(created);
      const observation = createdBody.data.observation as BrowserObservation;

      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: viewToken,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/actions`, {
            method: "POST",
            token: viewToken,
            body: command(observation),
          })
        ).status,
      ).toBe(401);
      const acted = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/actions`,
        { method: "POST", token: controlToken, body: command(observation) },
      );
      expect(acted.status).toBe(200);
      expect((await json(acted)).data.state).toBe("completed");

      const protectedCommand = protectedAuthCommand(observation);
      const protectedPath = `/v1/browser-sessions/${reference.browserSessionId}/protected-auth-fills`;
      expect(
        (
          await request(server, protectedPath, {
            method: "POST",
            token: viewToken,
            body: protectedCommand,
          })
        ).status,
      ).toBe(401);
      const protectedFill = await request(server, protectedPath, {
        method: "POST",
        token: controlToken,
        body: protectedCommand,
      });
      expect(protectedFill.status).toBe(200);
      const protectedBody = await protectedFill.text();
      expect(protectedBody).not.toContain("server-test-password");
      expect(JSON.parse(protectedBody).data.state).toBe("completed");
      const protectedReceiptPath = `/v1/browser-sessions/${reference.browserSessionId}/protected-auth-operations/${protectedCommand.operationId}`;
      expect((await request(server, protectedReceiptPath, { token: viewToken })).status).toBe(401);
      expect((await request(server, protectedReceiptPath, { token: controlToken })).status).toBe(
        200,
      );

      const externalAuthPath = `/v1/browser-sessions/${reference.browserSessionId}/external-auth`;
      const externalAuthCommand = {
        browserSessionId: reference.browserSessionId,
        controllerGeneration: reference.controllerGeneration,
        operationId: randomUUID(),
        authRunId: randomUUID(),
        adapterId: "kernel",
        connectionId: "managed-auth-1",
        action: "start",
      };
      expect(
        (
          await request(server, externalAuthPath, {
            method: "POST",
            token: viewToken,
            body: externalAuthCommand,
          })
        ).status,
      ).toBe(401);
      const externalAuth = await request(server, externalAuthPath, {
        method: "POST",
        token: controlToken,
        body: externalAuthCommand,
      });
      expect(externalAuth.status).toBe(200);
      expect((await json(externalAuth)).data).toMatchObject({
        state: "needs_human",
        interactiveUrl: null,
      });

      const clipboard = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/clipboard`,
        { token: viewToken },
      );
      expect(clipboard.status).toBe(200);
      expect((await json(clipboard)).data).toEqual({
        browserSessionId: reference.browserSessionId,
        controllerGeneration: reference.controllerGeneration,
        revision: 0,
        text: "",
        source: "empty",
        sourceTargetId: null,
        updatedAt: null,
      });

      const screenshot = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/screenshot`,
        { token: viewToken },
      );
      expect(screenshot.status).toBe(200);
      expect(screenshot.headers.get("content-type")).toBe("image/png");
      expect(
        decodeBrowserFrameMetadataHeader(screenshot.headers.get("x-opengeni-browser-frame")!),
      ).toMatchObject({
        browserSessionId: reference.browserSessionId,
        targetId: observation.target.id,
      });
      expect([...new Uint8Array(await screenshot.arrayBuffer())]).toEqual([...png()]);

      const conflicting = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference, {
          controlToken: rotatedControlToken,
          viewToken: rotatedViewToken,
        }),
      });
      expect(conflicting.status).toBe(409);
      const rotated = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference, {
          tokenGeneration: 2,
          controlToken: rotatedControlToken,
          viewToken: rotatedViewToken,
        }),
      });
      expect(rotated.status).toBe(200);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: viewToken,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: rotatedViewToken,
          })
        ).status,
      ).toBe(200);

      const ended = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/end`,
        {
          method: "POST",
          token: adminToken,
          body: {
            controllerGeneration: reference.controllerGeneration,
            removeState: true,
          },
        },
      );
      expect(ended.status).toBe(200);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: rotatedViewToken,
          })
        ).status,
      ).toBe(401);
    });
  });

  test("stages workspace files through control authority without exposing signed URLs", async () => {
    const bytes = Buffer.from("private workspace bytes", "utf8");
    const fileServer = Bun.serve({ port: 0, fetch: () => new Response(bytes) });
    let browserContext: BrowserSupervisorDriverContext | null = null;
    try {
      await withServer(
        async ({ server, reference }) => {
          const created = await request(server, "/v1/browser-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference),
          });
          expect(created.status).toBe(201);
          const observation = (await json(created)).data.observation as BrowserObservation;
          const operationId = randomUUID();
          const fileId = randomUUID();
          const authority = {
            operationId,
            files: [
              {
                fileId,
                safeFilename: "fixture.txt",
                sizeBytes: bytes.byteLength,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                download: {
                  url: `${fileServer.url}/file?signature=private`,
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              },
            ],
          };
          const path = `/v1/browser-sessions/${reference.browserSessionId}/operations/${operationId}/workspace-files`;
          expect(
            (
              await request(server, path, {
                method: "POST",
                token: viewToken,
                body: authority,
              })
            ).status,
          ).toBe(401);
          const staged = await request(server, path, {
            method: "POST",
            token: controlToken,
            body: authority,
          });
          expect(staged.status).toBe(200);
          const response = await staged.text();
          expect(response).not.toContain("signature");
          expect(JSON.parse(response).data).toMatchObject({
            operationId,
            fileIds: [fileId],
            replayed: false,
          });
          const resolved = await browserContext!.resolveWorkspaceFiles(operationId, [fileId]);
          expect(await readFile(resolved[0]!)).toEqual(bytes);
          const stale = await request(
            server,
            `/v1/browser-sessions/${reference.browserSessionId}/actions`,
            {
              method: "POST",
              token: controlToken,
              body: {
                ...command(observation),
                operationId,
                expectedTargetGeneration: "stale",
                action: {
                  type: "upload",
                  locator: { kind: "css", selector: "#file" },
                  workspaceFileIds: [fileId],
                },
              },
            },
          );
          expect((await json(stale)).data).toMatchObject({
            state: "failed",
            dispatchedAt: null,
            error: { code: "target_stale" },
          });
          expect(await browserContext!.resolveWorkspaceFiles(operationId, [fileId])).toEqual([]);
        },
        {
          onBrowserContext: (context) => {
            browserContext = context;
          },
        },
      );
    } finally {
      fileServer.stop(true);
    }
  });

  test("projects exact managed downloads through view authority without leaking placement paths", async () => {
    let browserContext: BrowserSupervisorDriverContext | null = null;
    const uploadAuthorities: string[] = [];
    await withServer(
      async ({ server, reference }) => {
        const created = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference),
        });
        expect(created.status).toBe(201);
        const download = await browserContext!.downloadEvents!.begin({
          guid: "server-download-guid",
          targetId: null,
          suggestedFilename: "fixture.pdf",
        });
        await writeFile(join(browserContext!.downloadDirectory, "server-download-guid"), "pdf");
        await browserContext!.downloadEvents!.progress({
          guid: "server-download-guid",
          state: "completed",
          receivedBytes: 3,
          totalBytes: 3,
        });

        const path = `/v1/browser-sessions/${reference.browserSessionId}/downloads`;
        expect((await request(server, path)).status).toBe(401);
        const listed = await request(server, path, { token: viewToken });
        expect(listed.status).toBe(200);
        const listedText = await listed.text();
        expect(listedText).not.toContain(browserContext!.downloadDirectory);
        expect(JSON.parse(listedText).data.downloads).toEqual([
          expect.objectContaining({
            id: download.id,
            filename: "fixture.pdf",
            status: "completed",
            receivedBytes: 3,
          }),
        ]);

        const fetched = await request(server, `${path}/${download.id}`, { token: viewToken });
        expect(fetched.status).toBe(200);
        expect((await json(fetched)).data).toMatchObject({
          id: download.id,
          browserSessionId: reference.browserSessionId,
          status: "completed",
        });

        const operationId = randomUUID();
        const exportPath = `${path}/${download.id}/exports`;
        const exportRequest = {
          operationId,
          downloadId: download.id,
          upload: {
            url: "https://storage.test/file?signature=private-export",
            requiredHeaders: { "content-type": "application/octet-stream" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
        expect(
          (
            await request(server, exportPath, {
              method: "POST",
              token: viewToken,
              body: exportRequest,
            })
          ).status,
        ).toBe(401);
        const exported = await request(server, exportPath, {
          method: "POST",
          token: controlToken,
          body: exportRequest,
        });
        expect(exported.status).toBe(200);
        const exportText = await exported.text();
        expect(exportText).not.toContain("private-export");
        expect(JSON.parse(exportText).data).toMatchObject({
          operationId,
          downloadId: download.id,
          sizeBytes: 3,
          replayed: false,
        });
        expect(uploadAuthorities).toEqual([exportRequest.upload.url]);
      },
      {
        onBrowserContext: (context) => {
          browserContext = context;
        },
        uploadDownload: async (path, authority, expected) => {
          expect(await readFile(path, "utf8")).toBe("pdf");
          expect(expected.sizeBytes).toBe(3);
          uploadAuthorities.push(authority.url);
        },
      },
    );
  });

  test("enrolls exact browser origins monotonically through admin authority", async () => {
    await withServer(
      async ({ server }) => {
        expect((await request(server, "/healthz", { origin: allowedOrigin })).status).toBe(403);
        const enrolled = await request(server, "/v1/origins", {
          method: "PUT",
          token: adminToken,
          body: { origins: [allowedOrigin, `${allowedOrigin}/`] },
        });
        expect(enrolled.status).toBe(200);
        expect((await json(enrolled)).data.origins).toEqual([allowedOrigin]);

        const health = await request(server, "/healthz", {
          origin: allowedOrigin,
        });
        expect(health.status).toBe(200);
        expect(health.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
        expect(
          (
            await request(server, "/v1/origins", {
              method: "PUT",
              token: adminToken,
              body: { origins: ["https://app.opengeni.test/path"] },
            })
          ).status,
        ).toBe(400);

        const capacity = await request(server, "/v1/origins", {
          method: "PUT",
          token: adminToken,
          body: {
            origins: Array.from({ length: 64 }, (_, index) => `https://origin-${index}.test`),
          },
        });
        expect(capacity.status).toBe(503);
        expect(
          (await json(await request(server, "/v1/origins", { token: adminToken }))).data.origins,
        ).toEqual([allowedOrigin]);
      },
      { allowedOrigins: [] },
    );
  });

  test("uses bounded expiring grants for browser frame viewers", async () => {
    await withServer(async ({ server, reference }) => {
      const created = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference),
      });
      const observation = (await json(created)).data.observation as BrowserObservation;
      const grantId = randomUUID();
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      const grantBody = {
        grantId,
        controllerGeneration: reference.controllerGeneration,
        token: grantedViewToken,
        expiresAt,
      };
      const granted = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/view-grants`,
        { method: "POST", token: adminToken, body: grantBody },
      );
      expect(granted.status).toBe(201);
      expect((await json(granted)).data).toEqual({ grantId, expiresAt });
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: grantedViewToken,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/actions`, {
            method: "POST",
            token: grantedViewToken,
            body: command(observation),
          })
        ).status,
      ).toBe(401);

      const websocket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/frames`,
        [
          BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${grantedViewToken}`,
        ],
      );
      websocket.binaryType = "arraybuffer";
      await websocketMessage(websocket);
      expect((await websocketClosed(websocket)).code).toBe(1008);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: grantedViewToken,
          })
        ).status,
      ).toBe(401);

      const tooLong = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/view-grants`,
        {
          method: "POST",
          token: adminToken,
          body: {
            ...grantBody,
            grantId: randomUUID(),
            expiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
          },
        },
      );
      expect(tooLong.status).toBe(400);
    });
  });

  test("streams bounded binary frames and revokes an established viewer on rotation", async () => {
    await withServer(async ({ server, reference }) => {
      const created = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference),
      });
      const observation = (await json(created)).data.observation as BrowserObservation;
      const websocket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/frames`,
        [
          BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${viewToken}`,
        ],
      );
      websocket.binaryType = "arraybuffer";
      const message = await websocketMessage(websocket);
      expect(websocket.protocol).toBe(BROWSER_CONTROL_WEBSOCKET_PROTOCOL);
      expect(decodeBrowserFrameMessage(new Uint8Array(message))).toMatchObject({
        browserSessionId: reference.browserSessionId,
        targetId: observation.target.id,
        sequence: 1,
      });
      const closed = websocketClosed(websocket);
      expect(
        (
          await request(server, "/v1/browser-sessions", {
            method: "POST",
            token: adminToken,
            body: createBody(reference, {
              tokenGeneration: 2,
              controlToken: rotatedControlToken,
              viewToken: rotatedViewToken,
            }),
          })
        ).status,
      ).toBe(200);
      expect((await closed).code).toBe(1008);
      await server.stop();
      await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
    });
  });

  test("a stale lifecycle request cannot disrupt the active session or its viewers", async () => {
    await withServer(async ({ server, reference }) => {
      const created = await request(server, "/v1/browser-sessions", {
        method: "POST",
        token: adminToken,
        body: createBody(reference),
      });
      const observation = (await json(created)).data.observation as BrowserObservation;
      const websocket = new WebSocket(
        `${server.url.replace("http:", "ws:")}/v1/browser-sessions/${reference.browserSessionId}/targets/${encodeURIComponent(observation.target.id)}/frames`,
        [
          BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
          `${BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX}${viewToken}`,
        ],
      );
      websocket.binaryType = "arraybuffer";
      await websocketMessage(websocket);

      const stale = await request(
        server,
        `/v1/browser-sessions/${reference.browserSessionId}/end`,
        {
          method: "POST",
          token: adminToken,
          body: { controllerGeneration: "controller-stale", removeState: true },
        },
      );
      expect(stale.status).toBe(409);
      expect(websocket.readyState).toBe(WebSocket.OPEN);
      expect(
        (
          await request(server, `/v1/browser-sessions/${reference.browserSessionId}/targets`, {
            token: viewToken,
          })
        ).status,
      ).toBe(200);
      websocket.close(1000, "done");
      await websocketClosed(websocket);
    });
  });

  test("keeps encrypted state capture behind exact admin authority and replays its receipt", async () => {
    let uploads = 0;
    await withServer(
      async ({ server, reference }) => {
        expect(
          (
            await request(server, "/v1/browser-sessions", {
              method: "POST",
              token: adminToken,
              body: createBody(reference),
            })
          ).status,
        ).toBe(201);
        const path = `/v1/browser-sessions/${reference.browserSessionId}/state-captures`;
        const body = stateCaptureBody(reference);
        expect((await request(server, path, { method: "POST", body })).status).toBe(401);
        expect(
          (
            await request(server, path, {
              method: "POST",
              token: adminToken,
              body: { ...body, dataKeyBase64: "not-base64" },
            })
          ).status,
        ).toBe(400);

        const captured = await request(server, path, {
          method: "POST",
          token: adminToken,
          body,
        });
        expect(captured.status).toBe(200);
        const first = await json(captured);
        expect(first.data).toMatchObject({
          operationId: body.operationId,
          browserSessionId: reference.browserSessionId,
          controllerGeneration: reference.controllerGeneration,
          objectKey: body.objectKey,
        });
        const serialized = JSON.stringify(first);
        expect(serialized).not.toContain(body.dataKeyBase64);
        expect(serialized).not.toContain(body.upload.url);
        expect(uploads).toBe(1);

        const replayed = await request(server, path, {
          method: "POST",
          token: adminToken,
          body,
        });
        expect(replayed.status).toBe(200);
        expect(await json(replayed)).toEqual(first);
        expect(uploads).toBe(1);
      },
      {
        uploadArtifact: async () => {
          uploads += 1;
        },
      },
    );
  });

  test("rejects malformed bodies without reflecting private driver failures", async () => {
    const unexpected: Array<{
      error: unknown;
      context: { method: string; pathname: string };
    }> = [];
    await withServer(
      async ({ server, reference }) => {
        const invalidUtf8 = await fetch(`${server.url}/v1/browser-sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          body: Uint8Array.of(0xff).slice().buffer,
        });
        expect(invalidUtf8.status).toBe(400);
        const failed = await request(server, "/v1/browser-sessions", {
          method: "POST",
          token: adminToken,
          body: createBody(reference),
        });
        expect(failed.status).toBe(500);
        expect(JSON.stringify(await json(failed))).not.toContain("private-driver-detail");
        expect(unexpected).toHaveLength(1);
        expect(unexpected[0]?.context).toEqual({
          method: "POST",
          pathname: "/v1/browser-sessions",
        });
        expect(unexpected[0]?.error).toMatchObject({ message: "private-driver-detail" });
      },
      {
        failStart: true,
        onUnexpectedError: (error, context) => unexpected.push({ error, context }),
      },
    );
  });
});

async function withServer(
  callback: (fixture: {
    server: BrowserControlServer;
    reference: { browserSessionId: string; controllerGeneration: string };
  }) => Promise<void>,
  options: {
    failStart?: boolean;
    allowedOrigins?: readonly string[];
    uploadArtifact?: (path: string, authority: BrowserStateUploadAuthority) => Promise<void>;
    uploadDownload?: BrowserSupervisorOptions["uploadDownload"];
    linkedComputer?: {
      computerSessionId: string;
      controllerGeneration: string;
      environment: NodeJS.ProcessEnv;
    };
    onBrowserContext?: (context: BrowserSupervisorDriverContext) => void;
    onUnexpectedError?: (error: unknown, context: { method: string; pathname: string }) => void;
  } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-server-");
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: join(directory, "state"),
    socketRootDirectory: join(directory, "sockets"),
    createDriver: async (context) => {
      options.onBrowserContext?.(context);
      return fakeDriver(context, options);
    },
    ...(options.uploadArtifact ? { uploadArtifact: options.uploadArtifact } : {}),
    ...(options.uploadDownload ? { uploadDownload: options.uploadDownload } : {}),
  });
  const computerSupervisor = options.linkedComputer
    ? ({
        launchEnvironment(reference: { computerSessionId: string; controllerGeneration: string }) {
          if (
            reference.computerSessionId !== options.linkedComputer!.computerSessionId ||
            reference.controllerGeneration !== options.linkedComputer!.controllerGeneration
          ) {
            throw new Error("stale ComputerSession fixture reference");
          }
          return { ...options.linkedComputer!.environment };
        },
        async close() {},
      } as unknown as ComputerSupervisor)
    : undefined;
  const server = BrowserControlServer.start({
    supervisor,
    ...(computerSupervisor ? { computerSupervisor } : {}),
    adminToken,
    port: 0,
    allowedOrigins: options.allowedOrigins ?? [allowedOrigin],
    ...(options.onUnexpectedError ? { onUnexpectedError: options.onUnexpectedError } : {}),
  });
  try {
    await callback({
      server,
      reference: {
        browserSessionId: randomUUID(),
        controllerGeneration: "controller-1",
      },
    });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

function fakeDriver(
  context: BrowserSupervisorDriverContext,
  options: { failStart?: boolean },
): BrowserSupervisorDriver {
  const target: BrowserTarget = {
    id: `target-${context.browserSessionId}`,
    browserSessionId: context.browserSessionId,
    controllerGeneration: context.controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    kind: "page",
    title: "Fixture",
    url: "about:blank",
    selected: true,
    attached: true,
    createdAt: "2026-08-09T12:00:00.000Z",
  };
  const observation = (): BrowserObservation => ({
    protocolVersion: 1,
    observationId: randomUUID(),
    browserSessionId: context.browserSessionId,
    target: { ...target },
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
  });
  return {
    async start(url) {
      if (options.failStart) throw new Error("private-driver-detail");
      target.url = url ?? "about:blank";
      return observation();
    },
    async target(targetId) {
      return targetId === target.id ? { ...target } : null;
    },
    async listTargets() {
      return [{ ...target }];
    },
    async openTarget(url) {
      target.url = url ?? "about:blank";
      return observation();
    },
    async selectTarget() {
      return observation();
    },
    async closeTarget() {
      return [];
    },
    async observe() {
      return observation();
    },
    async dispatch() {
      return observation();
    },
    async protectedFill() {
      return { target: { ...target }, status: "submitted" };
    },
    async externalAuth() {
      return {
        state: "needs_human",
        externalAction: {
          kind: "human",
          label: "Complete sign-in securely",
          expiresAt: null,
        },
        interactiveUrl: null,
        failureCode: null,
        profileLoaded: false,
      };
    },
    async captureScreenshot() {
      return frame(context, target);
    },
    async subscribeFrames() {
      const subscription = new LatestBrowserFrameSubscription(async () => undefined);
      queueMicrotask(() => subscription.push(frame(context, target)));
      return subscription;
    },
    async debug() {
      return {
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        targetId: target.id,
        targetGeneration: target.targetGeneration,
        entries: [],
        cursor: 0,
        truncated: false,
      };
    },
    readClipboard() {
      return {
        browserSessionId: context.browserSessionId,
        controllerGeneration: context.controllerGeneration,
        revision: 0,
        text: "",
        source: "empty",
        sourceTargetId: null,
        updatedAt: null,
      };
    },
    async runtimeSnapshot() {
      return {
        engine: "chromium" as const,
        engineVersion: "140.0.0.0",
        tabs: [{ url: target.url, selected: target.selected }],
      };
    },
    async close() {},
  };
}

function frame(context: BrowserSupervisorDriverContext, target: BrowserTarget): BrowserImageFrame {
  return {
    frameId: "image-1",
    browserSessionId: context.browserSessionId,
    controllerGeneration: context.controllerGeneration,
    targetId: target.id,
    targetGeneration: target.targetGeneration,
    documentGeneration: target.documentGeneration!,
    sequence: 1,
    mediaType: "image/png",
    width: 3,
    height: 2,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
    data: png(),
    capturedAt: "2026-08-09T12:00:00.000Z",
  };
}

function png(): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 3, 0, 0, 0, 2,
  ]);
}

function createBody(
  reference: { browserSessionId: string; controllerGeneration: string },
  overrides: Partial<{
    tokenGeneration: number;
    controlToken: string;
    viewToken: string;
    headed: boolean;
    linkedComputer: { computerSessionId: string; controllerGeneration: string };
    networkRoute: ReturnType<typeof proxyRoute> | ReturnType<typeof managedRoute>;
    transport:
      | { kind: "managed"; engine: "chromium" | "lightpanda" }
      | {
          kind: "external_provider";
          providerId: "browserbase" | "kernel";
          placementId: string;
          authority: { apiKey: string; endpoint?: string };
          timeoutSeconds?: number;
          stealth?: boolean;
        };
  }> = {},
) {
  return {
    ...reference,
    tokenGeneration: 1,
    controlToken,
    viewToken,
    headed: false,
    ...overrides,
  };
}

function proxyRoute() {
  return {
    routeId: "22222222-2222-4222-8222-222222222222",
    routeVersion: 1,
    authorityDigest: `ogr.${"a".repeat(43)}`,
    kind: "proxy" as const,
    consistency: {
      dns: "proxy" as const,
      expectedPublicIp: null,
      expectedRegion: null,
      locale: "en-US",
      timezone: "Europe/Oslo",
      geolocation: { latitude: 59.9139, longitude: 10.7522, accuracyMeters: 25 },
      webRtc: "disable_non_proxied_udp" as const,
      stability: "session" as const,
    },
    proxyUrl: "http://proxy-user:proxy-password@proxy.test:8443/",
  };
}

function managedRoute() {
  return {
    routeId: "33333333-3333-4333-8333-333333333333",
    routeVersion: 2,
    authorityDigest: `ogr.${"m".repeat(43)}`,
    kind: "managed" as const,
    consistency: {
      dns: "provider" as const,
      expectedPublicIp: null,
      expectedRegion: "NO",
      locale: "nb-NO",
      timezone: "Europe/Oslo",
      geolocation: { latitude: 59.9139, longitude: 10.7522, accuracyMeters: 25 },
      webRtc: "disable_non_proxied_udp" as const,
      stability: "session" as const,
    },
    providerRoute: {
      providerId: "kernel" as const,
      routeId: "kernel-proxy-7",
      egressClass: "isp" as const,
      region: "NO",
    },
  };
}

function stateCaptureBody(reference: { browserSessionId: string; controllerGeneration: string }) {
  const operationId = "22222222-2222-4222-8222-222222222222";
  return {
    operationId,
    controllerGeneration: reference.controllerGeneration,
    objectKey: `workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/browser-state/publications/${operationId}/chromium-profile.ogbs`,
    afterCapture: "restart",
    dataKeyBase64: Buffer.alloc(32, 9).toString("base64"),
    aadBase64: Buffer.from("workspace:object", "utf8").toString("base64"),
    upload: {
      url: "https://storage.test/upload?signature=fixture",
      requiredHeaders: { "content-type": BROWSER_STATE_ARTIFACT_CONTENT_TYPE },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function command(observation: BrowserObservation): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "system", subjectId: "server-test" },
    action: { type: "click", locator: { kind: "ref", ref: "e1" } },
  };
}

function protectedAuthCommand(observation: BrowserObservation): BrowserProtectedAuthFillCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration!,
    expectedFrameId: observation.frameId!,
    actor: { kind: "system", subjectId: "credential-broker-test" },
    authorityId: "password-authority",
    credentialVersion: 1,
    allowedOrigins: ["https://example.test"],
    fields: [
      {
        fieldId: "password",
        locator: { kind: "ref", ref: "e-password" },
        purpose: "password",
        value: "server-test-password",
      },
    ],
    submit: { type: "press", key: "Enter" },
  };
}

async function request(
  server: BrowserControlServer,
  path: string,
  options: {
    method?: string;
    token?: string;
    origin?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.origin) headers.origin = options.origin;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return await fetch(`${server.url}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function json(response: Response): Promise<{ data: Record<string, unknown> }> {
  return (await response.json()) as { data: Record<string, unknown> };
}

async function websocketMessage(websocket: WebSocket): Promise<ArrayBuffer> {
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2_000);
    websocket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        if (event.data instanceof ArrayBuffer) resolve(event.data);
        else reject(new Error("expected binary websocket frame"));
      },
      { once: true },
    );
    websocket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("websocket failed"));
      },
      { once: true },
    );
  });
}

async function websocketClosed(websocket: WebSocket): Promise<CloseEvent> {
  return await new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket close timeout")), 2_000);
    websocket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}
