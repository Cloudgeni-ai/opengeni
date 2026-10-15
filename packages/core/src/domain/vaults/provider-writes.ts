import { randomUUID } from "node:crypto";
import {
  generatePassword,
  isValidTotpInput,
  secretNameKey,
  type VaultFieldInput,
  type VaultFieldKind,
  type VaultItemType,
  type VaultProviderOperations,
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
  providerOperations,
  type ProviderCallBudget,
  type ProviderWriteField,
  type VaultProvider,
  type VaultProviderContext,
  type VaultProviderRegistry,
} from "@opengeni/vaults";
import {
  intersectProviderOperations,
  providerOperationsForMode,
  storedProviderOperations,
  withoutProviderWrites,
} from "./mapping";
import { vaultErrorCodeForProvider } from "./provider-registry";
import { syncLinkedProviderVault, type ProviderVaultSyncResult } from "./provider-sync";

/**
 * Edits of items in a read-write connected vault (OP-3, external vaults §10):
 * the change is written to the provider (with the mirrored version as the
 * expected version), then the metadata mirror is refreshed. Values never
 * touch Opengeni storage.
 *
 * Every write is checked against the vault's effective operations first (the
 * provider's current capabilities, narrowed by what it last reported for the
 * vault and by the link mode), before any reference is resolved or value
 * generated. A provider mutation is never retried: when its outcome is
 * unknown the caller is told to check the vault, and a write that succeeded
 * but could not be listed yet is reported as saved, never as a failure that
 * invites saving it again.
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

/** An operation a connected vault may not allow; reported in `vault_read_only` details. */
export type ProviderWriteOperation =
  | "createItem"
  | "updateItem"
  | "removeField"
  | "createTotp"
  | "updateTotp"
  | "archiveItem"
  | "deleteItem"
  | "restoreItem"
  | "writeFiles"
  | "restoreFieldHistory";

/** The result of a provider write once the mirror was refreshed. */
export type ProviderWriteOutcome =
  | { status: "listed"; itemId: string }
  | {
      /**
       * The provider confirmed the write, but the refreshed mirror does not
       * show it yet (for example the refresh was rate limited). It must not be
       * saved again; it appears after the next successful sync.
       */
      status: "saved_not_listed";
      vaultId: string;
      sync: ProviderVaultSyncResult["status"] | "error";
    };

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

const NO_PROVIDER_OPERATIONS: VaultProviderOperations = withoutProviderWrites({
  createItemTypes: [],
  updateItem: false,
  removeField: false,
  archiveItem: false,
  archiveKind: "none",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: false,
  updateTotp: false,
  createVault: false,
  restoreFieldHistory: false,
});

/**
 * What a connected vault allows now: the provider's current capabilities,
 * narrowed by the operations it last reported for this vault (a read-only
 * share, for example) and by the link mode. Permanent deletion is never
 * allowed.
 */
export function effectiveProviderOperations(
  vault: VaultRow,
  provider: Pick<VaultProvider, "capabilities"> | null,
): VaultProviderOperations {
  if (vault.source === "opengeni") return NO_PROVIDER_OPERATIONS;
  const stored = storedProviderOperations(vault);
  const live = provider ? providerOperations(provider.capabilities()) : null;
  const operations = live && stored ? intersectProviderOperations(live, stored) : (stored ?? live);
  return operations ? providerOperationsForMode(operations, vault.mode) : NO_PROVIDER_OPERATIONS;
}

function refuse(
  vault: VaultRow,
  operation: ProviderWriteOperation,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new VaultError("vault_read_only", message, { vaultId: vault.id, operation, ...details });
}

/** Refuses a provider operation Opengeni never performs, with the reason. */
export function refuseProviderOperation(
  vault: VaultRow,
  operation: Extract<ProviderWriteOperation, "deleteItem" | "restoreItem" | "restoreFieldHistory">,
): never {
  const messages = {
    deleteItem: `Opengeni never permanently deletes items in ${vault.name}. Archive the item, or delete it in the provider itself.`,
    restoreItem: `Items archived in ${vault.name} are restored in the provider itself; the restored item appears after the next sync.`,
    restoreFieldHistory: `${vault.name} keeps field history in the provider; restore an earlier value there.`,
  } as const;
  return refuse(vault, operation, messages[operation]);
}

type PlannedField = {
  input: ProviderFieldChange;
  base: ProviderWriteField;
  kind: VaultFieldKind;
};

