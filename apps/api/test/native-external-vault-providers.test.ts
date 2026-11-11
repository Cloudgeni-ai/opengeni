import { afterAll, describe, expect, test } from "bun:test";
import type { StoredVaultProviderCredentials } from "@opengeni/core";
import { DestinationPolicyError } from "@opengeni/network";
import { createProviderCallBudget, providerOperations, VaultProviderError } from "@opengeni/vaults";
import { testSettings } from "@opengeni/testing/settings";
import { FakeKsm, loginData } from "../../../packages/vaults-keeper/test/fake-ksm";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_MASTER_PASSWORD,
  FAKE_SERVER,
  FakeBitwarden,
} from "../../../packages/vaults-bitwarden/test/fake-server";
import { VALID_TOKEN, makeFakeCli } from "../../../packages/vaults-protonpass/test/fixture";
import {
  closeNativeExternalVaultProviders,
  createNativeExternalVaultFactories,
  nativeKeeperFetch,
} from "../src/integrations/external-vault-providers";

const ctx = () => ({ connectionId: "conn-native", budget: createProviderCallBudget(50) });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

function keeperWorld() {
  const fake = new FakeKsm();
  const folder = fake.addFolder("Engineering");
  fake.addRecord(folder.uid, loginData("Deploy"));
  const factories = createNativeExternalVaultFactories(testSettings(), {
    keeper: { queryFunction: fake.queryFunction, fetchFile: fake.fetchFile },
  });
  return { fake, folder, keeper: factories.keeper! };
}

afterAll(async () => {
  await closeNativeExternalVaultProviders();
});

