import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createProviderCallBudget,
  VaultProviderError,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { createProtonPassVaultProvider, type ProtonPassVaultProvider } from "../src/provider";
import { type FakeCli, TOTP_SEED, VALID_TOKEN, makeFakeCli } from "./fixture";

const RW = "rwShare==";
const RO = "roShare==";

type Setup = { fake: FakeCli; provider: ProtonPassVaultProvider };
const open: Setup[] = [];

function setup(
  change?: Parameters<typeof makeFakeCli>[0],
  options: Partial<Parameters<typeof createProtonPassVaultProvider>[0]> = {},
): Setup {
  const fake = makeFakeCli(change);
  const provider = createProtonPassVaultProvider({
    token: VALID_TOKEN,
    binaryPath: fake.binaryPath,
    stateRoot: fake.stateRoot,
    hostEnv: {
      PATH: "/usr/bin:/bin",
      SECRET_FROM_HOST: "leak",
      HTTPS_PROXY: "http://proxy.test:3128",
    },
    ...options,
  });
  const entry = { fake, provider };
  open.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of open.splice(0)) {
    await entry.provider.close().catch(() => {});
    entry.fake.cleanup();
  }
});

function ctx(extra: Partial<VaultProviderContext> = {}): VaultProviderContext {
  return {
    connectionId: "conn-1",
    budget: createProviderCallBudget(100),
    authority: {
      accountId: "acct-1",
      workspaceId: "ws-1",
      subjectId: "user-1",
      connectionWorkspaceId: "ws-1",
      sessionId: "sess-1",
      turnId: "turn-1",
    },
    ...extra,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<VaultProviderError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(VaultProviderError);
  return error as VaultProviderError;
}

const commands = (fake: FakeCli) => fake.log().map((entry) => entry.argv.join(" "));

describe("binary pinning", () => {
  test("refuses a pass-cli other than the pinned version before signing in", async () => {
    const { fake, provider } = setup((state) => {
      state.version = "2.5.0";
    });
    const error = await errorOf(provider.listVaults(ctx()));
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).toContain("2.4.2");
    expect(commands(fake)).toEqual(["--version"]);
  });

  test("refuses relative and world-writable binaries", async () => {
    const relative = setup(undefined, { binaryPath: "pass-cli" });
    expect((await errorOf(relative.provider.listVaults(ctx()))).code).toBe("provider_unavailable");
    const writable = setup();
    chmodSync(writable.fake.binaryPath, 0o777);
    const error = await errorOf(writable.provider.listVaults(ctx()));
    expect(error.message).toContain("world-writable");
    expect(writable.fake.log()).toEqual([]);
  });

  test("checks an optional SHA-256 pin", async () => {
    const bad = setup(undefined, { expectedSha256: "00".repeat(32) });
    expect((await errorOf(bad.provider.listVaults(ctx()))).message).toContain("SHA-256");
    const bytes = await Bun.file(bad.fake.binaryPath).bytes();
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const good = createProtonPassVaultProvider({
      token: VALID_TOKEN,
      binaryPath: bad.fake.binaryPath,
      stateRoot: bad.fake.stateRoot,
      expectedSha256: digest.toUpperCase(),
    });
    try {
      expect((await good.listVaults(ctx())).length).toBe(3);
    } finally {
      await good.close();
    }
  });

  test("resolves pass-cli from PATH when no path is configured", async () => {
    const { fake } = setup();
    const provider = createProtonPassVaultProvider({
      token: VALID_TOKEN,
      stateRoot: fake.stateRoot,
      hostEnv: { PATH: `relative/bin:${fake.dir}` },
    });
    try {
      expect((await provider.listVaults(ctx())).length).toBe(3);
    } finally {
      await provider.close();
    }
  });
});

