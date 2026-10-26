// The vault-backed interaction port against PostgreSQL (0739): agent-owned
// passkeys are saved as vault items, leased to one browser at a time (Q-32),
// sign counts only move forward (D20), and Browser references resolve through
// the real resolver. A connected password manager's login that holds a passkey
// (0986) is found by a passkey search and leased with key material read live
// from the provider, and its sign count is written back where allowed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type BrowserPasskeyCredentialMaterial,
  parseSecretReference,
  referenceKey,
  type SecretPrincipal,
} from "@opengeni/contracts";
import { createVaultService, syncLinkedProviderVault } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createVault,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getVaultItem,
  initializeSessionStartAtomically,
  linkProviderVault,
  listVaultItems,
  setSecretApprovalRules,
  upsertVaultItem,
  type DbClient,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  createVaultProviderRegistry,
  type ProviderPasskey,
  VaultProviderError,
} from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createVaultInteractionSecretsPort } from "../src/interaction-secrets-vault";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(11);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("interaction-secrets-vault");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function agentAttempt(): Promise<{
  principal: Extract<SecretPrincipal, { kind: "attempt" }>;
  subjectId: string;
}> {
  const db = client!.db;
  const userId = `w4-passkeys-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Passkeys",
  });
  const grant = access.workspaceGrants[0]!;
  const subjectId = `user:${userId}`;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "log in",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId },
    subjectId,
  });
  const started = await initializeSessionStartAtomically(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
  return {
    subjectId,
    principal: {
      kind: "attempt",
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
}

const credential: BrowserPasskeyCredentialMaterial = {
  rpId: "localhost",
  credentialId: "Y3JlZGVudGlhbC1pZC0xMjM0NTY",
  userHandle: "dXNlci1oYW5kbGU",
  userName: "alice",
  userDisplayName: "Alice",
  privateKey: "TUlHSEFnRUFNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VIQkcwd2F3SUJBUVFn",
  signCount: 1,
};

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "vault-backed interaction secrets (PostgreSQL)",
  () => {
    test("passkeys: save, lease to one holder, monotonic sign count, release", async () => {
      if (!client) return;
      const db = client.db;
      const { principal } = await agentAttempt();
      const port = createVaultInteractionSecretsPort({ db, encryptionKey: key });
      const store = port.passkeys!;

      const { itemId } = await store.saveRegistered(principal, {
        credential,
        origin: "http://localhost:47423",
      });
      const row = await getVaultItem(db, { kind: "principal", principal }, { itemId });
      expect(row.type).toBe("passkey");
      expect(row.name).toBe("localhost passkey for alice");
      expect(row.websites).toEqual(["http://localhost:47423"]);
      expect(row.fields.map((field) => [field.name, field.kind]).sort()).toEqual(
        [
          ["credentialId", "text"],
          ["privateKey", "concealed"],
          ["rpId", "text"],
          ["userHandle", "text"],
          ["userName", "text"],
        ].sort(),
      );
      expect(Number(row.passkeySignCount)).toBe(1);

      // A second registration for the same user gets a distinct name.
      const second = await store.saveRegistered(principal, {
        credential: { ...credential, credentialId: "c2Vjb25kLWNyZWRlbnRpYWw", signCount: 0 },
        origin: null,
      });
      const secondRow = await getVaultItem(
        db,
        { kind: "principal", principal },
        {
          itemId: second.itemId,
        },
      );
      expect(secondRow.name).toBe("localhost passkey for alice nRpYWw");
      expect(secondRow.websites).toEqual(["https://localhost"]);

      const leased = await store.lease(principal, "browser-a", 600);
      expect(leased.map((entry) => entry.itemId).sort()).toEqual([itemId, second.itemId].sort());
      const first = leased.find((entry) => entry.itemId === itemId)!;
      expect(first).toEqual({ ...credential, userDisplayName: null, itemId });

      // The most recent holder takes over, so a passkey registered in one
      // browser works at once in another.
      const takenOver = await store.lease(principal, "browser-b", 600);
      expect(takenOver.map((entry) => entry.itemId).sort()).toEqual([itemId, second.itemId].sort());

      await store.updateSignCount(principal, itemId, 7);
      await store.updateSignCount(principal, itemId, 3);
      const renewed = await store.lease(principal, "browser-a", 600);
      expect(renewed.find((entry) => entry.itemId === itemId)?.signCount).toBe(7);

      // Releasing a holder that no longer holds anything leaves the current lease.
      await store.release("browser-b");
      const kept = await getVaultItem(db, { kind: "principal", principal }, { itemId });
      expect(kept.passkeyLeasedUntil).not.toBeNull();

      await store.release("browser-a");
      const taken = await store.lease(principal, "browser-b", 600);
      expect(taken.map((entry) => entry.itemId).sort()).toEqual([itemId, second.itemId].sort());
      await store.release("browser-b");
    });

    test("connected password manager passkeys: found, leased live, counted back", async () => {
      if (!client) return;
      const db = client.db;
      const { principal, subjectId } = await agentAttempt();
      const scope = { accountId: principal.accountId, workspaceId: principal.workspaceId };
      const context = { kind: "subject" as const, ...scope, subjectId };
      const providerPasskey: ProviderPasskey = {
        // base64url with both URL-safe characters, as providers store it.
        credentialId: "-_-_cHJvdmlkZXI",
        rpId: "example.com",
        userHandle: "dXNlci1oYW5kbGU",
        userName: "alice@example.com",
        userDisplayName: "Alice",
        privateKey: credential.privateKey,
        signCount: 4,
      };
      const host = createFakeVaultProvider({
        capabilities: { passkeys: true },
        vaults: [
          {
            externalVaultId: "logins",
            name: "Logins",
            items: [
              {
                name: "Example",
                type: "login",
                websites: ["https://example.com"],
                fields: [
                  { name: "username", value: "alice@example.com" },
                  { name: "password", kind: "concealed", value: "Provider-Password-1" },
                ],
                passkeys: [providerPasskey],
              },
              {
                name: "Plain",
                type: "login",
                fields: [{ name: "password", kind: "concealed", value: "Plain-Password-1" }],
              },
            ],
          },
        ],
      });
      const providers = createVaultProviderRegistry({ host: async () => host });
      const vault = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Logins",
        source: "host",
        providerVaultRef: "logins",
        mode: "read_write",
      });
      const sync = async () =>
        await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
      await sync();
      const passkeyItems = async () =>
        (await listVaultItems(db, context, { vaultId: vault.id, type: "passkey" })).items;

      // The login is found as a passkey, with metadata only: no key material
      // is stored here.
      const [item, ...others] = await passkeyItems();
      expect(others).toHaveLength(0);
      expect(item!.name).toBe("Example");
      expect(item!.type).toBe("login");
      expect(item!.providerPasskeys).toEqual([
        { credentialId: "-_-_cHJvdmlkZXI", rpId: "example.com", userName: "alice@example.com" },
      ]);
      const [stored] = await shared!.admin`
        select row_to_json(i)::text as row from vault_items i where id = ${item!.id}`;
      expect(stored!.row).not.toContain(credential.privateKey);
      const service = createVaultService({ db, encryptionKey: key, providers });
      const search = await service.searchForAgent(principal, { type: "passkey", limit: 20 });
      expect(search.items.map((entry) => [entry.item.name, entry.item.hasPasskey])).toEqual([
        ["Example", true],
      ]);

      const logs: string[] = [];
      const port = createVaultInteractionSecretsPort({
        db,
        encryptionKey: key,
        providersFor: () => providers,
        log: (event) => logs.push(event),
      });
      const store = port.passkeys!;
      const leased = await store.lease(principal, "browser-a", 600);
      expect(leased).toEqual([{ ...providerPasskey, itemId: item!.id }]);

      // The browser reports the credential id in padded standard base64.
      const ctx = { connectionId: null, budget: createProviderCallBudget(10) };
      const [external] = (await host.listItems(ctx, "logins")).filter(
        (meta) => meta.name === "Example",
      );
      const providerCount = async () =>
        (await host.readPasskeys!(ctx, "logins", external!.externalItemId))[0]!.signCount;
      const recordedCount = async () =>
        Number((await getVaultItem(db, context, { itemId: item!.id })).passkeySignCount);
      await store.updateSignCount(principal, item!.id, 9, "+/+/cHJvdmlkZXI=");
      expect(await providerCount()).toBe(9);
      expect(await recordedCount()).toBe(9);
      await store.updateSignCount(principal, item!.id, 5, "+/+/cHJvdmlkZXI=");
      expect(await providerCount()).toBe(9);
      expect((await store.lease(principal, "browser-a", 600))[0]!.signCount).toBe(9);

      // A read-only link never writes to the provider; the count recorded here
      // keeps rising so the next sign-in stays valid.
      await shared!.admin`update vaults set mode = 'read_only' where id = ${vault.id}`;
      await store.updateSignCount(principal, item!.id, 12, "+/+/cHJvdmlkZXI=");
      expect(await providerCount()).toBe(9);
      expect(await recordedCount()).toBe(12);
      expect((await store.lease(principal, "browser-a", 600))[0]!.signCount).toBe(12);
      await shared!.admin`update vaults set mode = 'read_write' where id = ${vault.id}`;

      // An unreachable or withholding provider skips its passkeys, logged,
      // without failing the lease.
      const readPasskeys = host.readPasskeys!;
      host.readPasskeys = async () => {
        throw new VaultProviderError("provider_permission_denied", "secrets are hidden");
      };
      expect(await store.lease(principal, "browser-a", 600)).toEqual([]);
      expect(logs).toContain("browser.passkey.provider_read_failed");
      host.readPasskeys = readPasskeys;

      // An item that needs a person's approval for each use is not loaded.
      const rule = { itemId: item!.id, vaultId: vault.id, fieldKeys: [], subjectId };
      await setSecretApprovalRules(db, scope, { ...rule, item: true });
      expect(await store.lease(principal, "browser-a", 600)).toEqual([]);
      await setSecretApprovalRules(db, scope, { ...rule, item: false });
      expect(await store.lease(principal, "browser-a", 600)).toHaveLength(1);
      await store.release("browser-a");

      // A listing that does not report passkeys keeps them; one that reports
      // none clears them.
      const list = host.listItems.bind(host);
      host.listItems = async (...args) =>
        (await list(...args)).map(({ passkeys: _passkeys, ...meta }) => ({
          ...meta,
          version: `${meta.version}-unreported`,
        }));
      await sync();
      expect((await passkeyItems()).map((row) => row.id)).toEqual([item!.id]);
      host.listItems = async (...args) =>
        (await list(...args)).map((meta) => ({
          ...meta,
          version: `${meta.version}-removed`,
          passkeys: [],
        }));
      await sync();
      expect(await passkeyItems()).toEqual([]);
      expect(await store.lease(principal, "browser-a", 600)).toEqual([]);
    });

    test("references in actions resolve through the real resolver, TOTP included", async () => {
      if (!client) return;
      const db = client.db;
      const { principal, subjectId } = await agentAttempt();
      const context = {
        kind: "subject" as const,
        accountId: principal.accountId,
        workspaceId: principal.workspaceId,
        subjectId,
      };
      const vault = await createVault(db, context, { name: "Logins", ownerKind: "workspace" });
      await upsertVaultItem(db, context, {
        vaultId: vault.id,
        name: "Fake TOTP",
        type: "login",
        fields: [
          ["username", "text", "totp-user"],
          ["password", "concealed", "Fake-Login-Totp-Password-2"],
          ["one-time password", "totp", "JBSWY3DPEHPK3PXP"],
        ].map(([name, kind, value]) => ({
          name: name!,
          kind: kind as "text" | "concealed" | "totp",
          valueEncrypted: encryptEnvironmentValue(Buffer.from(key), value!),
          valueSize: Buffer.byteLength(value!),
        })),
      });
      const port = createVaultInteractionSecretsPort({ db, encryptionKey: key });
      const resolver = await port.resolverFor(principal);
      expect(resolver?.enabled).toBe(true);
      const refs = ["{{secret:Fake TOTP/password}}", "{{secret:Fake TOTP/otp}}"].map((raw) =>
        parseSecretReference(raw),
      );
      const resolved = await resolver!.resolve(refs, {
        surface: "browser",
        toolName: "browser_act",
        operationId: crypto.randomUUID(),
      });
      expect(resolved.get(referenceKey(refs[0]!))?.material).toEqual({
        type: "text",
        value: "Fake-Login-Totp-Password-2",
      });
      expect(resolved.get(referenceKey(refs[1]!))?.material.type).toBe("totp");
    });
  },
);
