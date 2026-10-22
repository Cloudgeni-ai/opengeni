import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  createDb,
  listConnectionsMetadata,
  listScheduledTasks,
  migrate,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import postgres from "postgres";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "google-drive-delegation-secret";
const STATE_SECRET = "google-drive-state-secret";
const CLIENT_ID = "google-drive-client.apps.googleusercontent.com";
const CLIENT_SECRET = "google-drive-client-secret";

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
    googleDriveClientId: CLIENT_ID,
    googleDriveClientSecret: CLIENT_SECRET,
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

function app(googleDriveFetch: typeof globalThis.fetch, overrides: Partial<Settings> = {}) {
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
    googleDriveFetch,
  } as never);
}

describe("retired native Google Drive setup", () => {
  test("refuses old source and publishing OAuth before contacting Google or writing credentials", async () => {
    if (!available) throw new Error("PostgreSQL required");
    const workspace = await freshWorkspace();
    let requests = 0;
    const provider = async () => {
      requests++;
      throw new Error("Unexpected provider request");
    };
    for (const capability of ["source_read", "publish"]) {
      const response = await app(provider).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/install`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, "subject-a", [
              "connections:read",
              "connections:write",
            ]),
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify({ capability }),
        },
      );
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("retired");
    }
    expect(requests).toBe(0);
    expect(await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a")).toEqual(
      [],
    );
    expect(await listScheduledTasks(client.db, workspace.workspaceId)).toEqual([]);
  });
  test("refuses legacy source configuration without creating a replacement schedule", async () => {
    if (!available) throw new Error("PostgreSQL required");
    const workspace = await freshWorkspace();
    const response = await app(async () => {
      throw new Error("Unexpected provider request");
    }).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/11111111-1111-4111-8111-111111111111/source`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", [
            "connections:read",
            "connections:write",
          ]),
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({ sourceId: "folder", syncEnabled: true, syncCadence: "hourly" }),
      },
    );
    expect(response.status).toBe(410);
    expect(await listScheduledTasks(client.db, workspace.workspaceId)).toEqual([]);
  });
});
