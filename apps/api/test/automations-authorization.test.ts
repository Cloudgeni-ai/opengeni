import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createAutomationSource,
  createAutomationTrigger,
  createDb,
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
import { registerAutomationRoutes } from "../src/routes/automations";

const DELEGATION_SECRET = "automation-authorization-test-secret";
let shared: SharedTestDatabase;
let client: DbClient;
let app: Hono;
let accountId: string;
let workspaceId: string;
let subjectId: string;
let sourceId: string;
let triggerId: string;
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

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("automations-authorization");
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
  const noop = async () => undefined;
  registerAutomationRoutes(app, {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      environmentsEncryptionKey: Buffer.alloc(32, 11).toString("base64"),
    }),
    db: client.db,
    workflowClient: {
      triggerAutomationRun: noop,
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
});
