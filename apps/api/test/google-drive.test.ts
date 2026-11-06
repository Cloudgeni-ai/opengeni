import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type ConnectionMetadata,
  type Permission,
} from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  getConnectionMetadata,
  listConnectionsMetadata,
  listScheduledTasks,
  migrate,
  type DbClient,
} from "@opengeni/db";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_READONLY_SCOPE,
} from "@opengeni/contracts/google-drive";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "google-drive-delegation-secret";
const STATE_SECRET = "google-drive-state-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) return await acquireSharedTestDatabase("api_google_drive");
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
  shared = await acquireDatabase();
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[google-drive] docker unavailable, skipping");
    return;
  }
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "http://127.0.0.1:8000",
    webBaseUrl: "http://127.0.0.1:3000",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Google Drive account') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'Google Drive workspace') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  for (const subjectId of ["subject-a", "subject-b"]) {
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared!.admin.json(["connections:read", "connections:write"])}
      )`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function bearer(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

function app(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: { ...settings, ...overrides },
    db: client.db,
    bus: {} as never,
    workflowClient: {
      syncScheduledTask: async () => {},
      triggerScheduledTask: async () => {},
      deleteScheduledTaskSchedule: async () => {},
    } as never,
    managedAuth: null,
  } as never);
}

describe("removed native Google Drive source setup", () => {
  test("a historical native connection is removed locally without contacting Google", async () => {
    if (!available) throw new Error("PostgreSQL required");
    const workspace = await freshWorkspace();
    // Seed a historical row directly: the removed OAuth is never needed to remove it.
    const connection = await createConnection(client.db, {
      ...workspace,
      subjectId: "subject-a",
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      kind: "oauth2",
      status: "active",
      credentialEncrypted: "historical-ciphertext-must-not-be-read",
      grantedScopes: [GOOGLE_DRIVE_READONLY_SCOPE],
      metadata: {
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
        googlePermissionId: "historical-google-account",
        accessMode: "readonly",
        lifecycle: { state: "active", recoverable: true, observedAt: new Date().toISOString() },
      },
      createdBySubjectId: "subject-a",
    });
    const originalFetch = globalThis.fetch;
    let providerRequests = 0;
    globalThis.fetch = (async () => {
      providerRequests += 1;
      throw new Error("Removing a historical connection must not contact Google");
    }) as unknown as typeof fetch;
    try {
      const authorization = await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]);
      const disconnect = () =>
        app().request(`/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`, {
          method: "DELETE",
          headers: {
            authorization,
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          // What the deprecated `disconnectGoogleDriveConnection` SDK method sends.
          body: JSON.stringify({
            expectedVersion: connection.version,
            idempotencyKey: `disconnect:${connection.id}`,
          }),
        });
      const first = await disconnect();
      expect(first.status).toBe(200);
      const body = (await first.json()) as { connection: ConnectionMetadata };
      expect(body.connection).toMatchObject({ id: connection.id, status: "revoked" });
      expect((await disconnect()).status).toBe(200);
      expect(
        await getConnectionMetadata(client.db, workspace.workspaceId, connection.id, "subject-a"),
      ).toMatchObject({ status: "revoked" });
      expect(providerRequests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("source setup routes are gone, and the SDK lifecycle route answers 410", async () => {
    if (!available) throw new Error("PostgreSQL required");
    const workspace = await freshWorkspace();
    const headers = {
      authorization: await bearer(workspace, "subject-a", [
        "connections:read",
        "connections:write",
      ]),
      "content-type": "application/json",
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
    for (const capability of ["source_read", "publish"]) {
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/install`,
        { method: "POST", headers, body: JSON.stringify({ capability }) },
      );
      expect(response.status).toBe(404);
    }
    const source = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/11111111-1111-4111-8111-111111111111/source`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceId: "folder", syncEnabled: true, syncCadence: "hourly" }),
      },
    );
    expect(source.status).toBe(404);
    const lifecycle = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/11111111-1111-4111-8111-111111111111/lifecycle`,
      { method: "PATCH", headers, body: JSON.stringify({ action: "pause" }) },
    );
    expect(lifecycle.status).toBe(410);
    expect(await lifecycle.text()).toContain("Integration Knowledge sync has been removed");
    expect(await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a")).toEqual(
      [],
    );
    expect(await listScheduledTasks(client.db, workspace.workspaceId)).toEqual([]);
  });
});
