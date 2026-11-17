import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  ConnectionAccountAlreadyConnectedError,
  connectionAccountIdentityKey,
  createConnection,
  createDb,
  persistProviderOAuthConnection,
  revokeConnection,
  updateConnection,
  type DbClient,
} from "../src/index";

// Every backend that verifies which provider account a connection is stamps
// its key, and PostgreSQL then holds at most one live connection per
// organization, owner and account: a racing or legacy writer cannot add a
// second one for the same account.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connection-account-identity");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function organization(subjectId = `user:identity-${crypto.randomUUID()}`) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `identity-account-${suffix}`,
    accountName: "Identity account",
    workspaceExternalSource: "test",
    workspaceExternalId: `identity-workspace-${suffix}`,
    workspaceName: "Identity workspace",
    subjectId,
  });
  return access.workspaceGrants[0]!;
}

const KEY = connectionAccountIdentityKey(["nango", "google-mail", "ada@example.com"]);

function connect(
  workspace: { accountId: string; workspaceId: string; subjectId: string },
  input: { personal: boolean; accountIdentityKey: string | null },
) {
  return createConnection(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: input.personal ? workspace.subjectId : null,
    providerDomain: "gmail.googleapis.com",
    kind: "oauth2",
    credentialEncrypted: "test-encrypted",
    accountIdentityKey: input.accountIdentityKey,
    createdBySubjectId: workspace.subjectId,
  });
}

