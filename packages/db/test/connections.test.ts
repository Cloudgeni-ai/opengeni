import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { acquireSharedTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  buildConnectionTokenResolver,
  createConnection,
  createDb,
  encryptEnvironmentValue,
  getConnectionMetadata,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  recordConnectionTokenRefresh,
  setConnectionStatus,
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
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function brokerCredential(overrides: Partial<ConnectionCredentialForBroker> = {}): ConnectionCredentialForBroker {
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

function resolverDeps(overrides: Partial<ConnectionBrokerDeps> = {}): { deps: ConnectionBrokerDeps; counts: Counts } {
  const counts: Counts = { load: 0, refresh: 0, recordRefresh: 0, recordUsed: 0, status: 0, loadInputs: [], refreshInputs: [] };
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
        credential: { ...cred.credential, access_token: "AC2", refresh_token: "RF2", token_type: "Bearer" },
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
  } catch { /* noop */ }
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
    expect(visibleToSubjectA.map((connection) => connection.id).sort()).toEqual([sharedConnection.id, subjectConnection.id].sort());
    expect(visibleToSubjectA.some((connection) => "credentialEncrypted" in connection)).toBe(false);

    expect(await getConnectionMetadata(db, ws.workspaceId, subjectConnection.id, "subject-b")).toBeNull();
    const sharedFetched = await getConnectionMetadata(db, ws.workspaceId, sharedConnection.id, "subject-b");
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

    expect(await recordConnectionTokenRefresh(db, {
      id: before!.id,
      version: before!.version + 99,
      workspaceId: ws.workspaceId,
      credentialEncrypted: enc({ access_token: "STALE", refresh_token: "RF", token_type: "Bearer" }),
      expiresAt: null,
      grantedScopes: ["write"],
      lastRefreshAt: new Date(),
    })).toBe(false);

    expect(await recordConnectionTokenRefresh(db, {
      id: before!.id,
      version: before!.version,
      workspaceId: ws.workspaceId,
      credentialEncrypted: enc({ access_token: "AC2", refresh_token: "RF2", token_type: "Bearer" }),
      expiresAt: new Date(Date.now() + 3_600_000),
      grantedScopes: ["read", "write"],
      lastRefreshAt: new Date(),
    })).toBe(true);

    const refreshed = await loadConnectionCredentialForBroker(db, settings, {
      workspaceId: ws.workspaceId,
      connectionId: connection.id,
      providerDomain: "oauth.example.com",
    });
    expect(refreshed?.credential).toMatchObject({ access_token: "AC2", refresh_token: "RF2" });
    expect(refreshed?.version).toBe(before!.version + 1);

    expect(await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "stale", {
      id: connection.id,
      version: before!.version,
    })).toBe(false);
    expect(await setConnectionStatus(db, ws.workspaceId, "needs_reauth", "expired", {
      id: connection.id,
      version: refreshed!.version,
    })).toBe(true);
    const afterStatus = await getConnectionMetadata(db, ws.workspaceId, connection.id);
    expect(afterStatus?.status).toBe("needs_reauth");
    expect(afterStatus?.lastError).toBe("expired");
  });
});

describe("buildConnectionTokenResolver", () => {
  test("materializes api_key headers and records usage", async () => {
    const { deps, counts } = resolverDeps();
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "subject-a",
      serverId: "srv_1",
      connectionRef: { providerDomain: "api.example.com", kind: "api_key", scopes: [] },
    });
    expect(result).toEqual({
      status: "ok",
      headers: { authorization: "Bearer A" },
      connectionId: "conn_1",
      expiresAt: null,
    });
    expect(counts.recordUsed).toBe(1);
    expect(counts.loadInputs[0]).toMatchObject({ allowSubjectOwned: false, subjectId: "subject-a" });
  });

  test("returns auth_needed for missing scopes without exposing credential material", async () => {
    const { deps, counts } = resolverDeps({
      loadCredential: async () => brokerCredential({ grantedScopes: ["read"] }),
    });
    const resolver = buildConnectionTokenResolver({} as Database, settings, deps);
    const result = await resolver({
      workspaceId: "ws_1",
      serverId: "srv_1",
      connectionRef: { providerDomain: "api.example.com", kind: "api_key", scopes: ["read", "write"] },
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
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let loadCalls = 0;
    const stale = brokerCredential({
      id: "conn_oauth",
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
      resolver({ workspaceId: "ws_1", serverId: "srv_1", connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2", scopes: ["read"] }, forceRefresh: true }),
      resolver({ workspaceId: "ws_1", serverId: "srv_1", connectionRef: { providerDomain: "oauth.example.com", kind: "oauth2", scopes: ["read"] }, forceRefresh: true }),
    ]);
    release();
    const results = await both;
    expect(counts.refresh).toBe(1);
    expect(counts.recordRefresh).toBe(1);
    expect(counts.refreshInputs).toEqual([{ id: "conn_oauth", version: 7 }]);
    expect(results).toEqual([
      { status: "ok", headers: { authorization: "Bearer AC2" }, connectionId: "conn_oauth", expiresAt: refreshed.expiresAt },
      { status: "ok", headers: { authorization: "Bearer AC2" }, connectionId: "conn_oauth", expiresAt: refreshed.expiresAt },
    ]);
  });
});
