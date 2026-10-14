import { expect, test } from "bun:test";
import { loadOnePasswordSdk } from "../src/sdk";

test("a server that cannot load the SDK says so plainly, and tries again next time", async () => {
  const missingCore = Object.assign(
    new Error("ENOENT: no such file or directory, open core_bg.wasm"),
    {
      code: "ENOENT",
    },
  );
  const error = console.error;
  console.error = () => undefined;
  try {
    await expect(loadOnePasswordSdk(() => Promise.reject(missingCore))).rejects.toMatchObject({
      name: "VaultProviderError",
      code: "provider_unavailable",
      message: expect.stringContaining("1Password support could not be loaded on this server"),
    });
  } finally {
    console.error = error;
  }
  const createClient = async () => ({}) as never;
  const sdk = await loadOnePasswordSdk(async () => ({ createClient }));
  expect(sdk.createClient).toBe(createClient);
});
