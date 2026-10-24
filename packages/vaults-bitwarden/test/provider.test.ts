import { beforeEach, describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import { encryptString, generateSymmetricKey, symmetricKeyBytes, toB64 } from "../src/crypto";
import {
  connectBitwarden,
  createBitwardenVaultProvider,
  PERSONAL_VAULT_ID,
  resetBitwardenTokens,
  type BitwardenCredentials,
} from "../src/provider";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_MASTER_PASSWORD,
  FAKE_SERVER,
  FAKE_USER_ID,
  FakeBitwarden,
} from "./fake-server";

const TOTP_SEED = "JBSWY3DPEHPK3PXP";

const input = (
  overrides: Partial<
    Record<"serverUrl" | "clientId" | "clientSecret" | "masterPassword", string>
  > = {},
) => ({
  serverUrl: FAKE_SERVER,
  clientId: FAKE_CLIENT_ID,
  clientSecret: FAKE_CLIENT_SECRET,
  masterPassword: FAKE_MASTER_PASSWORD,
  ...overrides,
});

const context = (): VaultProviderContext => ({
  connectionId: "conn-fake",
  budget: createProviderCallBudget(50),
});

async function refusal(
  promise: Promise<unknown>,
  code: VaultProviderErrorCode,
): Promise<VaultProviderError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  expect((error as VaultProviderError).code).toBe(code);
  return error as VaultProviderError;
}

async function connect(fake: FakeBitwarden, fetch = fake.fetch) {
  const connected = await connectBitwarden(input(), { fetch });
  return {
    ...connected,
    provider: createBitwardenVaultProvider({ credentials: connected.credentials, fetch }),
  };
}

function itemNamed(items: { name: string; externalItemId: string }[], name: string) {
  const found = items.find((item) => item.name === name);
  if (!found) throw new Error(`no item ${name}`);
  return found;
}

beforeEach(() => resetBitwardenTokens());

runVaultProviderContractSuite("Bitwarden adapter (wire fake)", async () => {
  const fake = await FakeBitwarden.create();
  fake.addCipher(
    fake.login("Test Login", {
      username: "fixture@example.test",
      password: "fixture-password",
      totp: TOTP_SEED,
      uri: "https://fixture.example.test",
    }),
  );
  const readOnly = fake.addCollection("Read only", { readOnly: true });
  fake.addCipher(fake.login("Shared read", { username: "ro" }, fake.orgKey, fake.orgId), [
    readOnly,
  ]);
  const { provider } = await connect(fake);
  return {
    provider,
    externalVaultId: PERSONAL_VAULT_ID,
    readOnlyVaultId: readOnly,
    fixtureItemName: "Test Login",
    context,
  };
});