describe("one live connection per owner and verified account", () => {
  test("the key names the integration and the account", () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/u);
    expect(connectionAccountIdentityKey(["nango", "google-drive", "ada@example.com"])).not.toBe(
      KEY,
    );
    expect(() => connectionAccountIdentityKey(["nango"])).toThrow();
    expect(() => connectionAccountIdentityKey(["nango", ""])).toThrow();
  });

  test("a second live connection of the same account is refused", async () => {
    const workspace = await organization();
    await connect(workspace, { personal: true, accountIdentityKey: KEY });
    await expect(connect(workspace, { personal: true, accountIdentityKey: KEY })).rejects.toThrow(
      ConnectionAccountAlreadyConnectedError,
    );
    await connect(workspace, { personal: false, accountIdentityKey: KEY });
    await expect(connect(workspace, { personal: false, accountIdentityKey: KEY })).rejects.toThrow(
      ConnectionAccountAlreadyConnectedError,
    );
  }, 60_000);

  test("unverified accounts, other owners and revoked rows never collide", async () => {
    const subjectId = `user:identity-${crypto.randomUUID()}`;
    const workspace = await organization(subjectId);
    await connect(workspace, { personal: true, accountIdentityKey: null });
    await connect(workspace, { personal: true, accountIdentityKey: null });
    const first = await connect(workspace, { personal: true, accountIdentityKey: KEY });
    // The same person in another organization is another owner.
    await connect(await organization(subjectId), { personal: true, accountIdentityKey: KEY });
    // Someone else's account in the same organization.
    await connect(workspace, {
      personal: true,
      accountIdentityKey: connectionAccountIdentityKey(["nango", "google-mail", "bo@example.com"]),
    });
    await revokeConnection(client.db, workspace.workspaceId, first.id, workspace.subjectId);
    const again = await connect(workspace, { personal: true, accountIdentityKey: KEY });
    expect(again.id).not.toBe(first.id);
  }, 60_000);

  test("reactivating or re-keying into a held account is refused", async () => {
    const workspace = await organization();
    const legacy = await connect(workspace, { personal: true, accountIdentityKey: null });
    await connect(workspace, { personal: true, accountIdentityKey: KEY });
    await expect(
      updateConnection(client.db, {
        workspaceId: workspace.workspaceId,
        connectionId: legacy.id,
        visibleToSubjectId: workspace.subjectId,
        accountIdentityKey: KEY,
      }),
    ).rejects.toThrow(ConnectionAccountAlreadyConnectedError);
  }, 60_000);

  test("the database refuses a key that is not a SHA-256", async () => {
    const workspace = await organization();
    await expect(
      connect(workspace, { personal: true, accountIdentityKey: "ada@example.com" }),
    ).rejects.toThrow();
  }, 60_000);

  test("reconnecting the same account keeps its authority generation; other changes advance it", async () => {
    const workspace = await organization();
    const created = await createConnection(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: workspace.subjectId,
      providerDomain: "gmail.googleapis.com",
      kind: "oauth2",
      credentialEncrypted: "first",
      grantedScopes: ["read"],
      accountIdentityKey: KEY,
      createdBySubjectId: workspace.subjectId,
    });
    const generation = async () =>
      Number(
        (
          await shared.admin<Array<{ authority_generation: string }>>`
            select authority_generation from connections where id = ${created.id}`
        )[0]!.authority_generation,
      );
    const reconnect = (input: { grantedScopes?: string[]; accountIdentityKey?: string | null }) =>
      updateConnection(client.db, {
        workspaceId: workspace.workspaceId,
        connectionId: created.id,
        visibleToSubjectId: workspace.subjectId,
        credentialEncrypted: `token-${crypto.randomUUID()}`,
        ...input,
      });
    const start = await generation();
    // A new token for the same account, with the same or more scopes.
    await reconnect({ grantedScopes: ["read"], accountIdentityKey: KEY });
    await reconnect({ grantedScopes: ["read", "write"], accountIdentityKey: KEY });
    expect(await generation()).toBe(start);
    // Fewer scopes, an unverified writer and another account are authority changes.
    await reconnect({ grantedScopes: ["write"], accountIdentityKey: KEY });
    expect(await generation()).toBe(start + 1);
    await reconnect({ grantedScopes: ["write"] });
    expect(await generation()).toBe(start + 2);
    await reconnect({
      grantedScopes: ["write"],
      accountIdentityKey: connectionAccountIdentityKey(["nango", "google-mail", "bo@example.com"]),
    });
    expect(await generation()).toBe(start + 3);
    await revokeConnection(client.db, workspace.workspaceId, created.id, workspace.subjectId);
    expect(await generation()).toBeGreaterThan(start + 3);
  }, 60_000);

  test("a reconnect of a row saved before keys keeps its generation when the writer vouches for it", async () => {
    const workspace = await organization();
    const legacy = await connect(workspace, { personal: true, accountIdentityKey: null });
    const generation = async () =>
      Number(
        (
          await shared.admin<Array<{ authority_generation: string }>>`
            select authority_generation from connections where id = ${legacy.id}`
        )[0]!.authority_generation,
      );
    const start = await generation();
    await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: legacy.id,
      visibleToSubjectId: workspace.subjectId,
      credentialEncrypted: "reconnected",
      accountIdentityKey: KEY,
      previousAccountIdentityKey: KEY,
    });
    expect(await generation()).toBe(start);
  }, 60_000);

  test("provider OAuth reconnects the live row, never a revoked duplicate", async () => {
    const workspace = await organization();
    const metadata = {
      credentialRole: "test_personal",
      providerFamily: "test",
      providerPrincipalId: "principal-1",
    };
    const legacy = () =>
      createConnection(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: workspace.subjectId,
        providerDomain: "provider.example",
        kind: "oauth2",
        credentialEncrypted: "legacy",
        metadata,
        createdBySubjectId: workspace.subjectId,
      });
    // Duplicates an older release left, both without a key.
    const older = await legacy();
    const newer = await legacy();
    const persist = () =>
      persistProviderOAuthConnection(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: workspace.subjectId,
        visibleToSubjectId: workspace.subjectId,
        providerDomain: "provider.example",
        kind: "oauth2",
        status: "active",
        credentialEncrypted: `token-${crypto.randomUUID()}`,
        grantedScopes: [],
        metadata,
        credentialRole: "test_personal",
        providerFamily: "test",
        providerPrincipalId: "principal-1",
        createdBySubjectId: workspace.subjectId,
      });
    expect((await persist())?.id).toBe(newer.id);
    // Disconnecting the other duplicate makes it the most recently updated row.
    await revokeConnection(client.db, workspace.workspaceId, older.id, workspace.subjectId);
    expect((await persist())?.id).toBe(newer.id);
  }, 60_000);

  test("a credential replaced without a verified account loses the key", async () => {
    const workspace = await organization();
    const keyed = await connect(workspace, { personal: true, accountIdentityKey: KEY });
    await updateConnection(client.db, {
      workspaceId: workspace.workspaceId,
      connectionId: keyed.id,
      visibleToSubjectId: workspace.subjectId,
      credentialEncrypted: "pasted",
    });
    const [row] = await shared.admin<Array<{ account_identity_key: string | null }>>`
      select account_identity_key from connections where id = ${keyed.id}`;
    expect(row!.account_identity_key).toBeNull();
    // The account's slot is free again.
    await connect(workspace, { personal: true, accountIdentityKey: KEY });
  }, 60_000);
});
