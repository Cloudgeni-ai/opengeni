import { describe, expect, test } from "bun:test";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { bootstrapKeeperConfiguration, bootstrapKeeperVaultProvider } from "../src/bootstrap";
import { createKeeperVaultProvider, type KeeperVaultProvider } from "../src/provider";
import { keeperConfigurationRecord } from "../src/config";
import { createKeeperSdkLoader } from "../src/sdk";
import { FakeKsm, loginData, uid } from "./fake-ksm";

const SEED = "JBSWY3DPEHPK3PXP";

function ctx(extra: Partial<VaultProviderContext> = {}): VaultProviderContext {
  return { connectionId: "conn-k", budget: createProviderCallBudget(100), ...extra };
}

async function errorOf(promise: Promise<unknown>): Promise<VaultProviderError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  return error as VaultProviderError;
}

type World = {
  fake: FakeKsm;
  provider: KeeperVaultProvider;
  persisted: Array<{ configuration: string; previous: string | null; reason: string }>;
  rw: string;
  ro: string;
  sub: string;
  login: string;
  subRecord: string;
  direct: string;
};

async function world(options: { persistFails?: () => boolean } = {}): Promise<World> {
  const fake = new FakeKsm();
  const rw = fake.addFolder("Engineering");
  const ro = fake.addFolder("Read only", { editable: false });
  const sub = fake.addFolder("Nested", { parent: rw.uid });
  const login = fake.addRecord(rw.uid, loginData("Test Login"));
  fake.addFile(login, "cert.pem", Buffer.from("hello"));
  fake.addFile(login, "big.bin", Buffer.alloc(16), 300_000);
  const subRecord = fake.addRecord(sub.uid, {
    type: "encryptedNotes",
    title: "Nested note",
    fields: [
      { type: "note", value: ["deep"] },
      { type: "date", value: [1_760_000_000_000] },
    ],
    custom: [],
  });
  fake.addRecord(ro.uid, loginData("Shared Login"));
  const direct = fake.addRecord(undefined, loginData("Direct"));
  const { configuration } = await bootstrapKeeperConfiguration({
    oneTimeToken: fake.createToken(),
    queryFunction: fake.queryFunction,
  });
  const persisted: World["persisted"] = [];
  const provider = createKeeperVaultProvider({
    configuration,
    persistConfiguration: async (next, context) => {
      if (options.persistFails?.()) throw new Error("storage down");
      persisted.push({ configuration: next, ...context });
    },
    queryFunction: fake.queryFunction,
    fetchFile: fake.fetchFile,
  });
  return {
    fake,
    provider,
    persisted,
    rw: rw.uid,
    ro: ro.uid,
    sub: sub.uid,
    login: login.uid,
    subRecord: subRecord.uid,
    direct: direct.uid,
  };
}

