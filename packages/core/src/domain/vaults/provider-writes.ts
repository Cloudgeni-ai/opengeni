import {
  generatePassword,
  isValidTotpInput,
  secretNameKey,
  type VaultFieldInput,
  type VaultFieldKind,
  type VaultItemType,
} from "@opengeni/contracts";
import {
  getProviderVaultItemRef,
  VaultError,
  type Database,
  type VaultDbContext,
  type VaultFieldRow,
  type VaultRow,
} from "@opengeni/db";
import {
  isVaultProviderError,
  type ProviderCallBudget,
  type ProviderWriteField,
  type VaultProvider,
  type VaultProviderRegistry,
} from "@opengeni/vaults";
import { vaultErrorCodeForProvider } from "./provider-registry";
import { syncLinkedProviderVault } from "./provider-sync";

/**
 * Edits of items in a read-write connected vault (OP-3): the change is written
 * to the provider (1Password `items.get` → patch → `items.put`, with the
 * mirrored version as the expected version), then the metadata mirror is
 * refreshed. Values never touch Opengeni storage.
 */

/** One field change; the REST `VaultFieldInput` and the agent `secret_save` field both fit. */
export interface ProviderFieldChange {
  fieldId?: string | undefined;
  name: string;
  kind?: VaultFieldKind | undefined;
  value?: string | undefined;
  generate?: VaultFieldInput["generate"] | undefined;
  fromReference?: string | undefined;
  fileBase64?: string | undefined;
  restoreVersion?: number | undefined;
  remove?: true | undefined;
}

export interface ProviderItemChange {
  name?: string | undefined;
  type?: VaultItemType | undefined;
  websites?: string[] | undefined;
  fields?: readonly ProviderFieldChange[] | undefined;
}

export interface ProviderWriteDeps {
  db: Database;
  context: VaultDbContext;
  providers: VaultProviderRegistry;
  /** Resolves `fromReference` field inputs (audited as a use by the caller). */
  resolveReference: (raw: string) => Promise<string>;
  budget?: ProviderCallBudget;
}

const TEXT_FIELD_NAMES = ["username", "user", "email", "login", "account"];

function defaultKind(name: string): VaultFieldKind {
  return TEXT_FIELD_NAMES.includes(secretNameKey(name)) ? "text" : "concealed";
}

/** A connected vault the caller may change items in. */
export function assertProviderVaultWritable(vault: VaultRow): void {
  if (vault.source === "opengeni") {
    throw new VaultError("vault_permission_denied", "not a connected vault");
  }
  if (vault.mode !== "read_write") {
    throw new VaultError("vault_read_only", "vault is read-only", { vaultId: vault.id });
  }
  if (vault.ownerKind === "user" && !vault.ownedByCaller) {
    throw new VaultError("vault_not_found", "vault not found", { vaultId: vault.id });
  }
}

async function providerFieldWrites(
  fields: readonly ProviderFieldChange[],
  existing: readonly VaultFieldRow[],
  resolveReference: (raw: string) => Promise<string>,
  generated: string[],
): Promise<ProviderWriteField[]> {
  const writes: ProviderWriteField[] = [];
  for (const input of fields) {
    const current = existing.find(
      (field) =>
        (input.fieldId !== undefined && field.id === input.fieldId) ||
        secretNameKey(field.name) === secretNameKey(input.name),
    );
    const kind: VaultFieldKind = input.kind ?? current?.kind ?? defaultKind(input.name);
    const base: ProviderWriteField = {
      ...(current?.providerFieldRef ? { externalFieldId: current.providerFieldRef } : {}),
      name: input.name,
      kind,
    };
    if (input.remove) {
      writes.push({ ...base, remove: true });
      continue;
    }
    if (input.restoreVersion !== undefined) {
      throw new VaultError(
        "provider_unavailable",
        "connected vaults keep their history in the provider; restore it there",
        { field: input.name },
      );
    }
    if (input.fileBase64 !== undefined || kind === "file") {
      throw new VaultError(
        "provider_unavailable",
        "files in connected vaults are read-only in Opengeni",
        { field: input.name },
      );
    }
    let value: string;
    if (input.generate !== undefined) {
      value = generatePassword(input.generate);
      generated.push(input.name);
    } else if (input.fromReference !== undefined)
      value = await resolveReference(input.fromReference);
    else value = input.value ?? "";
    if (kind === "totp") {
      if (!isValidTotpInput(value)) {
        throw new VaultError(
          "invalid_secret_name",
          `${input.name} is not a valid two-factor setup key or otpauth:// link`,
          { field: input.name },
        );
      }
      value = value.trim();
    }
    writes.push({ ...base, value });
  }
  return writes;
}

