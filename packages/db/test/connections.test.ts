import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  buildConnectionTokenResolver,
  buildHostConnectionTokenResolver,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  ConnectionRefreshHttpError,
  HostMcpCredentialBindingError,
  HostMcpCredentialScopeError,
  normalizeBearerScheme,
  createConnection,
  createDb,
  consumeIntegrationOAuthStateNonce,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  getConnectionMetadata,
  isPrivateAddress,
  loadIntegrationOAuthClient,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  recordConnectionTokenRefresh,
  recordConnectionUsed,
  refreshOAuthConnectionCredential,
  replaceIntegrationOAuthClientIfCurrent,
  revokeConnection,
  setConnectionStatus,
  storeIntegrationOAuthClient,
  transitionConnectionState,
  withDatabaseStatementTimeout,
  type ConnectionBrokerDeps,
  type ConnectionCredentialForBroker,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

const rawKey = randomBytes(32);
const settings = testSettings({ environmentsEncryptionKey: rawKey.toString("base64") }) as Settings;
const key = environmentsEncryptionKeyBytes(settings)!;

function enc(value: Record<string, unknown>): string {
  return encryptEnvironmentValue(key, JSON.stringify(value));
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function brokerCredential(
  overrides: Partial<ConnectionCredentialForBroker> = {},
): ConnectionCredentialForBroker {
  return {
    id: "conn_1",
    accountId: "acct_1",
    workspaceId: "ws_1",
    subjectId: null,
    providerDomain: "api.example.com",
    kind: "api_key",
    status: "active",
    credential: { headers: { authorization: "Bearer A" } },
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    version: 1,
    metadata: {},
    ...overrides,
  };
}

type Counts = {
  load: number;
  refresh: number;
  recordRefresh: number;
  recordUsed: number;
  status: number;
  loadInputs: Array<Parameters<ConnectionBrokerDeps["loadCredential"]>[2]>;
  refreshInputs: Array<{ id: string; version: number }>;
};

function resolverDeps(overrides: Partial<ConnectionBrokerDeps> = {}): {
  deps: ConnectionBrokerDeps;
  counts: Counts;
} {
  const counts: Counts = {
    load: 0,
    refresh: 0,
    recordRefresh: 0,
    recordUsed: 0,
    status: 0,
    loadInputs: [],
    refreshInputs: [],
  };
  const deps: ConnectionBrokerDeps = {
    loadCredential: async (_db, _settings, input) => {
      counts.load += 1;
      counts.loadInputs.push(input);
      return brokerCredential();
    },
    recordRefresh: async (_db, input) => {
      counts.recordRefresh += 1;
      counts.refreshInputs.push({ id: input.id, version: input.version });
      return true;
    },
    setStatus: async () => {
      counts.status += 1;
      return true;
    },
    recordUsed: async () => {
      counts.recordUsed += 1;
    },
    refresh: async (cred) => {
      counts.refresh += 1;
      return {
        credential: {
          ...cred.credential,
          access_token: "AC2",
          refresh_token: "RF2",
          token_type: "Bearer",
        },
        expiresAt: new Date(Date.now() + 3_600_000),
        grantedScopes: cred.grantedScopes,
      };
    },
    encrypt: () => "v1:enc",
    keyBytes: () => new Uint8Array(32),
    now: () => new Date(),
    ...overrides,
  };
  return { deps, counts };
}

describe("OAuth endpoint address classification", () => {
  test("IPv4-mapped IPv6 addresses are classified through their embedded IPv4 address", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::FFFF:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:0001")).toBe(true);
    expect(isPrivateAddress("::ffff:1.1.1.1")).toBe(false);
    expect(isPrivateAddress("not an ip address")).toBe(true);
  });
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("connections");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[connections] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("connections table and helpers", () => {
  test("metadata reads omit credential material and filter subject-owned rows", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sharedConnection = await createConnection(db, {
      ...ws,
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer shared" } }),
      grantedScopes: ["read"],
      metadata: { label: "shared" },
      createdBySubjectId: "subject-a",
    });
    const subjectConnection = await createConnection(db, {
      ...ws,
      subjectId: "subject-a",
      providerDomain: "subject.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer subject-a" } }),
    });
    await createConnection(db, {
      ...ws,
      subjectId: "subject-b",
      providerDomain: "other.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer subject-b" } }),
    });

    const sharedOnly = await listConnectionsMetadata(db, ws.workspaceId);
    expect(sharedOnly.map((connection) => connection.id)).toEqual([sharedConnection.id]);
    expect(sharedOnly.some((connection) => "credentialEncrypted" in connection)).toBe(false);

    const visibleToSubjectA = await listConnectionsMetadata(db, ws.workspaceId, "subject-a");
    expect(visibleToSubjectA.map((connection) => connection.id).sort()).toEqual(
      [sharedConnection.id, subjectConnection.id].sort(),
    );
    expect(visibleToSubjectA.some((connection) => "credentialEncrypted" in connection)).toBe(false);

    expect(
      await getConnectionMetadata(db, ws.workspaceId, subjectConnection.id, "subject-b"),
    ).toBeNull();
    const sharedFetched = await getConnectionMetadata(
      db,
      ws.workspaceId,
      sharedConnection.id,
      "subject-b",
    );
    expect(sharedFetched?.providerDomain).toBe("api.example.com");
    expect(sharedFetched && "credentialEncrypted" in sharedFetched).toBe(false);
  });

  test("broker decrypt-read returns credentials but rejects subject-owned rows unless explicitly allowed", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sharedConnection = await createConnection(db, {
      ...ws,
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer shared" } }),
    });
    const subjectConnection = await createConnection(db, {
      ...ws,
      subjectId: "subject-a",
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer subject-a" } }),
    });

    const loaded = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: sharedConnection.id,
      providerDomain: "api.example.com",
      allowSubjectOwned: false,
    });
    expect(loaded?.credential).toEqual({ headers: { authorization: "Bearer shared" } });

    const rejected = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: subjectConnection.id,
      providerDomain: "api.example.com",
      subjectId: "subject-a",
      allowSubjectOwned: false,
    });
    expect(rejected).toBeNull();

    const allowed = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: subjectConnection.id,
      providerDomain: "api.example.com",
      subjectId: "subject-a",
      allowSubjectOwned: true,
    });
    expect(allowed?.credential).toEqual({ headers: { authorization: "Bearer subject-a" } });
  });

  test("provider lookup selects the exact subject even when shared and other-subject rows are newer", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const alice = await createConnection(db, {
      ...ws,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: enc({ headers: { authorization: "Bearer alice" } }),
    });
    const bob = await createConnection(db, {
      ...ws,
      subjectId: "subject-bob",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: enc({ headers: { authorization: "Bearer bob" } }),
    });
    await createConnection(db, {
      ...ws,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: enc({ headers: { authorization: "Bearer shared" } }),
    });

    const aliceLoaded = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectId: "subject-alice",
      allowSubjectOwned: true,
    });
    const bobLoaded = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectId: "subject-bob",
      allowSubjectOwned: true,
    });
    expect(aliceLoaded?.id).toBe(alice.id);
    expect(aliceLoaded?.credential).toEqual({ headers: { authorization: "Bearer alice" } });
    expect(bobLoaded?.id).toBe(bob.id);
    expect(bobLoaded?.credential).toEqual({ headers: { authorization: "Bearer bob" } });
    expect(
      await loadConnectionCredentialForBroker(db, settings, {
        workspaceId: ws.workspaceId,
        providerDomain: "slack.com",
        kind: "oauth2",
        allowSubjectOwned: true,
      }),
    ).toBeNull();
  });

  test("refresh, status, and usage writes retain the exact connection subject", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const alice = await createConnection(db, {
      ...ws,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: enc({
        access_token: "access-alice",
        refresh_token: "refresh-alice",
        token_type: "Bearer",
      }),
    });

    expect(
      await recordConnectionTokenRefresh(db, {
        id: alice.id,
        version: alice.version,
        workspaceId: ws.workspaceId,
        subjectId: "subject-bob",
        credentialEncrypted: enc({ access_token: "access-wrong", token_type: "Bearer" }),
        expiresAt: null,
        lastRefreshAt: new Date(),
      }),
    ).toBe(false);
    expect(
      await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "wrong-subject", {
        id: alice.id,
        version: alice.version,
        subjectId: "subject-bob",
      }),
    ).toBe(false);
    await recordConnectionUsed(db, ws.workspaceId, alice.id, "subject-bob");
    const untouched = await getConnectionMetadata(db, ws.workspaceId, alice.id, "subject-alice");
    expect(untouched).toMatchObject({ status: "active", version: alice.version, lastUsedAt: null });

    await recordConnectionUsed(db, ws.workspaceId, alice.id, "subject-alice");
    expect(
      (await getConnectionMetadata(db, ws.workspaceId, alice.id, "subject-alice"))?.lastUsedAt,
    ).not.toBeNull();
    expect(
      await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "expired", {
        id: alice.id,
        version: alice.version,
        subjectId: "subject-alice",
      }),
    ).toBe(true);
    expect(
      await getConnectionMetadata(db, ws.workspaceId, alice.id, "subject-alice"),
    ).toMatchObject({ status: "needs_reauth", lastError: "expired", subjectId: "subject-alice" });
  });

  test("token refresh and status updates are compare-and-set on id plus version", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const connection = await createConnection(db, {
      ...ws,
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credentialEncrypted: enc({ access_token: "AC", refresh_token: "RF", token_type: "Bearer" }),
      grantedScopes: ["read"],
    });
    const before = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      providerDomain: "oauth.example.com",
    });

    expect(
      await recordConnectionTokenRefresh(db, {
        id: before!.id,
        version: before!.version + 99,
        workspaceId: ws.workspaceId,
        credentialEncrypted: enc({
          access_token: "STALE",
          refresh_token: "RF",
          token_type: "Bearer",
        }),
        expiresAt: null,
        grantedScopes: ["write"],
        lastRefreshAt: new Date(),
      }),
    ).toBe(false);

    expect(
      await recordConnectionTokenRefresh(db, {
        id: before!.id,
        version: before!.version,
        workspaceId: ws.workspaceId,
        credentialEncrypted: enc({
          access_token: "AC2",
          refresh_token: "RF2",
          token_type: "Bearer",
        }),
        expiresAt: new Date(Date.now() + 3_600_000),
        grantedScopes: ["read", "write"],
        lastRefreshAt: new Date(),
      }),
    ).toBe(true);

    const refreshed = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      providerDomain: "oauth.example.com",
    });
    expect(refreshed?.credential).toMatchObject({ access_token: "AC2", refresh_token: "RF2" });
    expect(refreshed?.version).toBe(before!.version + 1);

    expect(
      await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "stale", {
        id: connection.id,
        version: before!.version,
      }),
    ).toBe(false);
    expect(
      await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "expired", {
        id: connection.id,
        version: refreshed!.version,
      }),
    ).toBe(true);
    const afterStatus = await getConnectionMetadata(db, ws.workspaceId, connection.id);
    expect(afterStatus?.status).toBe("needs_reauth");
    expect(afterStatus?.lastError).toBe("expired");
  });

  test("metadata lifecycle transitions advance the shared CAS fence", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const connection = await createConnection(db, {
      ...ws,
      subjectId: "subject-a",
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: enc({ access_token: "AC", refresh_token: "RF" }),
      metadata: { lifecycle: { state: "active" } },
    });

    expect(
      await transitionConnectionState(db, {
        workspaceId: ws.workspaceId,
        connectionId: connection.id,
        visibleToSubjectId: "subject-b",
        expectedVersion: connection.version,
        metadata: { lifecycle: { state: "paused" } },
      }),
    ).toBeNull();

    const transitioned = await transitionConnectionState(db, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      visibleToSubjectId: "subject-a",
      expectedVersion: connection.version,
      status: "needs_reauth",
      metadata: { lifecycle: { state: "reconnect_required" } },
      lastError: "safe_internal_code",
      updatedBySubjectId: "subject-a",
    });
    expect(transitioned).toMatchObject({
      status: "needs_reauth",
      version: connection.version + 1,
      metadata: { lifecycle: { state: "reconnect_required" } },
      lastError: "safe_internal_code",
      updatedBySubjectId: "subject-a",
    });

    expect(
      await transitionConnectionState(db, {
        workspaceId: ws.workspaceId,
        connectionId: connection.id,
        visibleToSubjectId: "subject-a",
        expectedVersion: connection.version,
        metadata: { lifecycle: { state: "paused" } },
      }),
    ).toBeNull();
    expect(
      await recordConnectionTokenRefresh(db, {
        id: connection.id,
        version: connection.version,
        workspaceId: ws.workspaceId,
        subjectId: "subject-a",
        credentialEncrypted: enc({ access_token: "new", refresh_token: "RF" }),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastRefreshAt: new Date(),
      }),
    ).toBe(false);
  });

  test("disconnect receipts fence retries to one subject-owned connection generation", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const connection = await createConnection(db, {
      ...ws,
      subjectId: "subject-a",
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credentialEncrypted: enc({ fixture: "drive-disconnect" }),
      metadata: { lifecycle: { state: "active" } },
    });
    const disconnectInput = {
      ...ws,
      subjectId: "subject-a",
      connectionId: connection.id,
      expectedVersion: connection.version,
      idempotencyKey: "disconnect-generation-1",
      metadata: { lifecycle: { state: "disconnected" } },
      lastError: null,
      updatedBySubjectId: "subject-a",
    };

    const [first, exactRetry] = await Promise.all([
      disconnectConnectionIdempotently(db, disconnectInput),
      disconnectConnectionIdempotently(db, disconnectInput),
    ]);
    expect(first).toMatchObject({
      id: connection.id,
      status: "revoked",
      version: connection.version + 1,
      metadata: { lifecycle: { state: "disconnected" } },
    });
    expect(exactRetry).toMatchObject({
      id: connection.id,
      status: "revoked",
      version: connection.version + 1,
    });

    await expect(
      disconnectConnectionIdempotently(db, {
        ...disconnectInput,
        expectedVersion: connection.version + 1,
      }),
    ).rejects.toBeInstanceOf(ConnectionDisconnectIdempotencyError);

    const reconnected = await transitionConnectionState(db, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      visibleToSubjectId: "subject-a",
      expectedVersion: connection.version + 1,
      status: "active",
      metadata: { lifecycle: { state: "active" } },
      lastError: null,
      updatedBySubjectId: "subject-a",
    });
    expect(reconnected).toMatchObject({
      id: connection.id,
      status: "active",
      version: connection.version + 2,
      metadata: { lifecycle: { state: "active" } },
    });

    await expect(disconnectConnectionIdempotently(db, disconnectInput)).rejects.toBeInstanceOf(
      ConnectionDisconnectGenerationError,
    );
    expect(
      await getConnectionMetadata(db, ws.workspaceId, connection.id, "subject-a"),
    ).toMatchObject({
      status: "active",
      version: connection.version + 2,
      metadata: { lifecycle: { state: "active" } },
    });

    expect(
      await disconnectConnectionIdempotently(db, {
        ...disconnectInput,
        subjectId: "subject-b",
      }),
    ).toBeNull();
  });

  test("a revoke cannot be undone by an in-flight refresh", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const connection = await createConnection(db, {
      ...ws,
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credentialEncrypted: enc({ access_token: "AC", refresh_token: "RF", token_type: "Bearer" }),
    });
    const inFlight = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      providerDomain: "oauth.example.com",
    });

    const revoked = await revokeConnection(db, ws.workspaceId, connection.id);
    expect(revoked?.status).toBe("revoked");

    // The refresh raced the revoke: it still holds the pre-revoke version.
    expect(
      await recordConnectionTokenRefresh(db, {
        id: inFlight!.id,
        version: inFlight!.version,
        workspaceId: ws.workspaceId,
        credentialEncrypted: enc({
          access_token: "AC2",
          refresh_token: "RF2",
          token_type: "Bearer",
        }),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastRefreshAt: new Date(),
      }),
    ).toBe(false);
    const after = await getConnectionMetadata(db, ws.workspaceId, connection.id);
    expect(after?.status).toBe("revoked");
  });

  test("revoke respects subject visibility — another subject's private connection stays untouched", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const subjectConnection = await createConnection(db, {
      ...ws,
      subjectId: "subject-a",
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer subject-a" } }),
    });

    expect(
      await revokeConnection(db, ws.workspaceId, subjectConnection.id, "subject-b"),
    ).toBeNull();
    expect(
      (await getConnectionMetadata(db, ws.workspaceId, subjectConnection.id, "subject-a"))?.status,
    ).toBe("active");

    const ownRevoke = await revokeConnection(db, ws.workspaceId, subjectConnection.id, "subject-a");
    expect(ownRevoke?.status).toBe("revoked");
  });

  test("provider-domain lookup prefers an active row over a freshly revoked one", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const active = await createConnection(db, {
      ...ws,
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer active" } }),
    });
    const doomed = await createConnection(db, {
      ...ws,
      providerDomain: "api.example.com",
      kind: "api_key",
      credentialEncrypted: enc({ headers: { authorization: "Bearer doomed" } }),
    });
    // The revoke bumps updatedAt, making the dead row the NEWEST for the provider.
    await revokeConnection(db, ws.workspaceId, doomed.id);

    const loaded = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      providerDomain: "api.example.com",
    });
    expect(loaded?.id).toBe(active.id);
    expect(loaded?.status).toBe("active");
  });

  test("DCR OAuth client storage returns the first issuer winner without overwriting it", async () => {
    if (!available) return;
    const first = await storeIntegrationOAuthClient(db, {
      issuer: "https://as.example.com",
      authorizationServer: "https://as.example.com",
      clientId: "client-1",
      clientSecretEncrypted: encryptEnvironmentValue(key, "secret-1"),
      tokenEndpointAuthMethod: "client_secret_post",
      metadata: { registrationEndpoint: "https://as.example.com/register-1" },
    });
    const second = await storeIntegrationOAuthClient(db, {
      issuer: "https://as.example.com",
      authorizationServer: "https://as.example.com/other",
      clientId: "client-2",
      clientSecretEncrypted: encryptEnvironmentValue(key, "secret-2"),
      tokenEndpointAuthMethod: "client_secret_post",
      metadata: { registrationEndpoint: "https://as.example.com/register-2" },
    });
    expect(first.clientId).toBe("client-1");
    expect(second.clientId).toBe("client-1");

    const loaded = await loadIntegrationOAuthClient(db, settings, "https://as.example.com");
    expect(loaded).toMatchObject({
      issuer: "https://as.example.com",
      authorizationServer: "https://as.example.com",
      clientId: "client-1",
      clientSecret: "secret-1",
      tokenEndpointAuthMethod: "client_secret_post",
      metadata: { registrationEndpoint: "https://as.example.com/register-1" },
    });
  });

  test("DCR OAuth client replacement is compare-and-swap on the current client", async () => {
    if (!available) return;
    const issuer = `https://issuer-${randomBytes(8).toString("hex")}.example.com`;
    await storeIntegrationOAuthClient(db, {
      issuer,
      authorizationServer: issuer,
      clientId: "client-1",
      metadata: { registrationEndpoint: `${issuer}/register-1` },
    });
    expect(
      await replaceIntegrationOAuthClientIfCurrent(db, {
        issuer,
        authorizationServer: issuer,
        expectedClientId: "already-replaced",
        clientId: "client-2",
        metadata: { registrationEndpoint: `${issuer}/register-2` },
      }),
    ).toBeNull();
    expect(
      await replaceIntegrationOAuthClientIfCurrent(db, {
        issuer,
        authorizationServer: issuer,
        expectedClientId: "client-1",
        clientId: "client-2",
        metadata: { registrationEndpoint: `${issuer}/register-2` },
      }),
    ).toMatchObject({
      clientId: "client-2",
      metadata: { registrationEndpoint: `${issuer}/register-2` },
    });
  });

  test("database statement timeout cancels a stalled operation natively", async () => {
    if (!available) return;
    const startedAt = performance.now();
    let caught: unknown;
    try {
      await withDatabaseStatementTimeout(db, 25, async (scopedDb) => {
        await scopedDb.execute(sql`select pg_sleep(1)`);
      });
    } catch (error) {
      caught = error;
    }
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(caught).toMatchObject({ cause: { code: "57014" } });
  });

  test("OAuth state nonce consumption is single-use and TTL-cleaned per workspace", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const now = new Date();
    const first = await consumeIntegrationOAuthStateNonce(db, {
      ...ws,
      subjectId: "subject-a",
      nonce: "nonce-1",
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    const replay = await consumeIntegrationOAuthStateNonce(db, {
      ...ws,
      subjectId: "subject-a",
      nonce: "nonce-1",
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    expect(first).toBe(true);
    expect(replay).toBe(false);

    const expired = await consumeIntegrationOAuthStateNonce(db, {
      ...ws,
      subjectId: "subject-a",
      nonce: "expired",
      expiresAt: new Date(now.getTime() - 60_000),
      now: new Date(now.getTime() - 120_000),
    });
    expect(expired).toBe(true);
    const afterCleanup = await consumeIntegrationOAuthStateNonce(db, {
      ...ws,
      subjectId: "subject-a",
      nonce: "expired",
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    expect(afterCleanup).toBe(true);
  });
});

describe("buildHostConnectionTokenResolver", () => {
  const context = {
    accountId: "acct_1",
    workspaceId: "ws_1",
    sessionId: "session_1",
    rootSessionId: "session_root",
    turnId: "turn_1",
    attemptId: "attempt_1",
    executionGeneration: 4,
    initiator: { kind: "subject" as const, subjectId: "host:user:42", label: "Ada" },
    initiatorContext: { source: "host", via: [{ kind: "agent" }] },
    surface: "model" as const,
  };

  test("forwards frozen turn authority and returns a scope-checked header snapshot", async () => {
    let received: unknown;
    const headers = { Authorization: "Bearer host-token" };
    const resolver = buildHostConnectionTokenResolver(async (request) => {
      received = request;
      return {
        status: "ok",
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        headers,
        connectionId: "host-connection-7",
        providerDomain: request.connectionRef.providerDomain,
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
        ...(request.connectionRef.scopes ? { scopes: request.connectionRef.scopes } : {}),
        ...(request.connectionRef.selectedResources
          ? { selectedResources: request.connectionRef.selectedResources }
          : {}),
        expiresAt: "2026-07-21T23:00:00.000Z",
      };
    }, context);

    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "worker:first-party-mcp",
      serverId: "github",
      destinationUrl: "https://GitHub.com/mcp/",
      toolName: "create_pull_request",
      connectionRef: {
        provider: "github",
        providerDomain: "github.com",
        kind: "app_install",
        connectionId: "host-connection-7",
        scopes: ["repo"],
        selectedResources: [
          { kind: "repository", id: "101" },
          { kind: "repository", id: "202" },
        ],
      },
      forceRefresh: true,
    });

    expect(received).toEqual({
      ...context,
      callerSubjectId: "worker:first-party-mcp",
      serverId: "github",
      toolName: "create_pull_request",
      destinationUrl: "https://github.com/mcp",
      connectionRef: {
        provider: "github",
        providerDomain: "github.com",
        kind: "app_install",
        connectionId: "host-connection-7",
        scopes: ["repo"],
        selectedResources: [
          { kind: "repository", id: "101" },
          { kind: "repository", id: "202" },
        ],
      },
      forceRefresh: true,
    });
    expect(result).toEqual({
      status: "ok",
      headers: { Authorization: "Bearer host-token" },
      connectionId: "host-connection-7",
      expiresAt: new Date("2026-07-21T23:00:00.000Z"),
    });
    headers.Authorization = "Bearer mutated-after-return";
    expect(result).toMatchObject({ headers: { Authorization: "Bearer host-token" } });
  });

  test("rejects a mismatched host scope before returning credential material", async () => {
    const resolver = buildHostConnectionTokenResolver(
      async () => ({
        status: "ok",
        accountId: "acct_1",
        workspaceId: "other-workspace",
        sessionId: "session_1",
        headers: { Authorization: "Bearer wrong-tenant" },
        connectionId: "host-connection-7",
        providerDomain: "github.com",
      }),
      context,
    );

    expect(
      resolver({
        workspaceId: "ws_1",
        serverId: "github",
        destinationUrl: "https://github.com/mcp",
        connectionRef: { providerDomain: "github.com" },
      }),
    ).rejects.toBeInstanceOf(HostMcpCredentialScopeError);
  });

  test("rejects a destination/provider mismatch before invoking the host", async () => {
    let calls = 0;
    const resolver = buildHostConnectionTokenResolver(async () => {
      calls += 1;
      return {
        status: "ok",
        accountId: "acct_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
        headers: { Authorization: "Bearer must-not-escape" },
        connectionId: "host-connection-7",
        providerDomain: "github.com",
      };
    }, context);

    await expect(
      resolver({
        workspaceId: "ws_1",
        serverId: "github",
        destinationUrl: "https://attacker.example/mcp",
        connectionRef: { provider: "github", providerDomain: "github.com" },
      }),
    ).rejects.toBeInstanceOf(HostMcpCredentialBindingError);
    expect(calls).toBe(0);
  });

  test("rejects host credential material routed from a different binding or repository set", async () => {
    const resolver = buildHostConnectionTokenResolver(
      async (request) => ({
        status: "ok",
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        headers: { Authorization: "Bearer wrong-binding" },
        connectionId: "host-connection-other",
        provider: "github",
        providerDomain: "github.com",
        selectedResources: [{ kind: "repository", id: "999" }],
      }),
      context,
    );

    expect(
      resolver({
        workspaceId: "ws_1",
        serverId: "github",
        destinationUrl: "https://github.com/mcp",
        connectionRef: {
          connectionId: "host-connection-7",
          provider: "github",
          providerDomain: "github.com",
          selectedResources: [{ kind: "repository", id: "101" }],
        },
      }),
    ).rejects.toBeInstanceOf(HostMcpCredentialBindingError);
  });

  test("passes through reconnect metadata without credential headers", async () => {
    const resolver = buildHostConnectionTokenResolver(
      async (request) => ({
        status: "auth_needed",
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        reason: "expired",
        providerDomain: "gitlab.com",
        connectionId: "gitlab-connection",
        scopes: ["api"],
        authorizationUrl: "https://host.example/reconnect/gitlab-connection",
      }),
      { ...context, surface: "toolspace" },
    );

    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "gitlab",
      destinationUrl: "https://gitlab.com/mcp",
      connectionRef: { providerDomain: "gitlab.com" },
    });
    expect(result).toEqual({
      status: "auth_needed",
      reason: "expired",
      providerDomain: "gitlab.com",
      connectionId: "gitlab-connection",
      scopes: ["api"],
      authorizationUrl: "https://host.example/reconnect/gitlab-connection",
    });
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });

  test("rejects insecure non-loopback reconnect URLs", async () => {
    const resolver = buildHostConnectionTokenResolver(
      async (request) => ({
        status: "auth_needed",
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        reason: "expired",
        providerDomain: "gitlab.com",
        authorizationUrl: "http://host.example/reconnect",
      }),
      context,
    );
    expect(
      resolver({
        workspaceId: "ws_1",
        serverId: "gitlab",
        destinationUrl: "https://gitlab.com/mcp",
        connectionRef: { providerDomain: "gitlab.com" },
      }),
    ).rejects.toThrow("invalid authorizationUrl");
  });
});