describe("Bitwarden setup", () => {
  test("stores the user key and endpoints, never the master password", async () => {
    const fake = await FakeBitwarden.create();
    const { credentials, accountName, accountId } = await connectBitwarden(input(), {
      fetch: fake.fetch,
    });
    expect(accountName).toBe("Agents@Example.test");
    expect(accountId).toBe(FAKE_USER_ID);
    expect(credentials).toEqual({
      serverUrl: FAKE_SERVER,
      apiUrl: `${FAKE_SERVER}/api`,
      identityUrl: `${FAKE_SERVER}/identity`,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      userKey: toB64(symmetricKeyBytes(fake.userKey)),
    });
    expect(JSON.stringify(credentials)).not.toContain(FAKE_MASTER_PASSWORD);
  });

  test("refuses an organization API key before sending anything", async () => {
    const fake = await FakeBitwarden.create();
    const error = await refusal(
      connectBitwarden(input({ clientId: `organization.${FAKE_USER_ID}` }), { fetch: fake.fetch }),
      "provider_auth_invalid",
    );
    expect(error.message).toContain("personal API key");
    expect(fake.requests).toEqual([]);
  });

  test("a wrong API key and a wrong master password are both provider_auth_invalid", async () => {
    const fake = await FakeBitwarden.create();
    await refusal(
      connectBitwarden(input({ clientSecret: "not-the-secret" }), { fetch: fake.fetch }),
      "provider_auth_invalid",
    );
    resetBitwardenTokens();
    const error = await refusal(
      connectBitwarden(input({ masterPassword: "wrong horse" }), { fetch: fake.fetch }),
      "provider_auth_invalid",
    );
    expect(error.message).toContain("master password");
  });

  test("a rate-limited login is provider_rate_limited with the server's retry time", async () => {
    const fake = await FakeBitwarden.create();
    fake.rateLimitLogins = true;
    const error = await refusal(
      connectBitwarden(input(), { fetch: fake.fetch }),
      "provider_rate_limited",
    );
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("refuses a server whose configuration points the API at another site", async () => {
    const fake = await FakeBitwarden.create();
    fake.environment = {
      vault: FAKE_SERVER,
      api: "https://collector.example.net/api",
      identity: "https://collector.example.net/identity",
    };
    const error = await refusal(
      connectBitwarden(input(), { fetch: fake.fetch }),
      "provider_unavailable",
    );
    expect(error.message).toContain("another site");
    // The API key never left: only the configuration was read.
    expect(fake.requests).toEqual(["GET /api/config"]);
  });

  test("refuses plain http outside local development", async () => {
    const fake = await FakeBitwarden.create();
    const error = await refusal(
      connectBitwarden(input({ serverUrl: "http://vault.example.test" }), { fetch: fake.fetch }),
      "provider_auth_invalid",
    );
    expect(error.message).toContain("HTTPS");
    expect(fake.requests).toEqual([]);
  });
});

describe("Bitwarden adapter beyond the contract", () => {
  test("lists My vault first, then the collections this account can open", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(fake.login("Mine", { password: "p" }));
    const team = fake.addCollection("Team");
    const readOnly = fake.addCollection("Reference", { readOnly: true });
    fake.addCipher(fake.login("Team login", { password: "t" }, fake.orgKey, fake.orgId), [team]);
    fake.addCipher(fake.login("Both", { password: "b" }, fake.orgKey, fake.orgId), [
      team,
      readOnly,
    ]);
    const { provider } = await connect(fake);
    const vaults = await provider.listVaults(context());
    expect(
      vaults.map(({ externalVaultId, name, itemCount, writeAccess }) => ({
        externalVaultId,
        name,
        itemCount,
        writeAccess,
      })),
    ).toEqual([
      {
        externalVaultId: PERSONAL_VAULT_ID,
        name: "My vault",
        itemCount: 1,
        writeAccess: "read_write",
      },
      { externalVaultId: team, name: "Team", itemCount: 2, writeAccess: "read_write" },
      { externalVaultId: readOnly, name: "Reference", itemCount: 1, writeAccess: "read_only" },
    ]);
    const teamItems = await provider.listItems(context(), team);
    expect(teamItems.map((item) => item.name).sort()).toEqual(["Both", "Team login"]);
  });

  test("the change token moves when an item changes elsewhere", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Mine", { password: "p" }));
    const { provider } = await connect(fake);
    const [before] = await provider.listVaults(context());
    fake.touch(id);
    const [after] = await provider.listVaults(context());
    expect(after!.contentVersion).not.toBe(before!.contentVersion);
  });

  test("values are read live on every call, never cached", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Rotating", { password: "first" }));
    const { provider } = await connect(fake);
    const ctx = context();
    const item = itemNamed(await provider.listItems(ctx, PERSONAL_VAULT_ID), "Rotating");
    const read = async () =>
      (
        await provider.readFields(ctx, PERSONAL_VAULT_ID, item.externalItemId, ["login.password"])
      )[0]!.material;
    expect(await read()).toEqual({ type: "text", value: "first" });
    fake.touch(id, (cipher) => {
      cipher.login.password = encryptString("second", fake.userKey);
    });
    expect(await read()).toEqual({ type: "text", value: "second" });
  });

  test("a hide-passwords collection allows the username but not the password", async () => {
    const fake = await FakeBitwarden.create();
    const hidden = fake.addCollection("Use only", { hidePasswords: true });
    fake.addCipher(
      fake.login("Service", { username: "svc", password: "hidden" }, fake.orgKey, fake.orgId),
      [hidden],
    );
    const { provider } = await connect(fake);
    const item = itemNamed(await provider.listItems(context(), hidden), "Service");
    const [username] = await provider.readFields(context(), hidden, item.externalItemId, [
      "login.username",
    ]);
    expect(username!.material).toEqual({ type: "text", value: "svc" });
    await refusal(
      provider.readFields(context(), hidden, item.externalItemId, ["login.password"]),
      "provider_permission_denied",
    );
  });

  test("an item is only reachable through its own vault", async () => {
    const fake = await FakeBitwarden.create();
    const team = fake.addCollection("Team");
    fake.addCipher(fake.login("Team login", { password: "t" }, fake.orgKey, fake.orgId), [team]);
    const { provider } = await connect(fake);
    const item = itemNamed(await provider.listItems(context(), team), "Team login");
    await refusal(
      provider.readFields(context(), PERSONAL_VAULT_ID, item.externalItemId, ["login.password"]),
      "provider_not_found",
    );
  });

  test("creates an item in a collection under the organization's key", async () => {
    const fake = await FakeBitwarden.create();
    const team = fake.addCollection("Team");
    const { provider } = await connect(fake);
    const created = await provider.writeItem(context(), team, {
      name: "ogtest-team",
      type: "login",
      websites: [],
      fields: [{ name: "token", kind: "concealed", value: "s3cret" }],
    });
    const stored = fake.ciphers.get(created.externalItemId)!;
    expect(stored.organizationId).toBe(fake.orgId);
    expect(stored.collectionIds).toEqual([team]);
    const tokenField = created.fields.find((field) => field.name === "token")!;
    const [value] = await provider.readFields(context(), team, created.externalItemId, [
      tokenField.externalFieldId,
    ]);
    expect(value!.material).toEqual({ type: "text", value: "s3cret" });
  });

  test("a write that loses a race with another client is provider_conflict", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Raced", { password: "p" }));
    const racing = (url: string, init: RequestInit) => {
      if (init.method === "PUT" && new URL(url).pathname === `/api/ciphers/${id}`) fake.touch(id);
      return fake.fetch(url, init);
    };
    const { provider } = await connect(fake, racing);
    const item = itemNamed(await provider.listItems(context(), PERSONAL_VAULT_ID), "Raced");
    await refusal(
      provider.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: item.externalItemId,
        name: "Raced",
        type: "login",
        websites: [],
        fields: [
          { externalFieldId: "login.password", name: "password", kind: "concealed", value: "q" },
        ],
      }),
      "provider_conflict",
    );
  });

  test("reads an attachment as bytes", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("With file", { username: "u" }));
    const bytes = new TextEncoder().encode("-----BEGIN KEY-----\nabc\n-----END KEY-----\n");
    fake.addAttachment(id, "deploy.pem", bytes, fake.userKey);
    const { provider } = await connect(fake);
    const item = (await provider.listItems(context(), PERSONAL_VAULT_ID))[0]!;
    const file = item.fields.find((field) => field.kind === "file")!;
    expect(file.name).toBe("deploy.pem");
    const [value] = await provider.readFields(context(), PERSONAL_VAULT_ID, item.externalItemId, [
      file.externalFieldId,
    ]);
    expect(value!.material).toEqual({ type: "bytes", value: bytes });
  });

  test("archiving moves the item to Bitwarden's trash, where it can be restored", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Old", { password: "p" }));
    const { provider } = await connect(fake);
    await provider.archiveItem(context(), PERSONAL_VAULT_ID, id);
    expect(fake.ciphers.get(id)!.deletedDate).toBeString();
    expect(await provider.listItems(context(), PERSONAL_VAULT_ID)).toEqual([]);
  });

  test("logs in once and reuses the token across attempts; a revoked token is replaced once", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(fake.login("Mine", { password: "p" }));
    const { provider } = await connect(fake);
    for (let attempt = 0; attempt < 3; attempt += 1)
      await provider.listItems(context(), PERSONAL_VAULT_ID);
    const second = createBitwardenVaultProvider({
      credentials: (await connectBitwarden(input(), { fetch: fake.fetch })).credentials,
      fetch: fake.fetch,
    });
    await second.listVaults(context());
    expect(fake.logins).toBe(1);
    fake.revokeTokens();
    await provider.listVaults(context());
    expect(fake.logins).toBe(2);
  });

  test("an unconfirmed organization member sees My vault only and gets an actionable refusal", async () => {
    const fake = await FakeBitwarden.create();
    fake.orgConfirmed = false;
    const team = fake.addCollection("Team");
    fake.addCipher(fake.login("Team login", { password: "t" }, fake.orgKey, fake.orgId), [team]);
    const { provider } = await connect(fake);
    expect((await provider.listVaults(context())).map((vault) => vault.externalVaultId)).toEqual([
      PERSONAL_VAULT_ID,
    ]);
    const error = await refusal(provider.listItems(context(), team), "provider_permission_denied");
    expect(error.message).toContain("confirm");
  });

  test("a saved key that no longer opens the account asks for a reconnect", async () => {
    const fake = await FakeBitwarden.create();
    const { credentials } = await connectBitwarden(input(), { fetch: fake.fetch });
    const rotated: BitwardenCredentials = {
      ...credentials,
      userKey: toB64(symmetricKeyBytes(generateSymmetricKey())),
    };
    const provider = createBitwardenVaultProvider({ credentials: rotated, fetch: fake.fetch });
    const error = await refusal(provider.listVaults(context()), "provider_auth_invalid");
    expect(error.message).toContain("Reconnect");
  });

  test("a rate-limited vault read is provider_rate_limited", async () => {
    const fake = await FakeBitwarden.create();
    const limited = (url: string, init: RequestInit) =>
      new URL(url).pathname === "/api/sync"
        ? Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "5" } }))
        : fake.fetch(url, init);
    const { provider } = await connect(fake, limited);
    const error = await refusal(provider.listVaults(context()), "provider_rate_limited");
    expect(error.retryAfterMs).toBe(5_000);
  });
});
