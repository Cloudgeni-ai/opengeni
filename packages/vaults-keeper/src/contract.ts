/**
 * The shared vault contracts this adapter implements, re-exported for the
 * package's modules so every file names one source.
 */
export {
  VaultProviderError,
  type ProviderCallBudget,
  type ProviderCallOperation,
  type ProviderFieldMeta,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type ProviderWriteField,
  type ProviderWriteItem,
  type VaultProvider,
  type VaultProviderAuthority,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "@opengeni/vaults";
export {
  VAULT_LIMITS,
  parseTotpInput,
  type SecretMaterial,
  type TotpParams,
  type VaultFieldKind,
  type VaultItemType,
  type VaultProviderOperations,
} from "@opengeni/contracts";
