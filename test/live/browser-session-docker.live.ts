import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  BrowserActionReceipt,
  BrowserDownloadListResponse,
  BrowserDownloadSaveResponse,
  BrowserObservation,
  BrowserSessionAttachment,
  BrowserSessionMutationResponse,
  BrowserTargetListResponse,
  signDelegatedAccessToken,
  type FileAsset,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  readLease,
  type DbClient,
} from "@opengeni/db";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import type { ObjectStorage } from "@opengeni/storage";
import { createApp } from "../../apps/api/src/app";

const image = process.env.OPENGENI_BROWSER_CANARY_IMAGE?.trim() ?? "";
const engine = process.env.OPENGENI_BROWSER_CANARY_ENGINE?.trim() || "chromium";
if (engine !== "chromium" && engine !== "lightpanda") {
  throw new Error(`unsupported BrowserSession canary engine: ${engine}`);
}
const delegationSecret = "browser-session-docker-live-secret";
const origin = "http://localhost:3000";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  if (!image) return;
  shared = await acquireSharedTestDatabase("browser-session-docker-live");
  if (!shared) throw new Error("BrowserSession Docker canary requires PostgreSQL");
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("BrowserSession API Docker canary", () => {
  const liveTest = image ? test : test.skip;
  liveTest(
    "creates, observes, acts, exercises declared capabilities, heartbeats, and ends through the public API",
    async () => {
      const access = await bootstrapWorkspace(client.db, {
        accountExternalSource: "test",
        accountExternalId: `browser-live-account-${crypto.randomUUID()}`,
        accountName: "Browser live",
        workspaceExternalSource: "test",
        workspaceExternalId: `browser-live-workspace-${crypto.randomUUID()}`,
        workspaceName: "Browser live",
        subjectId: "browser-live-user",
      });
      const workspace = access.workspaceGrants[0]!;
      const session = await createSession(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId!,
        initialMessage: "Browser canary",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "docker",
      });
      const settings = testSettings({
        productAccessMode: "managed",
        delegationSecret,
        sandboxBackend: "docker",
        dockerImage: image,
        sandboxOwnershipEnabled: true,
        sandboxIdleGraceMs: 1_000,
      });
      const workflowClient = {
        signalUserMessage: async () => undefined,
        wakeSessionWorkflow: async () => undefined,
        signalApprovalDecision: async () => undefined,
        signalSessionControl: async () => undefined,
        syncScheduledTask: async () => undefined,
        deleteScheduledTaskSchedule: async () => undefined,
        triggerScheduledTask: async () => undefined,
      } as unknown as SessionWorkflowClient;
      const storageFixture = createLiveStorageFixture();
      const app = createApp({
        settings,
        db: client.db,
        bus: new MemoryEventBus() as never,
        workflowClient,
        managedAuth: null,
        objectStorage: storageFixture.storage,
      } satisfies AppDependencies);
      const token = await signDelegatedAccessToken(delegationSecret, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId!,
        subjectId: "browser-live-user",
        permissions: [
          "sessions:read",
          "sessions:control",
          "stream:view",
          "files:read",
          "files:upload",
        ],
        principalKind: "human_session",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
      });
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin,
      };
      let containerId: string | null = null;
      let primaryError: unknown;
      let cleanupError: Error | undefined;
      let containerDiagnostics: string | null = null;
      try {
        const createResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              sessionId: session.id,
              name: "Docker canary",
              engine,
              initialUrl:
                "data:text/html,%3Ctitle%3EBrowser%20Canary%3C%2Ftitle%3E%3Cbutton%3EReady%3C%2Fbutton%3E",
            }),
          },
        );
        const lease = await readLease(client.db, workspace.workspaceId!, session.sandboxGroupId);
        containerId = lease?.instanceId ?? null;
        const createBody = await createResponse.json();
        if (createResponse.status !== 201) {
          throw new Error(
            `BrowserSession create returned ${createResponse.status}: ${JSON.stringify(createBody)}`,
          );
        }
        const created = BrowserSessionMutationResponse.parse(createBody);
        expect(created.session).toMatchObject({
          lifecycle: "active",
          headless: true,
          capabilities:
            engine === "lightpanda"
              ? { semanticObservation: true, liveFrames: false, tabs: false, downloads: false }
              : { semanticObservation: true, liveFrames: true, tabs: true, downloads: true },
        });
        const browserSessionId = created.session.id;

        expect(containerId).toMatch(/^[a-f0-9]{64}$/u);

        const targetsResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/targets`,
          { headers },
        );
        expect(targetsResponse.status).toBe(200);
        const targets = BrowserTargetListResponse.parse(await targetsResponse.json());
        const target =
          targets.targets.find((candidate) => candidate.selected) ?? targets.targets[0]!;

        const observationResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/targets/${target.id}/observation`,
          { headers },
        );
        const observation = BrowserObservation.parse(await observationResponse.json());
        expect(observation.target.title).toBe("Browser Canary");

        const actionResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/actions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              targetId: target.id,
              expectedTargetGeneration: target.targetGeneration,
              expectedDocumentGeneration: target.documentGeneration,
              expectedFrameId: observation.frameId,
              action: {
                type: "navigate",
                url: storageFixture.fixtureUrl,
              },
            }),
          },
        );
        const navigated = BrowserActionReceipt.parse(await actionResponse.json());
        expect(navigated).toMatchObject({
          state: "completed",
        });
        if (!navigated.observation) throw new Error("navigation returned no observation");

        if (engine === "chromium") {
          const downloadAction = await app.request(
            `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/actions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                operationId: crypto.randomUUID(),
                targetId: target.id,
                expectedTargetGeneration: navigated.observation.target.targetGeneration,
                expectedDocumentGeneration: navigated.observation.target.documentGeneration,
                expectedFrameId: navigated.observation.frameId,
                action: {
                  type: "click",
                  locator: { kind: "text", text: "Download fixture" },
                },
              }),
            },
          );
          expect(BrowserActionReceipt.parse(await downloadAction.json())).toMatchObject({
            state: "completed",
          });
          const download = await waitForCompletedDownload(
            app,
            workspace.workspaceId!,
            browserSessionId,
            headers,
          );
          expect(download).toMatchObject({
            filename: "fixture-download.txt",
            receivedBytes: storageFixture.downloadBytes.byteLength,
            status: "completed",
          });

          const saveOperationId = crypto.randomUUID();
          const savePath = `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/downloads/${download.id}/save`;
          const saveResponse = await app.request(savePath, {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationId: saveOperationId,
              destinationPath: "fixture-download.txt",
              overwrite: false,
            }),
          });
          const saveBody = await saveResponse.json();
          if (saveResponse.status !== 201) {
            throw new Error(
              `BrowserDownload save returned ${saveResponse.status} after ${storageFixture.putCount()} object PUT and ${storageFixture.getCount()} object GET requests: ${JSON.stringify(saveBody)}`,
            );
          }
          const saved = BrowserDownloadSaveResponse.parse(saveBody);
          expect(saved).toMatchObject({
            download: { id: download.id },
            destinationPath: "fixture-download.txt",
            operationId: saveOperationId,
            replayed: false,
          });
          expect(storageFixture.putCount()).toBe(1);
          expect(storageFixture.getCount()).toBe(1);

          const readResponse = await app.request(
            `/v1/workspaces/${workspace.workspaceId}/sessions/${session.id}/fs/read`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                path: "fixture-download.txt",
                encoding: "utf8",
                maxBytes: 1_024,
              }),
            },
          );
          expect(readResponse.status).toBe(200);
          expect(await readResponse.json()).toMatchObject({
            content: storageFixture.downloadBytes.toString("utf8"),
            truncated: false,
          });

          storageFixture.stop();
          const replayResponse = await app.request(savePath, {
            method: "POST",
            headers,
            body: JSON.stringify({
              operationId: saveOperationId,
              destinationPath: "fixture-download.txt",
              overwrite: false,
            }),
          });
          expect(replayResponse.status).toBe(200);
          expect(BrowserDownloadSaveResponse.parse(await replayResponse.json())).toMatchObject({
            operationId: saveOperationId,
            replayed: true,
          });
          expect(storageFixture.putCount()).toBe(1);
          expect(storageFixture.getCount()).toBe(1);

          const attachmentResponse = await app.request(
            `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/attachments`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ targetId: target.id, expiresInSeconds: 30 }),
            },
          );
          const attachment = BrowserSessionAttachment.parse(await attachmentResponse.json());
          expect(attachment.stream.kind).toBe("direct_websocket");
          if (attachment.stream.kind !== "direct_websocket")
            throw new Error("expected direct stream");
          expect(attachment.stream.url).toMatch(/^ws:\/\/127\.0\.0\.1:/u);
          expect(attachment.stream.protocols).toHaveLength(2);
        }

        const heartbeatResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/heartbeat`,
          { method: "POST", headers, body: "{}" },
        );
        expect(heartbeatResponse.status).toBe(200);

        const endResponse = await app.request(
          `/v1/workspaces/${workspace.workspaceId}/browser-sessions/${browserSessionId}/end`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
          },
        );
        expect(
          BrowserSessionMutationResponse.parse(await endResponse.json()).session.lifecycle,
        ).toBe("ended");
      } catch (error) {
        primaryError = error;
      } finally {
        storageFixture.stop();
        if (containerId && /^[a-f0-9]{64}$/u.test(containerId)) {
          if (primaryError !== undefined) {
            containerDiagnostics = await readContainerDiagnostics(containerId);
          }
          const cleanup = Bun.spawn(["docker", "rm", "-f", containerId], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitCode = await cleanup.exited;
          if (exitCode !== 0) {
            cleanupError = new Error(
              `failed to remove BrowserSession canary container ${containerId}`,
            );
          }
        }
      }
      if (primaryError !== undefined && cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "BrowserSession canary failed and its exact container cleanup also failed",
        );
      }
      if (primaryError !== undefined && containerDiagnostics) {
        throw new AggregateError(
          [primaryError, new Error(containerDiagnostics)],
          "BrowserSession canary failed; exact placement diagnostics follow",
        );
      }
      if (primaryError !== undefined) throw primaryError;
      if (cleanupError) throw cleanupError;
    },
    300_000,
  );
});

