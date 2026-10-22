/**
 * Vault rows (encrypted, as the 0739 routines return them) to the public
 * contract shapes. Only text-kind field values are decrypted for display;
 * every other kind stays server-side until an audited reveal or a resolve.
 */
import {
  formatSecretReference,
  secretNameKey,
  VaultProviderOperations,
  type VaultItem,
  type VaultItemField,
  type VaultItemReferences,
  type VaultItemSummary,
  type VaultMode,
  type VaultSummary,
} from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  type VaultFieldRow,
  type VaultItemRow,
  type VaultRow,
} from "@opengeni/db";
import { providerVaultFreshness } from "./provider-sync";

/** What the caller may do beyond reading; decided by the route's grant. */
export type VaultCallerAuthority = {
  /** `secrets:write` */
  write: boolean;
  /** `account:admin` on the organization */
  accountAdmin: boolean;
};

/** No writes at all: what a read-only link or a read-only provider vault allows. */
export function withoutProviderWrites(
  operations: VaultProviderOperations,
): VaultProviderOperations {
  return {
    ...operations,
    createItemTypes: [],
    updateItem: false,
    removeField: false,
    archiveItem: false,
    archiveKind: "none",
    deleteItem: false,
    restoreItem: false,
    writeFiles: false,
    createTotp: false,
    updateTotp: false,
    createVault: false,
    restoreFieldHistory: false,
  };
}

/** Operations both sides allow (an archive needs both to agree on its kind). */
export function intersectProviderOperations(
  left: VaultProviderOperations,
  right: VaultProviderOperations,
): VaultProviderOperations {
  const archiveItem =
    left.archiveItem &&
    right.archiveItem &&
    left.archiveKind === right.archiveKind &&
    left.archiveKind !== "none";
  return {
    createItemTypes: left.createItemTypes.filter(
      (type) => type !== "passkey" && right.createItemTypes.includes(type),
    ),
    updateItem: left.updateItem && right.updateItem,
    removeField: left.removeField && right.removeField,
    archiveItem,
    archiveKind: archiveItem ? left.archiveKind : "none",
    deleteItem: false,
    restoreItem: left.restoreItem && right.restoreItem,
    readFiles: left.readFiles && right.readFiles,
    writeFiles: left.writeFiles && right.writeFiles,
    createTotp: left.createTotp && right.createTotp,
    updateTotp: left.updateTotp && right.updateTotp,
    createVault: left.createVault && right.createVault,
    restoreFieldHistory: left.restoreFieldHistory && right.restoreFieldHistory,
  };
}

/**
 * What a linked vault allows: the operations its provider last reported for
 * it, narrowed by the link mode. Null for hosted vaults and for links not yet
 * checked since operations were recorded (callers then ask the provider).
 */
export function storedProviderOperations(
  row: Pick<VaultRow, "source" | "mode"> & {
    providerOperations?: VaultProviderOperations | null;
  },
): VaultProviderOperations | null {
  if (row.source === "opengeni" || !row.providerOperations) return null;
  // Stored JSON is checked against the contract before it grants anything.
  const parsed = VaultProviderOperations.safeParse(row.providerOperations);
  return parsed.success ? providerOperationsForMode(parsed.data, row.mode) : null;
}

export function providerOperationsForMode(
  operations: VaultProviderOperations,
  mode: VaultMode,
): VaultProviderOperations {
  const normalized = intersectProviderOperations(operations, operations);
  return mode === "read_write" ? normalized : withoutProviderWrites(normalized);
}

function providerAllowsAnyWrite(operations: VaultProviderOperations | null): boolean {
  if (!operations) return true;
  return operations.createItemTypes.length > 0 || operations.updateItem || operations.archiveItem;
}

export function vaultCanWrite(row: VaultRow, authority: VaultCallerAuthority): boolean {
  // Read-write connected vaults are edited through their provider (W5, OP-3).
  if (row.mode !== "read_write" || !authority.write) return false;
  // A provider that reported no item writes for this vault makes it read-only here too.
  if (!providerAllowsAnyWrite(storedProviderOperations(row))) return false;
  if (row.ownerKind === "user") return row.ownedByCaller;
  return true;
}

export function vaultCanManage(row: VaultRow, authority: VaultCallerAuthority): boolean {
  switch (row.ownerKind) {
    case "task":
      return false;
    case "organization":
      return authority.accountAdmin;
    case "user":
      return row.ownedByCaller && authority.write;
    case "workspace":
      return authority.write;
  }
}

