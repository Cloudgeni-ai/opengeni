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
import {
  createProviderCallBudget,
  createVaultProviderRegistry,
  sshPublicKeyFromPrivateKey,
} from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
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

    test("a connected vault that stores API keys and files gets them; refusals name the operation", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vault-provider-files-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Provider files",
      });
      const grant = access.workspaceGrants[0]!;
      const actor = { grant, accountAdmin: false };
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
      const operations = {
        createItemTypes: ["login", "api_key", "note", "file"] as const,
        updateItem: true,
        removeField: true,
        archiveItem: true,
        archiveKind: "archive" as const,
        deleteItem: false,
        restoreItem: false,
        readFiles: true,
        writeFiles: true,
        createTotp: true,
        updateTotp: true,
        createVault: false,
        restoreFieldHistory: false,
      };
      const files = createFakeVaultProvider({
        vaults: [{ externalVaultId: "files", name: "Files" }],
        capabilities: {
          operations: { ...operations, createItemTypes: [...operations.createItemTypes] },
        },
        listArchived: true,
      });
      const notes = createFakeVaultProvider({
        vaults: [{ externalVaultId: "notes", name: "Notes" }],
        capabilities: {
          operations: { ...operations, createItemTypes: ["login", "note"], writeFiles: false },
        },
      });
      const providers = createVaultProviderRegistry({
        host: async () => files,
      });
      const notesProviders = createVaultProviderRegistry({ host: async () => notes });
      const key = new Uint8Array(32).fill(9);
      const service = createVaultService({ db, encryptionKey: key, providers });
      const notesService = createVaultService({
        db,
        encryptionKey: key,
        providers: notesProviders,
      });
      const ctx = { connectionId: null, budget: createProviderCallBudget(20) };
      const vault = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Files",
        source: "host",
        providerVaultRef: "files",
        mode: "read_write",
      });
      await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });

      // An API key, as a 1Password export has it: its secret is `credential`.
      const apiKey = await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Payments API",
          vault: "Files",
          type: "api_key",
          fields: [{ name: "credential", value: "sk_test_123" }],
          mode: "create",
        }),
      );
      expect(apiKey.item).toMatchObject({ vaultId: vault.id, type: "api_key" });
      const read = (reference: string) =>
        service.readForAgent(principal, { reference }, ["secrets:read"]);
      expect((await read("Files/Payments API/credential")).value).toBe("sk_test_123");
      // Another manager names the same secret `password` or `value`; the reference still works.
      expect((await read("Files/Payments API/password")).value).toBe("sk_test_123");
      expect((await read("Files/Payments API/value")).value).toBe("sk_test_123");
      await expect(read("Files/Payments API/token")).rejects.toBeDefined();
      // Two candidates are never guessed between.
      await service.saveForAgent(
        principal,
        SecretSaveInput.parse({
          item: "Two secrets",
          vault: "Files",
          type: "api_key",
          fields: [
            { name: "credential", value: "one" },
            { name: "value", value: "two" },
          ],
          mode: "create",
        }),
      );
      await expect(read("Files/Two secrets/password")).rejects.toBeDefined();
      expect((await read("Files/Two secrets/value")).value).toBe("two");

      // A file item, written through the provider.
      const content = "apiVersion: v1\nkind: Config\n";
      const created = await service.createItem(actor, grant.workspaceId, vault.id, {
        name: "kubeconfig",
        type: "file",
        fields: [
          {
            name: "file",
            kind: "file",
            fileBase64: Buffer.from(content).toString("base64"),
            fileName: "config.yaml",
          },
        ],
      });
      const [providerFile] = (await files.listItems(ctx, "files")).filter(
        (item) => item.name === "kubeconfig",
      );
      expect(providerFile!.fields).toEqual([
        expect.objectContaining({ name: "file", kind: "file" }),
      ]);
      const [bytes] = await files.readFields(ctx, "files", providerFile!.externalItemId, [
        providerFile!.fields[0]!.externalFieldId,
      ]);
      expect(bytes!.material).toEqual({
        type: "bytes",
        value: new Uint8Array(Buffer.from(content)),
      });
      expect(created.fields.map((field) => field.name)).toEqual(["file"]);

      // A file field needs its content.
      await expect(
        service.createItem(actor, grant.workspaceId, vault.id, {
          name: "empty",
          type: "file",
          fields: [{ name: "file", kind: "file", value: "not a file" }],
        }),
      ).rejects.toBeDefined();

      // Archived upstream: still mirrored, marked archived, listed only on request.
      await files.archiveItem(ctx, "files", providerFile!.externalItemId);
      await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
      const active = await service.listItems(actor, grant.workspaceId, vault.id, {});
      expect(active.items.map((item) => item.name).sort()).toEqual(["Payments API", "Two secrets"]);
      const all = await service.listItems(actor, grant.workspaceId, vault.id, {
        includeArchived: true,
      });
      const archived = all.items.find((item) => item.name === "kubeconfig")!;
      expect(archived.archivedAt).not.toBeNull();
      await expect(read("Files/kubeconfig/file")).rejects.toBeDefined();

      // A vault that writes, but not API keys or files, says so instead of claiming read-only.
      const notesVault = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Notes",
        source: "host",
        providerVaultRef: "notes",
        mode: "read_write",
      });
      await syncLinkedProviderVault({
        db,
        context,
        vaultId: notesVault.id,
        providers: notesProviders,
        force: true,
      });
      await expect(
        notesService.saveForAgent(
          principal,
          SecretSaveInput.parse({
            item: "Key",
            vault: "Notes",
            type: "api_key",
            fields: [{ name: "value", value: "x" }],
            mode: "create",
          }),
        ),
      ).rejects.toMatchObject({
        code: "vault_operation_unsupported",
        details: expect.objectContaining({ operation: "createItem", itemType: "api_key" }),
      });
      await expect(
        notesService.createItem(actor, grant.workspaceId, notesVault.id, {
          name: "Notes file",
          type: "note",
          fields: [{ name: "file", kind: "file", fileBase64: Buffer.from("x").toString("base64") }],
        }),
      ).rejects.toMatchObject({ code: "vault_operation_unsupported" });
      expect(notes.calls.some((call) => call.op === "writeItem")).toBe(false);
    });

    test("cards, identities, SSH keys and categories keep their type in Opengeni and connected vaults", async () => {
      if (!client) return;
      const db = client.db;
      const userId = `vault-provider-types-${crypto.randomUUID()}`;
      const access = await ensureManagedAccessForUser(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Provider types",
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
        vaults: [{ externalVaultId: "typed", name: "Typed" }],
        capabilities: {
          operations: {
            createItemTypes: ["login", "api_key", "note", "file", "card", "identity", "ssh_key"],
            updateItem: true,
            removeField: true,
            archiveItem: true,
            archiveKind: "archive",
            deleteItem: false,
            restoreItem: false,
            readFiles: true,
            writeFiles: true,
            createTotp: true,
            updateTotp: true,
            createVault: false,
            restoreFieldHistory: false,
          },
        },
      });
      const providers = createVaultProviderRegistry({ host: async () => host });
      const key = new Uint8Array(32).fill(5);
      const service = createVaultService({ db, encryptionKey: key, providers });
      const ctx = { connectionId: null, budget: createProviderCallBudget(30) };
      await createVault(db, context, { name: "Team", ownerKind: "workspace" });
      const typed = await linkProviderVault(db, context, {
        ownerKind: "workspace",
        name: "Typed",
        source: "host",
        providerVaultRef: "typed",
        mode: "read_write",
      });
      await syncLinkedProviderVault({ db, context, vaultId: typed.id, providers, force: true });
      const save = (input: Record<string, unknown>) =>
        service.saveForAgent(principal, SecretSaveInput.parse({ mode: "create", ...input }));
      const read = async (reference: string) =>
        (await service.readForAgent(principal, { reference }, ["secrets:read"])).value;

      // A card in an Opengeni vault: other managers' field names land in the standard slots.
      const card = await save({
        item: "Company card",
        vault: "Team",
        type: "card",
        fields: [
          { name: "cardholder name", kind: "text", value: "Example Corp" },
          { name: "number", value: "4111111111111111" },
          { name: "cvv", value: "123" },
        ],
      });
      expect(card.item.type).toBe("card");
      expect(await read("Team/Company card/security code")).toBe("123");
      // A reference written for another manager's name still resolves.
      expect(await read("Team/Company card/verification number")).toBe("123");

      // A generated SSH key pair: the public key and fingerprint are derived.
      const ssh = await save({
        item: "Deploy key",
        vault: "Team",
        type: "ssh_key",
        fields: [{ name: "private key", generateKey: {} }],
      });
      expect(ssh.item.type).toBe("ssh_key");
      expect(ssh.generatedFields).toContain("private key");
      const privateKey = await read("Team/Deploy key/private key");
      expect(privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
      const derived = sshPublicKeyFromPrivateKey(privateKey)!;
      expect(await read("Team/Deploy key/public key")).toBe(derived.publicKey);
      expect(await read("Team/Deploy key/fingerprint")).toBe(derived.fingerprint);

      // A category rides along with the type.
      const warehouse = await save({
        item: "Warehouse",
        vault: "Team",
        type: "api_key",
        category: "database",
        fields: [
          { name: "hostname", kind: "text", value: "db.example.test" },
          { name: "password", value: "warehouse-secret" },
        ],
      });
      expect(warehouse.item).toMatchObject({ type: "api_key", category: "database" });

      // Moving to a connected vault keeps every type, category and value.
      for (const name of ["Company card", "Deploy key", "Warehouse"]) {
        await service.moveForAgent(principal, {
          reference: `Team/${name}`,
          toVault: "Typed",
          mode: "move",
        });
      }
      const remote = await host.listItems(ctx, "typed");
      const kinds = Object.fromEntries(
        remote.map((item) => [item.name, [item.type, item.category ?? null]]),
      );
      expect(kinds).toEqual({
        "Company card": ["card", null],
        "Deploy key": ["ssh_key", null],
        Warehouse: ["api_key", "database"],
      });
      expect(await read("Typed/Deploy key/private key")).toBe(privateKey);
      expect(await read("Typed/Company card/security code")).toBe("123");
      expect(await read("Typed/Warehouse/password")).toBe("warehouse-secret");

      // An identity with a category, created straight in the connected vault.
      const person = await save({
        item: "Personal details",
        vault: "Typed",
        type: "identity",
        category: "person",
        fields: [
          { name: "first name", kind: "text", value: "Alex" },
          { name: "zip", kind: "text", value: "0150" },
        ],
      });
      expect(person.item).toMatchObject({ type: "identity", category: "person" });
      expect(await read("Typed/Personal details/postal code")).toBe("0150");

      // And back: a copy into the Opengeni vault keeps the type and category.
      const back = await service.moveForAgent(principal, {
        reference: "Typed/Warehouse",
        toVault: "Team",
        mode: "copy",
        newName: "Warehouse copy",
      });
      expect(back.item).toMatchObject({ type: "api_key", category: "database" });
      expect(await read("Team/Warehouse copy/password")).toBe("warehouse-secret");
    });
  },
);
