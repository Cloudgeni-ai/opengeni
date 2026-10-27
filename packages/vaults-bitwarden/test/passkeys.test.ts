// Passkeys a Bitwarden login holds (`login.fido2Credentials`): reported on the
// item, read with their key material, and their counter written back.
import { beforeEach, describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { decryptString, encryptString, type SymmetricKey } from "../src/crypto";
import { passkeyCredentialId } from "../src/mapping";
import {
  connectBitwarden,
  createBitwardenVaultProvider,
  PERSONAL_VAULT_ID,
  resetBitwardenTokens,
} from "../src/provider";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_MASTER_PASSWORD,
  FAKE_SERVER,
  FakeBitwarden,
} from "./fake-server";

const context = (): VaultProviderContext => ({
  connectionId: "conn-fake",
  budget: createProviderCallBudget(50),
});

beforeEach(() => resetBitwardenTokens());

async function connect(fake: FakeBitwarden) {
  const connected = await connectBitwarden(
    {
      serverUrl: FAKE_SERVER,
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      masterPassword: FAKE_MASTER_PASSWORD,
    },
    { fetch: fake.fetch },
  );
  return createBitwardenVaultProvider({ credentials: connected.credentials, fetch: fake.fetch });
}

const GUID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const IMPORTED_ID = Buffer.from("imported credential id bytes").toString("base64url");
const USER_HANDLE = Buffer.from("user handle 42").toString("base64url");

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey,
  };
}

/** A `fido2Credentials` entry as Bitwarden clients write it. */
function fido2(
  key: SymmetricKey,
  values: { credentialId: string; rpId: string; keyValue: string; counter?: number },
) {
  const enc = (value: string) => encryptString(value, key);
  return {
    credentialId: enc(values.credentialId),
    keyType: enc("public-key"),
    keyAlgorithm: enc("ECDSA"),
    keyCurve: enc("P-256"),
    keyValue: enc(values.keyValue),
    rpId: enc(values.rpId),
    userHandle: enc(USER_HANDLE),
    userName: enc("person@example.test"),
    counter: enc(String(values.counter ?? 0)),
    rpName: enc(values.rpId),
    userDisplayName: enc("A Person"),
    discoverable: enc("true"),
    creationDate: "2026-10-26T09:30:00.000Z",
  };
}

function loginWithPasskeys(fake: FakeBitwarden, name: string, credentials: unknown[]) {
  const body = fake.login(name, { username: "person@example.test", password: "pw" });
  body.login.fido2Credentials = credentials;
  return body;
}

