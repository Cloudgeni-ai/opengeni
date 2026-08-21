import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import type { Settings } from "@opengeni/config";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import {
  PERSONAL_GITHUB_CREDENTIAL_ROLE,
  PERSONAL_GITHUB_TOKEN_URL,
  PERSONAL_GITHUB_USER_URL,
  PersonalGitHubConnectionMetadata,
} from "@opengeni/contracts/personal-github";
import {
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import { createApp } from "../src/app";

const DELEGATION_SECRET = "personal-github-oauth-delegation";
const STATE_SECRET = "personal-github-oauth-state";
const EDGE_ACCESS_KEY = "personal-github-oauth-edge";
const CLIENT_ID = "personal-github-client";
const CLIENT_SECRET = "personal-github-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;
const workspaceIds: string[] = [];

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_PERSONAL_GITHUB_OAUTH_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_PERSONAL_GITHUB_OAUTH_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_PERSONAL_GITHUB_OAUTH_TEST_POSTGRES_ADMIN_URL and OPENGENI_PERSONAL_GITHUB_OAUTH_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end().catch(() => undefined),
    };
  } else {
    shared = await acquireSharedTestDatabase("personal_github_oauth");
  }
  if (!shared) {
    available = false;
    console.warn("[personal-github-oauth] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    authRequired: true,
    accessKey: EDGE_ACCESS_KEY,
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "http://127.0.0.1:8000",
    webBaseUrl: "http://127.0.0.1:3000",
    githubPersonalOauthEnabled: true,
    githubPersonalOauthClientId: CLIENT_ID,
    githubPersonalOauthClientSecret: CLIENT_SECRET,
  });
}, 180_000);

