/** Vaults and secret references: the only import point for the vault domain. */
export { buildMissingSecretAskCard } from "@opengeni/contracts";
export { isVaultError, VaultError, vaultErrorFromDatabase } from "@opengeni/db";
export {
  intersectProviderOperations,
  providerOperationsForMode,
  storedProviderOperations,
  toVaultItem,
  toVaultItemSummary,
  toVaultSummary,
  vaultCanManage,
  vaultCanWrite,
  vaultItemReferences,
  type VaultCallerAuthority,
} from "./mapping";
export {
  effectiveProviderOperations,
  type ProviderWriteOperation,
  type ProviderWriteOutcome,
} from "./provider-writes";
export {
  chooseSecretCandidate,
  createSecretResolver,
  type SecretResolverOptions,
} from "./secret-resolver";
export type { VaultRequestActor, VaultServiceDeps } from "./types";
export { createVaultService, vaultActorIsApiKey, type VaultService } from "./vault-service";
