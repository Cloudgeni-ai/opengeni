import type { SecretMaterial, VaultFieldKind, VaultItemType } from "@opengeni/contracts";
import { parseTotpInput } from "@opengeni/contracts";
import {
  VaultProviderError,
  type ProviderItemMeta,
  type ProviderVault,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "../provider";

export interface FakeProviderSeedField {
  externalFieldId?: string;
  name: string;
  kind?: VaultFieldKind;
  value: string;
}
export interface FakeProviderSeedItem {
  externalItemId?: string;
  name: string;
  type?: VaultItemType;
  websites?: string[];
  fields: FakeProviderSeedField[];
}
export interface FakeProviderSeedVault {
  externalVaultId?: string;
  name: string;
  items?: FakeProviderSeedItem[];
}
export interface FakeProviderSeed {
  accountName?: string | null;
  vaults?: FakeProviderSeedVault[];
  capabilities?: Partial<Omit<VaultProviderCapabilities, "passkeys">>;
  /** Every call fails with this code (auth, outage and rate-limit tests). */
  failWith?: VaultProviderErrorCode | null;
}
export interface FakeProviderCall {
  op:
    | "validate"
    | "listVaults"
    | "listItems"
    | "readFields"
    | "writeItem"
    | "archiveItem"
    | "createVault";
  connectionId: string | null;
  externalVaultId?: string;
  externalItemId?: string;
  externalFieldIds?: readonly string[];
}

interface FakeField {
  externalFieldId: string;
  name: string;
  kind: VaultFieldKind;
  value: string;
}
interface FakeItem {
  externalItemId: string;
  name: string;
  type: VaultItemType;
  websites: string[];
  fields: FakeField[];
  version: number;
  archived: boolean;
  updatedAt: string;
}
interface FakeVault {
  externalVaultId: string;
  name: string;
  items: FakeItem[];
  contentVersion: number;
}

let fakeIdCounter = 0;
function fakeId(prefix: string): string {
  fakeIdCounter += 1;
  return `${prefix}${fakeIdCounter.toString(36).padStart(6, "0")}`;
}

function materialFor(field: FakeField): SecretMaterial {
  if (field.kind === "totp") return { type: "totp", params: parseTotpInput(field.value) };
  if (field.kind === "file") {
    return { type: "bytes", value: Uint8Array.from(atob(field.value), (c) => c.charCodeAt(0)) };
  }
  return { type: "text", value: field.value };
}

function itemMeta(item: FakeItem): ProviderItemMeta {
  return {
    externalItemId: item.externalItemId,
    name: item.name,
    type: item.type,
    websites: [...item.websites],
    fields: item.fields.map(({ externalFieldId, name, kind }) => ({ externalFieldId, name, kind })),
    version: String(item.version),
    updatedAt: item.updatedAt,
  };
}

function vaultMeta(vault: FakeVault): ProviderVault {
  return {
    externalVaultId: vault.externalVaultId,
    name: vault.name,
    contentVersion: String(vault.contentVersion),
    itemCount: vault.items.filter((item) => !item.archived).length,
  };
}

/**
 * In-memory `VaultProvider` for tests and local development. Values are
 * kept in memory only; every call is recorded in `calls` (without values) and
 * charged to the context budget like a real provider.
 */
export function createFakeVaultProvider(
  seed: FakeProviderSeed = {},
): VaultProvider & { calls: FakeProviderCall[] } {
  const calls: FakeProviderCall[] = [];
  const now = () => new Date().toISOString();
  const vaults: FakeVault[] = (seed.vaults ?? []).map((vault) => ({
    externalVaultId: vault.externalVaultId ?? fakeId("fv"),
    name: vault.name,
    contentVersion: 1,
    items: (vault.items ?? []).map((item) => ({
      externalItemId: item.externalItemId ?? fakeId("fi"),
      name: item.name,
      type: item.type ?? "login",
      websites: item.websites ?? [],
      version: 1,
      archived: false,
      updatedAt: now(),
      fields: item.fields.map((field) => ({
        externalFieldId: field.externalFieldId ?? fakeId("ff"),
        name: field.name,
        kind: field.kind ?? (field.name === "username" ? "text" : "concealed"),
        value: field.value,
      })),
    })),
  }));
  const capabilities: VaultProviderCapabilities = {
    write: true,
    createVault: true,
    totp: true,
    files: true,
    groupGrants: false,
    ...seed.capabilities,
    passkeys: false,
  };

  function charge(
    ctx: VaultProviderContext,
    call: FakeProviderCall,
    op: "list" | "read" | "write" | "admin",
  ) {
    calls.push(call);
    if (ctx.signal?.aborted) throw new VaultProviderError("provider_unavailable", "aborted");
    ctx.budget.take(op);
    if (seed.failWith)
      throw new VaultProviderError(seed.failWith, `fake provider: ${seed.failWith}`);
  }
  function vaultById(id: string): FakeVault {
    const vault = vaults.find((candidate) => candidate.externalVaultId === id);
    if (!vault) throw new VaultProviderError("provider_not_found", "vault not found");
    return vault;
  }
  function itemById(vault: FakeVault, id: string): FakeItem {
    const item = vault.items.find(
      (candidate) => candidate.externalItemId === id && !candidate.archived,
    );
    if (!item) throw new VaultProviderError("provider_not_found", "item not found");
    return item;
  }

  const provider: VaultProvider & { calls: FakeProviderCall[] } = {
    id: "fake",
    calls,
    capabilities: () => ({ ...capabilities }),
    async validate(ctx) {
      charge(ctx, { op: "validate", connectionId: ctx.connectionId }, "admin");
      return { accountName: seed.accountName ?? "Fake account" };
    },
    async listVaults(ctx) {
      charge(ctx, { op: "listVaults", connectionId: ctx.connectionId }, "list");
      return vaults.map(vaultMeta);
    },
    async listItems(ctx, externalVaultId) {
      charge(ctx, { op: "listItems", connectionId: ctx.connectionId, externalVaultId }, "list");
      return vaultById(externalVaultId)
        .items.filter((item) => !item.archived)
        .map(itemMeta);
    },
    async readFields(ctx, externalVaultId, externalItemId, externalFieldIds) {
      charge(
        ctx,
        {
          op: "readFields",
          connectionId: ctx.connectionId,
          externalVaultId,
          externalItemId,
          externalFieldIds,
        },
        "read",
      );
      const item = itemById(vaultById(externalVaultId), externalItemId);
      return externalFieldIds.map((externalFieldId) => {
        const field = item.fields.find(
          (candidate) => candidate.externalFieldId === externalFieldId,
        );
        if (!field) throw new VaultProviderError("provider_not_found", "field not found");
        return { externalFieldId, material: materialFor(field) };
      });
    },
    async writeItem(ctx, externalVaultId, input) {
      charge(
        ctx,
        {
          op: "writeItem",
          connectionId: ctx.connectionId,
          externalVaultId,
          ...(input.externalItemId ? { externalItemId: input.externalItemId } : {}),
        },
        "write",
      );
      if (!capabilities.write)
        throw new VaultProviderError("provider_conflict", "provider is read-only");
      const vault = vaultById(externalVaultId);
      let item: FakeItem;
      if (input.externalItemId) {
        item = itemById(vault, input.externalItemId);
        if (input.expectedVersion != null && input.expectedVersion !== String(item.version)) {
          throw new VaultProviderError("provider_conflict", "item changed since it was read");
        }
      } else {
        item = {
          externalItemId: fakeId("fi"),
          name: input.name,
          type: input.type,
          websites: [],
          fields: [],
          version: 0,
          archived: false,
          updatedAt: now(),
        };
        vault.items.push(item);
      }
      item.name = input.name;
      item.type = input.type;
      item.websites = [...input.websites];
      for (const change of input.fields) {
        const existing = item.fields.find(
          (field) =>
            (change.externalFieldId !== undefined &&
              field.externalFieldId === change.externalFieldId) ||
            (change.externalFieldId === undefined && field.name === change.name),
        );
        if (change.remove) {
          if (existing) item.fields.splice(item.fields.indexOf(existing), 1);
          continue;
        }
        if (existing) {
          existing.name = change.name;
          existing.kind = change.kind;
          if (change.value !== undefined) existing.value = change.value;
        } else {
          item.fields.push({
            externalFieldId: fakeId("ff"),
            name: change.name,
            kind: change.kind,
            value: change.value ?? "",
          });
        }
      }
      item.version += 1;
      item.updatedAt = now();
      vault.contentVersion += 1;
      return itemMeta(item);
    },
    async archiveItem(ctx, externalVaultId, externalItemId) {
      charge(
        ctx,
        { op: "archiveItem", connectionId: ctx.connectionId, externalVaultId, externalItemId },
        "write",
      );
      const vault = vaultById(externalVaultId);
      itemById(vault, externalItemId).archived = true;
      vault.contentVersion += 1;
    },
    async createVault(ctx, input) {
      charge(ctx, { op: "createVault", connectionId: ctx.connectionId }, "admin");
      if (!capabilities.createVault)
        throw new VaultProviderError("provider_conflict", "cannot create vaults");
      const vault: FakeVault = {
        externalVaultId: fakeId("fv"),
        name: input.name,
        items: [],
        contentVersion: 1,
      };
      vaults.push(vault);
      return vaultMeta(vault);
    },
  };
  return provider;
}
