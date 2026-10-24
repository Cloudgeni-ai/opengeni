import { describe, expect, test } from "bun:test";
import { createProviderCallBudget, type VaultProviderContext } from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import {
  connectBitwarden,
  createBitwardenVaultProvider,
  PERSONAL_VAULT_ID,
  type BitwardenVaultProvider,
} from "../src/provider";

/**
 * The shared provider contract against a real Bitwarden or Vaultwarden
 * account, behind OPENGENI_BITWARDEN_LIVE=1. Use a dedicated test account:
 *
 *   OPENGENI_BITWARDEN_SERVER          https://vault.bitwarden.com, .eu or self-hosted
 *   OPENGENI_BITWARDEN_CLIENT_ID       user.<uuid> (Settings, Security, Keys, View API key)
 *   OPENGENI_BITWARDEN_CLIENT_SECRET
 *   OPENGENI_BITWARDEN_MASTER_PASSWORD used once to open the account, never stored
 *   OPENGENI_BITWARDEN_FIXTURE         a login in My vault with username, password and TOTP
 *                                      (default "Example login")
 *
 * Throwaway items are named `ogtest-…` and end in the account's trash.
 */
const live = process.env.OPENGENI_BITWARDEN_LIVE === "1";
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the live Bitwarden tests`);
  return value;
};

let connected: Promise<BitwardenVaultProvider> | null = null;
function provider(): Promise<BitwardenVaultProvider> {
  connected ??= connectBitwarden(
    {
      serverUrl: env("OPENGENI_BITWARDEN_SERVER"),
      clientId: env("OPENGENI_BITWARDEN_CLIENT_ID"),
      clientSecret: env("OPENGENI_BITWARDEN_CLIENT_SECRET"),
      masterPassword: env("OPENGENI_BITWARDEN_MASTER_PASSWORD"),
    },
    { fetch: (input, init) => fetch(input, init) },
  ).then(({ credentials }) =>
    createBitwardenVaultProvider({ credentials, fetch: (input, init) => fetch(input, init) }),
  );
  return connected;
}

const context = (): VaultProviderContext => ({
  connectionId: "conn-live",
  budget: createProviderCallBudget(50),
});

if (live) {
  runVaultProviderContractSuite("Bitwarden adapter (live account)", async () => ({
    provider: await provider(),
    externalVaultId: PERSONAL_VAULT_ID,
    fixtureItemName: process.env.OPENGENI_BITWARDEN_FIXTURE ?? "Example login",
    context,
  }));

  describe("Bitwarden adapter (live account): beyond the contract", () => {
    test("lists organization collections and reads every item type there is", async () => {
      const bitwarden = await provider();
      const vaults = await bitwarden.listVaults(context());
      expect(vaults[0]?.externalVaultId).toBe(PERSONAL_VAULT_ID);
      for (const vault of vaults) {
        const items = await bitwarden.listItems(context(), vault.externalVaultId);
        expect(items.length).toBe(vault.itemCount ?? items.length);
        for (const item of items) {
          const readable = item.fields.slice(0, 8).map((field) => field.externalFieldId);
          if (readable.length === 0) continue;
          const values = await bitwarden.readFields(
            context(),
            vault.externalVaultId,
            item.externalItemId,
            readable,
          );
          expect(values.map((value) => value.externalFieldId)).toEqual(readable);
        }
      }
    });
  });
}
