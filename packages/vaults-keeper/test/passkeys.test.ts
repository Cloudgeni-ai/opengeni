// Passkeys a Keeper login record holds (fields of type "passkey"): reported on
// the item, read with their keys (EC JWK as PKCS#8), and their counter raised.
import { describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { bootstrapKeeperConfiguration } from "../src/bootstrap";
import { keeperPasskeyMetas, keeperPasskeys } from "../src/passkeys";
import { createKeeperVaultProvider } from "../src/provider";
import { FakeKsm, loginData } from "./fake-ksm";

function ctx(): VaultProviderContext {
  return { connectionId: "conn-k", budget: createProviderCallBudget(100) };
}

const CREDENTIAL_ID = Buffer.from("keeper credential").toString("base64url");
const USER_ID = Buffer.from("user 7").toString("base64url");

function passkeyField(signCount = 0) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey,
    field: {
      type: "passkey",
      value: [
        {
          privateKey: { ...privateKey.export({ format: "jwk" }), ext: true, key_ops: ["sign"] },
          credentialId: CREDENTIAL_ID,
          signCount,
          userId: USER_ID,
          relyingParty: "example.test",
          username: "alice",
          createdDate: 1_760_000_000_000,
        },
      ],
    },
  };
}

async function world() {
  const fake = new FakeKsm();
  const folder = fake.addFolder("Engineering");
  const { field, publicKey } = passkeyField(5);
  const base = loginData("With passkey");
  const record = fake.addRecord(folder.uid, { ...base, fields: [...base.fields, field] });
  fake.addRecord(folder.uid, loginData("Plain"));
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
  return { fake, folder: folder.uid, record, provider, publicKey };
}

describe("Keeper passkeys", () => {
  test("a login record reports its passkey and hands out a working key", async () => {
    const { folder, provider, publicKey } = await world();
    expect(provider.capabilities().passkeys).toBe(true);
    const items = await provider.listItems(ctx(), folder);
    const item = items.find((candidate) => candidate.name === "With passkey")!;
    expect(item.passkeys).toEqual([
      { credentialId: CREDENTIAL_ID, rpId: "example.test", userName: "alice" },
    ]);
    expect(items.find((candidate) => candidate.name === "Plain")!.passkeys).toEqual([]);

    const [passkey] = await provider.readPasskeys!(ctx(), folder, item.externalItemId);
    expect(passkey).toMatchObject({
      credentialId: CREDENTIAL_ID,
      rpId: "example.test",
      userHandle: USER_ID,
      userName: "alice",
      signCount: 5,
    });
    const key = createPrivateKey({
      key: Buffer.from(passkey!.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const message = Buffer.from("assertion");
    expect(verify("sha256", message, publicKey, sign("sha256", message, key))).toBe(true);
  });

  test("only EC P-256 keys are handed out; custom passkey fields count too", () => {
    const { field } = passkeyField();
    const rsa = {
      type: "passkey",
      value: [{ ...field.value[0], privateKey: { kty: "RSA", n: "AQAB", e: "AQAB" } }],
    };
    const record = {
      recordUid: "r",
      data: { type: "login", title: "t", fields: [rsa], custom: [field] },
    } as never;
    expect(keeperPasskeyMetas(record)).toHaveLength(2);
    expect(keeperPasskeys(record)).toHaveLength(1);
  });

  test("the sign count is raised in Keeper, never lowered", async () => {
    const { fake, folder, record, provider } = await world();
    const signCount = () =>
      (record.data.fields as Array<{ type: string; value: Array<{ signCount: number }> }>).find(
        (field) => field.type === "passkey",
      )!.value[0]!.signCount;
    await provider.updatePasskeySignCount!(ctx(), folder, record.uid, {
      credentialId: CREDENTIAL_ID,
      signCount: 12,
    });
    expect(signCount()).toBe(12);
    const revision = fake.records.get(record.uid)!.revision;
    await provider.updatePasskeySignCount!(ctx(), folder, record.uid, {
      credentialId: CREDENTIAL_ID,
      signCount: 3,
    });
    expect(fake.records.get(record.uid)!.revision).toBe(revision);
    const error = await provider.updatePasskeySignCount!(ctx(), folder, record.uid, {
      credentialId: "AAAA",
      signCount: 30,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_not_found");
  });
});