function providerFailure(error: unknown): never {
  if (isVaultProviderError(error)) {
    throw new VaultError(vaultErrorCodeForProvider(error.code, "write"), error.message, {
      ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  }
  throw error;
}

async function providerFor(deps: ProviderWriteDeps, vault: VaultRow): Promise<VaultProvider> {
  try {
    return await deps.providers.forVault({
      source: vault.source,
      providerConnectionId: vault.providerConnectionId,
    });
  } catch (error) {
    return providerFailure(error);
  }
}

async function refreshAndFind(
  deps: ProviderWriteDeps,
  vault: VaultRow,
  providerItemRef: string,
): Promise<string> {
  await syncLinkedProviderVault({
    db: deps.db,
    context: deps.context,
    vaultId: vault.id,
    providers: deps.providers,
    force: true,
    ...(deps.budget ? { budget: deps.budget } : {}),
  });
  try {
    const ref = await getProviderVaultItemRef(deps.db, deps.context, {
      vaultId: vault.id,
      providerItemRef,
    });
    return ref.itemId;
  } catch (error) {
    if (error instanceof VaultError && error.code === "vault_item_not_found") {
      throw new VaultError(
        "provider_unavailable",
        "saved in the provider; Opengeni will show it after the next sync",
        { vaultId: vault.id },
      );
    }
    throw error;
  }
}

/** Create (existing = null) or update an item in a connected read-write vault; returns its item id. */
export async function writeProviderVaultItem(
  deps: ProviderWriteDeps,
  input: {
    vault: VaultRow;
    existing: {
      itemId: string;
      name: string;
      type: VaultItemType;
      websites: string[];
      fields: VaultFieldRow[];
      expectedGeneration?: number | undefined;
    } | null;
    change: ProviderItemChange;
    /** Receives the names of fields whose values were generated. */
    generated?: string[];
  },
): Promise<string> {
  const { vault, existing, change } = input;
  assertProviderVaultWritable(vault);
  if ((change.type ?? existing?.type) === "passkey") {
    throw new VaultError("vault_permission_denied", "passkeys live only in Opengeni vaults");
  }
  let externalItemId: string | undefined;
  let expectedVersion: string | null | undefined;
  if (existing) {
    const ref = await getProviderVaultItemRef(deps.db, deps.context, {
      vaultId: vault.id,
      itemId: existing.itemId,
    });
    if (
      existing.expectedGeneration !== undefined &&
      existing.expectedGeneration !== ref.generation
    ) {
      throw new VaultError("vault_generation_conflict", "the item changed; reload and retry", {
        itemId: existing.itemId,
        generation: ref.generation,
      });
    }
    externalItemId = ref.providerItemRef;
    expectedVersion = ref.providerVersion;
  }
  const fields = await providerFieldWrites(
    change.fields ?? [],
    existing?.fields ?? [],
    deps.resolveReference,
    input.generated ?? [],
  );
  const provider = await providerFor(deps, vault);
  let written;
  try {
    written = await provider.writeItem(
      { connectionId: vault.providerConnectionId, budget: deps.budget ?? { take() {} } },
      vault.providerVaultRef ?? "",
      {
        ...(externalItemId ? { externalItemId, expectedVersion: expectedVersion ?? null } : {}),
        name: change.name ?? existing?.name ?? "",
        type: change.type ?? existing?.type ?? "login",
        websites: change.websites ?? existing?.websites ?? [],
        fields,
      },
    );
  } catch (error) {
    return providerFailure(error);
  }
  return await refreshAndFind(deps, vault, written.externalItemId);
}

/** Archive an item in a connected read-write vault (the provider keeps it recoverable). */
export async function archiveProviderVaultItem(
  deps: ProviderWriteDeps,
  input: { vault: VaultRow; itemId: string },
): Promise<void> {
  assertProviderVaultWritable(input.vault);
  const ref = await getProviderVaultItemRef(deps.db, deps.context, {
    vaultId: input.vault.id,
    itemId: input.itemId,
  });
  const provider = await providerFor(deps, input.vault);
  try {
    await provider.archiveItem(
      { connectionId: input.vault.providerConnectionId, budget: deps.budget ?? { take() {} } },
      input.vault.providerVaultRef ?? "",
      ref.providerItemRef,
    );
  } catch (error) {
    providerFailure(error);
  }
  await syncLinkedProviderVault({
    db: deps.db,
    context: deps.context,
    vaultId: input.vault.id,
    providers: deps.providers,
    force: true,
    ...(deps.budget ? { budget: deps.budget } : {}),
  });
}
