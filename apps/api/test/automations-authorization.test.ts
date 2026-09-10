import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AutomationNormalizedEvent,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createAutomationSource,
  createAutomationTrigger,
  createWorkspaceGatewayCustomModel,
  createDb,
  deleteWorkspaceGatewayCustomModel,
  getAutomationSourceSecret,
  deleteWorkspace,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";
import { acceptAutomationEvent, registerAutomationRoutes } from "../src/routes/automations";

const DELEGATION_SECRET = "automation-authorization-test-secret";
let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let accountId: string;
let workspaceId: string;
let subjectId: string;
let sourceId: string;
let triggerId: string;
const triggeredRuns: Array<{
  accountId: string;
  workspaceId: string;
  runId: string;
}> = [];
const sessionTemplate = {
  prompt: "Investigate the event",
  instructions: null,
  resources: [],
  skills: [],
  tools: [],
  firstPartyMcpTools: [],
  firstPartyMcpPermissions: [],
  model: null,
  reasoningEffort: null,
  sandboxBackend: null,
  policyRole: null,
  metadata: {},
};

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("automations-authorization");
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  const acquired = await acquireDatabase();
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `automation-auth-${crypto.randomUUID()}`,
    accountName: "Automation authorization",
    workspaceExternalSource: "test",
    workspaceExternalId: `automation-auth-${crypto.randomUUID()}`,
    workspaceName: "Automation authorization",
    subjectId: `automation-auth-${crypto.randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  ({ accountId, workspaceId, subjectId } = grant);
  const source = await createAutomationSource(client.db, {
    accountId,
    workspaceId,
    createdBySubjectId: subjectId,
    webhookSecretEncrypted: "test-ciphertext",
    request: {
      name: "Authorization events",
      adapterId: "signed-json.v1",
      webhookSecret: "never-stored",
      configuration: {},
    },
  });
  sourceId = source.id;
  const trigger = await createAutomationTrigger(client.db, {
    accountId,
    workspaceId,
    createdBySubjectId: subjectId,
    adapterId: source.adapterId,
    request: {
      sourceId,
      name: "Authorization trigger",
      eventTypes: ["authorization.event"],
      configuration: {},
      parameters: {},
      sessionTemplate,
      status: "active",
      packInstallationId: null,
      packTemplateId: null,
    },
  });
  triggerId = trigger.id;
  app = new Hono();
  registerAutomationRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      environmentsEncryptionKey: Buffer.alloc(32, 11).toString("base64"),
    }),
    db: client.db,
    workflowClient: {
      triggerAutomationRun: async (input) => {
        triggeredRuns.push(input);
      },
    } as unknown as SessionWorkflowClient,
  } as unknown as ApiRouteDeps);
}, 300_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function authorization(permissions: Permission[]): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

describe("automation route authorization", () => {
  test("rechecks permissions introduced by a trigger template update", async () => {
    const response = await app.request(
      `http://test/v1/workspaces/${workspaceId}/automations/triggers/${triggerId}`,
      {
        method: "PATCH",
        headers: {
          authorization: await authorization(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 1,
          sessionTemplate: {
            ...sessionTemplate,
            firstPartyMcpPermissions: ["secrets:read"],
          },
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  test("rejects Pack ownership through the generic trigger create route", async () => {
    const response = await app.request(
      `http://test/v1/workspaces/${workspaceId}/automations/triggers`,
      {
        method: "POST",
        headers: {
          authorization: await authorization(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceId,
          name: "Claimed Pack trigger",
          eventTypes: ["authorization.event"],
          configuration: {},
          parameters: {},
          sessionTemplate,
          packInstallationId: "11111111-1111-4111-8111-111111111111",
          packTemplateId: "review",
        }),
      },
    );
    expect(response.status).toBe(409);
  });

  test("does not accept a new event for a trigger whose custom model was retired", async () => {
    triggeredRuns.length = 0;
    const upstreamModelId = `fixture/retired-${crypto.randomUUID()}`;
    const model = await createWorkspaceGatewayCustomModel(client.db, {
      accountId,
      workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "a".repeat(64),
      createdBySubjectId: subjectId,
    });
    if (!model) throw new Error("custom model create unexpectedly conflicted");
    await createAutomationTrigger(client.db, {
      accountId,
      workspaceId,
      createdBySubjectId: subjectId,
      adapterId: "signed-json.v1",
      request: {
        sourceId,
        name: "Retired model trigger",
        eventTypes: ["retired.model.event"],
        configuration: {},
        parameters: {},
        sessionTemplate: {
          ...sessionTemplate,
          model: `workspace-gateway/${upstreamModelId}`,
        },
        status: "active",
        packInstallationId: null,
        packTemplateId: null,
      },
    });
    await deleteWorkspaceGatewayCustomModel(client.db, {
      accountId,
      workspaceId,
      customModelId: model.id,
      expectedVersion: model.version,
      operationId: crypto.randomUUID(),
      requestHash: "b".repeat(64),
    });

    const response = await app.request(
      `http://test/v1/workspaces/${workspaceId}/automations/sources/${sourceId}/events`,
      {
        method: "POST",
        headers: {
          authorization: await authorization(["workspace:read", "workspace:admin"]),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventType: "retired.model.event",
          occurrenceKey: `retired:${crypto.randomUUID()}`,
          payload: {},
        }),
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      ignoredReason: "no_executable_triggers",
      runIds: [],
    });
    expect(triggeredRuns).toEqual([]);
  });

  test("checks the adapter-rendered model before accepting a PR-review event", async () => {
    triggeredRuns.length = 0;
    const registrationId = crypto.randomUUID();
    const source = await createAutomationSource(client.db, {
      accountId,
      workspaceId,
      createdBySubjectId: subjectId,
      webhookSecretEncrypted: "test-ciphertext",
      request: {
        name: "PR review rendered-model source",
        adapterId: "source-control.pull-request.v1",
        webhookSecret: "never-stored",
        configuration: {
          provider: "github",
          providerBaseUrl: "https://github.com",
          registrationId,
          webhookUsername: null,
        },
      },
    });
    const upstreamModelId = `fixture/pr-review-retired-${crypto.randomUUID()}`;
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const model = await createWorkspaceGatewayCustomModel(client.db, {
      accountId,
      workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "d".repeat(64),
      createdBySubjectId: subjectId,
    });
    if (!model) throw new Error("custom model create unexpectedly conflicted");
    await createAutomationTrigger(client.db, {
      accountId,
      workspaceId,
      createdBySubjectId: subjectId,
      adapterId: source.adapterId,
      request: {
        sourceId: source.id,
        name: "PR review rendered-model trigger",
        eventTypes: ["pull_request.review_requested"],
        configuration: {},
        parameters: {
          registrationId,
          repositoryBindingId: crypto.randomUUID(),
          provider: "github",
          repositoryUri: "https://github.com/example/repository.git",
          repositoryFullName: "example/repository",
          providerRepositoryId: "101",
          installationId: "202",
          projectId: null,
          model: productModelId,
          additionalInstructions: null,
        },
        sessionTemplate: {
          ...sessionTemplate,
          instructions: "Follow the PR-review instructions.",
          policyRole: "pull_request_review",
        },
        status: "active",
        packInstallationId: null,
        packTemplateId: null,
      },
    });
    await deleteWorkspaceGatewayCustomModel(client.db, {
      accountId,
      workspaceId,
      customModelId: model.id,
      expectedVersion: model.version,
      operationId: crypto.randomUUID(),
      requestHash: "e".repeat(64),
    });
    const sourceSecret = await getAutomationSourceSecret(client.db, {
      accountId,
      workspaceId,
      sourceId: source.id,
    });
    if (!sourceSecret) throw new Error("PR review source fixture is unavailable");
    const occurrenceKey = `pr-review-retired:${crypto.randomUUID()}`;
    const result = await acceptAutomationEvent(
      {
        settings: testSettings(),
        db: client.db,
        workflowClient: {
          triggerAutomationRun: async (input) => {
            triggeredRuns.push(input);
          },
        },
      } as unknown as ApiRouteDeps,
      sourceSecret,
      {
        deliveryKey: occurrenceKey,
        requestDigest: "f".repeat(64),
        normalizedEvent: AutomationNormalizedEvent.parse({
          adapterId: source.adapterId,
          eventType: "pull_request.review_requested",
          occurrenceKey,
          occurredAt: null,
          subject: "pull-request:7",
          resource: "repository:101",
          payload: {
            provider: "github",
            eventName: "pull_request",
            action: "opened",
            providerRepositoryId: "101",
            installationId: "202",
            projectId: null,
            pullRequestId: "7",
            headSha: "a".repeat(40),
            baseSha: "b".repeat(40),
            headRef: "feature",
            baseRef: "main",
            ignoredReason: null,
          },
        }),
      },
    );

    expect(result).toMatchObject({
      accepted: true,
      ignoredReason: "no_executable_triggers",
      runIds: [],
    });
    expect(triggeredRuns).toEqual([]);
  });

  test("records an unmatched event without requiring the deployment catalog", async () => {
    const source = await getAutomationSourceSecret(client.db, {
      accountId,
      workspaceId,
      sourceId,
    });
    if (!source) throw new Error("automation source fixture is unavailable");
    const occurrenceKey = `unmatched:${crypto.randomUUID()}`;

    const result = await acceptAutomationEvent(
      {
        settings: testSettings({ modelCatalogSource: "database" }),
        db: client.db,
        workflowClient: {
          triggerAutomationRun: async (input) => {
            triggeredRuns.push(input);
          },
        },
      } as unknown as ApiRouteDeps,
      source,
      {
        deliveryKey: occurrenceKey,
        requestDigest: "c".repeat(64),
        normalizedEvent: AutomationNormalizedEvent.parse({
          adapterId: source.adapterId,
          eventType: "unmatched.event",
          occurrenceKey,
          occurredAt: null,
          subject: null,
          resource: null,
          payload: {},
        }),
      },
    );

    expect(result).toMatchObject({
      accepted: true,
      ignoredReason: "no_matching_triggers",
      runIds: [],
    });
  });
});
