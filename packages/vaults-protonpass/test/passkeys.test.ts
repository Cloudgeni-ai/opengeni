// Passkeys a Proton Pass login holds: reported on the item and read with their
// key (a COSE EC2 key inside MessagePack) as PKCS#8. pass-cli cannot edit
// items, so the counter is never written back.
import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { createProviderCallBudget, type VaultProviderContext } from "@opengeni/vaults";
import { decodeProtonPasskey, protonPasskeyMeta } from "../src/passkeys";
import { createProtonPassVaultProvider } from "../src/provider";
import { makeFakeCli, type FakeCli, VALID_TOKEN } from "./fixture";

// A minimal MessagePack writer for the shapes Proton uses.
type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value };

function pack(value: Value): number[] {
  if (value === null) return [0xc0];
  if (value === true) return [0xc3];
  if (value === false) return [0xc2];
  if (typeof value === "number") {
    if (value >= 0 && value <= 0x7f) return [value];
    if (value < 0 && value >= -32) return [0x100 + value];
    if (value >= 0 && value <= 0xffff) return [0xcd, value >> 8, value & 0xff];
    throw new Error("number out of test range");
  }
  if (typeof value === "string") {
    const bytes = [...Buffer.from(value, "utf8")];
    return bytes.length < 32 ? [0xa0 | bytes.length, ...bytes] : [0xd9, bytes.length, ...bytes];
  }
  if (value instanceof Uint8Array) {
    return value.length <= 0xff
      ? [0xc4, value.length, ...value]
      : [0xc5, value.length >> 8, value.length & 0xff, ...value];
  }
  if (Array.isArray(value)) return [0x90 | value.length, ...value.flatMap(pack)];
  const entries = Object.entries(value);
  return [
    0x80 | entries.length,
    ...entries.flatMap(([key, entry]) => [...pack(key), ...pack(entry)]),
  ];
}

const label = (value: number): Value => ({ t: "int", c: value });
const bytes = (value: string): Value => ({
  t: "bytes",
  c: new Uint8Array(Buffer.from(value, "base64url")),
});

const CREDENTIAL = [1, 2, 3, 4, 5, 6, 7, 8];
const HANDLE = new Uint8Array([9, 9, 9]);

/** A Proton login passkey whose content holds a fresh P-256 key. */
function protonPasskey(options: { curve?: number; version?: number } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const inner = pack({
    key: {
      kty: { t: "Assigned", c: "EC2" },
      par: [
        [label(-1), label(options.curve ?? 1)],
        [label(-2), bytes(jwk.x!)],
        [label(-3), bytes(jwk.y!)],
        [label(-4), bytes(jwk.d!)],
      ],
    },
    cnt: 4,
    uhd: HANDLE,
    un: "alice@example.test",
    udn: "Alice",
  });
  const content = pack({ c: new Uint8Array(inner), v: options.version ?? 1 });
  return {
    publicKey,
    passkey: {
      key_id: "k1",
      content,
      domain: "example.test",
      rp_id: "example.test",
      rp_name: "Example",
      user_name: "alice@example.test",
      user_display_name: "Alice",
      credential_id: CREDENTIAL,
      user_handle: [...HANDLE],
    },
  };
}

const open: Array<{ fake: FakeCli; close(): Promise<void> }> = [];
afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.close().catch(() => {});
    entry.fake.cleanup();
  }
});

function ctx(): VaultProviderContext {
  return { connectionId: "conn-1", budget: createProviderCallBudget(100) };
}

describe("Proton Pass passkeys", () => {
  test("decodes a P-256 passkey into a working PKCS#8 key", () => {
    const { passkey, publicKey } = protonPasskey();
    const credentialId = Buffer.from(CREDENTIAL).toString("base64url");
    expect(protonPasskeyMeta(passkey)).toEqual({
      credentialId,
      rpId: "example.test",
      userName: "alice@example.test",
    });
    const decoded = decodeProtonPasskey(passkey)!;
    expect(decoded).toMatchObject({
      credentialId,
      rpId: "example.test",
      userHandle: Buffer.from(HANDLE).toString("base64url"),
      userName: "alice@example.test",
      userDisplayName: "Alice",
      signCount: 4,
    });
    const key = createPrivateKey({
      key: Buffer.from(decoded.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const message = Buffer.from("assertion");
    expect(verify("sha256", message, publicKey, sign("sha256", message, key))).toBe(true);
  });

  test("other curves, other formats and damaged content are left out", () => {
    expect(decodeProtonPasskey(protonPasskey({ curve: 2 }).passkey)).toBeNull();
    expect(decodeProtonPasskey(protonPasskey({ version: 2 }).passkey)).toBeNull();
    const damaged = protonPasskey().passkey;
    damaged.content = damaged.content.slice(0, 20);
    expect(decodeProtonPasskey(damaged)).toBeNull();
    expect(protonPasskeyMeta({ ...damaged, credential_id: [] })).toBeNull();
  });

  test("a login reports its passkey and readPasskeys hands it out", async () => {
    const { passkey } = protonPasskey();
    const fake = makeFakeCli((state) => {
      const login = state.items["rwShare=="]![0]! as { content: { content: { Login: any } } };
      login.content.content.Login.passkeys = [passkey, { rp_id: 7 }];
    });
    const provider = createProtonPassVaultProvider({
      token: VALID_TOKEN,
      binaryPath: fake.binaryPath,
      stateRoot: fake.stateRoot,
      hostEnv: { PATH: "/usr/bin:/bin" },
    });
    open.push({ fake, close: () => provider.close() });
    expect(provider.capabilities().passkeys).toBe(true);
    expect(provider.updatePasskeySignCount).toBeUndefined();
    const items = await provider.listItems(ctx(), "rwShare==");
    const login = items.find((item) => item.externalItemId === "loginItem1")!;
    expect(login.passkeys).toEqual([
      {
        credentialId: Buffer.from(CREDENTIAL).toString("base64url"),
        rpId: "example.test",
        userName: "alice@example.test",
      },
    ]);
    expect(items.find((item) => item.externalItemId === "customItem1")!.passkeys).toEqual([]);
    const passkeys = await provider.readPasskeys(ctx(), "rwShare==", "loginItem1");
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]!.signCount).toBe(4);
    expect(await provider.readPasskeys(ctx(), "rwShare==", "customItem1")).toEqual([]);
  });
});
