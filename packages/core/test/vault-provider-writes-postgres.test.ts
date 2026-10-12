// Agent writes into connected vaults (W5, OP-3): secret_save and secret_delete
// on a read-write host-linked vault go through the provider, then the mirror
// refreshes; a read-only link refuses with vault_read_only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SecretSaveInput, type SecretPrincipal } from "@opengeni/contracts";
import {
  createDb,
  ensureManagedAccessForUser,
  linkProviderVault,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { createProviderCallBudget, createVaultProviderRegistry } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createVaultService, isVaultError } from "../src/domain/vaults";
import { syncLinkedProviderVault } from "../src/domain/vaults/provider-sync";

setDefaultTimeout(180_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-provider-writes");
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

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "connected vault writes for agents",
  () => {
    test("secret_save and secret_delete write through a read-write link", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vault-provider-writes-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Provider writes",
      });
      const grant = access.workspaceGrants[0]!;
      const subjectId = `user:${userId}`;
      const context: VaultDbContext = {
        kind: "subject",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
      };
      const principal: SecretPrincipal = {
        kind: "human",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        verifiedHuman: true,
        viaApiKey: false,
      };
      const host = createFakeVaultProvider({
        vaults: [
          { externalVaultId: "host-rw", name: "Host RW" },
          { externalVaultId: "host-ro", name: "Host RO", readOnly: true },
        ],
      });
      const providers = createVaultProviderRegistry({ host: async () => host });
      const service = createVaultService({ db, encryptionKey: null, providers });
      const ctx = { connectionId: null, budget: createProviderCallBudget(20) };

      const rw = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Host RW",
        source: "host",
        providerVaultRef: "host-rw",
        mode: "read_write",
      });
      const ro = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Host RO",
        source: "host",
        providerVaultRef: "host-ro",
        mode: "read_only",
      });
      for (const vault of [rw, ro]) {
        await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
      }

      const saved = await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Agent login",
          vault: "Host RW",
          username: "agent",
          websites: ["https://agent.example.test"],
          fields: [{ name: "password", generate: { length: 20 } }],
          mode: "create",
        }),
      );
      expect(saved.generatedFields).toEqual(["password"]);
      expect(saved.item).toMatchObject({ name: "Agent login", vaultId: rw.id, username: null });
      const [providerItem] = await host.listItems(ctx, "host-rw");
      expect(providerItem).toMatchObject({
        name: "Agent login",
        websites: ["https://agent.example.test"],
      });
      const [password] = await host.readFields(ctx, "host-rw", providerItem!.externalItemId, [
        providerItem!.fields.find((field) => field.name === "password")!.externalFieldId,
      ]);
      expect(password!.material).toMatchObject({ type: "text" });
      expect((password!.material as { value: string }).value).toHaveLength(20);

      const updated = await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Agent login",
          vault: "Host RW",
          fields: [{ name: "note", kind: "text", value: "rotated by the agent" }],
          mode: "update",
        }),
      );
      expect(updated.item.id).toBe(saved.item.id);
      expect((await host.listItems(ctx, "host-rw"))[0]!.fields.map((f) => f.name)).toContain(
        "note",
      );

      try {
        await service.saveForAgent(
          principal,
          SecretSaveInput.parse({
            item: "Nope",
            vault: "Host RO",
            fields: [{ name: "value", value: "x" }],
          }),
        );
        throw new Error("expected vault_read_only");
      } catch (error) {
        expect(isVaultError(error) && error.code).toBe("vault_read_only");
      }
      expect(await host.listItems(ctx, "host-ro")).toEqual([]);

      const archived = await service.archiveForAgent(principal, {
        reference: "Host RW/Agent login",
      });
      expect(archived.archived).toBe(true);
      expect(await host.listItems(ctx, "host-rw")).toEqual([]);
    });
  },
);
