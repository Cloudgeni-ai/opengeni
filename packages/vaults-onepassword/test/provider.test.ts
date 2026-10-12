import { beforeEach, describe, expect, test } from "bun:test";

import {
  ONEPASSWORD_REQUEST_COST,
  createAttemptProviderBudget,
  onePasswordQuotaFor,
  resetOnePasswordQuotasForTests,
} from "../src/budget";
import { type VaultProviderContext, VaultProviderError } from "../src/contract";
import { OPENGENI_SECTION_ID } from "../src/mapping";
import { createOnePasswordVaultProvider } from "../src/provider";
import { OnePasswordClientCache } from "../src/sdk";
import {
  AuthExpiredError,
  NOT_AUTHENTICATED,
  RateLimitExceededError,
  createFakeOnePasswordSdk,
  fakeServiceAccountToken,
} from "./fake-sdk";

const RW = "rwvault00000000000000000000";
const RO = "rovault00000000000000000000";

function world() {
  const fake = createFakeOnePasswordSdk({
    vaults: [
      {
        id: RW,
        title: "OpenGeni Test RW",
        writable: true,
        items: [
          {
            id: "login0000000000000000000000",
            title: "Test Login",
            category: "Login",
            websites: [
              {
                url: "https://example.test",
                label: "website",
                autofillBehavior: "AnywhereOnWebsite",
              },
            ],
            sections: [{ id: "add more", title: "" }],
            fields: [
              { id: "username", title: "username", fieldType: "Text", value: "alice" },
              { id: "password", title: "password", fieldType: "Concealed", value: "s3cret" },
              {
                id: "TOTP_abc",
                title: "one-time password",
                sectionId: "add more",
                fieldType: "Totp",
                value: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=6&period=30",
                details: { type: "Otp", content: { code: "123456" } },
              },
              { id: "passkey", title: "passkey", fieldType: "Unsupported", value: "" },
            ],
          },
          {
            id: "note00000000000000000000000",
            title: "Deploy / notes {x}",
            category: "SecureNote",
            notes: "multi\nline",
          },
          {
            id: "doc000000000000000000000000",
            title: "kubeconfig",
            category: "Document",
            document: { id: "docfile", name: "kubeconfig.yaml", size: 10 },
          },
        ],
      },
      { id: RO, title: "OpenGeni Test RO", writable: false, items: [] },
    ],
  });
  const clientCache = new OnePasswordClientCache();
  const provider = createOnePasswordVaultProvider({
    token: fakeServiceAccountToken(),
    planTier: "family",
    sdk: fake.sdk,
    clientCache,
  });
  const ctx = (): VaultProviderContext => ({
    connectionId: crypto.randomUUID(),
    budget: createAttemptProviderBudget(),
  });
  return { fake, provider, ctx, clientCache };
}

beforeEach(() => resetOnePasswordQuotasForTests());

