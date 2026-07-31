import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  createDb,
  getConnectionMetadata,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = "google-drive-delegation-secret";
const STATE_SECRET = "google-drive-state-secret";
const CLIENT_ID = "google-drive-client.apps.googleusercontent.com";
const CLIENT_SECRET = "google-drive-client-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_google_drive");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[google-drive] docker unavailable, skipping");
    return;
  }
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

function googleFixture(options: { permissionId?: string; omitRefreshToken?: boolean } = {}) {
  const tokenRequests: URLSearchParams[] = [];
  const apiAuthorizationHeaders: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      tokenRequests.push(body);
      return Response.json({
        access_token: "google-access-token",
        ...(options.omitRefreshToken ? {} : { refresh_token: "google-refresh-token" }),
        token_type: "Bearer",
        expires_in: 3600,
        scope: GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
      });
    }
    apiAuthorizationHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
    if (url.pathname === "/drive/v3/about") {
      return Response.json({
        user: {
          displayName: "Drive Tester",
          emailAddress: "drive.tester@example.com",
          permissionId: options.permissionId ?? "google-permission-a",
        },
      });
    }
    if (url.pathname === "/drive/v3/files") {
      expect(url.searchParams.get("q")).toBe("'root' in parents and trashed = false");
      return Response.json({
        incompleteSearch: false,
        files: [
          {
            id: "folder-1",
            name: "Product",
            mimeType: "application/vnd.google-apps.folder",
            modifiedTime: "2026-07-31T06:00:00.000Z",
            webViewLink: "https://drive.google.com/drive/folders/folder-1",
          },
          {
            id: "file-1",
            name: "Strategy",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-07-31T06:01:00.000Z",
            webViewLink: "https://docs.google.com/document/d/file-1/edit",
          },
        ],
      });
    }
    if (url.pathname === "/drive/v3/files/folder-1") {
      return Response.json({
        id: "folder-1",
        name: "Product",
        mimeType: "application/vnd.google-apps.folder",
        modifiedTime: "2026-07-31T06:00:00.000Z",
        webViewLink: "https://drive.google.com/drive/folders/folder-1",
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, tokenRequests, apiAuthorizationHeaders };
}

function app(googleDriveFetch: typeof globalThis.fetch, overrides: Partial<Settings> = {}) {
  return createApp({
    settings: { ...settings, ...overrides },
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    googleDriveFetch,
  } as never);
}

async function startConnection(
  workspace: { accountId: string; workspaceId: string },
  googleDriveFetch: typeof globalThis.fetch,
  connectionId?: string,
) {
  const response = await app(googleDriveFetch).request(
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
      body: JSON.stringify(connectionId ? { connectionId } : {}),
    },
  );
  const body = (await response.json()) as { authorizationUrl?: string };
  return { response, authorizationUrl: body.authorizationUrl ?? "" };
}

async function connect(
  workspace: { accountId: string; workspaceId: string },
  google: ReturnType<typeof googleFixture>,
  connectionId?: string,
) {
  const start = await startConnection(workspace, google.fetch, connectionId);
  expect(start.response.status).toBe(200);
  const authorizationUrl = new URL(start.authorizationUrl);
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  const callback = await app(google.fetch).request(
    `/v1/integrations/google-drive/callback?code=fixture-code&state=${encodeURIComponent(state!)}`,
  );
  const connections = await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a");
  const connection = connections.find(
    (candidate) => candidate.metadata.credentialRole === GOOGLE_DRIVE_CREDENTIAL_ROLE,
  );
  expect(connection).toBeTruthy();
  return { start, callback, state: state!, connection: connection! };
}