export function toVaultSummary(
  row: VaultRow,
  authority: VaultCallerAuthority,
  options: { now?: Date; refreshing?: boolean } = {},
): VaultSummary {
  const operations = storedProviderOperations(row);
  const freshness = providerVaultFreshness(row, options.now ?? new Date(), {
    ...(options.refreshing ? { refreshing: true } : {}),
  });
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerKind: row.ownerKind,
    ownerLabel: row.ownerLabel ?? "",
    rootSessionId: row.rootSessionId,
    name: row.name,
    description: row.description,
    source: row.source,
    mode: row.mode,
    syncStatus: row.syncStatus,
    syncErrorCode: row.syncErrorCode,
    syncErrorMessage: row.syncErrorMessage,
    lastSyncedAt: row.lastSyncedAt,
    rateLimitedUntil: row.rateLimitedUntil,
    providerConnectionId: row.providerConnectionId,
    ...(operations ? { providerOperations: operations } : {}),
    ...(freshness ? { freshness } : {}),
    availability: row.availability,
    isDefault: row.isDefault,
    itemCount: Number(row.itemCount),
    canWrite: vaultCanWrite(row, authority),
    canManage: vaultCanManage(row, authority),
    generation: Number(row.generation),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function decryptOrNull(key: Uint8Array | null, stored: string | null): string | null {
  if (stored === null || key === null) return null;
  try {
    return decryptEnvironmentValue(key, stored);
  } catch {
    return null;
  }
}

/** A reference string, falling back to the ID form when a name cannot be referenced. */
function referenceFor(
  item: Pick<VaultItemRow, "id" | "name" | "vaultName">,
  field: string | undefined,
  otp = false,
): string {
  const tail = { ...(field !== undefined ? { field } : {}), otp };
  try {
    return formatSecretReference({ vault: item.vaultName, item: item.name, ...tail });
  } catch {
    return formatSecretReference({ itemId: item.id, ...tail });
  }
}

/**
 * Ready references for an item. Every reference names the vault and the field
 * (`{{secret:Vault/Item/field}}`), so it cannot become ambiguous when another
 * reachable vault gains an item with the same name.
 */
export function vaultItemReferences(
  item: Pick<VaultItemRow, "id" | "name" | "vaultName" | "fields" | "primaryFieldId">,
): VaultItemReferences {
  const byField: Record<string, string> = {};
  for (const field of item.fields) byField[field.name] = referenceFor(item, field.name);
  const primary = item.fields.find((field) => field.id === item.primaryFieldId);
  const totp = item.fields.find((field) => field.kind === "totp");
  return {
    primary: primary ? byField[primary.name]! : null,
    otp: totp ? referenceFor(item, totp.name, true) : null,
    byField,
  };
}

function usernameOf(row: VaultItemRow, key: Uint8Array | null): string | null {
  const field = row.fields.find(
    (candidate) => candidate.kind === "text" && secretNameKey(candidate.name) === "username",
  );
  return field ? decryptOrNull(key, field.valueEncrypted) : null;
}

export function toVaultItemSummary(row: VaultItemRow, key: Uint8Array | null): VaultItemSummary {
  return {
    id: row.id,
    vaultId: row.vaultId,
    type: row.type,
    name: row.name,
    websites: row.websites ?? [],
    username: usernameOf(row, key),
    hasTotp: row.fields.some((field) => field.kind === "totp"),
    hasPasskey: row.type === "passkey",
    expiresAt: row.expiresAt,
    archivedAt: row.archivedAt,
    lastUsedAt: row.lastUsedAt,
    updatedAt: row.updatedAt,
    references: vaultItemReferences(row),
  };
}

function toVaultItemField(
  item: VaultItemRow,
  field: VaultFieldRow,
  key: Uint8Array | null,
): VaultItemField {
  return {
    id: field.id,
    name: field.name,
    kind: field.kind,
    position: field.position,
    currentVersion: field.currentVersion,
    value: field.kind === "text" ? decryptOrNull(key, field.valueEncrypted) : null,
    fileName: field.fileName,
    fileSize: field.fileSize,
    reference: referenceFor(item, field.name),
    updatedAt: field.updatedAt,
  };
}

export function toVaultItem(row: VaultItemRow, key: Uint8Array | null): VaultItem {
  const textField = (name: string) => {
    const field = row.fields.find((candidate) => secretNameKey(candidate.name) === name);
    return field ? decryptOrNull(key, field.valueEncrypted) : null;
  };
  const credentialId = row.type === "passkey" ? (textField("credentialid") ?? "") : "";
  return {
    ...toVaultItemSummary(row, key),
    fields: row.fields.map((field) => toVaultItemField(row, field, key)),
    passkey:
      row.type === "passkey"
        ? {
            rpId: textField("rpid") ?? "",
            userName: textField("username"),
            credentialIdSuffix: credentialId.slice(-8),
            signCount: Number(row.passkeySignCount ?? 0),
            leasedUntil: row.passkeyLeasedUntil,
            lastUsedAt: row.lastUsedAt,
          }
        : null,
    aliases: row.aliases ?? [],
    primaryFieldId: row.primaryFieldId,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    generation: Number(row.generation),
  };
}
