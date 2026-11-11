import { beforeEach, describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  generateSshKeyPair,
  VaultProviderError,
  type VaultProviderContext,
  type VaultProviderErrorCode,
} from "@opengeni/vaults";
import { runVaultProviderContractSuite } from "@opengeni/vaults/testing";
import {
  decryptString,
  encryptString,
  generateSymmetricKey,
  symmetricKeyBytes,
  toB64,
} from "../src/crypto";
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

/** A non-login item in My vault, written as clients write it. */
function typedCipher(
  fake: FakeBitwarden,
  type: 2 | 3 | 4 | 5,
  name: string,
  values: Record<string, string>,
) {
  const section = { 2: "secureNote", 3: "card", 4: "identity", 5: "sshKey" }[type];
  const body: Record<string, any> = { ...fake.login(name, {}), type, login: null };
  body[section] =
    type === 2
      ? { type: 0 }
      : Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, encryptString(value, fake.userKey)]),
        );
  if (type === 2 && values.notes) body.notes = encryptString(values.notes, fake.userKey);
  return body;
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
  test("inventory includes only the username display hint from login values", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(
      fake.login("Login", {
        username: "alice@example.com",
        password: "must-not-leak",
        totp: TOTP_SEED,
      }),
    );
    fake.addCipher(fake.login("No username", {}));
    fake.addCipher(typedCipher(fake, 2, "Note", { notes: "private-note" }));
    const { provider } = await connect(fake);
    const items = await provider.listItems(context(), PERSONAL_VAULT_ID);
    expect(items.find((item) => item.name === "Login")!.username).toBe("alice@example.com");
    expect(items.find((item) => item.name === "No username")!.username).toBeNull();
    expect(items.find((item) => item.name === "Note")!.username).toBeNull();
    for (const secret of ["must-not-leak", TOTP_SEED, "private-note"])
      expect(JSON.stringify(items)).not.toContain(secret);
  });
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

  test("updates and removes a card's and an identity's own fields", async () => {
    const fake = await FakeBitwarden.create();
    const cardId = fake.addCipher(
      typedCipher(fake, 3, "Company card", {
        cardholderName: "A Person",
        number: "4111111111111111",
        code: "123",
      }),
    );
    const identityId = fake.addCipher(
      typedCipher(fake, 4, "Me", { firstName: "A", email: "a@example.test", phone: "+1 555 0100" }),
    );
    const { provider } = await connect(fake);
    const ctx = context();
    const items = await provider.listItems(ctx, PERSONAL_VAULT_ID);
    const card = itemNamed(items, "Company card");
    const identity = itemNamed(items, "Me");

    await provider.writeItem(ctx, PERSONAL_VAULT_ID, {
      externalItemId: card.externalItemId,
      name: "Company card",
      type: "card",
      websites: [],
      fields: [
        {
          externalFieldId: "card.number",
          name: "number",
          kind: "concealed",
          value: "5555555555554444",
        },
        { externalFieldId: "card.code", name: "security code", kind: "concealed", remove: true },
        { name: "expiry month", kind: "text", value: "07" },
      ],
    });
    await provider.writeItem(ctx, PERSONAL_VAULT_ID, {
      externalItemId: identity.externalItemId,
      name: "Me",
      type: "identity",
      websites: [],
      fields: [
        { externalFieldId: "identity.email", name: "email", kind: "text", value: "b@example.test" },
        { externalFieldId: "identity.phone", name: "phone", kind: "text", remove: true },
      ],
    });

    const storedCard = fake.ciphers.get(cardId)!;
    expect(storedCard.type).toBe(3);
    expect(storedCard.card.code).toBeNull();
    const cardValues = await provider.readFields(ctx, PERSONAL_VAULT_ID, card.externalItemId, [
      "card.number",
      "card.expMonth",
      "card.cardholderName",
    ]);
    expect(cardValues.map((value) => value.material)).toEqual([
      { type: "text", value: "5555555555554444" },
      { type: "text", value: "07" },
      { type: "text", value: "A Person" },
    ]);

    const storedIdentity = fake.ciphers.get(identityId)!;
    expect(storedIdentity.identity.phone).toBeNull();
    const identityValues = await provider.readFields(
      ctx,
      PERSONAL_VAULT_ID,
      identity.externalItemId,
      ["identity.email", "identity.firstName"],
    );
    expect(identityValues.map((value) => value.material)).toEqual([
      { type: "text", value: "b@example.test" },
      { type: "text", value: "A" },
    ]);
  });

  test("an update keeps passkeys, match rules, linked fields, history and settings it does not model", async () => {
    const fake = await FakeBitwarden.create();
    const enc = (value: string) => encryptString(value, fake.userKey);
    const body = fake.login("Everything", {
      username: "user",
      password: "old-password",
      uri: "https://example.test/login",
    });
    const passkey = {
      credentialId: enc("credential-id"),
      keyType: enc("public-key"),
      keyAlgorithm: enc("ECDSA"),
      keyCurve: enc("P-256"),
      keyValue: enc("private-key-value"),
      rpId: enc("example.test"),
      counter: enc("0"),
      discoverable: enc("true"),
      creationDate: "2026-09-01T00:00:00.000Z",
    };
    body.login.fido2Credentials = [passkey];
    body.login.uris[0].match = 3;
    body.fields = [{ name: enc("login name"), value: null, type: 3, linkedId: 100 }];
    body.passwordHistory = [{ password: enc("older"), lastUsedDate: "2026-08-01T00:00:00.000Z" }];
    body.favorite = true;
    body.reprompt = 1;
    body.folderId = "3c4a5b6c-0000-4000-8000-000000000001";
    const id = fake.addCipher(body);
    fake.addAttachment(id, "notes.txt", new TextEncoder().encode("hello"), fake.userKey);
    const attachments = fake.ciphers.get(id)!.attachments;
    const { provider } = await connect(fake);
    const item = itemNamed(await provider.listItems(context(), PERSONAL_VAULT_ID), "Everything");

    await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      externalItemId: item.externalItemId,
      name: "Everything",
      type: "login",
      websites: ["https://example.test/login"],
      fields: [
        {
          externalFieldId: "login.password",
          name: "password",
          kind: "concealed",
          value: "new-password",
        },
      ],
    });

    const stored = fake.ciphers.get(id)!;
    expect(stored.login.fido2Credentials).toEqual([passkey]);
    expect(stored.login.uris).toEqual(body.login.uris);
    expect(stored.fields).toEqual(body.fields);
    expect(stored.attachments).toEqual(attachments);
    expect(stored.favorite).toBe(true);
    expect(stored.reprompt).toBe(1);
    expect(stored.folderId).toBe(body.folderId);
    expect(stored.passwordHistory).toHaveLength(2);
    expect(stored.passwordHistory[0].password).toBe(body.login.password);
    expect(stored.passwordHistory[1]).toEqual(body.passwordHistory[0]);
  });

  test("an SSH key is created and its key pair replaced here, as a Bitwarden SSH key", async () => {
    const fake = await FakeBitwarden.create();
    const { provider } = await connect(fake);
    const first = generateSshKeyPair("ed25519");
    const created = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "Deploy key",
      type: "ssh_key",
      websites: [],
      fields: [
        { name: "private key", kind: "concealed", value: first.privateKey },
        { name: "public key", kind: "text", value: first.publicKey },
        { name: "fingerprint", kind: "text", value: first.fingerprint },
      ],
    });
    expect([created.type, created.category ?? null]).toEqual(["ssh_key", null]);
    const id = created.externalItemId;
    const sshKeyOf = () => {
      const stored = fake.ciphers.get(id)!;
      expect(stored.type).toBe(5);
      return Object.fromEntries(
        ["privateKey", "publicKey", "keyFingerprint"].map((key) => [
          key,
          decryptString(stored.sshKey[key], fake.userKey),
        ]),
      );
    };
    expect(sshKeyOf()).toEqual({
      privateKey: first.privateKey,
      publicKey: first.publicKey,
      keyFingerprint: first.fingerprint,
    });

    const next = generateSshKeyPair("ed25519");
    await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      externalItemId: id,
      name: "Deploy key (rotated)",
      type: "ssh_key",
      websites: [],
      fields: [
        {
          externalFieldId: "sshKey.privateKey",
          name: "private key",
          kind: "concealed",
          value: next.privateKey,
        },
        {
          externalFieldId: "sshKey.publicKey",
          name: "public key",
          kind: "text",
          value: next.publicKey,
        },
        {
          externalFieldId: "sshKey.keyFingerprint",
          name: "fingerprint",
          kind: "text",
          value: next.fingerprint,
        },
        { name: "notes", kind: "text", value: "rotated" },
      ],
    });
    expect(sshKeyOf()).toEqual({
      privateKey: next.privateKey,
      publicKey: next.publicKey,
      keyFingerprint: next.fingerprint,
    });
  });

  test("cards, identities and categorized API keys are created as their own Bitwarden types", async () => {
    const fake = await FakeBitwarden.create();
    const { provider } = await connect(fake);
    const card = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "Card",
      type: "card",
      websites: [],
      fields: [
        { name: "cardholder name", kind: "text", value: "Ada Example" },
        { name: "cvv", kind: "concealed", value: "123" },
        { name: "number", kind: "concealed", value: "4111111111111111" },
      ],
    });
    expect([card.type, card.category ?? null]).toEqual(["card", null]);
    expect(fake.ciphers.get(card.externalItemId)!.type).toBe(3);
    const [code] = await provider.readFields(context(), PERSONAL_VAULT_ID, card.externalItemId, [
      card.fields.find((field) => field.name === "security code")!.externalFieldId,
    ]);
    expect(code!.material).toEqual({ type: "text", value: "123" });

    const identity = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "Me",
      type: "identity",
      category: "person",
      websites: [],
      fields: [{ name: "first name", kind: "text", value: "Ada" }],
    });
    expect(identity).toMatchObject({ type: "identity", category: "person" });
    expect(fake.ciphers.get(identity.externalItemId)!.type).toBe(4);

    const database = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "DB",
      type: "api_key",
      category: "database",
      websites: [],
      fields: [{ name: "value", kind: "concealed", value: "pg" }],
    });
    expect(database).toMatchObject({ type: "api_key", category: "database" });
    expect(database.fields.map((field) => field.name)).toEqual(["value"]);
    const listed = itemNamed(await provider.listItems(context(), PERSONAL_VAULT_ID), "DB");
    expect(listed).toMatchObject({ type: "api_key", category: "database" });
  });

  test("an item's type can't change", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(typedCipher(fake, 2, "Plain note", { notes: "text" }));
    const { provider } = await connect(fake);
    const item = itemNamed(await provider.listItems(context(), PERSONAL_VAULT_ID), "Plain note");
    await refusal(
      provider.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: item.externalItemId,
        name: "Plain note",
        type: "login",
        websites: [],
        fields: [],
      }),
      "provider_conflict",
    );
  });

  test("an update to a shared item keeps its organization and collections", async () => {
    const fake = await FakeBitwarden.create();
    const team = fake.addCollection("Team");
    const other = fake.addCollection("Other");
    const id = fake.addCipher(
      fake.login("Team login", { password: "t" }, fake.orgKey, fake.orgId),
      [team, other],
    );
    const { provider } = await connect(fake);
    const item = itemNamed(await provider.listItems(context(), team), "Team login");
    await provider.writeItem(context(), team, {
      externalItemId: item.externalItemId,
      name: "Team login",
      type: "login",
      websites: [],
      fields: [
        { externalFieldId: "login.password", name: "password", kind: "concealed", value: "u" },
      ],
    });
    const stored = fake.ciphers.get(id)!;
    expect(stored.organizationId).toBe(fake.orgId);
    expect(stored.collectionIds).toEqual([team, other]);
    const [value] = await provider.readFields(context(), other, item.externalItemId, [
      "login.password",
    ]);
    expect(value!.material).toEqual({ type: "text", value: "u" });
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

  test("archiving uses Bitwarden's Archive for this account; the item stays listed, archived", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Old", { password: "p" }));
    const { provider } = await connect(fake);
    const [vault] = await provider.listVaults(context());
    expect(vault!.operations?.archiveKind ?? "archive").toBe("archive");
    expect(vault!.itemCount).toBe(1);
    await provider.archiveItem(context(), PERSONAL_VAULT_ID, id);
    expect(fake.requests).toContain(`PUT /api/ciphers/${id}/archive`);
    expect(fake.ciphers.get(id)!.deletedDate).toBeNull();
    const [item] = await provider.listItems(context(), PERSONAL_VAULT_ID);
    expect(item!.externalItemId).toBe(id);
    expect(item!.archivedAt).toBeString();
    const [after] = await provider.listVaults(context());
    expect(after!.itemCount).toBe(0);
    expect(after!.contentVersion).not.toBe(vault!.contentVersion);
  });

  test("an update keeps the item archived (Vaultwarden unarchives when archivedDate is left out)", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("Old", { password: "p" }));
    const { provider } = await connect(fake);
    await provider.archiveItem(context(), PERSONAL_VAULT_ID, id);
    const archivedDate = fake.ciphers.get(id)!.archivedDate;
    await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      externalItemId: id,
      name: "Old",
      type: "login",
      websites: [],
      fields: [
        { externalFieldId: "login.password", name: "password", kind: "concealed", value: "q" },
      ],
    });
    expect(fake.ciphers.get(id)!.archivedDate).toBe(archivedDate);
  });

  test("without Bitwarden's Archive, archiving moves the item to the trash", async () => {
    const fake = await FakeBitwarden.create();
    fake.archiveFeature = false;
    const id = fake.addCipher(fake.login("Old", { password: "p" }));
    const { provider } = await connect(fake);
    const [vault] = await provider.listVaults(context());
    expect(vault!.operations?.archiveKind).toBe("trash");
    await provider.archiveItem(context(), PERSONAL_VAULT_ID, id);
    expect(fake.ciphers.get(id)!.deletedDate).toBeString();
    expect(await provider.listItems(context(), PERSONAL_VAULT_ID)).toEqual([]);
  });

  test("every request declares a client version, so SSH keys sync", async () => {
    const fake = await FakeBitwarden.create();
    fake.addCipher(
      typedCipher(fake, 5, "Deploy key", {
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
        publicKey: "ssh-ed25519 AAAA",
        keyFingerprint: "SHA256:abc",
      }),
    );
    const { provider } = await connect(fake);
    const items = await provider.listItems(context(), PERSONAL_VAULT_ID);
    expect(itemNamed(items, "Deploy key")).toBeDefined();
    const id = fake.addCipher(fake.login("Mine", { password: "p" }));
    await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      externalItemId: id,
      name: "Mine",
      type: "login",
      websites: [],
      fields: [
        { name: "key", kind: "file", file: { name: "k", bytes: new Uint8Array([1, 2, 3]) } },
      ],
    });
    await provider.archiveItem(context(), PERSONAL_VAULT_ID, id);
    expect(fake.requests.length).toBeGreaterThan(5);
    expect(fake.unversioned).toEqual([]);
  });

  test("API keys and files are created as secure notes; their fields and files keep their names", async () => {
    const fake = await FakeBitwarden.create();
    const { provider } = await connect(fake);
    const apiKey = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "Payments API",
      type: "api_key",
      websites: [],
      fields: [{ name: "credential", kind: "concealed", value: "sk_test_1" }],
    });
    expect(fake.ciphers.get(apiKey.externalItemId)!.type).toBe(2);
    const credential = apiKey.fields.find((field) => field.name === "credential")!;
    const [value] = await provider.readFields(context(), PERSONAL_VAULT_ID, apiKey.externalItemId, [
      credential.externalFieldId,
    ]);
    expect(value!.material).toEqual({ type: "text", value: "sk_test_1" });

    const bytes = new TextEncoder().encode("apiVersion: v1\n");
    const file = await provider.writeItem(context(), PERSONAL_VAULT_ID, {
      name: "kubeconfig",
      type: "file",
      websites: [],
      fields: [{ name: "file", kind: "file", file: { name: "config.yaml", bytes } }],
    });
    const attachment = file.fields.find((field) => field.kind === "file")!;
    expect(attachment.name).toBe("file");
    const [read] = await provider.readFields(context(), PERSONAL_VAULT_ID, file.externalItemId, [
      attachment.externalFieldId,
    ]);
    expect(read!.material).toEqual({ type: "bytes", value: bytes });
  });

  test("attachments are added, replaced and removed", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(fake.login("With file", { username: "u", password: "p" }));
    const { provider } = await connect(fake);
    const write = (fields: Parameters<typeof provider.writeItem>[2]["fields"]) =>
      provider.writeItem(context(), PERSONAL_VAULT_ID, {
        externalItemId: id,
        name: "With file",
        type: "login",
        websites: [],
        fields,
      });
    const encode = (text: string) => new TextEncoder().encode(text);
    const added = await write([
      { name: "deploy.pem", kind: "file", file: { name: "deploy.pem", bytes: encode("one") } },
    ]);
    const first = added.fields.find((field) => field.name === "deploy.pem")!;
    expect(added.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(["username", "password", "deploy.pem"]),
    );
    await refusal(
      write([{ name: "deploy.pem", kind: "file", file: { name: "x", bytes: encode("x") } }]),
      "provider_conflict",
    );
    const replaced = await write([
      {
        externalFieldId: first.externalFieldId,
        name: "deploy.pem",
        kind: "file",
        file: { name: "deploy.pem", bytes: encode("two") },
      },
    ]);
    const second = replaced.fields.find((field) => field.name === "deploy.pem")!;
    expect(second.externalFieldId).not.toBe(first.externalFieldId);
    expect(fake.ciphers.get(id)!.attachments).toHaveLength(1);
    const [value] = await provider.readFields(context(), PERSONAL_VAULT_ID, id, [
      second.externalFieldId,
    ]);
    expect(value!.material).toEqual({ type: "bytes", value: encode("two") });
    const removed = await write([
      { externalFieldId: second.externalFieldId, name: "deploy.pem", kind: "file", remove: true },
    ]);
    expect(removed.fields.some((field) => field.kind === "file")).toBe(false);
    expect(fake.ciphers.get(id)!.attachments).toEqual([]);
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
