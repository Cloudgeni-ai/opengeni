import type { VaultProviderOperations } from "@opengeni/contracts";
import type { ProviderVault, VaultProviderCapabilities } from "./provider";

/** Preserve the published legacy port, while new adapters declare exact operations. */
export function providerOperations(
  capabilities: VaultProviderCapabilities,
  vault?: Pick<ProviderVault, "operations" | "writeAccess">,
): VaultProviderOperations {
  const base: VaultProviderOperations = capabilities.operations ?? {
    createItemTypes: capabilities.write ? ["login", "api_key", "note"] : [],
    updateItem: capabilities.write,
    removeField: capabilities.write,
    archiveItem: capabilities.write,
    archiveKind: capabilities.write ? "archive" : "none",
    deleteItem: false,
    restoreItem: false,
    readFiles: capabilities.files,
    writeFiles: false,
    createTotp: capabilities.write && capabilities.totp,
    updateTotp: capabilities.write && capabilities.totp,
    createVault: capabilities.createVault,
    restoreFieldHistory: false,
  };
  const override = vault?.operations;
  // An upstream vault may narrow its adapter's abilities, never widen them.
  const operations: VaultProviderOperations = {
    createItemTypes: base.createItemTypes.filter(
      (type) => type !== "passkey" && (!override || override.createItemTypes.includes(type)),
    ),
    updateItem: base.updateItem && (override?.updateItem ?? true),
    removeField: base.removeField && (override?.removeField ?? true),
    archiveItem: base.archiveItem && (override?.archiveItem ?? true),
    archiveKind: base.archiveKind,
    deleteItem: false,
    restoreItem: base.restoreItem && (override?.restoreItem ?? true),
    readFiles: base.readFiles && (override?.readFiles ?? true),
    writeFiles: base.writeFiles && (override?.writeFiles ?? true),
    createTotp: base.createTotp && (override?.createTotp ?? true),
    updateTotp: base.updateTotp && (override?.updateTotp ?? true),
    createVault: base.createVault && (override?.createVault ?? true),
    restoreFieldHistory: base.restoreFieldHistory && (override?.restoreFieldHistory ?? true),
  };
  if (override && override.archiveKind !== base.archiveKind) operations.archiveItem = false;
  if (operations.archiveKind === "none") operations.archiveItem = false;
  if (!operations.archiveItem) operations.archiveKind = "none";
  operations.removeField &&= operations.updateItem;
  operations.updateTotp &&= operations.updateItem;
  operations.createTotp &&= operations.createItemTypes.length > 0;
  if (vault?.writeAccess !== "read_only" && capabilities.write) return operations;
  return {
    ...operations,
    createItemTypes: [],
    updateItem: false,
    removeField: false,
    archiveItem: false,
    archiveKind: "none",
    restoreItem: false,
    writeFiles: false,
    createTotp: false,
    updateTotp: false,
    createVault: false,
    restoreFieldHistory: false,
  };
}