describe("process isolation", () => {
  test("runs with a minimal environment; the token is only given to login", async () => {
    const { fake, provider } = setup();
    await provider.validate(ctx());
    const log = fake.log();
    const login = log.find((entry) => entry.argv[0] === "login")!;
    expect(login.patPresent).toBe(true);
    expect(login.reason).toBeNull();
    for (const entry of log.filter((candidate) => candidate.argv[0] !== "login")) {
      expect(entry.patPresent).toBe(false);
    }
    const listed = log.find((entry) => entry.argv[0] === "share")!;
    expect(listed.envNames).toEqual(
      [
        "HOME",
        "HTTPS_PROXY",
        "LANG",
        "LC_ALL",
        "PASS_LOG_LEVEL",
        "PATH",
        "PROTON_PASS_AGENT_REASON",
        "PROTON_PASS_DISABLE_TELEMETRY",
        "PROTON_PASS_ENCRYPTION_KEY",
        "PROTON_PASS_KEY_PROVIDER",
        "PROTON_PASS_NO_UPDATE_CHECK",
        "PROTON_PASS_SESSION_DIR",
        "TZ",
      ].sort(),
    );
    expect(listed.path).toBe("/usr/bin:/bin");
    expect(listed.home.startsWith(fake.stateRoot)).toBe(true);
    expect(listed.sessionDir).toBe(join(listed.home, "session"));
    expect(listed.reason).toContain("Opengeni list vaults");
    expect(listed.reason).toContain("workspace ws-1");
    expect(listed.reason!.length).toBeLessThanOrEqual(300);
    for (const entry of log) expect(entry.argv.join(" ")).not.toContain(VALID_TOKEN);
  });

  test("keeps state in a private directory and wipes it on close", async () => {
    const { fake, provider } = setup();
    await provider.listVaults(ctx());
    const home = fake.log().at(-1)!.home;
    expect(statSync(fake.stateRoot).mode & 0o777).toBe(0o700);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    await provider.close();
    expect(existsSync(home)).toBe(false);
    expect(commands(fake).at(-1)).toBe("logout");
    expect((await errorOf(provider.listVaults(ctx()))).code).toBe("provider_unavailable");
  });

  test("closes an idle session", async () => {
    const { fake, provider } = setup(undefined, { idleCloseMs: 30 });
    await provider.listVaults(ctx());
    await Bun.sleep(400);
    expect(commands(fake)).toContain("logout");
    expect(readdirSync(fake.stateRoot)).toEqual([]);
    // A later call signs in again in a fresh directory.
    expect((await provider.listVaults(ctx())).length).toBe(3);
    expect(fake.state().logins).toBe(2);
  });

  test("rejects malformed tokens and refuses ids that could be options", async () => {
    expect(() => createProtonPassVaultProvider({ token: "has space ::x" })).toThrow(
      VaultProviderError,
    );
    const { fake, provider } = setup();
    const error = await errorOf(provider.readFields(ctx(), "--help", "x", ["@note"]));
    expect(error.code).toBe("provider_not_found");
    expect(fake.log()).toEqual([]);
  });
});