async function readContainerDiagnostics(containerId: string): Promise<string | null> {
  const logs = Bun.spawn(["docker", "logs", "--tail", "200", containerId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const controller = Bun.spawn(
    [
      "docker",
      "exec",
      containerId,
      "sh",
      "-c",
      'if [ -r /tmp/opengeni-browserd/browserd.log ]; then sed -n "1,240p" /tmp/opengeni-browserd/browserd.log; fi',
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode, controllerStdout, controllerStderr, controllerExitCode] =
    await Promise.all([
      new Response(logs.stdout).text(),
      new Response(logs.stderr).text(),
      logs.exited,
      new Response(controller.stdout).text(),
      new Response(controller.stderr).text(),
      controller.exited,
    ]);
  if (exitCode !== 0 && controllerExitCode !== 0) return null;
  const output = [stdout, stderr, controllerStdout, controllerStderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  return output ? `BrowserSession placement logs:\n${output}` : null;
}

function createLiveStorageFixture() {
  const downloadBytes = Buffer.from("deterministic workspace download\n", "utf8");
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; sha256: string | null }
  >();
  let putCount = 0;
  let getCount = 0;
  let stopped = false;
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture") {
        return new Response(
          '<!doctype html><title>Download canary</title><a download href="/download">Download fixture</a>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname === "/download") {
        return new Response(downloadBytes, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": 'attachment; filename="fixture-download.txt"',
          },
        });
      }
      if (!url.pathname.startsWith("/objects/")) return new Response(null, { status: 404 });
      const key = decodeURIComponent(url.pathname.slice("/objects/".length));
      if (request.method === "PUT") {
        putCount += 1;
        objects.set(key, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
          sha256: request.headers.get("x-goog-meta-sha256"),
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        getCount += 1;
        const object = objects.get(key);
        return object
          ? new Response(object.bytes, { headers: { "content-type": object.contentType } })
          : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 405 });
    },
  });
  const containerBaseUrl = `http://host.docker.internal:${server.port}`;
  const objectUrl = (key: string, authority: "get" | "put") =>
    `${containerBaseUrl}/objects/${encodeURIComponent(key)}?authority=${authority}`;
  const storage: ObjectStorage = {
    bucket: "browser-download-live",
    backend: "gcs",
    maxSinglePutSizeBytes: 5_000_000_000,
    async createPutUrl({ key, contentType, sha256, expiresInSeconds = 300 }) {
      return {
        url: objectUrl(key, "put"),
        requiredHeaders: {
          "content-type": contentType,
          ...(sha256 ? { "x-goog-meta-sha256": sha256 } : {}),
        },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
      };
    },
    async createGetUrl({ key, expiresInSeconds = 300 }) {
      return {
        url: objectUrl(key, "get"),
        expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
      };
    },
    async headFile(file) {
      const object = objects.get(file.objectKey);
      if (!object) throw new Error("object not found");
      return {
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        ...(object.sha256 ? { Metadata: { sha256: object.sha256 } } : {}),
      };
    },
    async fileExists(file) {
      return objects.has(file.objectKey);
    },
    async getFileBytes(file) {
      const object = requireLiveObject(objects, file);
      return object.bytes;
    },
    async getFileRange(file, range) {
      const object = objects.get(file.objectKey);
      return object ? object.bytes.slice(range.start, range.end + 1) : null;
    },
    async getObjectBytes(key) {
      const object = objects.get(key);
      return object ? { bytes: object.bytes, contentType: object.contentType } : null;
    },
    async putObject({ key, contentType, body, sha256 }) {
      objects.set(key, { bytes: body, contentType, sha256: sha256 ?? null });
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  };
  return {
    storage,
    downloadBytes,
    fixtureUrl: `${containerBaseUrl}/fixture`,
    putCount: () => putCount,
    getCount: () => getCount,
    stop() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
    },
  };
}

function requireLiveObject(
  objects: Map<string, { bytes: Uint8Array; contentType: string; sha256: string | null }>,
  file: FileAsset,
) {
  const object = objects.get(file.objectKey);
  if (!object) throw new Error("object not found");
  return object;
}

async function waitForCompletedDownload(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  browserSessionId: string,
  headers: Record<string, string>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/downloads`,
      { headers },
    );
    if (response.status !== 200) {
      throw new Error(`BrowserDownload list returned ${response.status}`);
    }
    const listed = BrowserDownloadListResponse.parse(await response.json());
    const completed = listed.downloads.find((download) => download.status === "completed");
    if (completed) return completed;
    await Bun.sleep(50);
  }
  throw new Error("BrowserDownload did not complete");
}
