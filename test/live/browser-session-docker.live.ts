import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  MemoryEventBus,
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  BrowserActionReceipt,
  BrowserObservation,
  BrowserSessionAttachment,
  BrowserSessionMutationResponse,
  BrowserTargetListResponse,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  readLease,
  type DbClient,
} from "@opengeni/db";
import type { AppDependencies, SessionWorkflowClient } from "@opengeni/core";
import { createApp } from "../../apps/api/src/app";

const image = process.env.OPENGENI_BROWSER_CANARY_IMAGE?.trim() ?? "";
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
    "creates, observes, acts, grants frames, heartbeats, and ends through the public API",
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
      const app = createApp({
        settings,
        db: client.db,
        bus: new MemoryEventBus() as never,
        workflowClient,
        managedAuth: null,
      } satisfies AppDependencies);
      const token = await signDelegatedAccessToken(delegationSecret, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId!,
        subjectId: "browser-live-user",
        permissions: ["sessions:read", "sessions:control", "stream:view"],
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
        expect(created.session).toMatchObject({ lifecycle: "active", headless: true });
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
                url: "data:text/html,%3Ctitle%3EAction%20Completed%3C%2Ftitle%3E",
              },
            }),
          },
        );
        expect(BrowserActionReceipt.parse(await actionResponse.json())).toMatchObject({
          state: "completed",
        });

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
        if (containerId && /^[a-f0-9]{64}$/u.test(containerId)) {
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
      if (primaryError !== undefined) throw primaryError;
      if (cleanupError) throw cleanupError;
    },
    300_000,
  );
});
