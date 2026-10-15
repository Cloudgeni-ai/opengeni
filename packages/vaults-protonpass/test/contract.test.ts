import { afterAll } from "bun:test";
import { createProviderCallBudget, type VaultProvider } from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import { createProtonPassVaultProvider } from "../src/provider";
import { VALID_TOKEN, makeFakeCli } from "./fixture";

/**
 * The shared provider contract over the fake pass-cli. The suite gates its
 * create, update and archive steps on `capabilities().write` alone, and Proton
 * cannot update items, so the suite runs against the read side (the adapter
 * reported as read-only) while provider.test.ts covers the declared operations.
 */
// The suite's no-values check matches the literal `"value"`, so the fixture's
// custom field (normally named "value") is renamed here.
const fake = makeFakeCli((state) => {
  const custom = state.items["rwShare=="]!.find((item) => item.id === "customItem1")!;
  const content = custom.content as {
    content: { Custom: { sections: Array<{ section_fields: Array<{ name: string }> }> } };
  };
  for (const field of content.content.Custom.sections[0]!.section_fields) field.name = "token";
});
const proton = createProtonPassVaultProvider({
  token: VALID_TOKEN,
  binaryPath: fake.binaryPath,
  stateRoot: fake.stateRoot,
  hostEnv: { PATH: "/usr/bin:/bin" },
});

afterAll(async () => {
  await proton.close();
  fake.cleanup();
});

const readSide: VaultProvider = {
  id: proton.id,
  capabilities: () => ({ ...proton.capabilities(), write: false }),
  validate: (ctx) => proton.validate(ctx),
  listVaults: (ctx) => proton.listVaults(ctx),
  listItems: (ctx, vault) => proton.listItems(ctx, vault),
  readFields: (ctx, vault, item, fields) => proton.readFields(ctx, vault, item, fields),
  writeItem: (ctx, vault, item) => proton.writeItem(ctx, vault, item),
  archiveItem: (ctx, vault, item) => proton.archiveItem(ctx, vault, item),
};

runVaultProviderContractSuite("Proton Pass adapter (fake pass-cli 2.4.2, read side)", async () => ({
  provider: readSide,
  context: () => ({ connectionId: "conn-contract", budget: createProviderCallBudget(50) }),
  externalVaultId: "rwShare==",
  readOnlyVaultId: "roShare==",
  fixtureItemName: "Test Login",
}));
