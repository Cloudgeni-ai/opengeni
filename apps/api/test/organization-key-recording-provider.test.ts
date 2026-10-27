import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  type DbClient,
} from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { createApp } from "../src/app";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

let fixture: SharedTestDatabase;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = adminUrl ? postgres(adminUrl, { max: 4 }) : null;
  const acquired =
    admin && adminUrl && appUrl
      ? {
          admin,
          adminUrl,
          appUrl,
          release: async () => {
            await admin.end();
          },
        }
      : await acquireSharedTestDatabase("organization-key-recording-provider");
  if (!acquired) throw new Error("PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

// A product that embeds Opengeni with only an organization API key has no person
// to sign in to settings. The workspace connection route is its supported way to
// give a workspace an ElevenLabs key for meeting transcription.
test("an organization API key connects ElevenLabs to a workspace for meetings", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Embedding product",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Meetings",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Server",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: testSettings({
      productAccessMode: "managed",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
    }),
  });
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  const created = await app.request(`/v1/workspaces/${grant.workspaceId}/connections`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerDomain: "api.elevenlabs.io",
      kind: "api_key",
      subjectId: null,
      credential: { apiKey: "sk_fixture_elevenlabs" },
      metadata: { credentialRole: "elevenlabs" },
      operationId: randomUUID(),
    }),
  });
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    connection: { providerDomain: string; subjectId: string | null; status: string };
  };
  expect(body.connection).toMatchObject({
    providerDomain: "api.elevenlabs.io",
    subjectId: null,
    status: "active",
  });

  const listed = await app.request(`/v1/workspaces/${grant.workspaceId}/connections`, {
    headers,
  });
  expect(listed.status).toBe(200);
  const connections = ((await listed.json()) as { connections: Array<{ providerDomain: string }> })
    .connections;
  expect(connections.map((connection) => connection.providerDomain)).toContain("api.elevenlabs.io");
}, 60_000);
