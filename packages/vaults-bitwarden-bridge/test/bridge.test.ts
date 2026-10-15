import { afterEach, describe, expect, test } from "bun:test";
import type { VaultProviderFreshness } from "@opengeni/contracts";
import { createInMemoryExternalVaultReceiverStore } from "@opengeni/sdk/external-vault-receiver";
import {
  createProviderCallBudget,
  createRemoteVaultProvider,
  type RemoteVaultTransport,
  type VaultProviderContext,
} from "@opengeni/vaults";
import {
  BitwardenServeClient,
  createBitwardenBridge,
  createUnixSocketBitwardenTransport,
  customFieldId,
  type BitwardenBridgeConfig,
} from "../src/index";
import {
  COLLECTION_ID,
  ORG_ID,
  OTHER_COLLECTION_ID,
  USER_ID,
  login,
  startFakeBwServe,
  type FakeItem,
} from "./fake-bw-serve";

const SECRET = "k".repeat(48);
const CONNECTION = "4b2e1f00-7c3d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET_VALUES = [
  "hunter2",
  "ghp_secret",
  "JBSWY3DPEHPK3PXP",
  "recovery codes",
  "platform",
  "octo",
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function config(overrides: Partial<BitwardenBridgeConfig> = {}): BitwardenBridgeConfig {
  return {
    connectionId: CONNECTION,
    signingSecrets: [SECRET],
    opengeni: {
      accountId: "acct_1",
      connectionWorkspaceId: "ws_owner",
      workspaceIds: ["ws_owner", "ws_2"],
    },
    vaults: [
      { kind: "personal", mode: "read_write" },
      {
        kind: "collection",
        collectionId: COLLECTION_ID,
        organizationId: ORG_ID,
        mode: "read_write",
      },
      {
        kind: "collection",
        collectionId: OTHER_COLLECTION_ID,
        organizationId: ORG_ID,
        mode: "read_only",
      },
    ],
    ...overrides,
  };
}

async function harness(
  options: { items?: FakeItem[]; config?: Partial<BitwardenBridgeConfig> } = {},
) {
  const bw = await startFakeBwServe({ items: options.items ?? [login()] });
  cleanups.push(() => bw.close());
  let offset = 0;
  const now = () => Date.now() + offset;
  const client = new BitwardenServeClient({
    transport: createUnixSocketBitwardenTransport({ socketPath: bw.socketPath }),
    timeoutMs: 2_000,
  });
  const bridge = createBitwardenBridge({
    config: config(options.config),
    client,
    store: createInMemoryExternalVaultReceiverStore({ now }),
    now,
  });
  const responses: string[] = [];
  const transport: RemoteVaultTransport = {
    async post(request) {
      const response = await bridge.handle({ body: request.body, headers: request.headers });
      responses.push(response.body);
      return {
        status: response.status,
        headers: new Headers(response.headers),
        body: response.body,
      };
    },
  };
  const provider = createRemoteVaultProvider({
    provider: "bitwarden",
    endpoint: "https://bridge.example.com/opengeni/vault",
    signingSecret: SECRET,
    transport,
    connectionId: CONNECTION,
    now,
  });
  const freshness: VaultProviderFreshness[] = [];
  const ctx = (extra: Partial<VaultProviderContext> = {}): VaultProviderContext => ({
    connectionId: CONNECTION,
    budget: createProviderCallBudget(100),
    authority: {
      accountId: "acct_1",
      workspaceId: "ws_2",
      subjectId: "user_1",
      connectionWorkspaceId: "ws_owner",
    },
    onFreshness: (value) => freshness.push(value),
    ...extra,
  });
  return {
    bw,
    bridge,
    provider,
    ctx,
    responses,
    freshness,
    advance: (ms: number) => (offset += ms),
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "ok",
    (error: { code?: string }) => error.code ?? String(error),
  );
}

