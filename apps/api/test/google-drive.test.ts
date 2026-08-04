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
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
} from "@opengeni/contracts/google-drive";
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

function googleFixture(
  options: {
    permissionId?: string;
    omitRefreshToken?: boolean;
    scopes?: string[];
    refreshError?: { status: number; error: string; description: string };
    fileListError?: { status: number; reason: string; message: string };
  } = {},
) {
  const tokenRequests: URLSearchParams[] = [];
  const apiAuthorizationHeaders: string[] = [];
  const fileListQueries: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      tokenRequests.push(body);
      if (body.get("grant_type") === "refresh_token" && options.refreshError) {
        return Response.json(
          {
            error: options.refreshError.error,
            error_description: options.refreshError.description,
          },
          { status: options.refreshError.status },
        );
      }
      return Response.json({
        access_token: "google-access-token",
        ...(options.omitRefreshToken ? {} : { refresh_token: "google-refresh-token" }),
        token_type: "Bearer",
        expires_in: 3600,
        scope: (options.scopes ?? [GOOGLE_DRIVE_READONLY_SCOPE]).join(" "),
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
      fileListQueries.push(url.searchParams.get("q") ?? "");
      if (options.fileListError) {
        return Response.json(
          {
            error: {
              code: options.fileListError.status,
              message: options.fileListError.message,
              errors: [{ reason: options.fileListError.reason }],
            },
          },
          { status: options.fileListError.status },
        );
      }
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
    if (url.pathname === "/drive/v3/files/0AF9DylqqXWK2Uk9PVA") {
      return Response.json({
        id: "0AF9DylqqXWK2Uk9PVA",
        name: "Test google drive",
        mimeType: "application/vnd.google-apps.folder",
        driveId: "0AF9DylqqXWK2Uk9PVA",
        modifiedTime: "2026-07-31T06:00:00.000Z",
        webViewLink: "https://drive.google.com/drive/folders/0AF9DylqqXWK2Uk9PVA",
      });
    }
    if (url.pathname === "/drive/v3/drives/0AF9DylqqXWK2Uk9PVA") {
      return Response.json({
        id: "0AF9DylqqXWK2Uk9PVA",
        name: "Test google drive",
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, tokenRequests, apiAuthorizationHeaders, fileListQueries };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  test("starts an explicit read-only OAuth flow with state and PKCE", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const { response, authorizationUrl } = await startConnection(workspace, google.fetch);
    expect(response.status).toBe(200);
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_DRIVE_READONLY_SCOPE);
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
      grantedScopes: [GOOGLE_DRIVE_READONLY_SCOPE],
      metadata: {
        credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
        googlePermissionId: "google-permission-a",
        googleEmail: "drive.tester@example.com",
        accessMode: "readonly",
        lifecycle: { state: "active", recoverable: true },
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

  test("accepts an explicitly stronger Drive grant through the shared capability decision", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture({ scopes: ["openid", GOOGLE_DRIVE_FULL_SCOPE] });
    const connected = await connect(workspace, google);
    expect(connected.callback.headers.get("location")).toContain("google_drive=connected");
    expect(connected.connection).toMatchObject({
      grantedScopes: ["openid", GOOGLE_DRIVE_FULL_SCOPE],
      metadata: { accessMode: "readonly" },
    });
    expect(google.apiAuthorizationHeaders).toEqual(["Bearer google-access-token"]);
  });

  test("rejects partial Drive grants before identity lookup or credential persistence", async () => {
    if (!available) return;
    for (const scopes of [
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_METADATA_READONLY_SCOPE],
      ["openid", "email"],
    ]) {
      const workspace = await freshWorkspace();
      const google = googleFixture({ scopes });
      const start = await startConnection(workspace, google.fetch);
      const state = new URL(start.authorizationUrl).searchParams.get("state");
      const callback = await app(google.fetch).request(
        `/v1/integrations/google-drive/callback?code=fixture-code&state=${encodeURIComponent(state!)}`,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain("reason=scope_not_granted");
      expect(google.apiAuthorizationHeaders).toEqual([]);
      expect(
        (await listConnectionsMetadata(client.db, workspace.workspaceId, "subject-a")).filter(
          (connection) => connection.providerDomain === "googleapis.com",
        ),
      ).toEqual([]);
    }
  });

  test("browses metadata server-side and saves only connector configuration", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    const authorization = await bearer(workspace, "subject-a", [
      "connections:read",
      "connections:write",
      "workspace:admin",
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
      current: { id: string; kind: string };
      items: Array<{ id: string; kind: string }>;
    };
    expect(listed.current).toEqual(expect.objectContaining({ id: "root", kind: "folder" }));
    expect(listed.items).toEqual([
      expect.objectContaining({ id: "folder-1", kind: "folder" }),
      expect.objectContaining({ id: "file-1", kind: "file" }),
    ]);
    expect(google.fileListQueries).toEqual(["'root' in parents and trashed = false"]);

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
          sources: [
            {
              id: "folder-1",
              name: "Product",
              mimeType: "application/vnd.google-apps.folder",
              driveId: null,
            },
            {
              id: "root",
              name: "My Drive",
              mimeType: "application/vnd.google-apps.folder",
              driveId: null,
            },
          ],
          destination: { authorityKind: "workspace", collectionId: null },
          syncCadence: "hourly",
          readPolicy: "allow",
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
      documentDestination: {
        authorityKind: "workspace",
        authorityAccountId: workspace.accountId,
        authorityWorkspaceId: workspace.workspaceId,
        authoritySubjectId: null,
        collectionId: null,
      },
      selectedSources: [
        {
          id: "folder-1",
          name: "Product",
          destination: {
            authorityKind: "workspace",
            authorityAccountId: workspace.accountId,
            authorityWorkspaceId: workspace.workspaceId,
            authoritySubjectId: null,
          },
          syncCadence: "hourly",
          readPolicy: "allow",
        },
        {
          id: "root",
          name: "My Drive",
          destination: {
            authorityKind: "workspace",
            authorityAccountId: workspace.accountId,
            authorityWorkspaceId: workspace.workspaceId,
            authoritySubjectId: null,
          },
          syncCadence: "hourly",
          readPolicy: "allow",
        },
      ],
    });
    expect(
      await shared!.admin`
      select id from documents where workspace_id = ${workspace.workspaceId}
    `,
    ).toHaveLength(0);
  });

  test("authorizes all connector destinations and keeps legacy config workspace-bound", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    const endpoint =
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/` +
      `${connected.connection.id}/source`;
    const save = async (
      authorization: string,
      destination: Record<string, unknown>,
    ): Promise<Response> =>
      await app(google.fetch).request(endpoint, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({
          sources: [],
          ...destination,
          syncCadence: "hourly",
          readPolicy: "allow",
        }),
      });

    const writer = await bearer(workspace, "subject-a", ["connections:write"]);
    expect(
      (await save(writer, { destination: { authorityKind: "workspace", collectionId: null } }))
        .status,
    ).toBe(403);
    expect(
      (await save(writer, { destination: { authorityKind: "organization", collectionId: null } }))
        .status,
    ).toBe(403);

    const workspaceAdmin = await bearer(workspace, "subject-a", [
      "connections:write",
      "workspace:admin",
    ]);
    expect(
      (await save(workspaceAdmin, { targetScope: "organization" })).status,
    ).toBe(200);
    expect(
      (
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.connection.id,
          "subject-a",
        )
      )?.metadata.documentDestination,
    ).toEqual({
      authorityKind: "workspace",
      authorityAccountId: workspace.accountId,
      authorityWorkspaceId: workspace.workspaceId,
      authoritySubjectId: null,
      collectionId: null,
    });

    expect(
      (
        await save(writer, {
          destination: { authorityKind: "personal", collectionId: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.connection.id,
          "subject-a",
        )
      )?.metadata.documentDestination,
    ).toMatchObject({
      authorityKind: "personal",
      authorityWorkspaceId: workspace.workspaceId,
      authoritySubjectId: "subject-a",
    });

    const accountAdmin = await bearer(workspace, "subject-a", [
      "connections:write",
      "account:admin",
    ]);
    expect(
      (
        await save(accountAdmin, {
          destination: { authorityKind: "organization", collectionId: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await getConnectionMetadata(
          client.db,
          workspace.workspaceId,
          connected.connection.id,
          "subject-a",
        )
      )?.metadata.documentDestination,
    ).toMatchObject({
      authorityKind: "organization",
      authorityAccountId: workspace.accountId,
      authorityWorkspaceId: null,
      authoritySubjectId: null,
    });
  });

  test("pauses and resumes with idempotent version-fenced transitions", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    const authorization = await bearer(workspace, "subject-a", [
      "connections:read",
      "connections:write",
    ]);
    const lifecycleRequest = (action: "pause" | "resume", expectedVersion: number) =>
      app(google.fetch).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/lifecycle`,
        {
          method: "PATCH",
          headers: {
            authorization,
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify({ action, expectedVersion }),
        },
      );

    const [firstPause, duplicatePause] = await Promise.all([
      lifecycleRequest("pause", connected.connection.version),
      lifecycleRequest("pause", connected.connection.version),
    ]);
    expect(firstPause.status).toBe(200);
    expect(duplicatePause.status).toBe(200);
    const pausedBodies = (await Promise.all([firstPause.json(), duplicatePause.json()])) as Array<{
      connection: { version: number; metadata: { lifecycle: { state: string } } };
    }>;
    expect(pausedBodies[0]?.connection.metadata.lifecycle.state).toBe("paused");
    expect(pausedBodies[1]?.connection.metadata.lifecycle.state).toBe("paused");
    expect(pausedBodies[0]?.connection.version).toBe(pausedBodies[1]?.connection.version);

    google.apiAuthorizationHeaders.length = 0;
    const blockedBrowse = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(blockedBrowse.status).toBe(409);
    expect(await blockedBrowse.json()).toMatchObject({
      error: { message: "Google Drive is paused" },
    });
    expect(google.apiAuthorizationHeaders).toEqual([]);

    const staleResume = await lifecycleRequest("resume", connected.connection.version);
    expect(staleResume.status).toBe(409);
    const paused = pausedBodies[0]!.connection;
    const resumed = await lifecycleRequest("resume", paused.version);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      connection: {
        status: "active",
        version: paused.version + 1,
        metadata: { lifecycle: { state: "active", recoverable: true } },
      },
    });

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
  });

  test("fails closed before provider reads when a legacy connection lacks recursive access", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    await shared!.admin`
      update connections
      set granted_scopes = ${shared!.admin.json([GOOGLE_DRIVE_METADATA_READONLY_SCOPE])},
          metadata = jsonb_set(metadata, '{accessMode}', '"metadata_readonly"'::jsonb)
      where id = ${connected.connection.id}
    `;
    google.apiAuthorizationHeaders.length = 0;
    const browse = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(browse.status).toBe(401);
    expect((await browse.json()) as { error: { message: string } }).toMatchObject({
      error: {
        message: "Google Drive needs permission re-consent for selected-source read access",
      },
    });
    expect(google.apiAuthorizationHeaders).toEqual([]);
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.connection.id,
        "subject-a",
      ),
    ).toMatchObject({
      status: "needs_reauth",
      lastError: "google_drive_reconsent_required",
      metadata: { lifecycle: { state: "reconsent_required", recoverable: true } },
    });

    const reconnected = await connect(workspace, googleFixture(), connected.connection.id);
    expect(reconnected.callback.headers.get("location")).toContain("google_drive=connected");
    expect(reconnected.connection).toMatchObject({
      id: connected.connection.id,
      status: "active",
      metadata: {
        googlePermissionId: "google-permission-a",
        accessMode: "readonly",
        lifecycle: { state: "active", recoverable: true },
      },
    });
  });

  test("accepts a pasted Google Drive folder link and rejects lookalike hosts", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const connected = await connect(workspace, google);
    const authorization = await bearer(workspace, "subject-a", ["connections:read"]);
    const sharedDriveId = "0AF9DylqqXWK2Uk9PVA";
    const sharedDriveUrl = `https://drive.google.com/drive/u/0/folders/${sharedDriveId}`;
    const browse = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=${encodeURIComponent(sharedDriveUrl)}`,
      {
        headers: {
          authorization,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(browse.status).toBe(200);
    expect(await browse.json()).toMatchObject({
      parentId: sharedDriveId,
      current: {
        id: sharedDriveId,
        name: "Test google drive",
        kind: "folder",
        driveId: sharedDriveId,
      },
    });
    expect(google.fileListQueries).toEqual([`'${sharedDriveId}' in parents and trashed = false`]);

    const lookalike = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=${encodeURIComponent(`https://example.com/drive/folders/${sharedDriveId}`)}`,
      {
        headers: {
          authorization,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(lookalike.status).toBe(400);
  });

  test("classifies revoked grants and removed apps without retaining provider error bodies", async () => {
    if (!available) return;
    for (const fixture of [
      {
        error: "invalid_grant",
        lifecycle: "token_revoked",
        status: "needs_reauth",
        recoverable: true,
        lastError: "google_drive_token_revoked",
      },
      {
        error: "invalid_client",
        lifecycle: "app_removed",
        status: "error",
        recoverable: false,
        lastError: "google_drive_app_removed",
      },
    ] as const) {
      const workspace = await freshWorkspace();
      const providerDescription = `provider-only-${fixture.error}-detail`;
      const google = googleFixture({
        refreshError: {
          status: 400,
          error: fixture.error,
          description: providerDescription,
        },
      });
      const connected = await connect(workspace, google);
      await shared!.admin`
        update connections
        set expires_at = now() - interval '1 minute'
        where id = ${connected.connection.id}
      `;
      google.apiAuthorizationHeaders.length = 0;
      const browse = await app(google.fetch).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
        {
          headers: {
            authorization: await bearer(workspace, "subject-a", ["connections:read"]),
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
        },
      );
      expect(browse.status).toBe(401);
      const responseBody = JSON.stringify(await browse.json());
      expect(responseBody).not.toContain(providerDescription);
      expect(responseBody).not.toContain(fixture.error);
      expect(google.apiAuthorizationHeaders).toEqual([]);
      expect(google.tokenRequests).toHaveLength(2);

      const persisted = await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.connection.id,
        "subject-a",
      );
      expect(persisted).toMatchObject({
        status: fixture.status,
        lastError: fixture.lastError,
        metadata: {
          lifecycle: {
            state: fixture.lifecycle,
            recoverable: fixture.recoverable,
          },
        },
      });
      const serialized = JSON.stringify(persisted);
      expect(serialized).not.toContain(providerDescription);
      expect(serialized).not.toContain("google-access-token");
      expect(serialized).not.toContain("google-refresh-token");
    }
  });

  test("maps permission failures to re-consent without exposing Google response text", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const providerMessage = "sensitive file permission context";
    const google = googleFixture({
      fileListError: {
        status: 403,
        reason: "insufficientPermissions",
        message: providerMessage,
      },
    });
    const connected = await connect(workspace, google);
    const browse = await app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(browse.status).toBe(403);
    const responseBody = JSON.stringify(await browse.json());
    expect(responseBody).not.toContain(providerMessage);
    expect(responseBody).not.toContain("insufficientPermissions");
    const persisted = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.connection.id,
      "subject-a",
    );
    expect(persisted).toMatchObject({
      status: "needs_reauth",
      version: connected.connection.version + 1,
      lastError: "google_drive_reconsent_required",
      metadata: { lifecycle: { state: "reconsent_required", recoverable: true } },
    });
  });

  test("does not let a stale provider response mutate a reconnected generation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const google = googleFixture();
    const providerRequestStarted = deferred<void>();
    const staleProviderResponse = deferred<Response>();
    const fixtureFetch = google.fetch;
    google.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/drive/v3/files") {
        providerRequestStarted.resolve();
        return await staleProviderResponse.promise;
      }
      return await fixtureFetch(input, init);
    };
    const connected = await connect(workspace, google);
    const browsePromise = app(google.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization: await bearer(workspace, "subject-a", ["connections:read"]),
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    await providerRequestStarted.promise;

    const reconnected = await connect(workspace, googleFixture(), connected.connection.id);
    expect(reconnected.callback.headers.get("location")).toContain("google_drive=connected");
    expect(reconnected.connection).toMatchObject({
      id: connected.connection.id,
      status: "active",
      version: connected.connection.version + 1,
      lastError: null,
      metadata: { lifecycle: { state: "active", recoverable: true } },
    });

    staleProviderResponse.resolve(
      Response.json(
        {
          error: {
            code: 403,
            message: "stale permission response",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
        { status: 403 },
      ),
    );
    const browse = await browsePromise;
    expect(browse.status).toBe(403);

    const persisted = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      connected.connection.id,
      "subject-a",
    );
    expect(persisted).toMatchObject({
      id: connected.connection.id,
      status: "active",
      version: reconnected.connection.version,
      lastError: null,
      metadata: {
        googlePermissionId: "google-permission-a",
        lifecycle: { state: "active", recoverable: true },
      },
    });
    expect(persisted?.updatedAt).toEqual(reconnected.connection.updatedAt);
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

  test("disconnect is local, idempotent, stale-replay safe, and then permits account switching", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const first = googleFixture();
    const connected = await connect(workspace, first);
    const authorization = await bearer(workspace, "subject-a", [
      "connections:read",
      "connections:write",
    ]);
    const disconnectBody = JSON.stringify({
      expectedVersion: connected.connection.version,
      idempotencyKey: `disconnect:${connected.connection.id}:${connected.connection.version}`,
    });
    const disconnect = () =>
      app(first.fetch).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/${connected.connection.id}`,
        {
          method: "DELETE",
          headers: {
            authorization,
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: disconnectBody,
        },
      );
    const [firstDisconnect, duplicateDisconnect] = await Promise.all([disconnect(), disconnect()]);
    expect(firstDisconnect.status).toBe(200);
    expect(duplicateDisconnect.status).toBe(200);
    const firstBody = (await firstDisconnect.json()) as {
      connection: { version: number; status: string; metadata: Record<string, unknown> };
    };
    const duplicateBody = (await duplicateDisconnect.json()) as {
      connection: { version: number; status: string; metadata: Record<string, unknown> };
    };
    expect(firstBody.connection).toMatchObject({
      status: "revoked",
      version: connected.connection.version + 1,
      metadata: { lifecycle: { state: "disconnected", recoverable: true } },
    });
    expect(duplicateBody).toMatchObject({
      connection: {
        status: "revoked",
        version: firstBody.connection.version,
        metadata: { lifecycle: { state: "disconnected" } },
      },
    });
    expect(first.tokenRequests).toHaveLength(1);
    expect(first.apiAuthorizationHeaders).toHaveLength(1);

    const blockedBrowse = await app(first.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(blockedBrowse.status).toBe(409);
    expect(first.apiAuthorizationHeaders).toHaveLength(1);

    const samePermission = googleFixture();
    const reconnected = await connect(workspace, samePermission, connected.connection.id);
    expect(reconnected.callback.headers.get("location")).toContain("google_drive=connected");
    expect(reconnected.connection).toMatchObject({
      id: connected.connection.id,
      subjectId: "subject-a",
      status: "active",
      version: firstBody.connection.version + 1,
      metadata: {
        googlePermissionId: "google-permission-a",
        lifecycle: { state: "active", recoverable: true },
      },
    });

    const staleReplay = await disconnect();
    expect(staleReplay.status).toBe(409);
    expect(
      await getConnectionMetadata(
        client.db,
        workspace.workspaceId,
        connected.connection.id,
        "subject-a",
      ),
    ).toMatchObject({
      status: "active",
      version: reconnected.connection.version,
      metadata: { lifecycle: { state: "active" } },
    });
    expect(first.tokenRequests).toHaveLength(1);
    expect(first.apiAuthorizationHeaders).toHaveLength(1);

    const currentDisconnect = await app(samePermission.fetch).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connected.connection.id}`,
      {
        method: "DELETE",
        headers: {
          authorization,
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({
          expectedVersion: reconnected.connection.version,
          idempotencyKey: `disconnect:${connected.connection.id}:${reconnected.connection.version}`,
        }),
      },
    );
    expect(currentDisconnect.status).toBe(200);

    const second = googleFixture({ permissionId: "google-permission-b" });
    const switched = await connect(workspace, second);
    expect(switched.callback.headers.get("location")).toContain("google_drive=connected");
    expect(switched.connection).toMatchObject({
      subjectId: "subject-a",
      status: "active",
      metadata: {
        googlePermissionId: "google-permission-b",
        lifecycle: { state: "active", recoverable: true },
      },
    });
    expect(switched.connection.id).not.toBe(connected.connection.id);
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
