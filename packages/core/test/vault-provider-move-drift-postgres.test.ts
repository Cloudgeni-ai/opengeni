// A move out of a connected vault copies the original's values, saves the
// copy in the target and only then archives the original. If the provider
// changed the original after its values were read (or its current version
// cannot be confirmed), the original is kept and the move reports the copy
// as saved with the original not archived, so nothing newer is archived.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  createDb,
  ensureManagedAccessForUser,
  linkProviderVault,
  type DbClient,
  type VaultDbContext,
  type VaultError,
} from "@opengeni/db";
import {
  createProviderCallBudget,
  createVaultProviderRegistry,
  VaultProviderError,
  type VaultProvider,
} from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createVaultService, isVaultError } from "../src/domain/vaults";
import { syncLinkedProviderVault } from "../src/domain/vaults/provider-sync";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(9);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-provider-move-drift");
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

type Controls = {
  /** Runs inside the target write, before the copy lands (a concurrent edit). */
  duringTargetWrite: (() => Promise<void>) | null;
  /** After the copy lands, listings of the source vault fail. */
  failSourceListingAfterCopy: boolean;
  copied: boolean;
};

async function world() {
  const db = client!.db;
  const userId = `vault-provider-move-drift-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Move drift",
  });
  const grant = access.workspaceGrants[0]!;
  const actor = { grant, accountAdmin: false };
  const workspaceId = grant.workspaceId;
  const context: VaultDbContext = {
    kind: "subject",
    accountId: grant.accountId,
    workspaceId,
    subjectId: `user:${userId}`,
  };
  const fake = createFakeVaultProvider({
    vaults: [
      {
        externalVaultId: "src",
        name: "Source",
        items: [
          {
            externalItemId: "deploy",
            name: "Deploy key",
            type: "api_key",
            fields: [{ externalFieldId: "value", name: "value", value: "old-value" }],
          },
        ],
      },
      { externalVaultId: "dst", name: "Target" },
    ],
  });
  const controls: Controls = {
    duringTargetWrite: null,
    failSourceListingAfterCopy: false,
    copied: false,
  };
  const host: VaultProvider & { calls: typeof fake.calls } = {
    ...fake,
    async listItems(ctx, externalVaultId) {
      if (externalVaultId === "src" && controls.copied && controls.failSourceListingAfterCopy) {
        throw new VaultProviderError("provider_unavailable", "the source listing timed out");
      }
      return await fake.listItems(ctx, externalVaultId);
    },
    async writeItem(ctx, externalVaultId, input) {
      if (externalVaultId === "dst" && controls.duringTargetWrite) {
        await controls.duringTargetWrite();
      }
      const written = await fake.writeItem(ctx, externalVaultId, input);
      if (externalVaultId === "dst") controls.copied = true;
      return written;
    },
  };
  const providers = createVaultProviderRegistry({ host: async () => host });
  const service = createVaultService({ db, encryptionKey: key, providers });
  const link = async (name: string, providerVaultRef: string) => {
    const vault = await linkProviderVault(db, context, {
      ownerKind: "workspace",
      name,
      source: "host",
      providerVaultRef,
      mode: "read_write",
    });
    await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
    return vault;
  };
  const source = await link("Source", "src");
  const target = await link("Target", "dst");
  const direct = () => ({ connectionId: null, budget: createProviderCallBudget(50) });
  const providerValue = async (vaultRef: string, name: string) => {
    const item = (await fake.listItems(direct(), vaultRef)).find((meta) => meta.name === name);
    if (!item) return null;
    const [value] = await fake.readFields(direct(), vaultRef, item.externalItemId, [
      item.fields[0]!.externalFieldId,
    ]);
    return value!.material.type === "text" ? value!.material.value : null;
  };
  const sourceItemId = async () => {
    const page = await service.listItems(actor, workspaceId, source.id, {});
    return page.items.find((item) => item.name === "Deploy key")!.id;
  };
  const move = async () =>
    await service.moveItem(actor, workspaceId, await sourceItemId(), {
      targetVaultId: target.id,
      mode: "move",
    });
  return {
    fake,
    controls,
    source,
    target,
    move,
    providerValue,
    calls: (op: string) => fake.calls.filter((call) => call.op === op).length,
    editSourceInProvider: async (value: string) => {
      await fake.writeItem(direct(), "src", {
        externalItemId: "deploy",
        name: "Deploy key",
        type: "api_key",
        websites: [],
        fields: [{ externalFieldId: "value", name: "value", kind: "concealed", value }],
      });
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (isVaultError(error)) return error;
    throw error;
  }
  throw new Error("expected the move to be refused");
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "moving an item out of a connected vault",
  () => {
    test("an unchanged original is archived after the copy is saved", async () => {
      if (!client) return;
      const w = await world();
      const moved = await w.move();
      expect(moved.vaultId).toBe(w.target.id);
      expect(w.calls("archiveItem")).toBe(1);
      expect(await w.providerValue("dst", "Deploy key")).toBe("old-value");
      expect(await w.providerValue("src", "Deploy key")).toBeNull();
    });

    test("an original edited in the provider while the copy was saved is kept", async () => {
      if (!client) return;
      const w = await world();
      w.controls.duringTargetWrite = async () => {
        w.controls.duringTargetWrite = null;
        await w.editSourceInProvider("new-value");
      };
      const error = await refusal(w.move());
      expect(error.details).toMatchObject({
        saved: true,
        sourceArchived: false,
        sourceChanged: true,
        vaultId: w.target.id,
        sourceVaultId: w.source.id,
      });
      expect(error.message).toContain("Do not move it again");
      expect(w.calls("archiveItem")).toBe(0);
      // The newer original stays in the provider; the copy has what was read.
      expect(await w.providerValue("src", "Deploy key")).toBe("new-value");
      expect(await w.providerValue("dst", "Deploy key")).toBe("old-value");
    });

    test("an original whose current version cannot be confirmed is kept", async () => {
      if (!client) return;
      const w = await world();
      w.controls.failSourceListingAfterCopy = true;
      const error = await refusal(w.move());
      expect(error.details).toMatchObject({ saved: true, sourceArchived: false });
      expect(w.calls("archiveItem")).toBe(0);
      expect(await w.providerValue("src", "Deploy key")).toBe("old-value");
      expect(await w.providerValue("dst", "Deploy key")).toBe("old-value");
    });
  },
);