describe("bootstrap", () => {
  test("redeems a one-time token into a bound configuration", async () => {
    const fake = new FakeKsm();
    const token = fake.createToken();
    const result = await bootstrapKeeperConfiguration({
      oneTimeToken: token,
      queryFunction: fake.queryFunction,
    });
    const config = JSON.parse(result.configuration);
    expect(Object.keys(config).sort()).toEqual([
      "appKey",
      "appOwnerPublicKey",
      "clientId",
      "hostname",
      "privateKey",
    ]);
    expect(config.hostname).toBe("keepersecurity.com");
    expect(result.accountName).toBe("Opengeni CI App");
    expect(result.configuration).not.toContain(token.split(":")[1]!);

    const again = await errorOf(
      bootstrapKeeperConfiguration({ oneTimeToken: token, queryFunction: fake.queryFunction }),
    );
    expect(again.code).toBe("provider_auth_invalid");
  });

  test("refuses hosts outside the allowlist before any request", async () => {
    const fake = new FakeKsm();
    const token = fake.createToken("evil.example.test");
    const error = await errorOf(
      bootstrapKeeperConfiguration({ oneTimeToken: token, queryFunction: fake.queryFunction }),
    );
    expect(error.code).toBe("provider_auth_invalid");
    const bare = fake.createToken(null);
    expect(
      (
        await errorOf(
          bootstrapKeeperConfiguration({ oneTimeToken: bare, queryFunction: fake.queryFunction }),
        )
      ).code,
    ).toBe("provider_auth_invalid");
    expect(
      (
        await bootstrapKeeperConfiguration({
          oneTimeToken: bare,
          hostname: "keepersecurity.com",
          queryFunction: fake.queryFunction,
        })
      ).accountName,
    ).toBe("Opengeni CI App");
    expect(fake.requests.filter((request) => request.path === "get_secret").length).toBe(2);
    expect(
      (await errorOf(bootstrapKeeperConfiguration({ oneTimeToken: "not a token" }))).code,
    ).toBe("provider_auth_invalid");
  });

  test("a lost bind response is ambiguous and never retried", async () => {
    const fake = new FakeKsm();
    const token = fake.createToken();
    const error = await errorOf(
      bootstrapKeeperConfiguration({
        oneTimeToken: token,
        queryFunction: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(error.message).toContain("generate a new one");
  });

  test("a bind answered by a gateway error after Keeper applied it is ambiguous", async () => {
    for (const body of ["<html><body>502 Bad Gateway</body></html>", ""]) {
      const fake = new FakeKsm();
      const token = fake.createToken();
      fake.hooks.answerAfterApply = { path: "get_secret", status: 502, body };
      const saved: string[] = [];
      const error = await errorOf(
        bootstrapKeeperConfiguration({
          oneTimeToken: token,
          queryFunction: fake.queryFunction,
          persistConfiguration: async (configuration) => {
            saved.push(configuration);
          },
        }),
      );
      expect(error.code).toBe("provider_outcome_unknown");
      expect(error.message).toContain("generate a new one");
      expect(saved).toHaveLength(0);
      expect(fake.requests.filter((request) => request.path === "get_secret")).toHaveLength(1);
      // The token really was spent: it cannot bind again.
      expect(
        (
          await errorOf(
            bootstrapKeeperConfiguration({
              oneTimeToken: token,
              queryFunction: fake.queryFunction,
            }),
          )
        ).code,
      ).toBe("provider_auth_invalid");
    }
  });

  test("a bind refused with a known rejection status stays definite", async () => {
    const fake = new FakeKsm();
    fake.hooks.failNext = {
      path: "get_secret",
      status: 403,
      body: { result_code: "access_denied", message: "One-time token was already used" },
    };
    const error = await errorOf(
      bootstrapKeeperConfiguration({
        oneTimeToken: fake.createToken(),
        queryFunction: fake.queryFunction,
      }),
    );
    expect(error.code).toBe("provider_auth_invalid");
  });

  test("bootstrapKeeperVaultProvider returns a working provider", async () => {
    const fake = new FakeKsm();
    fake.addFolder("Ops");
    const saved: Array<{ configuration: string; previous: string | null; reason: string }> = [];
    let requestsAtSave = -1;
    const { provider, configuration } = await bootstrapKeeperVaultProvider({
      oneTimeToken: fake.createToken(),
      queryFunction: fake.queryFunction,
      persistConfiguration: async (next, context) => {
        requestsAtSave = fake.requests.length;
        saved.push({ configuration: next, ...context });
      },
    });
    // Saved once, when the binding call (the bind plus the SDK's own refetch)
    // returns, before the provider makes any request.
    expect(saved).toEqual([{ configuration, previous: null, reason: "bind" }]);
    expect(requestsAtSave).toBe(2);
    expect(provider.currentConfiguration()).toBe(configuration);
    expect((await provider.listVaults(ctx())).map((vault) => vault.name)).toEqual(["Ops"]);
    expect(saved).toHaveLength(1);
  });

  test("a bind that succeeds before a later failure still keeps and saves the configuration", async () => {
    const fake = new FakeKsm();
    fake.addFolder("Ops");
    fake.hooks.corruptAppData = true;
    const saved: string[] = [];
    const result = await bootstrapKeeperConfiguration({
      oneTimeToken: fake.createToken(),
      queryFunction: fake.queryFunction,
      persistConfiguration: async (next) => {
        saved.push(next);
      },
    });
    expect(result.accountName).toBeNull();
    expect(saved).toEqual([result.configuration]);
    fake.hooks.corruptAppData = false;
    const provider = createKeeperVaultProvider({
      configuration: keeperConfigurationRecord(result.configuration),
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
    });
    expect((await provider.listVaults(ctx())).map((vault) => vault.name)).toEqual(["Ops"]);
  });

  test("a failed save after binding is reported without the configuration", async () => {
    const fake = new FakeKsm();
    const error = await errorOf(
      bootstrapKeeperVaultProvider({
        oneTimeToken: fake.createToken(),
        queryFunction: fake.queryFunction,
        persistConfiguration: async () => {
          throw new Error("storage down");
        },
      }),
    );
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toContain("generate a new token");
    expect(error.message).not.toContain("appKey");
    expect(fake.requests).toHaveLength(2);
  });
});

describe("configuration", () => {
  test("rejects unbound or malformed configurations", () => {
    const persistConfiguration = async () => {};
    for (const configuration of [
      "",
      "{}",
      "[1]",
      JSON.stringify({ hostname: "keepersecurity.com", clientId: "a", privateKey: "b" }),
    ]) {
      expect(() => createKeeperVaultProvider({ configuration, persistConfiguration })).toThrow(
        VaultProviderError,
      );
    }
  });

  test("a configuration naming another host makes no request", async () => {
    const { fake, provider } = await world();
    const config = JSON.parse(provider.currentConfiguration());
    const evil = createKeeperVaultProvider({
      configuration: JSON.stringify({ ...config, hostname: "evil.example.test" }),
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
    });
    const before = fake.requests.length;
    expect((await errorOf(evil.listVaults(ctx()))).code).toBe("provider_auth_invalid");
    expect(fake.requests.length).toBe(before);
  });

  test("accepts base64 configurations as Keeper tools export them", async () => {
    const { fake, provider } = await world();
    const encoded = Buffer.from(provider.currentConfiguration()).toString("base64");
    const again = createKeeperVaultProvider({
      configuration: encoded,
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
    });
    expect((await again.listVaults(ctx())).length).toBe(2);
  });

  test("persists a server key rotation through the callback", async () => {
    const { fake, provider, persisted } = await world();
    const before = provider.currentConfiguration();
    fake.hooks.requireKeyId = 8;
    expect((await provider.listVaults(ctx())).length).toBe(2);
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!.configuration).serverPublicKeyId).toBe("8");
    expect(persisted[0]!.previous).toBe(before);
    expect(persisted[0]!.reason).toBe("rotation");
    await provider.listVaults(ctx());
    expect(persisted).toHaveLength(1);
    expect(fake.requests.at(-1)!.keyId).toBe(8);
  });

  test("a failed persistence fails reads and is retried before the next call", async () => {
    let failing = true;
    const { fake, provider, persisted } = await world({ persistFails: () => failing });
    fake.hooks.requireKeyId = 8;
    expect((await errorOf(provider.listVaults(ctx()))).code).toBe("provider_unavailable");
    expect((await errorOf(provider.listVaults(ctx()))).code).toBe("provider_unavailable");
    failing = false;
    expect((await provider.listVaults(ctx())).length).toBe(2);
    expect(persisted).toHaveLength(1);
  });
});

describe("reads", () => {
  test("lists shared folders only, with unknown write access", async () => {
    const { provider, rw, ro } = await world();
    const vaults = await provider.listVaults(ctx());
    expect(vaults).toEqual([
      {
        externalVaultId: rw,
        name: "Engineering",
        contentVersion: null,
        itemCount: null,
        writeAccess: "unknown",
      },
      {
        externalVaultId: ro,
        name: "Read only",
        contentVersion: null,
        itemCount: null,
        writeAccess: "unknown",
      },
    ]);
  });

  test("lists records of a shared folder, including subfolders, without values", async () => {
    const { provider, rw, login, subRecord, direct } = await world();
    const items = await provider.listItems(ctx(), rw);
    expect(items.map((item) => item.externalItemId).sort()).toEqual([login, subRecord].sort());
    expect(items.some((item) => item.externalItemId === direct)).toBe(false);
    const meta = items.find((item) => item.externalItemId === login)!;
    expect(meta).toMatchObject({
      name: "Test Login",
      type: "login",
      websites: ["https://login.example.test"],
      version: "1",
    });
    expect(meta.fields.map((field) => [field.externalFieldId, field.name, field.kind])).toEqual([
      ["f:login", "username", "text"],
      ["f:password", "password", "concealed"],
      ["f:url", "website", "text"],
      ["f:oneTimeCode", "one-time password", "totp"],
      ["c:otp", "otp-code", "text"],
      ["c:recovery", "recovery", "concealed"],
      ["c:recovery#2", "recovery (2)", "concealed"],
      ["c:paymentCard", "paymentCard", "concealed"],
      ["@notes", "notes", "concealed"],
      [expect.stringMatching(/^@file:/), "cert.pem", "file"],
      [expect.stringMatching(/^@file:/), "big.bin", "file"],
    ]);
    const note = items.find((item) => item.externalItemId === subRecord)!;
    expect(note.type).toBe("note");
    const text = JSON.stringify(items);
    for (const secret of ["pw-123", "rc-1", SEED, "4111", "rotate monthly", "deep"])
      expect(text).not.toContain(secret);
  });

  test("reads text, TOTP, structured, notes and bounded file values", async () => {
    const { fake, provider, rw, login } = await world();
    const meta = (await provider.listItems(ctx(), rw)).find(
      (item) => item.externalItemId === login,
    )!;
    const fileId = meta.fields.find((field) => field.name === "cert.pem")!.externalFieldId;
    const values = await provider.readFields(ctx(), rw, login, [
      "f:password",
      "f:oneTimeCode",
      "c:paymentCard",
      "@notes",
      "c:recovery#2",
      fileId,
    ]);
    expect(values[0]!.material).toEqual({ type: "text", value: "pw-123" });
    const otp = values[1]!.material;
    expect(otp.type === "totp" && otp.params.secretBase32).toBe(SEED);
    expect(JSON.parse((values[2]!.material as { value: string }).value).cardNumber).toBe("4111");
    expect(values[3]!.material).toEqual({ type: "text", value: "rotate monthly" });
    expect(values[4]!.material).toEqual({ type: "text", value: "rc-2" });
    const file = values[5]!.material;
    expect(file.type === "bytes" && Buffer.from(file.value).toString()).toBe("hello");

    const bigId = meta.fields.find((field) => field.name === "big.bin")!.externalFieldId;
    let fetched = 0;
    const counting = createKeeperVaultProvider({
      configuration: provider.currentConfiguration(),
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
      fetchFile: async (url, options) => {
        fetched += 1;
        return fake.fetchFile(url, options);
      },
    });
    expect((await errorOf(counting.readFields(ctx(), rw, login, [bigId]))).code).toBe(
      "provider_unavailable",
    );
    expect(fetched).toBe(0);
  });

  test("file downloads go through the runtime fetch (the server's pinned fetch) by default", async () => {
    const { provider, fake, rw, login } = await world();
    const meta = (await provider.listItems(ctx(), rw)).find(
      (item) => item.externalItemId === login,
    )!;
    const fileId = meta.fields.find((field) => field.name === "cert.pem")!.externalFieldId;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const pinned = createKeeperVaultProvider({
      configuration: provider.currentConfiguration(),
      persistConfiguration: async () => {},
      queryFunction: fake.queryFunction,
      // No fetchFile: production relies on this default.
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        // The encrypted bytes Keeper's file storage serves for this URL.
        const bytes = await fake.fetchFile(String(input), {
          maxBytes: 1_000_000,
          timeoutMs: 1_000,
        });
        return new Response(Buffer.from(bytes));
      },
    });
    const controller = new AbortController();
    const [value] = await pinned.readFields(ctx({ signal: controller.signal }), rw, login, [
      fileId,
    ]);
    expect(value!.material.type === "bytes" && Buffer.from(value!.material.value).toString()).toBe(
      "hello",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toStartWith("https://files.keeper.test/");
    expect(calls[0]!.init.redirect).toBe("error");
    controller.abort();
    expect(calls[0]!.init.signal!.aborted).toBe(true);
  });

  test("never reads a record through another folder, and unknown ids are not found", async () => {
    const { provider, ro, rw, login } = await world();
    expect((await errorOf(provider.readFields(ctx(), ro, login, ["f:password"]))).code).toBe(
      "provider_not_found",
    );
    expect((await errorOf(provider.readFields(ctx(), rw, uid(), ["f:password"]))).code).toBe(
      "provider_not_found",
    );
    expect((await errorOf(provider.readFields(ctx(), rw, login, ["f:nothing"]))).code).toBe(
      "provider_not_found",
    );
    expect((await errorOf(provider.readFields(ctx(), rw, "../etc", ["f:password"]))).code).toBe(
      "provider_not_found",
    );
  });

  test("records the SDK cannot decrypt make listings incomplete", async () => {
    const { fake, provider, rw } = await world();
    const bad = fake.addRecord(rw, loginData("Corrupt"), { corrupt: true });
    expect((await errorOf(provider.listItems(ctx(), rw))).code).toBe(
      "provider_inventory_incomplete",
    );
    expect((await errorOf(provider.readFields(ctx(), rw, bad.uid, ["f:password"]))).code).toBe(
      "provider_unavailable",
    );
  });

  test("records with more fields or websites than Opengeni mirrors make the listing incomplete", async () => {
    const fields = await world();
    fields.fake.addRecord(fields.rw, {
      type: "login",
      title: "Many fields",
      fields: [],
      custom: Array.from({ length: 51 }, (_, index) => ({
        type: "text",
        label: `field ${index}`,
        value: ["v"],
      })),
    });
    expect((await errorOf(fields.provider.listItems(ctx(), fields.rw))).code).toBe(
      "provider_inventory_incomplete",
    );
    const sites = await world();
    sites.fake.addRecord(sites.rw, {
      type: "login",
      title: "Many sites",
      fields: [
        {
          type: "url",
          value: Array.from({ length: 21 }, (_, index) => `https://s${index}.example.test`),
        },
      ],
      custom: [],
    });
    expect((await errorOf(sites.provider.listItems(ctx(), sites.rw))).code).toBe(
      "provider_inventory_incomplete",
    );
  });

  test("caches values per attempt only", async () => {
    const { fake, provider, rw, login } = await world();
    const attempt = ctx();
    const count = () => fake.requests.filter((request) => request.path === "get_secret").length;
    const start = count();
    await provider.readFields(attempt, rw, login, ["f:password"]);
    await provider.readFields(attempt, rw, login, ["f:login"]);
    expect(count() - start).toBe(1);
    await provider.readFields(ctx(), rw, login, ["f:login"]);
    expect(count() - start).toBe(2);
    await provider.readFields({ ...attempt, forceRefresh: true }, rw, login, ["f:login"]);
    expect(count() - start).toBe(3);
  });

  test("throttling surfaces at once with the server's retry hint", async () => {
    const { fake, provider } = await world();
    fake.hooks.failNext = {
      path: "get_folders",
      status: 429,
      body: { error: "throttled", retry_after: 7 },
    };
    const started = Date.now();
    const error = await errorOf(provider.listVaults(ctx()));
    expect(error.code).toBe("provider_rate_limited");
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(7_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("budget exhaustion and aborts stop before any request", async () => {
    const { fake, provider, rw } = await world();
    const before = fake.requests.length;
    expect(
      (await errorOf(provider.listItems(ctx({ budget: createProviderCallBudget(0) }), rw))).code,
    ).toBe("provider_rate_limited");
    const controller = new AbortController();
    controller.abort();
    await expect(provider.listVaults(ctx({ signal: controller.signal }))).rejects.toThrow();
    expect(fake.requests.length).toBe(before);
  });

  test("two connections in one process never share SDK key state", async () => {
    const a = await world();
    const b = await world();
    const work = [];
    for (let index = 0; index < 8; index += 1) {
      work.push(a.provider.readFields(ctx(), a.rw, a.login, ["f:password", "@notes"]));
      work.push(b.provider.listItems(ctx(), b.rw));
      work.push(b.provider.readFields(ctx(), b.rw, b.login, ["f:password"]));
      work.push(a.provider.listVaults(ctx()));
    }
    const results = await Promise.all(work);
    expect(results).toHaveLength(32);
    const clientsA = new Set(a.fake.requests.map((request) => request.clientId));
    const clientsB = new Set(b.fake.requests.map((request) => request.clientId));
    expect(clientsA.size).toBe(1);
    expect(clientsB.size).toBe(1);
    expect([...clientsA][0]).not.toBe([...clientsB][0]);
  });

  test("providers sharing one attempt budget never share cached records or values", async () => {
    // Core shares one budget across every provider in an attempt; two
    // connections to the same application see the same folder and record uids.
    const a = await world();
    const { configuration } = await bootstrapKeeperConfiguration({
      oneTimeToken: a.fake.createToken(),
      queryFunction: a.fake.queryFunction,
    });
    const b = createKeeperVaultProvider({
      configuration,
      persistConfiguration: async () => {},
      queryFunction: a.fake.queryFunction,
      fetchFile: a.fake.fetchFile,
    });
    const shared = ctx();
    expect((await a.provider.listItems(shared, a.rw)).length).toBeGreaterThan(0);
    const values = await a.provider.readFields(shared, a.rw, a.login, ["f:password"]);
    expect(values[0]!.material).toEqual({ type: "text", value: "pw-123" });

    a.fake.revoke(keeperConfigurationRecord(configuration).clientId!);
    const before = a.fake.requests.length;
    expect((await errorOf(b.readFields(shared, a.rw, a.login, ["f:password"]))).code).toBe(
      "provider_auth_invalid",
    );
    expect((await errorOf(b.listItems(shared, a.rw))).code).toBe("provider_auth_invalid");
    expect(a.fake.requests.length - before).toBe(2);
    // A's own cache is unaffected.
    const again = await a.provider.readFields(shared, a.rw, a.login, ["f:password"]);
    expect(again).toEqual(values);
    expect(a.fake.requests.length - before).toBe(2);
  });
});

describe("writes", () => {
  test("creates logins and notes in a shared folder", async () => {
    const { fake, provider, rw } = await world();
    const created = await provider.writeItem(ctx(), rw, {
      name: "New Login",
      type: "login",
      websites: ["https://a.example.test", "https://b.example.test"],
      fields: [
        { name: "username", kind: "text", value: "bob" },
        { name: "password", kind: "concealed", value: "s3cret" },
        { name: "one-time password", kind: "totp", value: SEED },
        { name: "pin", kind: "concealed", value: "1234" },
      ],
    });
    expect(created.type).toBe("login");
    expect(created.version).toBe("1");
    expect(created.websites).toEqual(["https://a.example.test", "https://b.example.test"]);
    const stored = fake.records.get(created.externalItemId)!;
    expect(stored.folderUid).toBe(rw);
    expect(
      (stored.data.fields as Array<{ type: string; value: string[] }>).find(
        (field) => field.type === "oneTimeCode",
      )!.value[0],
    ).toStartWith("otpauth://totp/");
    const [otp] = await provider.readFields(ctx(), rw, created.externalItemId, ["f:oneTimeCode"]);
    expect(otp!.material.type === "totp" && otp!.material.params.secretBase32).toBe(SEED);

    const note = await provider.writeItem(ctx(), rw, {
      name: "Runbook",
      type: "note",
      websites: [],
      fields: [{ name: "note", kind: "concealed", value: "step 1" }],
    });
    expect(note.type).toBe("note");
    expect(fake.records.get(note.externalItemId)!.data.type).toBe("encryptedNotes");
  });

  test("refuses API keys, files and passkeys before any request", async () => {
    const { fake, provider, rw } = await world();
    const before = fake.requests.length;
    for (const type of ["api_key", "file", "passkey"] as const) {
      expect(
        (
          await errorOf(
            provider.writeItem(ctx(), rw, { name: "x", type, websites: [], fields: [] }),
          )
        ).code,
      ).toBe("provider_unavailable");
    }
    expect(fake.requests.length).toBe(before);
  });

  test("upstream permission and folder checks", async () => {
    const { provider, ro, sub } = await world();
    const item = { name: "x", type: "login" as const, websites: [], fields: [] };
    expect((await errorOf(provider.writeItem(ctx(), ro, item))).code).toBe(
      "provider_permission_denied",
    );
    expect((await errorOf(provider.writeItem(ctx(), sub, item))).code).toBe("provider_not_found");
    expect((await errorOf(provider.writeItem(ctx(), uid(), item))).code).toBe("provider_not_found");
  });

  test("a lost create response is ambiguous and not retried", async () => {
    const { fake, provider, rw } = await world();
    fake.hooks.dropResponse = "create_secret";
    const count = fake.records.size;
    const error = await errorOf(
      provider.writeItem(ctx(), rw, { name: "maybe", type: "note", websites: [], fields: [] }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(fake.records.size).toBe(count + 1);
    expect(fake.requests.filter((request) => request.path === "create_secret")).toHaveLength(1);
  });

  test("a create applied and then answered with 502 is ambiguous, not unavailable", async () => {
    const { fake, provider, rw } = await world();
    fake.hooks.answerAfterApply = {
      path: "create_secret",
      status: 502,
      body: "<html><body>502 Bad Gateway</body></html>",
    };
    const count = fake.records.size;
    const error = await errorOf(
      provider.writeItem(ctx(), rw, { name: "maybe", type: "note", websites: [], fields: [] }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(fake.records.size).toBe(count + 1);
    expect(fake.requests.filter((request) => request.path === "create_secret")).toHaveLength(1);
  });

  test("an update applied and then answered with 503 is ambiguous", async () => {
    const { fake, provider, rw, login } = await world();
    fake.hooks.answerAfterApply = { path: "update_secret", status: 503, body: "" };
    const error = await errorOf(
      provider.writeItem(ctx(), rw, {
        externalItemId: login,
        name: "Test Login",
        type: "login",
        websites: ["https://login.example.test"],
        fields: [
          { externalFieldId: "f:password", name: "password", kind: "concealed", value: "maybe" },
        ],
      }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(fake.records.get(login)!.revision).toBe(2);
  });

  test("known rejections before applying stay definite", async () => {
    const { fake, provider, rw } = await world();
    fake.hooks.failNext = {
      path: "create_secret",
      status: 400,
      body: { result_code: "error", message: "Record data is invalid" },
    };
    const count = fake.records.size;
    const error = await errorOf(
      provider.writeItem(ctx(), rw, { name: "no", type: "note", websites: [], fields: [] }),
    );
    expect(error.code).not.toBe("provider_outcome_unknown");
    expect(fake.records.size).toBe(count);
  });

  test("updates by field patch with revision checks", async () => {
    const { fake, provider, rw, login } = await world();
    const before = (await provider.listItems(ctx(), rw)).find(
      (item) => item.externalItemId === login,
    )!;
    const updated = await provider.writeItem(ctx(), rw, {
      externalItemId: login,
      expectedVersion: before.version,
      name: "Renamed Login",
      type: "login",
      websites: before.websites,
      fields: [
        { externalFieldId: "f:password", name: "password", kind: "concealed", value: "next-pw" },
        { externalFieldId: "c:recovery#2", name: "recovery (2)", kind: "concealed", remove: true },
        {
          externalFieldId: "f:oneTimeCode",
          name: "one-time password",
          kind: "totp",
          value: "GEZDGNBVGY3TQOJQ",
        },
        { name: "api token", kind: "concealed", value: "tok" },
      ],
    });
    expect(updated.version).toBe("2");
    expect(updated.name).toBe("Renamed Login");
    expect(updated.fields.map((field) => field.name)).toContain("api token");
    expect(updated.fields.filter((field) => field.name.startsWith("recovery"))).toHaveLength(1);
    const record = fake.records.get(login)!;
    expect(
      (record.data.custom as Array<{ type: string }>).some((field) => field.type === "paymentCard"),
    ).toBe(true);
    expect(record.data.notes).toBe("rotate monthly");
    const values = await provider.readFields(ctx(), rw, login, ["f:password", "f:oneTimeCode"]);
    expect(values[0]!.material).toEqual({ type: "text", value: "next-pw" });
    expect(values[1]!.material.type === "totp" && values[1]!.material.params.secretBase32).toBe(
      "GEZDGNBVGY3TQOJQ",
    );

    const updates = () =>
      fake.requests.filter((request) => request.path === "update_secret").length;
    const sent = updates();
    const stale = await errorOf(
      provider.writeItem(ctx(), rw, {
        externalItemId: login,
        expectedVersion: before.version,
        name: "x",
        type: "login",
        websites: [],
        fields: [
          { externalFieldId: "f:password", name: "password", kind: "concealed", value: "z" },
        ],
      }),
    );
    expect(stale.code).toBe("provider_conflict");
    expect(updates()).toBe(sent);

    fake.hooks.failNext = {
      path: "update_secret",
      status: 400,
      body: { result_code: "error", message: "Record revision is out of date" },
    };
    const upstream = await errorOf(
      provider.writeItem(ctx(), rw, {
        externalItemId: login,
        expectedVersion: "2",
        name: "x",
        type: "login",
        websites: [],
        fields: [
          { externalFieldId: "f:password", name: "password", kind: "concealed", value: "z" },
        ],
      }),
    );
    expect(upstream.code).toBe("provider_conflict");
  });

  test("structured fields and read-only folders refuse updates", async () => {
    const { fake, provider, rw, login } = await world();
    expect(
      (
        await errorOf(
          provider.writeItem(ctx(), rw, {
            externalItemId: login,
            name: "Test Login",
            type: "login",
            websites: ["https://login.example.test"],
            fields: [
              {
                externalFieldId: "c:paymentCard",
                name: "paymentCard",
                kind: "concealed",
                value: "4242",
              },
            ],
          }),
        )
      ).code,
    ).toBe("provider_unavailable");
    const shared = [...fake.records.values()].find(
      (record) => record.data.title === "Shared Login",
    )!;
    const roFolder = shared.folderUid!;
    expect(
      (
        await errorOf(
          provider.writeItem(ctx(), roFolder, {
            externalItemId: shared.uid,
            name: "Shared Login",
            type: "login",
            websites: ["https://login.example.test"],
            fields: [
              { externalFieldId: "f:password", name: "password", kind: "concealed", value: "x" },
            ],
          }),
        )
      ).code,
    ).toBe("provider_permission_denied");
  });

  test("a lost update response is ambiguous", async () => {
    const { fake, provider, rw, login } = await world();
    fake.hooks.dropResponse = "update_secret";
    const error = await errorOf(
      provider.writeItem(ctx(), rw, {
        externalItemId: login,
        name: "Test Login",
        type: "login",
        websites: ["https://login.example.test"],
        fields: [
          { externalFieldId: "f:password", name: "password", kind: "concealed", value: "maybe" },
        ],
      }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(fake.records.get(login)!.revision).toBe(2);
  });

  test("archive is not offered", async () => {
    const { fake, provider, rw, login } = await world();
    const before = fake.requests.length;
    expect((await errorOf(provider.archiveItem(ctx(), rw, login))).code).toBe(
      "provider_unavailable",
    );
    expect(fake.requests.length).toBe(before);
    const operations = provider.capabilities().operations!;
    expect(operations).toMatchObject({
      archiveItem: false,
      archiveKind: "none",
      deleteItem: false,
      createItemTypes: ["login", "note"],
    });
  });
});

describe("SDK isolation", () => {
  test("refuses an SDK build other than the pinned 17.6.0", () => {
    const loader = createKeeperSdkLoader({ source: "module.exports = {}" });
    expect(() => loader.instance()).toThrow(/not @keeper-security\/secrets-manager-core 17.6.0/);
  });

  test("each instance has no filesystem and its own module state", async () => {
    const loader = createKeeperSdkLoader();
    const first = loader.instance();
    const second = loader.instance();
    expect(first.sdk).not.toBe(second.sdk);
    expect(first.sdk.platform).not.toBe(second.sdk.platform);
    await first.sdk.platform.importKey("probe", new Uint8Array(32));
    expect(first.sdk.platform.hasKeysCached()).toBe(true);
    expect(second.sdk.platform.hasKeysCached()).toBe(false);
    expect(() => first.sdk.localConfigStorage("client-config.json")).toThrow();
  });
});
