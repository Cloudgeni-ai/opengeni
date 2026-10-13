/** Vaults and secret references: the only import point for the vault domain. */
export { buildMissingSecretAskCard } from "@opengeni/contracts";
export { isVaultError, VaultError, vaultErrorFromDatabase } from "@opengeni/db";
export {
  toVaultItem,
  toVaultItemSummary,
  toVaultSummary,
  vaultCanManage,
  vaultCanWrite,
  vaultItemReferences,
  type VaultCallerAuthority,
} from "./mapping";
export {
  chooseSecretCandidate,
  createSecretResolver,
  type SecretResolverOptions,
} from "./secret-resolver";
export type { VaultRequestActor, VaultServiceDeps } from "./types";
export { createVaultService, vaultActorIsApiKey, type VaultService } from "./vault-service";