describe("sign-in lifecycle", () => {
  test("an invalid token is provider_auth_invalid without echoing CLI output", async () => {
    const { provider } = setup((state) => {
      state.token = "pst_other::key";
    });
    const error = await errorOf(provider.validate(ctx()));
    expect(error.code).toBe("provider_auth_invalid");
    expect(error.message).not.toContain("422");
  });

  test("validate reports the token name", async () => {
    const { provider } = setup();
    expect(await provider.validate(ctx())).toEqual({ accountName: "opengeni-ci" });
  });

  test("signs in again before the 2 h session limit", async () => {
    let clock = Date.parse("2026-10-15T10:00:00Z");
    const { fake, provider } = setup(undefined, { now: () => clock });
    await provider.listVaults(ctx());
    clock += 104 * 60_000;
    await provider.listVaults(ctx());
    expect(fake.state().logins).toBe(1);
    clock += 2 * 60_000;
    await provider.listVaults(ctx());
    expect(fake.state().logins).toBe(2);
  });

  test("a missing session is signed in again and retried, also for writes", async () => {
    const { fake, provider } = setup();
    await provider.listVaults(ctx());
    rmSync(join(fake.log().at(-1)!.sessionDir, "session.json"));
    const created = await provider.writeItem(ctx(), RW, {
      name: "after relogin",
      type: "note",
      websites: [],
      fields: [{ name: "note", kind: "concealed", value: "n" }],
    });
    expect(created.name).toBe("after relogin");
    expect(fake.state().logins).toBe(2);
    expect(commands(fake).filter((command) => command.startsWith("item create"))).toHaveLength(2);
  });

  test("an invalidated session retries reads but leaves writes unknown", async () => {
    const { fake, provider } = setup();
    await provider.listVaults(ctx());
    fake.update((state) => {
      state.invalidate = 1;
    });
    expect((await provider.listVaults(ctx())).length).toBe(3);
    fake.update((state) => {
      state.invalidate = 1;
    });
    const error = await errorOf(
      provider.writeItem(ctx(), RW, { name: "x", type: "note", websites: [], fields: [] }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(commands(fake).filter((command) => command.startsWith("item create"))).toHaveLength(1);
  });
});

describe("vaults", () => {
  test("maps share roles to write access and narrows custom roles", async () => {
    const { provider } = setup();
    const vaults = await provider.listVaults(ctx());
    expect(vaults.map((vault) => [vault.externalVaultId, vault.writeAccess])).toEqual([
      [RW, "read_write"],
      [RO, "read_only"],
      ["customShare", "read_write"],
    ]);
    const custom = vaults[2]!;
    expect(custom.operations?.archiveItem).toBe(false);
    expect(custom.operations?.archiveKind).toBe("none");
    expect(custom.operations?.createItemTypes).toEqual(["login", "note", "api_key"]);
    expect(vaults[0]!.operations).toBeUndefined();
  });

  test("falls back to vault list with unknown access when shares cannot be listed", async () => {
    const { provider } = setup((state) => {
      state.failures.push({
        match: "share list",
        stderr: "Error: Error listing shares\n\nCaused by:\n    Invalid status code: 403\n",
      });
    });
    const vaults = await provider.listVaults(ctx());
    expect(vaults.every((vault) => vault.writeAccess === "unknown")).toBe(true);
    expect(vaults.map((vault) => vault.externalVaultId)).toEqual([RW, RO, "customShare"]);
  });

  test("reports live freshness", async () => {
    const { provider } = setup();
    const seen: unknown[] = [];
    await provider.listVaults(ctx({ onFreshness: (freshness) => seen.push(freshness) }));
    expect(seen).toEqual([expect.objectContaining({ state: "current", source: "live" })]);
  });
});

describe("items", () => {
  test("lists active items with secrets once, viewing only items with files", async () => {
    const { fake, provider } = setup();
    const items = await provider.listItems(ctx(), RW);
    expect(items.map((item) => item.name)).toEqual(["Test Login", "Deploy key"]);
    const listCalls = commands(fake).filter((command) => command.startsWith("item "));
    expect(listCalls).toEqual([
      `item list --share-id=${RW} --filter-state active --show-secrets --output json`,
      `item view --share-id=${RW} --item-id=customItem1 --output json`,
    ]);
    const login = items[0]!;
    expect(login).toMatchObject({
      externalItemId: "loginItem1",
      type: "login",
      websites: ["https://login.example.test"],
      version: "2026-10-15T09:00:00",
      updatedAt: "2026-10-15T09:00:00.000Z",
    });
    expect(login.fields).toEqual([
      { externalFieldId: "login.username", name: "username", kind: "text" },
      { externalFieldId: "login.password", name: "password", kind: "concealed" },
      { externalFieldId: "login.totp", name: "one-time password", kind: "totp" },
      { externalFieldId: "x:recovery code", name: "recovery code", kind: "concealed" },
      { externalFieldId: "x:otp", name: "otp-code", kind: "text" },
      { externalFieldId: "x:renewal", name: "renewal", kind: "text" },
    ]);
    const custom = items[1]!;
    expect(custom.type).toBe("api_key");
    expect(custom.fields).toEqual([
      { externalFieldId: "s:Fields/value", name: "value", kind: "concealed" },
      { externalFieldId: "s:Fields/value#2", name: "value (2)", kind: "concealed" },
      { externalFieldId: "@note", name: "note", kind: "concealed" },
      { externalFieldId: "@file:att1", name: "cert.pem", kind: "file" },
      { externalFieldId: "@file:attBig", name: "big.bin", kind: "file" },
    ]);
    const json = JSON.stringify(items);
    for (const secret of ["pw-123", "sk_live_1", "rc-1", TOTP_SEED, "rotate quarterly"]) {
      expect(json).not.toContain(secret);
    }
  });

  test("agent tokens list summaries and view each item with an audit reason", async () => {
    const { fake, provider } = setup((state) => {
      state.agent = true;
    });
    expect((await provider.validate(ctx())).accountName).toBe("opengeni-ci");
    const items = await provider.listItems(ctx(), RW);
    expect(items.map((item) => item.externalItemId)).toEqual(["loginItem1", "customItem1"]);
    const itemCalls = fake.log().filter((entry) => entry.argv[0] === "item");
    expect(itemCalls.map((entry) => entry.argv.join(" "))).toEqual([
      `item list --share-id=${RW} --filter-state active --output json`,
      `item view --share-id=${RW} --item-id=loginItem1 --output json`,
      `item view --share-id=${RW} --item-id=customItem1 --output json`,
    ]);
    for (const entry of itemCalls) expect(entry.reason).toContain("Opengeni list items");
  });

  test("bounds the per-item fan-out for agent tokens", async () => {
    const { provider } = setup(
      (state) => {
        state.agent = true;
      },
      { maxItemViewsPerList: 1 },
    );
    expect((await errorOf(provider.listItems(ctx(), RW))).code).toBe(
      "provider_inventory_incomplete",
    );
  });

  test("oversized or malformed listings are incomplete inventories", async () => {
    const big = setup(undefined, { maxStdoutBytes: 64 });
    expect((await errorOf(big.provider.listItems(ctx(), RW))).code).toBe(
      "provider_inventory_incomplete",
    );
    const garbage = setup((state) => {
      state.failures.push({ match: "item list", stdoutBytes: 10 });
    });
    expect((await errorOf(garbage.provider.listItems(ctx(), RW))).code).toBe(
      "provider_inventory_incomplete",
    );
  });

  test("reads text, TOTP and bounded file values", async () => {
    const { fake, provider } = setup();
    const values = await provider.readFields(ctx(), RW, "loginItem1", [
      "login.username",
      "login.password",
      "login.totp",
      "x:renewal",
    ]);
    expect(values[0]!.material).toEqual({ type: "text", value: "alice" });
    expect(values[1]!.material).toEqual({ type: "text", value: "pw-123" });
    const otp = values[2]!.material;
    expect(otp.type === "totp" && otp.params.secretBase32).toBe(TOTP_SEED);
    expect(values[3]!.material).toEqual({ type: "text", value: "2025-10-09T08:53:20.000Z" });

    const [file] = await provider.readFields(ctx(), RW, "customItem1", ["@file:att1"]);
    expect(file!.material.type).toBe("bytes");
    if (file!.material.type === "bytes")
      expect(Buffer.from(file!.material.value).toString()).toBe("hello");
    const home = fake.log().at(-1)!.home;
    expect(readdirSync(home).filter((name) => name.startsWith("dl-"))).toEqual([]);

    const tooBig = await errorOf(provider.readFields(ctx(), RW, "customItem1", ["@file:attBig"]));
    expect(tooBig.code).toBe("provider_unavailable");
    expect(commands(fake).filter((command) => command.includes("attachment-id=attBig"))).toEqual(
      [],
    );
  });

  test("missing items, trashed items and unknown fields are not found", async () => {
    const { provider } = setup();
    expect((await errorOf(provider.readFields(ctx(), RW, "nope", ["@note"]))).code).toBe(
      "provider_not_found",
    );
    expect((await errorOf(provider.readFields(ctx(), RW, "trashedItem", ["@note"]))).code).toBe(
      "provider_not_found",
    );
    expect(
      (await errorOf(provider.readFields(ctx(), RW, "loginItem1", ["login.nothing"]))).code,
    ).toBe("provider_not_found");
    expect(
      (await errorOf(provider.readFields(ctx(), "unknownShare", "loginItem1", ["@note"]))).code,
    ).toBe("provider_not_found");
  });

  test("caches item values per attempt only", async () => {
    const { fake, provider } = setup();
    const attempt = ctx();
    await provider.readFields(attempt, RW, "loginItem1", ["login.password"]);
    await provider.readFields(attempt, RW, "loginItem1", ["login.username"]);
    const views = () => commands(fake).filter((command) => command.startsWith("item view")).length;
    expect(views()).toBe(1);
    await provider.readFields(ctx(), RW, "loginItem1", ["login.password"]);
    expect(views()).toBe(2);
    await provider.readFields({ ...attempt, forceRefresh: true }, RW, "loginItem1", [
      "login.password",
    ]);
    expect(views()).toBe(3);
  });

  test("charges the attempt budget per CLI call and stops before spawning", async () => {
    const { fake, provider } = setup();
    const budget = createProviderCallBudget(1);
    await provider.readFields(ctx({ budget }), RW, "loginItem1", ["login.password"]);
    const before = fake.log().length;
    expect((await errorOf(provider.listItems(ctx({ budget }), RW))).code).toBe(
      "provider_rate_limited",
    );
    expect(fake.log().length).toBe(before);
  });

  test("an aborted call never starts a process", async () => {
    const { fake, provider } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(provider.listVaults(ctx({ signal: controller.signal }))).rejects.toThrow();
    expect(fake.log()).toEqual([]);
  });
});

describe("writes", () => {
  test("creates logins with values only on stdin", async () => {
    const { fake, provider } = setup();
    const created = await provider.writeItem(ctx(), RW, {
      name: "New Login",
      type: "login",
      websites: ["https://new.example.test"],
      fields: [
        { name: "username", kind: "text", value: "bob" },
        { name: "password", kind: "concealed", value: "s3cret-value" },
        { name: "one-time password", kind: "totp", value: TOTP_SEED },
      ],
    });
    const create = fake.log().find((entry) => entry.argv[1] === "create")!;
    expect(create.argv).toEqual([
      "item",
      "create",
      "login",
      `--share-id=${RW}`,
      "--from-template",
      "-",
    ]);
    expect(create.argv.join(" ")).not.toContain("s3cret-value");
    const template = JSON.parse(create.stdin);
    expect(template).toMatchObject({
      title: "New Login",
      username: "bob",
      password: "s3cret-value",
      urls: ["https://new.example.test"],
    });
    expect(template.totp_uri).toStartWith("otpauth://totp/");
    expect(created.fields.map((field) => field.name)).toEqual([
      "username",
      "password",
      "one-time password",
    ]);
    expect(created.version).not.toBeNull();
    const [otp] = await provider.readFields(ctx(), RW, created.externalItemId, ["login.totp"]);
    expect(otp!.material.type === "totp" && otp!.material.params.secretBase32).toBe(TOTP_SEED);
  });

  test("creates notes and custom (api_key) items", async () => {
    const { fake, provider } = setup();
    const note = await provider.writeItem(ctx(), RW, {
      name: "Runbook",
      type: "note",
      websites: [],
      fields: [{ name: "note", kind: "concealed", value: "line 1" }],
    });
    expect(note.type).toBe("note");
    expect(note.fields).toEqual([{ externalFieldId: "@note", name: "note", kind: "concealed" }]);
    const key = await provider.writeItem(ctx(), RW, {
      name: "Stripe",
      type: "api_key",
      websites: [],
      fields: [
        { name: "value", kind: "concealed", value: "sk_test_x" },
        { name: "account", kind: "text", value: "acct_1" },
        { name: "mfa", kind: "totp", value: TOTP_SEED },
      ],
    });
    expect(key.type).toBe("api_key");
    expect(key.fields.map((field) => [field.externalFieldId, field.kind])).toEqual([
      ["s:Fields/value", "concealed"],
      ["s:Fields/account", "text"],
      ["s:Fields/mfa", "totp"],
    ]);
    const custom = fake.log().find((entry) => entry.argv[2] === "custom")!;
    expect(JSON.parse(custom.stdin).sections[0].fields[0]).toEqual({
      field_name: "value",
      field_type: "hidden",
      value: "sk_test_x",
    });
  });

  test("refuses updates, unsupported shapes and passkeys without running pass-cli", async () => {
    const { fake, provider } = setup();
    const update = await errorOf(
      provider.writeItem(ctx(), RW, {
        externalItemId: "loginItem1",
        expectedVersion: "2026-10-15T09:00:00",
        name: "Test Login",
        type: "login",
        websites: [],
        fields: [
          { externalFieldId: "login.password", name: "password", kind: "concealed", value: "x" },
        ],
      }),
    );
    expect(update.code).toBe("provider_unavailable");
    for (const item of [
      {
        name: "a",
        type: "login" as const,
        websites: [],
        fields: [{ name: "pin", kind: "text" as const, value: "1" }],
      },
      { name: "b", type: "passkey" as const, websites: [], fields: [] },
      { name: "c", type: "file" as const, websites: [], fields: [] },
      {
        name: "d",
        type: "login" as const,
        websites: [],
        fields: [{ name: "one-time password", kind: "totp" as const, value: "not base32 !" }],
      },
    ]) {
      expect((await errorOf(provider.writeItem(ctx(), RW, item))).code).toBe(
        "provider_unavailable",
      );
    }
    expect(fake.log()).toEqual([]);
  });

  test("a read-only vault refuses writes locally once known, and upstream otherwise", async () => {
    const upstream = setup();
    const denied = await errorOf(
      upstream.provider.writeItem(ctx(), RO, { name: "x", type: "note", websites: [], fields: [] }),
    );
    expect(denied.code).toBe("provider_permission_denied");
    expect(
      commands(upstream.fake).filter((command) => command.startsWith("item create")),
    ).toHaveLength(1);

    const local = setup();
    await local.provider.listVaults(ctx());
    const refused = await errorOf(
      local.provider.writeItem(ctx(), RO, { name: "x", type: "note", websites: [], fields: [] }),
    );
    expect(refused.code).toBe("provider_permission_denied");
    expect(commands(local.fake).filter((command) => command.startsWith("item create"))).toEqual([]);
  });

  test("archive moves to trash and never deletes", async () => {
    const { fake, provider } = setup();
    await provider.archiveItem(ctx(), RW, "loginItem1");
    expect(commands(fake).filter((command) => command.startsWith("item "))).toEqual([
      `item trash --share-id=${RW} --item-id=loginItem1`,
    ]);
    const items = await provider.listItems(ctx(), RW);
    expect(items.some((item) => item.externalItemId === "loginItem1")).toBe(false);
    expect(commands(fake).some((command) => command.startsWith("item delete"))).toBe(false);
    expect((await errorOf(provider.archiveItem(ctx(), RW, "nope"))).code).toBe(
      "provider_not_found",
    );
  });

  test("a failure after the create request leaves the outcome unknown", async () => {
    const { fake, provider } = setup((state) => {
      state.failures.push({
        match: "item create",
        afterEffect: true,
        stderr: "Error: Error sending monitor event\n\nCaused by:\n    Invalid status code: 500\n",
      });
    });
    const error = await errorOf(
      provider.writeItem(ctx(), RW, { name: "maybe", type: "note", websites: [], fields: [] }),
    );
    expect(error.code).toBe("provider_outcome_unknown");
    expect(
      fake.state().items[RW]!.some((item) => (item.content as { title: string }).title === "maybe"),
    ).toBe(true);
    expect(commands(fake).filter((command) => command.startsWith("item create"))).toHaveLength(1);
  });

  test("a timed-out write is unknown and a timed-out read is unavailable", async () => {
    const { provider } = setup(
      (state) => {
        state.failures.push({ match: "item create", sleepMs: 5_000, stderr: "" });
        state.failures.push({ match: "item view", sleepMs: 5_000, stderr: "" });
      },
      { commandTimeoutMs: 1_500 },
    );
    await provider.listVaults(ctx());
    const write = await errorOf(
      provider.writeItem(ctx(), RW, { name: "slow", type: "note", websites: [], fields: [] }),
    );
    expect(write.code).toBe("provider_outcome_unknown");
    const read = await errorOf(provider.readFields(ctx(), RW, "loginItem1", ["login.password"]));
    expect(read.code).toBe("provider_unavailable");
  }, 20_000);
});