describe("native external vault factories", () => {
  test("Keeper and Bitwarden are always offered; Proton Pass only with an operator-installed CLI", () => {
    expect(Object.keys(createNativeExternalVaultFactories(testSettings())).sort()).toEqual([
      "bitwarden",
      "keeper",
    ]);
    const withCli = createNativeExternalVaultFactories(
      testSettings({ protonPassCliPath: "/opt/proton/pass-cli" }),
    );
    expect(Object.keys(withCli).sort()).toEqual(["bitwarden", "keeper", "protonpass"]);
  });

  test("Keeper setup persists the bound configuration and never returns the token", async () => {
    const { fake, keeper } = keeperWorld();
    const token = fake.createToken();
    const saved: StoredVaultProviderCredentials[] = [];
    let requestsAtSave = -1;
    const prepared = await keeper({
      credentials: { provider: "keeper", oneTimeToken: token },
      persistCredentials: async (next) => {
        requestsAtSave = fake.requests.length;
        saved.push(next);
      },
    });
    expect(prepared.provider.id).toBe("keeper");
    expect(saved).toEqual([prepared.credentials]);
    expect(requestsAtSave).toBe(fake.requests.length);
    if (prepared.credentials.provider !== "keeper") throw new Error("expected keeper");
    expect(Object.keys(prepared.credentials.configuration).sort()).toEqual([
      "appKey",
      "appOwnerPublicKey",
      "clientId",
      "hostname",
      "privateKey",
    ]);
    const secretPart = token.split(":")[1]!;
    expect(JSON.stringify(prepared.credentials)).not.toContain(secretPart);
    expect(JSON.stringify(saved)).not.toContain(secretPart);
    expect((await prepared.provider.listVaults(ctx())).map((vault) => vault.name)).toEqual([
      "Engineering",
    ]);

    // The stored record opens the same connection again.
    const reopened = await keeper({
      credentials: prepared.credentials,
      persistCredentials: async () => {},
    });
    expect(reopened.credentials).toEqual(prepared.credentials);
    expect((await reopened.provider.listVaults(ctx())).map((vault) => vault.name)).toEqual([
      "Engineering",
    ]);
  });

  test("Keeper fails closed without durable storage, before any request", async () => {
    const { fake, keeper } = keeperWorld();
    const error = await rejection(
      keeper({ credentials: { provider: "keeper", oneTimeToken: fake.createToken() } }),
    );
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_unavailable");
    expect(fake.requests).toHaveLength(0);
  });

  test("Bitwarden setup stores the account key, never the master password, and reopens from it", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(fake.login("Deploy", { username: "deploy", password: "pw" }));
    const { bitwarden } = createNativeExternalVaultFactories(testSettings(), {
      bitwarden: { fetch: fake.fetch },
    });
    const prepared = await bitwarden!({
      credentials: {
        provider: "bitwarden",
        serverUrl: FAKE_SERVER,
        clientId: FAKE_CLIENT_ID,
        clientSecret: FAKE_CLIENT_SECRET,
        masterPassword: FAKE_MASTER_PASSWORD,
      },
    });
    expect(prepared.provider.id).toBe("bitwarden");
    if (prepared.credentials.provider !== "bitwarden") throw new Error("expected bitwarden");
    expect(Object.keys(prepared.credentials).sort()).toEqual([
      "apiUrl",
      "clientId",
      "clientSecret",
      "identityUrl",
      "provider",
      "serverUrl",
      "userKey",
    ]);
    expect(JSON.stringify(prepared.credentials)).not.toContain(FAKE_MASTER_PASSWORD);
    const reopened = await bitwarden!({ credentials: prepared.credentials });
    expect(reopened.credentials).toEqual(prepared.credentials);
    const [personal] = await reopened.provider.listVaults(ctx());
    expect(personal).toMatchObject({ name: "My vault", itemCount: 1 });

    const wrong = await rejection(
      bitwarden!({
        credentials: {
          provider: "bitwarden",
          serverUrl: FAKE_SERVER,
          clientId: FAKE_CLIENT_ID,
          clientSecret: FAKE_CLIENT_SECRET,
          masterPassword: "not it",
        },
      }),
    );
    expect((wrong as VaultProviderError).code).toBe("provider_auth_invalid");
  });

  test("verified setup operations narrow the adapter and refuse without a request", async () => {
    const { fake, folder, keeper } = keeperWorld();
    const bound = await keeper({
      credentials: { provider: "keeper", oneTimeToken: fake.createToken() },
      persistCredentials: async () => {},
    });
    const readOnly = providerOperations({
      write: false,
      createVault: false,
      totp: true,
      files: false,
      groupGrants: false,
      passkeys: false,
    });
    const narrowed = await keeper({
      credentials: bound.credentials,
      persistCredentials: async () => {},
      operations: readOnly,
    });
    const operations = narrowed.provider.capabilities().operations!;
    expect(operations.createItemTypes).toEqual([]);
    expect(operations.updateItem).toBe(false);
    expect(narrowed.provider.capabilities().write).toBe(false);
    const before = fake.requests.length;
    const error = await rejection(
      narrowed.provider.writeItem(ctx(), folder.uid, {
        name: "New",
        type: "login",
        websites: [],
        fields: [{ name: "password", kind: "concealed", value: "x" }],
      }),
    );
    expect((error as VaultProviderError).code).toBe("provider_permission_denied");
    expect(fake.requests.length).toBe(before);
  });

  test("credentials for another provider are refused", async () => {
    const { keeper } = keeperWorld();
    const error = await rejection(
      keeper({
        credentials: { provider: "protonpass", token: "pst_0123456789abcdef::key" },
        persistCredentials: async () => {},
      }),
    );
    expect((error as VaultProviderError).code).toBe("provider_unavailable");
  });

  test("Keeper setup stops at the caller's signal without redeeming the token", async () => {
    const { fake, keeper } = keeperWorld();
    const controller = new AbortController();
    controller.abort(new Error("setup deadline"));
    const saved: StoredVaultProviderCredentials[] = [];
    await rejection(
      keeper({
        credentials: { provider: "keeper", oneTimeToken: fake.createToken() },
        persistCredentials: async (next) => {
          saved.push(next);
        },
        signal: controller.signal,
      }),
    );
    expect(fake.requests).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  test("Proton Pass sessions are scoped to the connection, not the token", async () => {
    const fake = makeFakeCli();
    try {
      const { protonpass } = createNativeExternalVaultFactories(
        testSettings({ protonPassCliPath: fake.binaryPath }),
        { protonpass: { stateRoot: fake.stateRoot, hostEnv: { PATH: "/usr/bin:/bin" } } },
      );
      const open = async (connectionId?: string) =>
        (
          await protonpass!({
            credentials: { provider: "protonpass", token: VALID_TOKEN },
            ...(connectionId ? { connectionId } : {}),
          })
        ).provider;
      await (await open("conn-a")).listVaults(ctx());
      await (await open("conn-a")).listVaults(ctx());
      await (await open("conn-b")).listVaults(ctx());
      await (await open()).listVaults(ctx());
      const logins = fake.log().filter((entry) => entry.argv[0] === "login");
      expect(logins).toHaveLength(3);
      expect(new Set(logins.map((entry) => entry.home)).size).toBe(3);
    } finally {
      await closeNativeExternalVaultProviders();
      await fake.cleanup();
    }
  });

  test("Proton Pass returns a pooled, narrowed provider without starting the CLI", async () => {
    const { protonpass } = createNativeExternalVaultFactories(
      testSettings({ protonPassCliPath: "/nonexistent/pass-cli" }),
    );
    const token = "pst_0123456789abcdef::secret-key-material";
    const prepared = await protonpass!({
      credentials: { provider: "protonpass", token },
      operations: providerOperations({
        write: false,
        createVault: false,
        totp: false,
        files: false,
        groupGrants: false,
        passkeys: false,
      }),
    });
    expect(prepared.provider.id).toBe("protonpass");
    expect(prepared.credentials).toEqual({ provider: "protonpass", token });
    expect(prepared.provider.capabilities().operations!.archiveItem).toBe(false);
    const error = await rejection(prepared.provider.archiveItem(ctx(), "share==", "item=="));
    expect((error as VaultProviderError).code).toBe("provider_permission_denied");
  });
});

describe("Keeper network path", () => {
  const production = testSettings({ environment: "production" });

  test("requests are DNS-pinned and refuse private answers before connecting", async () => {
    let connected = false;
    const fetch = nativeKeeperFetch(production, {
      dnsLookup: async () => [{ address: "10.1.2.3", family: 4 }],
      fetchImpl: async () => {
        connected = true;
        return new Response(null);
      },
      agentFactory: () => ({ close() {}, destroy() {} }),
    });
    const error = await rejection(
      fetch("https://keepersecurity.com/api/rest/sm/v1/get_secret", { method: "POST" }),
    );
    expect(error).toBeInstanceOf(DestinationPolicyError);
    expect(connected).toBe(false);
  });

  test("public answers are used as pinned, with manual redirects and the caller's signal", async () => {
    const seen: Array<RequestInit & { dispatcher?: unknown }> = [];
    const pinned: unknown[] = [];
    const fetch = nativeKeeperFetch(production, {
      dnsLookup: async () => [{ address: "1.1.1.1", family: 4 }],
      agentFactory: (addresses) => {
        pinned.push(addresses);
        return { dispatcher: "pinned-dispatcher", close() {}, destroy() {} };
      },
      fetchImpl: async (_input, init) => {
        seen.push(init as RequestInit & { dispatcher?: unknown });
        return new Response(new Uint8Array([1]), { status: 200 });
      },
    });
    const controller = new AbortController();
    const response = await fetch("https://keepersecurity.com/api/rest/sm/v1/get_secret", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(pinned).toEqual([[{ address: "1.1.1.1", family: 4 }]]);
    expect(seen[0]!.redirect).toBe("manual");
    expect(seen[0]!.dispatcher).toBe("pinned-dispatcher");
    expect(seen[0]!.signal).toBe(controller.signal);
    expect(
      (await rejection(fetch("http://keepersecurity.com/x", { method: "POST" }))) instanceof
        DestinationPolicyError,
    ).toBe(true);
  });
});
