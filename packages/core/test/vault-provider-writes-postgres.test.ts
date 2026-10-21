// Agent writes into connected vaults (W5, OP-3): secret_save and secret_delete
// on a read-write host-linked vault go through the provider, then the mirror
// refreshes; a read-only link refuses with vault_read_only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseSecretReference, SecretSaveInput, type SecretPrincipal } from "@opengeni/contracts";
import {
  createDb,
  createVault,
  ensureManagedAccessForUser,
  getVaultItem,
  linkProviderVault,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { createProviderCallBudget, createVaultProviderRegistry } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createSecretResolver, createVaultService, isVaultError } from "../src/domain/vaults";
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

    test("secret_move and the move route cross into and out of a connected vault", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vault-provider-move-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Provider moves",
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
      const key = new Uint8Array(32).fill(7);
      const service = createVaultService({ db, encryptionKey: key, providers });
      const ctx = { connectionId: null, budget: createProviderCallBudget(20) };
      const local = await createVault(db, context, { name: "Team", ownerKind: "workspace" });
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
          item: "Billing login",
          vault: "Team",
          type: "login",
          username: "ops@example.test",
          fields: [{ name: "password", value: "move-me-correct-horse" }],
          mode: "create",
        }),
      );
      expect(saved.item.vaultId).toBe(local.id);

      // Opengeni -> connected: the value lands in the provider, the source is archived.
      const moved = await service.moveForAgent(principal, {
        reference: "Team/Billing login",
        toVault: "Host RW",
        mode: "move",
      });
      expect(moved.item).toMatchObject({ name: "Billing login", vaultId: rw.id });
      const [providerItem] = await host.listItems(ctx, "host-rw");
      const passwordRef = providerItem!.fields.find((f) => f.name === "password")!;
      const [password] = await host.readFields(ctx, "host-rw", providerItem!.externalItemId, [
        passwordRef.externalFieldId,
      ]);
      expect((password!.material as { value: string }).value).toBe("move-me-correct-horse");
      const original = await getVaultItem(db, context, { itemId: saved.item.id });
      expect(original.archivedAt).not.toBeNull();

      // Browser, run_on and tool-gateway resolvers get providers for the acting subject.
      const seen: Array<string | null> = [];
      const resolver = createSecretResolver({ db, encryptionKey: key }, principal, {
        capabilityEnabled: true,
        providersForSubject: (subject) => {
          seen.push(subject);
          return providers;
        },
      });
      const resolved = await resolver.resolve(
        [parseSecretReference("{{secret:Host RW/Billing login/password}}")],
        { surface: "browser", toolName: "browser_act" },
      );
      expect([...resolved.values()][0]!.material).toEqual({
        type: "text",
        value: "move-me-correct-horse",
      });
      expect(seen).toEqual([subjectId]);

      // Connected -> Opengeni copy keeps the provider item and stores the value locally.
      const copied = await service.moveForAgent(principal, {
        reference: "Host RW/Billing login",
        toVault: "Team",
        mode: "copy",
        newName: "Billing login copy",
      });
      expect(copied.item.vaultId).toBe(local.id);
      expect(await host.listItems(ctx, "host-rw")).toHaveLength(1);
      const read = await service.readForAgent(
        principal,
        { reference: "Team/Billing login copy/password" },
        ["secrets:read"],
      );
      expect(read.value).toBe("move-me-correct-horse");

      // A read-only connected vault never receives items.
      await expect(
        service.moveForAgent(principal, {
          reference: "Host RW/Billing login",
          toVault: "Host RO",
          mode: "move",
        }),
      ).rejects.toMatchObject({ code: "vault_read_only" });
      expect(await host.listItems(ctx, "host-ro")).toEqual([]);
    });
  },
);
