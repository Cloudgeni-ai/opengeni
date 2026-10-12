import { createAttemptProviderBudget } from "../src/budget";
import { createOnePasswordVaultProvider } from "../src/provider";
import { OnePasswordClientCache } from "../src/sdk";
import { createFakeVaultProvider, runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import { createFakeOnePasswordSdk, fakeServiceAccountToken } from "./fake-sdk";

// The provider contract against the 1Password adapter over an in-memory SDK
// double that reproduces the SDK's versioning and error strings. The live run
// (test/live.test.ts) executes the same suite against real 1Password.
runVaultProviderContractSuite("1Password adapter (SDK double)", async () => {
  const fake = createFakeOnePasswordSdk({
    vaults: [
      {
        id: "rw",
        title: "OpenGeni Test RW",
        writable: true,
        items: [
          {
            title: "Test Login",
            category: "Login",
            fields: [
              { id: "username", title: "username", fieldType: "Text", value: "alice" },
              { id: "password", title: "password", fieldType: "Concealed", value: "pw" },
              {
                id: "otp",
                title: "one-time password",
                fieldType: "Totp",
                value: "JBSWY3DPEHPK3PXP",
              },
            ],
          },
        ],
      },
      { id: "ro", title: "OpenGeni Test RO", writable: false },
    ],
  });
  const connectionId = crypto.randomUUID();
  return {
    provider: createOnePasswordVaultProvider({
      token: fakeServiceAccountToken(),
      planTier: "family",
      sdk: fake.sdk,
      clientCache: new OnePasswordClientCache(),
    }),
    context: () => ({ connectionId, budget: createAttemptProviderBudget() }),
    externalVaultId: "rw",
    readOnlyVaultId: "ro",
    fixtureItemName: "Test Login",
    namePrefix: "ogtest-",
  };
});

// The same suite against the shared in-memory fake provider (F1), so the fake
// used by seeds and API tests keeps behaving like the 1Password adapter.
runVaultProviderContractSuite("fake provider", async () => ({
  provider: createFakeVaultProvider({
    vaults: [
      {
        externalVaultId: "rw",
        name: "OpenGeni Test RW",
        items: [
          {
            name: "Test Login",
            fields: [
              { name: "username", kind: "text", value: "alice" },
              { name: "password", kind: "concealed", value: "pw" },
              { name: "one-time password", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
            ],
          },
        ],
      },
      { externalVaultId: "ro", name: "OpenGeni Test RO", readOnly: true },
    ],
  }),
  externalVaultId: "rw",
  readOnlyVaultId: "ro",
  fixtureItemName: "Test Login",
}));
