import type { OnePasswordVaultProviderFactory } from "@opengeni/core";

/**
 * Loads the 1Password adapter (and its ~14 MB WASM SDK) only when a turn first
 * touches a 1Password vault. The only allowed import edge, besides apps/api,
 * is this dynamic one (OP-5, packages/vaults-onepassword/test/import-guard.test.ts).
 */
export const loadOnePasswordVaultProvider: OnePasswordVaultProviderFactory = async (input) => {
  const { vaultProviderForOnePasswordConnection } = await import("@opengeni/vaults-onepassword");
  return vaultProviderForOnePasswordConnection(input);
};