describe("1Password adapter", () => {
  test("mirrors metadata: categories, safe names, notes/document fields, no values, passkeys skipped", async () => {
    const { provider, ctx, fake } = world();
    const items = await provider.listItems(ctx(), RW);
    expect(fake.calls.map((call) => call.op)).toEqual(["items.list", "items.getAll"]);
    const login = items.find((item) => item.name === "Test Login")!;
    expect(login.type).toBe("login");
    expect(login.websites).toEqual(["https://example.test"]);
    expect(login.fields).toEqual([
      { externalFieldId: "username", name: "username", kind: "text" },
      { externalFieldId: "password", name: "password", kind: "concealed" },
      { externalFieldId: "TOTP_abc", name: "one-time password", kind: "totp" },
    ]);
    const note = items.find((item) => item.externalItemId === "note00000000000000000000000")!;
    expect(note.name).toBe("Deploy - notes -x-");
    expect(note.type).toBe("note");
    expect(note.fields).toEqual([{ externalFieldId: "@notes", name: "note", kind: "concealed" }]);
    const doc = items.find((item) => item.name === "kubeconfig")!;
    expect(doc.type).toBe("file");
    expect(doc.fields).toEqual([{ externalFieldId: "@document", name: "file", kind: "file" }]);
    expect(JSON.stringify(items)).not.toContain("s3cret");
  });

  test("reads live values: text, TOTP params, notes and document bytes", async () => {
    const { provider, ctx } = world();
    const c = ctx();
    const values = await provider.readFields(c, RW, "login0000000000000000000000", [
      "password",
      "TOTP_abc",
    ]);
    expect(values[0]!.material).toEqual({ type: "text", value: "s3cret" });
    expect(values[1]!.material).toEqual({
      type: "totp",
      params: { secretBase32: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, periodSeconds: 30 },
    });
    const [note] = await provider.readFields(c, RW, "note00000000000000000000000", ["@notes"]);
    expect(note!.material).toEqual({ type: "text", value: "multi\nline" });
    const [doc] = await provider.readFields(c, RW, "doc000000000000000000000000", ["@document"]);
    expect(doc!.material.type).toBe("bytes");
  });

  test("per-attempt cache: single-flight and 60 s reuse; a new attempt reads again", async () => {
    const { provider, ctx, fake } = world();
    const c = ctx();
    await Promise.all([
      provider.readFields(c, RW, "login0000000000000000000000", ["password"]),
      provider.readFields(c, RW, "login0000000000000000000000", ["username"]),
    ]);
    await provider.readFields(c, RW, "login0000000000000000000000", ["TOTP_abc"]);
    expect(fake.calls.filter((call) => call.op === "items.get")).toHaveLength(1);
    await provider.readFields(
      { ...ctx(), connectionId: c.connectionId },
      RW,
      "login0000000000000000000000",
      ["password"],
    );
    expect(fake.calls.filter((call) => call.op === "items.get")).toHaveLength(2);
  });

  test("the connection quota is charged measured HTTP requests, including the first sign-in", async () => {
    const { provider, ctx } = world();
    const c = ctx();
    const quota = onePasswordQuotaFor(c.connectionId!, "family");
    const start = quota.remainingDaily;
    await provider.listVaults(c);
    expect(start - quota.remainingDaily).toBe(
      ONEPASSWORD_REQUEST_COST.signIn + ONEPASSWORD_REQUEST_COST.vaultsList,
    );
    const afterList = quota.remainingDaily;
    await provider.readFields(c, RW, "login0000000000000000000000", ["password"]);
    expect(afterList - quota.remainingDaily).toBe(ONEPASSWORD_REQUEST_COST.itemsGet);
  });

  test("the attempt budget stops the 51st provider read before any SDK call", async () => {
    const { provider, fake } = world();
    const c: VaultProviderContext = {
      connectionId: null,
      budget: createAttemptProviderBudget({ reads: 2 }),
    };
    await provider.listVaults(c);
    await provider.readFields(c, RW, "login0000000000000000000000", ["password"]);
    const before = fake.calls.length;
    await expect(
      provider.readFields(c, RW, "note00000000000000000000000", ["@notes"]),
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
    });
    expect(fake.calls.length).toBe(before);
  });

  test("a 429 maps to provider_rate_limited and fails fast for the connection", async () => {
    const { provider, ctx, fake } = world();
    const c = ctx();
    fake.failNext(
      "vaults.list",
      () => new RateLimitExceededError("rate limit exceeded, retry in 5 minutes"),
    );
    await expect(provider.listVaults(c)).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterMs: 300_000,
    });
    const calls = fake.calls.length;
    await expect(
      provider.listVaults({ ...ctx(), connectionId: c.connectionId }),
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
    });
    expect(fake.calls.length).toBe(calls);
  });

  test("an expired token maps to provider_auth_expired and drops the cached client", async () => {
    const { provider, ctx, fake } = world();
    const c = ctx();
    await provider.listVaults(c);
    fake.failNext("vaults.list", () => new AuthExpiredError("service account token expired"));
    await expect(provider.listVaults(c)).rejects.toMatchObject({ code: "provider_auth_expired" });
    await provider.listVaults(c);
    expect(fake.signIns).toBe(2);
  });

  test("a lapsed SDK session signs in again once, transparently", async () => {
    const { provider, ctx, fake } = world();
    const c = ctx();
    await provider.listVaults(c);
    fake.failNext("vaults.list", () => new Error(NOT_AUTHENTICATED));
    expect((await provider.listVaults(c)).length).toBe(2);
    expect(fake.signIns).toBe(2);
  });

  test("create: login built-ins plus TOTP in an OpenGeni section; api_key value → credential", async () => {
    const { provider, ctx, fake } = world();
    const login = await provider.writeItem(ctx(), RW, {
      name: "GitHub",
      type: "login",
      websites: ["https://github.com"],
      fields: [
        { name: "username", kind: "text", value: "bot" },
        { name: "password", kind: "concealed", value: "generated-Pw-1!" },
        { name: "one-time password", kind: "totp", value: "JBSWY3DPEHPK3PXP" },
      ],
    });
    const stored = fake.vaults.get(RW)!.items.get(login.externalItemId)!;
    expect(stored.category).toBe("Login");
    expect(stored.fields.map((f) => [f.id, f.fieldType, f.sectionId ?? null])).toEqual([
      ["username", "Text", null],
      ["password", "Concealed", null],
      ["opengeni_one_time_password", "Totp", OPENGENI_SECTION_ID],
    ]);
    const key = await provider.writeItem(ctx(), RW, {
      name: "Stripe",
      type: "api_key",
      websites: [],
      fields: [{ name: "value", kind: "concealed", value: "sk_test_x" }],
    });
    const storedKey = fake.vaults.get(RW)!.items.get(key.externalItemId)!;
    expect(storedKey.category).toBe("ApiCredentials");
    expect(storedKey.fields[0]).toMatchObject({
      id: "credential",
      title: "value",
      value: "sk_test_x",
    });
    expect(key.fields).toEqual([
      { externalFieldId: "credential", name: "value", kind: "concealed" },
    ]);
  });

  test("update preserves unknown fields (passkeys), re-applies once on a race, conflicts on stale expected version", async () => {
    const { provider, ctx, fake } = world();
    const id = "login0000000000000000000000";
    // Concurrent edit between our get and put, without an expected version: re-read and re-apply.
    const original = fake.client.items.get.bind(fake.client.items);
    let raced = false;
    fake.client.items.get = async (vaultId, itemId) => {
      const item = await original(vaultId, itemId);
      if (!raced) {
        raced = true;
        fake.touch(vaultId, itemId);
      }
      return item;
    };
    const saved = await provider.writeItem(ctx(), RW, {
      externalItemId: id,
      name: "Test Login",
      type: "login",
      websites: ["https://example.test"],
      fields: [
        { externalFieldId: "password", name: "password", kind: "concealed", value: "rotated" },
      ],
    });
    fake.client.items.get = original;
    const stored = fake.vaults.get(RW)!.items.get(id)!;
    expect(stored.fields.find((f) => f.id === "password")!.value).toBe("rotated");
    expect(stored.fields.some((f) => f.fieldType === "Unsupported")).toBe(true);
    expect(saved.version).toBe("3");
    await expect(
      provider.writeItem(ctx(), RW, {
        externalItemId: id,
        expectedVersion: "1",
        name: "Test Login",
        type: "login",
        websites: [],
        fields: [{ name: "password", kind: "concealed", value: "lost-update" }],
      }),
    ).rejects.toMatchObject({ code: "provider_conflict" });
    expect(stored.fields.find((f) => f.id === "password")!.value).toBe("rotated");
  });

  test("field removal and notes updates", async () => {
    const { provider, ctx, fake } = world();
    await provider.writeItem(ctx(), RW, {
      externalItemId: "login0000000000000000000000",
      name: "Test Login",
      type: "login",
      websites: [],
      fields: [
        { externalFieldId: "TOTP_abc", name: "one-time password", kind: "totp", remove: true },
        { name: "notes", kind: "concealed", value: "recovery codes inside" },
      ],
    });
    const stored = fake.vaults.get(RW)!.items.get("login0000000000000000000000")!;
    expect(stored.fields.some((f) => f.id === "TOTP_abc")).toBe(false);
    expect(stored.notes).toBe("recovery codes inside");
    expect(stored.websites).toEqual([]);
  });

  test("writes to a read-only vault surface provider_permission_denied", async () => {
    const { provider, ctx } = world();
    const error = await provider
      .writeItem(ctx(), RO, {
        name: "x",
        type: "note",
        websites: [],
        fields: [{ name: "note", kind: "concealed", value: "v" }],
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(VaultProviderError);
    expect(error.code).toBe("provider_permission_denied");
  });

  test("unsupported writes are refused before any call: passkeys, files", async () => {
    const { provider, ctx, fake } = world();
    await expect(
      provider.writeItem(ctx(), RW, { name: "pk", type: "passkey", websites: [], fields: [] }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(
      provider.writeItem(ctx(), RW, {
        externalItemId: "doc000000000000000000000000",
        name: "kubeconfig",
        type: "file",
        websites: [],
        fields: [{ externalFieldId: "@document", name: "file", kind: "file", value: "x" }],
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(fake.calls.some((call) => call.op === "items.put" || call.op === "items.create")).toBe(
      false,
    );
  });

  test("managed vaults: admins access; group grants need Teams or Business", async () => {
    const { provider, ctx, fake } = world();
    const vault = await provider.createVault!(ctx(), {
      name: "OpenGeni – Shared",
      allowAdminsAccess: true,
    });
    expect(vault.itemCount).toBe(0);
    await expect(
      provider.createVault!(ctx(), { name: "x", allowAdminsAccess: true, groupId: "g1" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    const teams = createOnePasswordVaultProvider({
      token: fakeServiceAccountToken(),
      planTier: "teams",
      sdk: fake.sdk,
      clientCache: new OnePasswordClientCache(),
    });
    expect(teams.capabilities().groupGrants).toBe(true);
    await teams.createVault!(ctx(), { name: "Team vault", allowAdminsAccess: true, groupId: "g1" });
    expect(fake.calls.slice(-2).map((call) => call.op)).toEqual([
      "vaults.create",
      "vaults.grantGroupPermissions",
    ]);
  });
});
