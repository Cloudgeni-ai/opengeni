import type { OnePasswordVaultProviderFactory } from "@opengeni/core";

/**
 * Loads the 1Password adapter (and its ~14 MB WASM SDK) only when a request
 * first touches 1Password. The only allowed import edge, besides apps/worker,
 * is this dynamic one (OP-5, packages/vaults-onepassword/test/import-guard.test.ts).
 */
export const loadOnePasswordVaultProvider: OnePasswordVaultProviderFactory = async (input) => {
  const { vaultProviderForOnePasswordConnection } = await import("@opengeni/vaults-onepassword");
  return vaultProviderForOnePasswordConnection(input);
};

/** The offline token check and connection-scoped provider used by the install route. */
export async function loadOnePasswordModule() {
  return await import("@opengeni/vaults-onepassword");
}
