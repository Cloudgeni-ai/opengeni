/**
 * The shared vault contracts this adapter implements (F1: `@opengeni/vaults`
 * §10B.1.4 and `@opengeni/contracts`), re-exported for the package's modules.
 */
export {
  VaultProviderError,
  type ProviderCallBudget,
  type ProviderFieldMeta,
  type ProviderFieldValue,
  type ProviderItemMeta,
  type ProviderVault,
  type ProviderWriteItem,
  type VaultProvider,
  type VaultProviderCapabilities,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "@opengeni/vaults";
export {
  parseTotpInput,
  totpCode,
  type SecretMaterial,
  type TotpParams,
  type VaultFieldKind,
  type VaultItemType,
} from "@opengeni/contracts";
