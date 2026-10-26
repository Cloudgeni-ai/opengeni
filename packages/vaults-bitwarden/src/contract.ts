/**
 * The shared vault contracts this adapter implements, re-exported so every
 * module names one source.
 */
export {
  VaultProviderError,
  restrictToOperations,
  type ProviderCallBudget,
  type ProviderFieldMeta,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type ProviderWriteField,
  type ProviderWriteItem,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
} from "@opengeni/vaults";
export {
  VAULT_LIMITS,
  parseTotpInput,
  type SecretMaterial,
  type VaultFieldKind,
  type VaultProviderOperations,
} from "@opengeni/contracts";