/** Checks every field change against the vault's operations, before any value exists. */
function planFieldWrites(
  vault: VaultRow,
  operations: VaultProviderOperations,
  creating: boolean,
  fields: readonly ProviderFieldChange[],
  existing: readonly VaultFieldRow[],
): PlannedField[] {
  return fields.map((input) => {
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
    if (input.restoreVersion !== undefined) {
      return refuseProviderOperation(vault, "restoreFieldHistory");
    }
    if (input.fileBase64 !== undefined || kind === "file" || current?.kind === "file") {
      throw new VaultError(
        "provider_unavailable",
        "files in connected vaults are read-only in Opengeni",
        { field: input.name, vaultId: vault.id, operation: "writeFiles" },
      );
    }
    const totp = kind === "totp" || current?.kind === "totp";
    if (input.remove) {
      if (!operations.removeField) {
        refuse(vault, "removeField", `${vault.name} does not allow removing fields here`, {
          field: input.name,
        });
      }
      if (totp && !operations.updateTotp) {
        refuse(vault, "updateTotp", `${vault.name} does not allow changing one-time passwords`, {
          field: input.name,
        });
      }
      return { input, base, kind };
    }
    if (totp) {
      const allowed = creating ? operations.createTotp : operations.updateTotp;
      if (!allowed) {
        refuse(
          vault,
          creating ? "createTotp" : "updateTotp",
          `${vault.name} does not allow ${creating ? "saving" : "changing"} one-time passwords`,
          { field: input.name },
        );
      }
    }
    return { input, base, kind };
  });
}

