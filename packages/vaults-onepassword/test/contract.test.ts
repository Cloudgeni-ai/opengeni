import { createAttemptProviderBudget } from "../src/budget";
import { createOnePasswordVaultProvider } from "../src/provider";
import { OnePasswordClientCache } from "../src/sdk";
import { defineVaultProviderContract } from "./contract-suite";
import { createFakeOnePasswordSdk, fakeServiceAccountToken } from "./fake-sdk";

// The provider contract against the 1Password adapter over an in-memory SDK
// double that reproduces the SDK's versioning and error strings. The live run
// (test/live.test.ts) executes the same suite against real 1Password.
defineVaultProviderContract("1Password adapter (SDK double)", async () => {
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
              { id: "otp", title: "one-time password", fieldType: "Totp", value: "JBSWY3DPEHPK3PXP" },
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
    readWriteVaultId: "rw",
    readOnlyVaultId: "ro",
    fixtureItemName: "Test Login",
    namePrefix: "ogtest-",
  };
});