describe("buildConnectionTokenResolver", () => {
  test("fails closed before credential lookup for repository-scoped provider bindings", async () => {
    const { deps, counts } = resolverDeps();
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "github",
      destinationUrl: "https://github.com/mcp",
      connectionRef: {
        connectionId: "github-installation-one",
        provider: "github",
        providerDomain: "github.com",
        kind: "app_install",
        selectedResources: [{ kind: "repository", id: "101" }],
      },
    });
    expect(result).toEqual({
      status: "auth_needed",
      reason: "resource_scope_unavailable",
      connectionId: "github-installation-one",
      provider: "github",
      providerDomain: "github.com",
      selectedResources: [{ kind: "repository", id: "101" }],
    });
    expect(counts.load).toBe(0);
    expect(counts.recordUsed).toBe(0);
  });

  test("materializes api_key headers and records usage", async () => {
    const { deps, counts } = resolverDeps();
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "subject-a",
      serverId: "srv_1",
      destinationUrl: "https://api.example.com/mcp",
      connectionRef: { providerDomain: "api.example.com", kind: "api_key", scopes: [] },
    });
    expect(result).toEqual({
      status: "ok",
      headers: { authorization: "Bearer A" },
      connectionId: "conn_1",
      connectionVersion: 1,
      expiresAt: null,
    });
    expect(counts.recordUsed).toBe(1);
    expect(counts.loadInputs[0]).toMatchObject({
      allowSubjectOwned: false,
      providerDomain: "api.example.com",
      kind: "api_key",
    });
    expect(counts.loadInputs[0]).not.toHaveProperty("subjectId");
  });

  test("subject refs require a concrete owner and reject a faulty cross-subject loader", async () => {
    const { deps, counts } = resolverDeps();
    deps.loadCredential = async (_db, _settings, input) => {
      counts.load += 1;
      counts.loadInputs.push(input);
      return brokerCredential({
        id: "conn-bob",
        subjectId: "subject-bob",
        providerDomain: "slack.com",
        kind: "oauth2",
      });
    };
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const noSubject = await resolver({
      workspaceId: "ws_1",
      serverId: "slack",
      destinationUrl: "https://slack.com/mcp",
      connectionRef: {
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(noSubject).toMatchObject({
      status: "auth_needed",
      reason: "personal_authority_unavailable",
    });
    expect(counts.load).toBe(0);

    const wrongOwner = await resolver({
      workspaceId: "ws_1",
      subjectId: "subject-alice",
      serverId: "slack",
      destinationUrl: "https://slack.com/mcp",
      connectionRef: {
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(wrongOwner).toMatchObject({ status: "auth_needed", reason: "missing_connection" });
    expect(counts.load).toBe(1);
    expect(counts.loadInputs[0]).toMatchObject({
      allowSubjectOwned: true,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
    });
    expect(counts.recordUsed).toBe(0);
  });

  test("returns auth_needed for missing scopes without exposing credential material", async () => {
    const { deps, counts } = resolverDeps({
      loadCredential: async () => brokerCredential({ grantedScopes: ["read"] }),
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "srv_1",
      destinationUrl: "https://api.example.com/mcp",
      connectionRef: {
        providerDomain: "api.example.com",
        kind: "api_key",
        scopes: ["read", "write"],
      },
    });
    expect(result).toEqual({
      status: "auth_needed",
      reason: "insufficient_scope",
      providerDomain: "api.example.com",
      connectionId: "conn_1",
      scopes: ["write"],
    });
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(counts.recordUsed).toBe(0);
  });

  test("single-flight refresh coalesces concurrent forced oauth refreshes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loadCalls = 0;
    const stale = brokerCredential({
      id: "conn_oauth",
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credential: { access_token: "AC", refresh_token: "RF", token_type: "Bearer" },
      expiresAt: new Date(Date.now() - 1_000),
      grantedScopes: ["read"],
      version: 7,
    });
    const refreshed = brokerCredential({
      ...stale,
      credential: { access_token: "AC2", refresh_token: "RF2", token_type: "Bearer" },
      expiresAt: new Date(Date.now() + 3_600_000),
      version: 8,
    });
    const { deps, counts } = resolverDeps({
      loadCredential: async () => {
        loadCalls += 1;
        return loadCalls <= 2 ? stale : refreshed;
      },
      refresh: async (cred) => {
        counts.refresh += 1;
        await gate;
        return {
          credential: { ...cred.credential, access_token: "AC2", refresh_token: "RF2" },
          expiresAt: refreshed.expiresAt,
          grantedScopes: ["read"],
        };
      },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const both = Promise.all([
      resolver({
        workspaceId: "ws_1",
        serverId: "srv_1",
        destinationUrl: "https://oauth.example.com/mcp",
        connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2", scopes: ["read"] },
        forceRefresh: true,
      }),
      resolver({
        workspaceId: "ws_1",
        serverId: "srv_1",
        destinationUrl: "https://oauth.example.com/mcp",
        connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2", scopes: ["read"] },
        forceRefresh: true,
      }),
    ]);
    release();
    const results = await both;
    expect(counts.refresh).toBe(1);
    expect(counts.recordRefresh).toBe(1);
    expect(counts.refreshInputs).toEqual([{ id: "conn_oauth", version: 7 }]);
    expect(results).toEqual([
      {
        status: "ok",
        headers: { authorization: "Bearer AC2" },
        connectionId: "conn_oauth",
        connectionVersion: 8,
        expiresAt: refreshed.expiresAt,
      },
      {
        status: "ok",
        headers: { authorization: "Bearer AC2" },
        connectionId: "conn_oauth",
        connectionVersion: 8,
        expiresAt: refreshed.expiresAt,
      },
    ]);
  });

  test("a transient refresh failure (AS 5xx / network) does not poison the connection", async () => {
    const stale = brokerCredential({
      id: "conn_oauth",
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credential: { access_token: "AC", refresh_token: "RF", token_type: "Bearer" },
      expiresAt: new Date(Date.now() - 1_000),
      version: 3,
    });
    const { deps, counts } = resolverDeps({
      loadCredential: async () => stale,
      refresh: async () => {
        counts.refresh += 1;
        throw new ConnectionRefreshHttpError(503);
      },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "srv_1",
      destinationUrl: "https://oauth.example.com/mcp",
      connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2" },
    });
    expect(result).toMatchObject({
      status: "auth_needed",
      reason: "refresh_failed",
      connectionId: "conn_oauth",
    });
    expect(counts.status).toBe(0);
  });

  test("a 429 from the token endpoint is transient — no needs_reauth", async () => {
    const stale = brokerCredential({
      id: "conn_oauth",
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credential: { access_token: "AC", refresh_token: "RF", token_type: "Bearer" },
      expiresAt: new Date(Date.now() - 1_000),
      version: 3,
    });
    const { deps, counts } = resolverDeps({
      loadCredential: async () => stale,
      refresh: async () => {
        counts.refresh += 1;
        throw new ConnectionRefreshHttpError(429);
      },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "srv_1",
      destinationUrl: "https://oauth.example.com/mcp",
      connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2" },
    });
    expect(result).toMatchObject({ status: "auth_needed", reason: "refresh_failed" });
    expect(counts.status).toBe(0);
  });

  test("refresh token POST rejects redirects without marking needs_reauth", async () => {
    let redirectTargetHits = 0;
    const redirectTarget = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        redirectTargetHits += 1;
        return Response.json({
          access_token: "redirected-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    });
    let tokenHits = 0;
    let tokenRequestBody: URLSearchParams | null = null;
    const tokenEndpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        tokenHits += 1;
        tokenRequestBody = new URLSearchParams(await request.text());
        return new Response("", {
          status: 302,
          headers: { location: `http://127.0.0.1:${redirectTarget.port}/capture` },
        });
      },
    });
    try {
      const stale = brokerCredential({
        id: "conn_oauth",
        providerDomain: "oauth.example.com",
        kind: "oauth2",
        credential: {
          access_token: "AC",
          refresh_token: "RF",
          token_type: "Bearer",
          token_endpoint: `http://127.0.0.1:${tokenEndpoint.port}/token`,
        },
        expiresAt: new Date(Date.now() - 1_000),
        version: 3,
      });
      let observedError: unknown;
      const { deps, counts } = resolverDeps({
        loadCredential: async () => stale,
        refresh: async (cred, ref) => {
          counts.refresh += 1;
          try {
            return await refreshOAuthConnectionCredential(cred, ref, settings);
          } catch (error) {
            observedError = error;
            throw error;
          }
        },
      });
      const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
      const result = await resolver({
        workspaceId: "ws_1",
        serverId: "srv_1",
        destinationUrl: "https://oauth.example.com/mcp",
        connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2" },
      });
      expect(result).toMatchObject({
        status: "auth_needed",
        reason: "refresh_failed",
        connectionId: "conn_oauth",
      });
      expect(observedError).toBeInstanceOf(ConnectionRefreshHttpError);
      expect((observedError as ConnectionRefreshHttpError).httpStatus).toBe(302);
      expect(counts.status).toBe(0);
      expect(tokenHits).toBe(1);
      expect(tokenRequestBody!.get("grant_type")).toBe("refresh_token");
      expect(tokenRequestBody!.get("refresh_token")).toBe("RF");
      expect(redirectTargetHits).toBe(0);
    } finally {
      tokenEndpoint.stop(true);
      redirectTarget.stop(true);
    }
  });

  test("public-client refresh sends client_id from the credential bundle", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: URLSearchParams | null = null;
    let capturedSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = new URLSearchParams(String(init?.body));
      capturedSignal = init?.signal ?? null;
      return new Response(
        JSON.stringify({ access_token: "AC2", token_type: "Bearer", expires_in: 3600 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    try {
      const refreshed = await refreshOAuthConnectionCredential(
        brokerCredential({
          kind: "oauth2",
          credential: {
            access_token: "AC",
            refresh_token: "RF",
            token_type: "Bearer",
            token_endpoint: "https://as.example.com/token",
            client_id: "https://opengeni.example.com/v1/integrations/oauth/client-metadata.json",
          },
        }),
        { providerDomain: "oauth.example.com", kind: "oauth2" },
        settings,
        {
          fetchImpl: globalThis.fetch,
          dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
        },
      );
      expect(refreshed.credential).toMatchObject({ access_token: "AC2" });
      expect(capturedBody!.get("client_id")).toBe(
        "https://opengeni.example.com/v1/integrations/oauth/client-metadata.json",
      );
      expect(capturedBody!.get("grant_type")).toBe("refresh_token");
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a rejected refresh grant (4xx) marks the connection needs_reauth", async () => {
    const stale = brokerCredential({
      id: "conn_oauth",
      providerDomain: "oauth.example.com",
      kind: "oauth2",
      credential: { access_token: "AC", refresh_token: "RF", token_type: "Bearer" },
      expiresAt: new Date(Date.now() - 1_000),
      version: 3,
    });
    const { deps, counts } = resolverDeps({
      loadCredential: async () => stale,
      refresh: async () => {
        counts.refresh += 1;
        throw new ConnectionRefreshHttpError(400);
      },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "srv_1",
      destinationUrl: "https://oauth.example.com/mcp",
      connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2" },
    });
    expect(result).toMatchObject({
      status: "auth_needed",
      reason: "refresh_failed",
      connectionId: "conn_oauth",
    });
    expect(counts.status).toBe(1);
  });

  test("a provider adapter owns a bounded permanent-refresh lifecycle transition", async () => {
    const stale = brokerCredential({
      id: "conn_google",
      workspaceId: "ws_google",
      subjectId: "subject-a",
      providerDomain: "googleapis.com",
      kind: "oauth2",
      credential: { access_token: "AC", refresh_token: "RF", token_type: "Bearer" },
      expiresAt: new Date(Date.now() - 1_000),
      version: 11,
    });
    const observed = [] as Array<Record<string, unknown>>;
    const { deps, counts } = resolverDeps({
      loadCredential: async () => stale,
      refresh: async () => {
        counts.refresh += 1;
        throw new ConnectionRefreshHttpError(400, "invalid_grant");
      },
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps, {
      transitionPermanentRefreshFailure: async (failure) => {
        observed.push(failure);
        return true;
      },
    });
    const result = await resolver({
      workspaceId: "ws_google",
      subjectId: "subject-a",
      serverId: "google-drive",
      destinationUrl: "https://www.googleapis.com/drive/v3/files",
      connectionRef: {
        providerDomain: "googleapis.com",
        kind: "oauth2",
        subjectScope: "subject",
      },
    });
    expect(result).toMatchObject({ status: "auth_needed", reason: "refresh_failed" });
    expect(observed).toEqual([
      {
        workspaceId: "ws_google",
        connectionId: "conn_google",
        connectionVersion: 11,
        subjectId: "subject-a",
        providerDomain: "googleapis.com",
        httpStatus: 400,
        oauthErrorCode: "invalid_grant",
      },
    ]);
    expect(counts.status).toBe(0);
  });

  test("refresh errors retain only a bounded OAuth code, never the provider description", async () => {
    let observedError: unknown;
    try {
      await refreshOAuthConnectionCredential(
        brokerCredential({
          kind: "oauth2",
          providerDomain: "googleapis.com",
          credential: {
            access_token: "AC",
            refresh_token: "RF",
            token_type: "Bearer",
            token_endpoint: "https://oauth2.googleapis.com/token",
            client_id: "client-id",
          },
        }),
        { providerDomain: "googleapis.com", kind: "oauth2" },
        settings,
        {
          fetchImpl: async () =>
            Response.json(
              {
                error: "invalid_grant",
                error_description: "sensitive provider detail must never escape",
              },
              { status: 400 },
            ),
          dnsLookup: async () => [{ address: "142.250.72.234", family: 4 }],
        },
      );
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toBeInstanceOf(ConnectionRefreshHttpError);
    expect((observedError as ConnectionRefreshHttpError).oauthErrorCode).toBe("invalid_grant");
    expect((observedError as Error).message).toBe("connection refresh failed with HTTP 400");
    expect(JSON.stringify(observedError)).not.toContain("sensitive provider detail");
  });
});

describe("normalizeBearerScheme", () => {
  test('canonicalizes a lowercase/absent bearer scheme to "Bearer" (Linear MCP rejects lowercase)', () => {
    expect(normalizeBearerScheme("bearer")).toBe("Bearer");
    expect(normalizeBearerScheme("BEARER")).toBe("Bearer");
    expect(normalizeBearerScheme("Bearer")).toBe("Bearer");
    expect(normalizeBearerScheme(null)).toBe("Bearer");
    expect(normalizeBearerScheme("")).toBe("Bearer");
  });
  test("passes a non-bearer scheme through unchanged", () => {
    expect(normalizeBearerScheme("DPoP")).toBe("DPoP");
  });
});
