import { providerOperations } from "@opengeni/vaults";
import {
  VaultProviderError,
  type ProviderWriteItem,
  type VaultProvider,
  type VaultProviderOperations,
} from "./contract";

function refused(what: string): never {
  throw new VaultProviderError(
    "provider_permission_denied",
    `${what} is not enabled for this vault connection`,
  );
}

function checkWrite(operations: VaultProviderOperations, item: ProviderWriteItem) {
  const totp = item.fields.some((field) => field.kind === "totp" && !field.remove);
  if (item.externalItemId !== undefined) {
    if (!operations.updateItem) refused("Updating items");
    if (totp && !operations.updateTotp) refused("Changing one-time password seeds");
    if (item.fields.some((field) => field.remove) && !operations.removeField)
      refused("Removing fields");
    return;
  }
  if (!operations.createItemTypes.includes(item.type)) refused(`Creating ${item.type} items`);
  if (totp && !operations.createTotp) refused("Adding one-time password seeds");
}

/**
 * Narrows an adapter to the operations verified when its connection was set
 * up: what it reports and what it will do. It never widens the adapter's own
 * operations, and refused calls make no provider request.
 */
export function restrictToOperations<P extends VaultProvider>(
  provider: P,
  verified: VaultProviderOperations | undefined,
  fileFieldPrefix: string,
): P {
  if (!verified) return provider;
  const effective = () =>
    providerOperations(provider.capabilities(), { operations: verified, writeAccess: "unknown" });
  return {
    ...provider,
    capabilities() {
      const base = provider.capabilities();
      const operations = effective();
      const writes =
        operations.createItemTypes.length > 0 || operations.updateItem || operations.archiveItem;
      return { ...base, write: base.write && writes, operations };
    },
    async readFields(ctx, vaultId, itemId, fieldIds) {
      if (!effective().readFiles && fieldIds.some((id) => id.startsWith(fileFieldPrefix)))
        refused("Reading files");
      return provider.readFields(ctx, vaultId, itemId, fieldIds);
    },
    async writeItem(ctx, vaultId, item) {
      checkWrite(effective(), item);
      return provider.writeItem(ctx, vaultId, item);
    },
    async archiveItem(ctx, vaultId, itemId) {
      if (!effective().archiveItem) refused("Archiving items");
      return provider.archiveItem(ctx, vaultId, itemId);
    },
  };
}