describe("Google Drive local source preview", () => {
  test("starts an explicit metadata-only OAuth flow with state and PKCE", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const { response, authorizationUrl } = await startConnection(workspace, google.fetch);
    expect(response.status).toBe(200);
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")?.length).toBeGreaterThan(40);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/google-drive/callback",
    );
  });

  test("binds encrypted credentials to the initiating subject and returns to the web origin", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    expect(connected.callback.status).toBe(302);
    expect(connected.callback.headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${workspace.workspaceId}/capabilities?google_drive=connected&connectionId=${connected.connection.id}`,
    );
    expect(google.tokenRequests).toHaveLength(1);
    expect(google.tokenRequests[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(google.apiAuthorizationHeaders).toEqual(["Bearer google-access-token"]);
    expect(connected.connection).toMatchObject({
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      providerDomain: "googleapis.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [GOOGLE_DRIVE_METADATA_READONLY_SCOPE],
      metadata: {
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        googlePermissionId: "google-permission-a",
        googleEmail: "drive.tester@example.com",
        accessMode: "metadata_readonly",
      },
    });
    expect(JSON.stringify(connected.connection)).not.toContain("google-access-token");
    expect(JSON.stringify(connected.connection)).not.toContain("google-refresh-token");

    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: connected.connection.id,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      subjectId: "subject-a",
      allowSubjectOwned: true,
    });
    expect(credential?.credential).toMatchObject({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const replay = await app(google.fetch).request(
      `/v1/integrations/google-drive/callback?code=fixture-code&state=${encodeURIComponent(connected.state)}`,
    );
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain("google_drive=error");
    expect(google.tokenRequests).toHaveLength(1);
  });

  test("browses metadata server-side and saves only connector configuration", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    const authorization = await bearer(workspace, "subject-a", [
      "connections:read",
      "connections:write",
    ]);
    const browse = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(browse.status).toBe(200);
    const listed = (await browse.json()) as {
      items: Array<{ id: string; kind: string }>;
    };
    expect(listed.items).toEqual([
      expect.objectContaining({ id: "folder-1", kind: "folder" }),
      expect.objectContaining({ id: "file-1", kind: "file" }),
    ]);

    const save = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/source`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({
          source: {
            id: "folder-1",
            name: "Product",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
          },
          targetScope: "workspace",
        }),
      },
    );
    expect(save.status).toBe(200);
    const persisted = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.connection.id,
      "subject-a",
    );
    expect(persisted?.metadata).toMatchObject({
      selectedSource: {
        id: "folder-1",
        name: "Product",
        targetScope: "workspace",
      },
    });
    expect(
      await shared!.admin`
      select id from documents where workspace_id = ${workspace.workspaceId}
    `,
    ).toHaveLength(0);
  });

  test("fails closed on account switching and generic credential writes", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const first = googleFixture();
    const connected = await connect(workspace, first);
    const second = googleFixture({ permissionId: "google-permission-b" });
    const reconnect = await startConnection(workspace, second.fetch, connected.connection.id);
    const state = new URL(reconnect.authorizationUrl).searchParams.get("state");
    const callback = await app(second.fetch).request(
      `/v1/integrations/google-drive/callback?code=fixture-code&state=${encodeURIComponent(state!)}`,
    );
    expect(callback.headers.get("location")).toContain("reason=account_mismatch");

    const generic = await app(second.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:write"]),
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({
          providerDomain: "googleapis.com",
          kind: "oauth2",
          subjectId: "subject-a",
          credential: { access_token: "fabricated" },
        }),
      },
    );
    expect(generic.status).toBe(422);
  });

  test("reconnect preserves the existing refresh token when Google omits it", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const first = googleFixture();
    const connected = await connect(workspace, first);
    const reconnect = googleFixture({ omitRefreshToken: true });
    const completed = await connect(workspace, reconnect, connected.connection.id);
    expect(completed.callback.headers.get("location")).toContain("google_drive=connected");
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: connected.connection.id,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      subjectId: "subject-a",
      allowSubjectOwned: true,
    });
    expect(credential?.credential.refresh_token).toBe("google-refresh-token");
  });

  test("reports missing deployment credentials without creating a connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const { response } = await startConnection(workspace, google.fetch);
    expect(response.status).toBe(200);
    const missing = await app(google.fetch, {
      googleDriveClientId: undefined,
      googleDriveClientSecret: undefined,
    }).request(`/v1/workspaces/${workspace.workspaceId}/connections/google-drive/install`, {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", ["connections:write"]),
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      },
      body: "{}",
    });
    expect(missing.status).toBe(503);
  });
});