afterAll(async () => {
  for (const workspaceId of workspaceIds) {
    await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function freshWorkspace() {
  const userId = `personal-github-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal GitHub user",
  });
  const workspaceId = access.defaultWorkspaceId!;
  const personalWorkspaceId = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId !== workspaceId,
  )!.workspaceId;
  const grant = access.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId)!;
  workspaceIds.push(...access.workspaceGrants.map((candidate) => candidate.workspaceId));
  return { accountId: grant.accountId, workspaceId, personalWorkspaceId, subjectId };
}

async function bearer(
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  principalKind: "human_session" | "service" = "human_session",
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions: ["connections:read", "connections:write", "workspace:read"],
    principalKind,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

function githubFixture() {
  const tokenRequests: URLSearchParams[] = [];
  let githubUserId = 123456;
  let scopes = "repo";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === PERSONAL_GITHUB_TOKEN_URL) {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      tokenRequests.push(body);
      return Response.json({
        access_token: `github-access-${tokenRequests.length}`,
        refresh_token: `github-refresh-${tokenRequests.length}`,
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
        scope: scopes,
      });
    }
    if (url.href === PERSONAL_GITHUB_USER_URL) {
      return Response.json(
        { id: githubUserId, login: `octocat-${githubUserId}` },
        { headers: { "x-oauth-scopes": scopes } },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return {
    fetch,
    tokenRequests,
    setGitHubUserId(value: number) {
      githubUserId = value;
    },
    setScopes(value: string) {
      scopes = value;
    },
  };
}

function testApp(fixture: ReturnType<typeof githubFixture>) {
  return createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    githubPersonalFetch: fixture.fetch,
  } as never);
}

async function start(
  fixture: ReturnType<typeof githubFixture>,
  workspace: Awaited<ReturnType<typeof freshWorkspace>>,
  connectionId?: string,
  principalKind: "human_session" | "service" = "human_session",
) {
  const path = connectionId
    ? `/v1/workspaces/${workspace.workspaceId}/connections/${connectionId}/github/reconnect`
    : `/v1/workspaces/${workspace.workspaceId}/connections/github/oauth/start`;
  const response = await testApp(fixture).request(path, {
    method: "POST",
    headers: {
      authorization: await bearer(workspace, principalKind),
      "content-type": "application/json",
      "x-opengeni-access-key": EDGE_ACCESS_KEY,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    },
    body: "{}",
  });
  const body = (await response.json()) as { authorizationUrl?: string; error?: unknown };
  return { response, authorizationUrl: body.authorizationUrl ?? "", body };
}

async function callback(fixture: ReturnType<typeof githubFixture>, state: string) {
  return await testApp(fixture).request(
    `/v1/integrations/github-personal/oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
  );
}

describe("personal GitHub OAuth", () => {
  test("connects one verified user-owned account with PKCE and encrypted credentials", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = githubFixture();
    const started = await start(fixture, workspace);
    expect(started.response.status).toBe(200);
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://github.com");
    expect(authorizationUrl.searchParams.get("scope")).toBe("repo");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/github-personal/oauth/callback",
    );
    const state = authorizationUrl.searchParams.get("state")!;
    const connected = await callback(fixture, state);
    expect(connected.status).toBe(302);
    const location = new URL(connected.headers.get("location")!);
    expect(location.searchParams.get("github_personal_oauth")).toBe("success");

    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    const connection = connections[0]!;
    expect(connection).toMatchObject({
      subjectId: workspace.subjectId,
      authorityId: expect.any(String),
      providerDomain: "github.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: ["repo"],
      metadata: {
        credentialRole: PERSONAL_GITHUB_CREDENTIAL_ROLE,
        providerFamily: "github",
        providerPrincipalId: "123456",
        githubUserId: "123456",
        githubLogin: "octocat-123456",
      },
    });
    expect(JSON.stringify(connection)).not.toContain("github-access");
    expect(JSON.stringify(connection)).not.toContain(CLIENT_SECRET);
    const credential = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: workspace.workspaceId,
      connectionId: connection.id,
      providerDomain: "github.com",
      kind: "oauth2",
      subjectId: workspace.subjectId,
      allowSubjectOwned: true,
    });
    expect(credential?.credential).toMatchObject({
      access_token: "github-access-1",
      refresh_token: "github-refresh-1",
      client_id: CLIENT_ID,
    });
    expect(credential?.credential.client_secret).toBeUndefined();
    expect(fixture.tokenRequests[0]?.get("code_verifier")).toHaveLength(64);

    const replay = await callback(fixture, state);
    expect(new URL(replay.headers.get("location")!).searchParams.get("reason")).toBe(
      "state_replayed",
    );
    expect(fixture.tokenRequests).toHaveLength(1);

    const expiredState = createSignedState(
      STATE_SECRET,
      readSignedState(state, STATE_SECRET) as Record<string, unknown>,
      Math.floor(Date.now() / 1_000) - 601,
    );
    const expired = await callback(fixture, expiredState);
    expect(new URL(expired.headers.get("location")!).searchParams.get("reason")).toBe(
      "invalid_state",
    );
    expect(fixture.tokenRequests).toHaveLength(1);
  }, 60_000);

  test("the signed canonical managed-human claim reaches the personal-workspace authority lane", async () => {
    if (!available) return;
    const provisioned = await freshWorkspace();
    const workspace = { ...provisioned, workspaceId: provisioned.personalWorkspaceId };
    const fixture = githubFixture();
    const started = await start(fixture, workspace);
    expect(started.response.status).toBe(200);
    const originalState = new URL(started.authorizationUrl).searchParams.get("state")!;
    const decoded = readSignedState(originalState, STATE_SECRET) as Record<string, unknown>;
    const canonicalState = createSignedState(STATE_SECRET, {
      ...decoded,
      canonicalManagedHumanSession: true,
    });
    const connected = await callback(fixture, canonicalState);
    expect(
      new URL(connected.headers.get("location")!).searchParams.get("github_personal_oauth"),
    ).toBe("success");
    const [connection] = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connection?.authorityId).toEqual(expect.any(String));
    expect(connection?.subjectId).toBe(workspace.subjectId);
  }, 60_000);

  test("repeated and concurrent same-account starts preserve one stable credential binding", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = githubFixture();
    const firstStart = await start(fixture, workspace);
    await callback(fixture, new URL(firstStart.authorizationUrl).searchParams.get("state")!);
    const [first] = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    const firstMetadata = PersonalGitHubConnectionMetadata.parse(first!.metadata);

    const secondStart = await start(fixture, workspace);
    await callback(fixture, new URL(secondStart.authorizationUrl).searchParams.get("state")!);
    const concurrentStarts = await Promise.all([
      start(fixture, workspace),
      start(fixture, workspace),
    ]);
    const concurrentCallbacks = await Promise.all(
      concurrentStarts.map(
        async (candidate) =>
          await callback(fixture, new URL(candidate.authorizationUrl).searchParams.get("state")!),
      ),
    );
    expect(
      concurrentCallbacks.map((response) =>
        new URL(response.headers.get("location")!).searchParams.get("github_personal_oauth"),
      ),
    ).toEqual(["success", "success"]);

    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    const finalMetadata = PersonalGitHubConnectionMetadata.parse(connections[0]!.metadata);
    expect(finalMetadata.credentialBindingId).toBe(firstMetadata.credentialBindingId);
    expect(finalMetadata.connectedAt).toBe(firstMetadata.connectedAt);
  }, 60_000);

  test("concurrent first connects for different GitHub accounts admit exactly one principal", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const firstFixture = githubFixture();
    const secondFixture = githubFixture();
    secondFixture.setGitHubUserId(999999);
    const [firstStart, secondStart] = await Promise.all([
      start(firstFixture, workspace),
      start(secondFixture, workspace),
    ]);
    const callbacks = await Promise.all([
      callback(firstFixture, new URL(firstStart.authorizationUrl).searchParams.get("state")!),
      callback(secondFixture, new URL(secondStart.authorizationUrl).searchParams.get("state")!),
    ]);
    expect(
      callbacks
        .map((response) =>
          new URL(response.headers.get("location")!).searchParams.get("github_personal_oauth"),
        )
        .sort(),
    ).toEqual(["error", "success"]);
    const connections = await listConnectionsMetadata(
      client.db,
      workspace.workspaceId,
      workspace.subjectId,
    );
    expect(connections).toHaveLength(1);
    expect(["123456", "999999"]).toContain(
      PersonalGitHubConnectionMetadata.parse(connections[0]!.metadata).providerPrincipalId,
    );
  }, 60_000);

  test("rejects machines, generic credential injection, insufficient scopes, and account switches", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = githubFixture();
    expect((await start(fixture, workspace, undefined, "service")).response.status).toBe(422);

    const generic = await testApp(fixture).request(
      `/v1/workspaces/${workspace.workspaceId}/connections`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(workspace),
          "content-type": "application/json",
          "x-opengeni-access-key": EDGE_ACCESS_KEY,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({
          providerDomain: "github.com",
          kind: "oauth2",
          ownership: "personal",
          credential: { access_token: "forged" },
          metadata: {},
        }),
      },
    );
    expect(generic.status).toBe(422);

    fixture.setScopes("read:user");
    const insufficient = await start(fixture, workspace);
    const denied = await callback(
      fixture,
      new URL(insufficient.authorizationUrl).searchParams.get("state")!,
    );
    expect(new URL(denied.headers.get("location")!).searchParams.get("reason")).toBe(
      "scope_not_granted",
    );
    fixture.setScopes("repo");

    const connectedStart = await start(fixture, workspace);
    await callback(fixture, new URL(connectedStart.authorizationUrl).searchParams.get("state")!);
    const connection = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;
    const reconnect = await start(fixture, workspace, connection.id);
    fixture.setGitHubUserId(999999);
    const switched = await callback(
      fixture,
      new URL(reconnect.authorizationUrl).searchParams.get("state")!,
    );
    expect(new URL(switched.headers.get("location")!).searchParams.get("reason")).toBe(
      "account_mismatch",
    );
    const unchanged = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;
    expect(unchanged.version).toBe(connection.version);
  }, 60_000);

  test("disconnect is generation-fenced and idempotent", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const fixture = githubFixture();
    const started = await start(fixture, workspace);
    await callback(fixture, new URL(started.authorizationUrl).searchParams.get("state")!);
    const connection = (
      await listConnectionsMetadata(client.db, workspace.workspaceId, workspace.subjectId)
    )[0]!;
    const body = {
      expectedVersion: connection.version,
      idempotencyKey: crypto.randomUUID(),
    };
    const authorization = await bearer(workspace);
    const machineDisconnect = await testApp(fixture).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "DELETE",
        headers: {
          authorization: await bearer(workspace, "service"),
          "content-type": "application/json",
          "x-opengeni-access-key": EDGE_ACCESS_KEY,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify(body),
      },
    );
    expect(machineDisconnect.status).toBe(422);
    const genericDisconnect = await testApp(fixture).request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
      {
        method: "DELETE",
        headers: {
          authorization,
          "content-type": "application/json",
          "x-opengeni-access-key": EDGE_ACCESS_KEY,
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: "{}",
      },
    );
    expect(genericDisconnect.status).toBe(400);
    const disconnect = () =>
      testApp(fixture).request(
        `/v1/workspaces/${workspace.workspaceId}/connections/${connection.id}`,
        {
          method: "DELETE",
          headers: {
            authorization,
            "content-type": "application/json",
            "x-opengeni-access-key": EDGE_ACCESS_KEY,
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify(body),
        },
      );
    const first = await disconnect();
    const second = await disconnect();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await first.json()) as { connection: { status: string } }).connection.status).toBe(
      "revoked",
    );
    expect(((await second.json()) as { connection: { status: string } }).connection.status).toBe(
      "revoked",
    );
  }, 60_000);
});