describe("Bitwarden passkeys", () => {
  test("credential ids are the bytes a site sees", () => {
    expect(passkeyCredentialId(GUID)).toBe(
      Buffer.from(GUID.replaceAll("-", ""), "hex").toString("base64url"),
    );
    expect(passkeyCredentialId(`b64.${IMPORTED_ID}`)).toBe(IMPORTED_ID);
    expect(passkeyCredentialId("not-a-guid")).toBeNull();
    expect(passkeyCredentialId("b64.")).toBeNull();
  });

  test("a login reports its passkeys and hands out their keys", async () => {
    const fake = await FakeBitwarden.create();
    const first = newKey();
    const second = newKey();
    fake.addCipher(
      loginWithPasskeys(fake, "Google", [
        fido2(fake.userKey, { credentialId: GUID, rpId: "google.com", keyValue: first.pkcs8 }),
        fido2(fake.userKey, {
          credentialId: `b64.${IMPORTED_ID}`,
          rpId: "accounts.example.test",
          keyValue: second.pkcs8,
          counter: 7,
        }),
      ]),
    );
    fake.addCipher(fake.login("Plain", { password: "p" }));
    const provider = await connect(fake);
    expect(provider.capabilities().passkeys).toBe(true);
    const items = await provider.listItems(context(), PERSONAL_VAULT_ID);
    const google = items.find((item) => item.name === "Google")!;
    const guidId = passkeyCredentialId(GUID)!;
    expect(google.passkeys).toEqual([
      { credentialId: guidId, rpId: "google.com", userName: "person@example.test" },
      { credentialId: IMPORTED_ID, rpId: "accounts.example.test", userName: "person@example.test" },
    ]);
    expect(items.find((item) => item.name === "Plain")!.passkeys).toEqual([]);

    const passkeys = await provider.readPasskeys!(
      context(),
      PERSONAL_VAULT_ID,
      google.externalItemId,
    );
    expect(passkeys.map(({ privateKey: _key, ...rest }) => rest)).toEqual([
      {
        credentialId: guidId,
        rpId: "google.com",
        userHandle: USER_HANDLE,
        userName: "person@example.test",
        userDisplayName: "A Person",
        signCount: 0,
      },
      {
        credentialId: IMPORTED_ID,
        rpId: "accounts.example.test",
        userHandle: USER_HANDLE,
        userName: "person@example.test",
        userDisplayName: "A Person",
        signCount: 7,
      },
    ]);
    // The handed-out key signs like the stored one.
    const message = Buffer.from("webauthn assertion");
    const key = createPrivateKey({
      key: Buffer.from(passkeys[0]!.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    expect(verify("sha256", message, first.publicKey, sign("sha256", message, key))).toBe(true);
    expect(createPublicKey(key).export({ format: "jwk" })).toEqual(
      first.publicKey.export({ format: "jwk" }),
    );
  });

  test("keys other than ECDSA P-256 and unreadable entries are left out", async () => {
    const fake = await FakeBitwarden.create();
    const good = newKey();
    const rsa = fido2(fake.userKey, { credentialId: GUID, rpId: "rsa.test", keyValue: "AAAA" });
    rsa.keyAlgorithm = encryptString("RSA", fake.userKey);
    const broken = fido2(fake.userKey, {
      credentialId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f1",
      rpId: "broken.test",
      keyValue: good.pkcs8,
    });
    broken.rpId = "2.not-a-valid|encstring";
    fake.addCipher(
      loginWithPasskeys(fake, "Mixed", [
        rsa,
        broken,
        fido2(fake.userKey, {
          credentialId: `b64.${IMPORTED_ID}`,
          rpId: "good.test",
          keyValue: good.pkcs8,
        }),
      ]),
    );
    const provider = await connect(fake);
    const item = (await provider.listItems(context(), PERSONAL_VAULT_ID))[0]!;
    expect(item.passkeys!.map((passkey) => passkey.rpId)).toEqual(["rsa.test", "good.test"]);
    const passkeys = await provider.readPasskeys!(
      context(),
      PERSONAL_VAULT_ID,
      item.externalItemId,
    );
    expect(passkeys.map((passkey) => passkey.rpId)).toEqual(["good.test"]);
  });

  test("a hide-passwords collection shows a passkey but never hands out its key", async () => {
    const fake = await FakeBitwarden.create();
    const hidden = fake.addCollection("Use only", { hidePasswords: true });
    const login = fake.login("Service", { username: "svc" }, fake.orgKey, fake.orgId);
    login.login.fido2Credentials = [
      fido2(fake.orgKey, { credentialId: GUID, rpId: "service.test", keyValue: newKey().pkcs8 }),
    ];
    fake.addCipher(login, [hidden]);
    const provider = await connect(fake);
    const item = (await provider.listItems(context(), hidden))[0]!;
    expect(item.passkeys).toHaveLength(1);
    const error = await provider.readPasskeys!(context(), hidden, item.externalItemId).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_permission_denied");
  });

  test("the sign count is raised in Bitwarden, never lowered", async () => {
    const fake = await FakeBitwarden.create();
    const id = fake.addCipher(
      loginWithPasskeys(fake, "Google", [
        fido2(fake.userKey, {
          credentialId: GUID,
          rpId: "google.com",
          keyValue: newKey().pkcs8,
          counter: 3,
        }),
      ]),
    );
    const provider = await connect(fake);
    const item = (await provider.listItems(context(), PERSONAL_VAULT_ID))[0]!;
    const credentialId = item.passkeys![0]!.credentialId;
    const counter = () =>
      decryptString(fake.ciphers.get(id)!.login.fido2Credentials[0].counter, fake.userKey);
    const passwordBefore = fake.ciphers.get(id)!.login.password;

    await provider.updatePasskeySignCount!(context(), PERSONAL_VAULT_ID, item.externalItemId, {
      credentialId,
      signCount: 9,
    });
    expect(counter()).toBe("9");
    // Everything else on the item is kept as it was.
    expect(fake.ciphers.get(id)!.login.password).toBe(passwordBefore);
    expect(fake.ciphers.get(id)!.login.fido2Credentials[0].credentialId).toBeDefined();

    const puts = () => fake.requests.filter((request) => request.startsWith("PUT")).length;
    const before = puts();
    await provider.updatePasskeySignCount!(context(), PERSONAL_VAULT_ID, item.externalItemId, {
      credentialId,
      signCount: 4,
    });
    expect(puts()).toBe(before);
    expect(counter()).toBe("9");

    const missing = await provider.updatePasskeySignCount!(
      context(),
      PERSONAL_VAULT_ID,
      item.externalItemId,
      {
        credentialId: "AAAA",
        signCount: 20,
      },
    ).catch((caught: unknown) => caught);
    expect((missing as VaultProviderError).code).toBe("provider_not_found");
  });
});
