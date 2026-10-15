import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderCallBudget, VaultProviderError } from "@opengeni/vaults";
import { testSettings } from "@opengeni/testing";
import { FakeKsm, loginData } from "../../../packages/vaults-keeper/test/fake-ksm";
import {
  closeNativeExternalVaultProviders,
  createNativeExternalVaultFactories,
} from "../src/external-vault-providers";

afterAll(async () => {
  await closeNativeExternalVaultProviders();
});

test("the worker's native factories are the API's, line for line", () => {
  const root = join(import.meta.dir, "../../..");
  const strip = (path: string) =>
    readFileSync(join(root, path), "utf8").replace(/^ \* file identical to .*$/m, "");
  expect(strip("apps/worker/src/external-vault-providers.ts")).toBe(
    strip("apps/api/src/integrations/external-vault-providers.ts"),
  );
});

test("turn workers open stored Keeper connections and refuse without durable storage", async () => {
  const fake = new FakeKsm();
  const folder = fake.addFolder("Ops");
  fake.addRecord(folder.uid, loginData("Deploy"));
  const { keeper, protonpass } = createNativeExternalVaultFactories(testSettings(), {
    keeper: { queryFunction: fake.queryFunction, fetchFile: fake.fetchFile },
  });
  expect(protonpass).toBeUndefined();
  const bound = await keeper!({
    credentials: { provider: "keeper", oneTimeToken: fake.createToken() },
    persistCredentials: async () => {},
  });
  const opened = await keeper!({
    credentials: bound.credentials,
    persistCredentials: async () => {},
  });
  const items = await opened.provider.listItems(
    { connectionId: "conn-worker", budget: createProviderCallBudget(10) },
    folder.uid,
  );
  expect(items.map((item) => item.name)).toEqual(["Deploy"]);

  const refused = await keeper!({ credentials: bound.credentials }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(VaultProviderError);
  expect((refused as VaultProviderError).code).toBe("provider_unavailable");
});