async function providerFieldValues(
  planned: readonly PlannedField[],
  resolveReference: (raw: string) => Promise<string>,
  generated: string[],
): Promise<ProviderWriteField[]> {
  const writes: ProviderWriteField[] = [];
  for (const { input, base, kind } of planned) {
    if (input.remove) {
      writes.push({ ...base, remove: true });
      continue;
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

/**
 * A provider mutation that failed. Only a provider's own definitive answer is
 * a failure; anything else (a timeout, a dropped connection, an adapter
 * defect, or a provider that says so) leaves the outcome unknown, and the
 * mutation is not retried.
 */
function mutationFailure(vault: VaultRow, error: unknown, what: string): never {
  if (isVaultProviderError(error) && error.code !== "provider_outcome_unknown") {
    return providerFailure(error);
  }
  throw new VaultError(
    "provider_outcome_unknown",
    `${vault.name} did not confirm ${what}. It may have been applied: check the vault before trying again.`,
    { vaultId: vault.id },
  );
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

function mutationContext(deps: ProviderWriteDeps, vault: VaultRow): VaultProviderContext {
  return {
    connectionId: vault.providerConnectionId,
    budget: deps.budget ?? { take() {} },
    cacheEpoch: vault.providerCacheEpoch ?? null,
    // Read-before-write must see the provider's current item, never a cached copy.
    forceRefresh: true,
    idempotencyKey: randomUUID(),
  };
}

/** Refresh after a confirmed write; never turns the confirmed write into a failure. */
async function refreshAfterWrite(
  deps: ProviderWriteDeps,
  vault: VaultRow,
): Promise<ProviderVaultSyncResult["status"] | "error"> {
  try {
    const result = await syncLinkedProviderVault({
      db: deps.db,
      context: deps.context,
      vaultId: vault.id,
      providers: deps.providers,
      force: true,
      ...(deps.budget ? { budget: deps.budget } : {}),
    });
    return result.status;
  } catch {
    return "error";
  }
}

async function refreshAndFind(
  deps: ProviderWriteDeps,
  vault: VaultRow,
  providerItemRef: string,
): Promise<ProviderWriteOutcome> {
  const sync = await refreshAfterWrite(deps, vault);
  try {
    const ref = await getProviderVaultItemRef(deps.db, deps.context, {
      vaultId: vault.id,
      providerItemRef,
    });
    return { status: "listed", itemId: ref.itemId };
  } catch (error) {
    if (error instanceof VaultError && error.code === "vault_item_not_found") {
      return { status: "saved_not_listed", vaultId: vault.id, sync };
    }
    throw error;
  }
}

/**
 * Create (existing = null) or update an item in a connected read-write vault
 * and report whether the refreshed mirror lists it.
 */
export async function writeProviderVaultItemOutcome(
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
): Promise<ProviderWriteOutcome> {
  const { vault, existing, change } = input;
  assertProviderVaultWritable(vault);
  const type = change.type ?? existing?.type ?? "login";
  if (type === "passkey") {
    throw new VaultError("vault_permission_denied", "passkeys live only in Opengeni vaults");
  }
  const provider = await providerFor(deps, vault);
  const operations = effectiveProviderOperations(vault, provider);
  if (existing) {
    if (!operations.updateItem) {
      refuse(vault, "updateItem", `${vault.name} does not allow changing items here`);
    }
  } else if (!operations.createItemTypes.includes(type)) {
    refuse(
      vault,
      "createItem",
      operations.createItemTypes.length === 0
        ? `${vault.name} does not allow creating items here`
        : `${vault.name} cannot hold ${type} items; it accepts ${operations.createItemTypes.join(", ")}`,
      { itemType: type, allowedItemTypes: operations.createItemTypes },
    );
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
  const planned = planFieldWrites(
    vault,
    operations,
    existing === null,
    change.fields ?? [],
    existing?.fields ?? [],
  );
  const fields = await providerFieldValues(planned, deps.resolveReference, input.generated ?? []);
  const name = change.name ?? existing?.name ?? "";
  let written;
  try {
    written = await provider.writeItem(mutationContext(deps, vault), vault.providerVaultRef ?? "", {
      ...(externalItemId ? { externalItemId, expectedVersion: expectedVersion ?? null } : {}),
      name,
      type,
      websites: change.websites ?? existing?.websites ?? [],
      fields,
    });
  } catch (error) {
    return mutationFailure(vault, error, existing ? `the change to ${name}` : `saving ${name}`);
  }
  return await refreshAndFind(deps, vault, written.externalItemId);
}

/** Thrown when a confirmed provider write is not listed yet: it must not be saved again. */
export function savedNotListedError(
  vault: VaultRow,
  itemName: string,
  outcome: Extract<ProviderWriteOutcome, { status: "saved_not_listed" }>,
): VaultError {
  return new VaultError(
    "provider_inventory_incomplete",
    `Saved ${itemName} in ${vault.name}, but Opengeni could not list it yet. Do not save it again: it appears after the next successful sync.`,
    { saved: true, vaultId: outcome.vaultId, itemName, sync: outcome.sync },
  );
}

/**
 * Create (existing = null) or update an item in a connected read-write vault;
 * returns its item id. A confirmed write that is not listed yet throws
 * `provider_inventory_incomplete` with `details.saved = true`.
 */
export async function writeProviderVaultItem(
  deps: ProviderWriteDeps,
  input: Parameters<typeof writeProviderVaultItemOutcome>[1],
): Promise<string> {
  const outcome = await writeProviderVaultItemOutcome(deps, input);
  if (outcome.status === "listed") return outcome.itemId;
  throw savedNotListedError(
    input.vault,
    input.change.name ?? input.existing?.name ?? "the item",
    outcome,
  );
}

/** Whether an item can leave this vault recoverably (moves need it before anything is written). */
export function providerArchiveKind(
  vault: VaultRow,
  provider: Pick<VaultProvider, "capabilities"> | null,
): "archive" | "trash" | null {
  const operations = effectiveProviderOperations(vault, provider);
  if (!operations.archiveItem) return null;
  return operations.archiveKind === "archive" || operations.archiveKind === "trash"
    ? operations.archiveKind
    : null;
}

/**
 * Refuses, before any value is read or written, an item a connected vault
 * cannot receive as a new item (its type, a one-time password, or a file).
 */
export async function assertProviderVaultAccepts(
  deps: ProviderWriteDeps,
  vault: VaultRow,
  item: { type: VaultItemType; fields: ReadonlyArray<{ kind: VaultFieldKind }> },
): Promise<void> {
  assertProviderVaultWritable(vault);
  if (item.type === "passkey") {
    throw new VaultError("vault_permission_denied", "passkeys live only in Opengeni vaults");
  }
  if (item.fields.some((field) => field.kind === "file")) {
    throw new VaultError(
      "provider_unavailable",
      "files in connected vaults are read-only in Opengeni; copy the item into an Opengeni vault instead",
      { vaultId: vault.id, operation: "writeFiles" },
    );
  }
  const operations = effectiveProviderOperations(vault, await providerFor(deps, vault));
  if (!operations.createItemTypes.includes(item.type)) {
    refuse(
      vault,
      "createItem",
      operations.createItemTypes.length === 0
        ? `${vault.name} does not allow creating items here`
        : `${vault.name} cannot hold ${item.type} items; it accepts ${operations.createItemTypes.join(", ")}`,
      { itemType: item.type, allowedItemTypes: operations.createItemTypes },
    );
  }
  if (item.fields.some((field) => field.kind === "totp") && !operations.createTotp) {
    refuse(vault, "createTotp", `${vault.name} does not allow saving one-time passwords`);
  }
}

/**
 * Refuses a move out of a connected vault that cannot archive the original
 * recoverably (copy instead); returns where the original will go.
 */
export async function assertProviderVaultReleases(
  deps: ProviderWriteDeps,
  vault: VaultRow,
): Promise<"archive" | "trash"> {
  assertProviderVaultWritable(vault);
  const archiveKind = providerArchiveKind(vault, await providerFor(deps, vault));
  if (archiveKind === null) {
    refuse(
      vault,
      "archiveItem",
      `${vault.name} cannot archive the original recoverably, so the item cannot be moved out of it; copy it instead`,
    );
  }
  return archiveKind;
}

/**
 * Archive an item in a connected read-write vault. Only a recoverable archive
 * (the provider's archive or trash) is ever used; permanent deletion is not.
 */
export async function archiveProviderVaultItem(
  deps: ProviderWriteDeps,
  input: { vault: VaultRow; itemId: string },
): Promise<{ archiveKind: "archive" | "trash" }> {
  const { vault } = input;
  assertProviderVaultWritable(vault);
  const ref = await getProviderVaultItemRef(deps.db, deps.context, {
    vaultId: vault.id,
    itemId: input.itemId,
  });
  const provider = await providerFor(deps, vault);
  const archiveKind = providerArchiveKind(vault, provider);
  if (archiveKind === null) {
    refuse(vault, "archiveItem", `${vault.name} does not allow archiving items here`);
  }
  try {
    await provider.archiveItem(
      mutationContext(deps, vault),
      vault.providerVaultRef ?? "",
      ref.providerItemRef,
    );
  } catch (error) {
    mutationFailure(vault, error, "archiving the item");
  }
  await refreshAfterWrite(deps, vault);
  return { archiveKind };
}
