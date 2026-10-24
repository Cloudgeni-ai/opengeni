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
 * The round-trip test rewrites every writable item unchanged and checks that
 * nothing was lost, and the card test changes a card's security code and
 * puts it back.
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

async function valuesOf(
  bitwarden: BitwardenVaultProvider,
  vaultId: string,
  item: { externalItemId: string; fields: { externalFieldId: string; kind: string }[] },
) {
  const ids = item.fields
    .filter((field) => field.kind !== "file")
    .map((field) => field.externalFieldId);
  if (ids.length === 0) return [];
  return bitwarden.readFields(context(), vaultId, item.externalItemId, ids);
}

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

    test("rewriting any item unchanged keeps every field, value and attachment", async () => {
      const bitwarden = await provider();
      for (const vault of await bitwarden.listVaults(context())) {
        if (vault.writeAccess !== "read_write") continue;
        for (const item of await bitwarden.listItems(context(), vault.externalVaultId)) {
          const before = await valuesOf(bitwarden, vault.externalVaultId, item);
          const saved = await bitwarden.writeItem(context(), vault.externalVaultId, {
            externalItemId: item.externalItemId,
            name: item.name,
            type: item.type,
            websites: item.websites,
            fields: [],
          });
          expect(saved.fields).toEqual(item.fields);
          expect(saved.websites).toEqual(item.websites);
          expect(await valuesOf(bitwarden, vault.externalVaultId, saved)).toEqual(before);
        }
      }
    }, 120_000);

    test("changes a card's own field and puts it back", async () => {
      const bitwarden = await provider();
      const items = await bitwarden.listItems(context(), PERSONAL_VAULT_ID);
      const card = items.find((item) =>
        item.fields.some((field) => field.externalFieldId === "card.code"),
      );
      if (!card) return;
      const read = async () =>
        (
          await bitwarden.readFields(context(), PERSONAL_VAULT_ID, card.externalItemId, [
            "card.code",
          ])
        )[0]!.material;
      const original = await read();
      if (original.type !== "text") throw new Error("a card code is text");
      const write = (value: string) =>
        bitwarden.writeItem(context(), PERSONAL_VAULT_ID, {
          externalItemId: card.externalItemId,
          name: card.name,
          type: card.type,
          websites: [],
          fields: [
            { externalFieldId: "card.code", name: "security code", kind: "concealed", value },
          ],
        });
      try {
        await write("999");
        expect(await read()).toEqual({ type: "text", value: "999" });
      } finally {
        await write(original.value);
      }
      expect(await read()).toEqual(original);
    });
  });
}