describe("describe and inventory", () => {
  test("validate returns the stable Bitwarden user id and truthful operations", async () => {
    const { provider, ctx } = await harness();
    const result = await provider.validate(ctx());
    expect(result.accountId).toBe(`bitwarden:${USER_ID}`);
    expect(result.accountName).toBe("ops@example.com");
    expect(result.capabilities).toEqual({ totp: true, files: false });
    expect(result.operations).toMatchObject({
      createItemTypes: ["login", "note"],
      archiveKind: "trash",
      deleteItem: false,
      restoreItem: false,
      readFiles: false,
      writeFiles: false,
      createVault: false,
    });
    expect(provider.capabilities()).toMatchObject({
      write: true,
      files: false,
      createVault: false,
    });
  });

  test("lists only configured vaults; collection write access is unknown, not assumed", async () => {
    const { bw, provider, ctx } = await harness();
    bw.state.collections = bw.state.collections.filter((c) => c.id !== OTHER_COLLECTION_ID);
    const vaults = await provider.listVaults(ctx());
    expect(vaults.map((v) => [v.externalVaultId, v.name, v.writeAccess])).toEqual([
      ["personal", "My vault", "read_write"],
      [`collection:${COLLECTION_ID}`, "Platform", "unknown"],
    ]);
    expect(bw.state.syncs).toBe(1);
  });

  test("item listings sync first, contain no values and respect scope", async () => {
    const personal = login();
    const trashed = login({ deletedDate: "2026-10-14T00:00:00.000Z" });
    const archived = login({ archivedDate: "2026-10-14T00:00:00.000Z" });
    const shared = login({ organizationId: ORG_ID, collectionIds: [COLLECTION_ID] });
    const other = login({ organizationId: ORG_ID, collectionIds: [OTHER_COLLECTION_ID] });
    const { bw, provider, ctx, responses, freshness } = await harness({
      items: [personal, trashed, archived, shared, other],
    });
    const items = await provider.listItems(ctx(), "personal");
    expect(items.map((item) => item.externalItemId)).toEqual([personal.id]);
    expect(
      (await provider.listItems(ctx(), `collection:${COLLECTION_ID}`)).map((i) => i.externalItemId),
    ).toEqual([shared.id]);
    expect(bw.state.syncs).toBe(1);
    expect(freshness[0]).toMatchObject({ state: "current", source: "live" });
    for (const body of responses)
      for (const value of SECRET_VALUES) expect(body).not.toContain(value);
    expect(
      await code(provider.listItems(ctx(), "collection:00000000-0000-4000-8000-000000000000")),
    ).toBe("provider_not_found");
  });

  test("pages share a snapshot; foreign or expired cursors are incomplete inventory", async () => {
    const items = [login(), login(), login()];
    const { provider, ctx } = await harness({ items });
    const first = await provider.listItemPage(ctx(), "personal", { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await provider.listItemPage(ctx(), "personal", {
      limit: 2,
      cursor: first.nextCursor!,
      snapshot: first.snapshot!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      await code(
        provider.listItemPage(ctx(), `collection:${COLLECTION_ID}`, {
          limit: 2,
          cursor: first.nextCursor!,
          snapshot: first.snapshot!,
        }),
      ),
    ).toBe("provider_inventory_incomplete");
  });
});

describe("reads and freshness", () => {
  test("reads values, syncing upstream at most once per read TTL", async () => {
    const item = login();
    const { bw, provider, ctx, advance, freshness } = await harness({ items: [item] });
    const values = await provider.readFields(ctx(), "personal", item.id, [
      "login.password",
      "login.totp",
    ]);
    expect(values.map((v) => v.externalFieldId)).toEqual(["login.password", "login.totp"]);
    expect(bw.state.syncs).toBe(1);
    await provider.readFields(ctx(), "personal", item.id, ["login.password"]);
    expect(bw.state.syncs).toBe(1);
    expect(freshness.at(-1)).toMatchObject({ state: "current", source: "cache" });
    advance(301_000);
    await provider.readFields(ctx(), "personal", item.id, ["login.password"]);
    expect(bw.state.syncs).toBe(2);
    advance(20_000);
    await provider.readFields(ctx({ forceRefresh: true }), "personal", item.id, ["login.password"]);
    expect(bw.state.syncs).toBe(3);
  });

  test("offline upstream: values come from the CLI cache marked stale, or fail when stale reads are off", async () => {
    const item = login();
    const { bw, provider, ctx, freshness } = await harness({ items: [item] });
    bw.state.offline = true;
    await provider.readFields(ctx(), "personal", item.id, ["login.password"]);
    expect(freshness.at(-1)).toMatchObject({ state: "stale", errorCode: "provider_unavailable" });
    expect(freshness.at(-1)?.sourceSyncedAt).toBe("2026-10-15T09:00:00.000Z");
    const strict = await harness({ items: [item], config: { allowStaleReads: false } });
    strict.bw.state.offline = true;
    expect(
      await code(strict.provider.readFields(strict.ctx(), "personal", item.id, ["login.password"])),
    ).toBe("provider_unavailable");
  });

  test("locked and logged-out CLIs are reported, never unlocked", async () => {
    const item = login();
    const { bw, provider, ctx } = await harness({ items: [item] });
    bw.state.status = "locked";
    expect(await code(provider.readFields(ctx(), "personal", item.id, ["login.password"]))).toBe(
      "provider_locked",
    );
    bw.state.status = "unauthenticated";
    expect(await code(provider.listVaults(ctx()))).toBe("provider_auth_expired");
    expect(bw.state.requests.every((r) => !/unlock|login/.test(r.path))).toBe(true);
  });

  test("items outside the vault scope are not found; hidden values are permission denied", async () => {
    const shared = login({ organizationId: ORG_ID, collectionIds: [COLLECTION_ID] });
    const hidden = login({
      login: { uris: [], username: "u", password: null, totp: null },
      fields: [],
    });
    const { provider, ctx } = await harness({ items: [shared, hidden] });
    expect(await code(provider.readFields(ctx(), "personal", shared.id, ["login.password"]))).toBe(
      "provider_not_found",
    );
    expect(await code(provider.readFields(ctx(), "personal", hidden.id, ["login.password"]))).toBe(
      "provider_permission_denied",
    );
  });
});

describe("authorization", () => {
  test("an unlisted calling workspace is refused even with a valid signature", async () => {
    const item = login();
    const { provider, ctx } = await harness({ items: [item] });
    const outsider = ctx({
      authority: {
        accountId: "acct_1",
        workspaceId: "ws_9",
        subjectId: "user_1",
        connectionWorkspaceId: "ws_owner",
      },
    });
    expect(await code(provider.readFields(outsider, "personal", item.id, ["login.password"]))).toBe(
      "provider_permission_denied",
    );
    const otherAccount = ctx({
      authority: {
        accountId: "acct_2",
        workspaceId: "ws_2",
        subjectId: "user_1",
        connectionWorkspaceId: "ws_owner",
      },
    });
    expect(await code(provider.listVaults(otherAccount))).toBe("provider_permission_denied");
  });

  test("subject allow-lists gate values and writes but not inventory", async () => {
    const item = login();
    const { provider, ctx } = await harness({
      items: [item],
      config: {
        opengeni: {
          accountId: "acct_1",
          connectionWorkspaceId: "ws_owner",
          workspaceIds: ["ws_2"],
          subjectIds: ["user_ok"],
        },
      },
    });
    expect(await code(provider.listItems(ctx(), "personal"))).toBe("ok");
    expect(await code(provider.readFields(ctx(), "personal", item.id, ["login.password"]))).toBe(
      "provider_permission_denied",
    );
    const allowed = ctx({
      authority: {
        accountId: "acct_1",
        workspaceId: "ws_2",
        subjectId: "user_ok",
        connectionWorkspaceId: "ws_owner",
      },
    });
    expect(await code(provider.readFields(allowed, "personal", item.id, ["login.password"]))).toBe(
      "ok",
    );
  });

  test("a different signing secret is refused", async () => {
    const { bridge } = await harness();
    const provider = createRemoteVaultProvider({
      provider: "bitwarden",
      endpoint: "https://bridge.example.com/opengeni/vault",
      signingSecret: "z".repeat(48),
      connectionId: CONNECTION,
      transport: {
        async post(request) {
          const response = await bridge.handle({ body: request.body, headers: request.headers });
          return {
            status: response.status,
            headers: new Headers(response.headers),
            body: response.body,
          };
        },
      },
    });
    expect(
      await code(
        provider.validate({
          connectionId: CONNECTION,
          budget: createProviderCallBudget(10),
          authority: {
            accountId: "acct_1",
            workspaceId: "ws_owner",
            subjectId: null,
            connectionWorkspaceId: "ws_owner",
          },
        }),
      ),
    ).toBe("provider_auth_invalid");
  });
});

describe("writes", () => {
  async function writable(items: FakeItem[]) {
    const h = await harness({ items });
    await h.provider.validate(h.ctx());
    return h;
  }

  test("an update syncs, checks the revision and keeps unknown upstream data", async () => {
    const item = login();
    const { bw, provider, ctx } = await writable([item]);
    const saved = await provider.writeItem(ctx({ idempotencyKey: "op-1" }), "personal", {
      externalItemId: item.id,
      expectedVersion: item.revisionDate as string,
      name: "GitHub",
      type: "login",
      websites: ["https://github.com"],
      fields: [
        {
          externalFieldId: "login.password",
          name: "password",
          kind: "concealed",
          value: "rotated",
        },
      ],
    });
    expect(saved.version).not.toBe(item.revisionDate);
    expect(JSON.stringify(saved)).not.toContain("rotated");
    const stored = bw.state.items[0]!;
    expect((stored.login as Record<string, unknown>).password).toBe("rotated");
    expect(stored.unknownFutureField).toEqual({ keep: true });
    expect(stored.passwordHistory).toEqual(item.passwordHistory);
    expect(bw.state.syncs).toBeGreaterThanOrEqual(1);
  });

  test("a stale expected version is a conflict and nothing is sent", async () => {
    const item = login();
    const { bw, provider, ctx } = await writable([item]);
    const result = await code(
      provider.writeItem(ctx(), "personal", {
        externalItemId: item.id,
        expectedVersion: "2026-01-01T00:00:00.000Z",
        name: "x",
        type: "login",
        websites: [],
        fields: [],
      }),
    );
    expect(result).toBe("provider_conflict");
    expect(bw.state.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  test("creates in the configured collection; read-only vaults refuse writes", async () => {
    const { bw, provider, ctx } = await writable([]);
    const created = await provider.writeItem(ctx(), `collection:${COLLECTION_ID}`, {
      name: "Stripe",
      type: "login",
      websites: [],
      fields: [{ name: "password", kind: "concealed", value: "pw" }],
    });
    expect(bw.state.items[0]).toMatchObject({
      organizationId: ORG_ID,
      collectionIds: [COLLECTION_ID],
    });
    expect(created.fields.map((f) => f.externalFieldId)).toEqual(["login.password"]);
    expect(
      await code(
        provider.writeItem(ctx(), `collection:${OTHER_COLLECTION_ID}`, {
          name: "n",
          type: "note",
          websites: [],
          fields: [],
        }),
      ),
    ).toBe("provider_permission_denied");
    expect(bw.state.items).toHaveLength(1);
  });

  test("Bitwarden's own edit refusal is permission denied", async () => {
    const item = login({ organizationId: ORG_ID, collectionIds: [COLLECTION_ID] });
    const { bw, provider, ctx } = await writable([item]);
    bw.state.readOnly.add(item.id);
    expect(
      await code(
        provider.writeItem(ctx(), `collection:${COLLECTION_ID}`, {
          externalItemId: item.id,
          name: "x",
          type: "login",
          websites: [],
          fields: [],
        }),
      ),
    ).toBe("provider_permission_denied");
  });

  test("writes need a fresh upstream sync", async () => {
    const { bw, provider, ctx } = await writable([]);
    bw.state.offline = true;
    expect(
      await code(
        provider.writeItem(ctx(), "personal", {
          name: "n",
          type: "note",
          websites: [],
          fields: [],
        }),
      ),
    ).toBe("provider_unavailable");
    expect(bw.state.items).toHaveLength(0);
  });

  test("an ambiguous write is reported once and never retried; a replay of the key stays unknown", async () => {
    const { bw, provider, ctx } = await writable([]);
    bw.state.dropAfterCommit = true;
    const write = { name: "n", type: "note" as const, websites: [], fields: [] };
    expect(
      await code(provider.writeItem(ctx({ idempotencyKey: "amb-1" }), "personal", write)),
    ).toBe("provider_outcome_unknown");
    expect(bw.state.items).toHaveLength(1);
    expect(
      await code(provider.writeItem(ctx({ idempotencyKey: "amb-1" }), "personal", write)),
    ).toBe("provider_outcome_unknown");
    expect(
      bw.state.requests.filter((r) => r.method === "POST" && r.path === "/object/item"),
    ).toHaveLength(1);
  });

  test("a completed key replays its result without a second upstream write", async () => {
    const { bw, provider, ctx } = await writable([]);
    const write = { name: "n", type: "note" as const, websites: [], fields: [] };
    const first = await provider.writeItem(ctx({ idempotencyKey: "same" }), "personal", write);
    const again = await provider.writeItem(ctx({ idempotencyKey: "same" }), "personal", write);
    expect(again).toEqual(first);
    expect(bw.state.items).toHaveLength(1);
    expect(
      await code(
        provider.writeItem(ctx({ idempotencyKey: "same" }), "personal", {
          ...write,
          name: "other",
        }),
      ),
    ).toBe("provider_conflict");
  });

  test("archive moves the item to Trash, never a permanent delete", async () => {
    const item = login();
    const { bw, provider, ctx } = await writable([item]);
    await provider.archiveItem(ctx(), "personal", item.id);
    expect(bw.state.items[0]!.deletedDate).not.toBeNull();
    expect(bw.state.requests.some((r) => r.path.includes("permanent"))).toBe(false);
    expect(await provider.listItems(ctx(), "personal")).toEqual([]);
    expect(await code(provider.archiveItem(ctx(), `collection:${COLLECTION_ID}`, item.id))).toBe(
      "provider_not_found",
    );
  });

  test("custom field edits use stable ids", async () => {
    const item = login();
    const { bw, provider, ctx } = await writable([item]);
    await provider.writeItem(ctx(), "personal", {
      externalItemId: item.id,
      name: "GitHub",
      type: "login",
      websites: ["https://github.com"],
      fields: [
        {
          externalFieldId: customFieldId("api key", 0),
          name: "api key",
          kind: "concealed",
          value: "ghp_new",
        },
      ],
    });
    const values = await provider.readFields(ctx(), "personal", item.id, [
      customFieldId("api key", 0),
    ]);
    expect(values).toHaveLength(1);
    expect((bw.state.items[0]!.fields as Array<{ value: string }>)[0]!.value).toBe("ghp_new");
  });
});
