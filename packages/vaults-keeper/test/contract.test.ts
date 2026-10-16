import { afterAll } from "bun:test";
import { createProviderCallBudget, type VaultProvider } from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import { bootstrapKeeperConfiguration } from "../src/bootstrap";
import { createKeeperVaultProvider, type KeeperVaultProvider } from "../src/provider";
import { FakeKsm, loginData } from "./fake-ksm";

/**
 * The shared provider contract over the wire-level fake KSM. The suite gates
 * its create, update and archive steps on `capabilities().write` alone, and
 * Keeper exposes no archive, so the suite runs against the read side (the
 * adapter reported as read-only) while provider.test.ts covers the declared
 * write operations. Keeper folder permissions are only known upstream, so no
 * read-only vault is declared here; provider.test.ts covers that refusal.
 */
let keeper: KeeperVaultProvider | null = null;

afterAll(async () => {
  await keeper?.close();
});

runVaultProviderContractSuite("Keeper adapter (fake KSM, SDK 17.6.0, read side)", async () => {
  const fake = new FakeKsm();
  const folder = fake.addFolder("Engineering");
  fake.addRecord(folder.uid, loginData("Test Login"));
  const { configuration } = await bootstrapKeeperConfiguration({
    oneTimeToken: fake.createToken(),
    queryFunction: fake.queryFunction,
  });
  const provider = createKeeperVaultProvider({
    configuration,
    persistConfiguration: async () => {},
    queryFunction: fake.queryFunction,
    fetchFile: fake.fetchFile,
  });
  keeper = provider;
  const readSide: VaultProvider = {
    id: provider.id,
    capabilities: () => ({ ...provider.capabilities(), write: false }),
    validate: (ctx) => provider.validate(ctx),
    listVaults: (ctx) => provider.listVaults(ctx),
    listItems: (ctx, vault) => provider.listItems(ctx, vault),
    readFields: (ctx, vault, item, fields) => provider.readFields(ctx, vault, item, fields),
    writeItem: (ctx, vault, item) => provider.writeItem(ctx, vault, item),
    archiveItem: (ctx, vault, item) => provider.archiveItem(ctx, vault, item),
  };
  return {
    provider: readSide,
    context: () => ({ connectionId: "conn-contract", budget: createProviderCallBudget(50) }),
    externalVaultId: folder.uid,
    fixtureItemName: "Test Login",
  };
});
