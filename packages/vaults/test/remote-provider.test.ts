import { describe, expect, test } from "bun:test";
import {
  VAULT_PROVIDER_WIRE_ERROR_CODES,
  VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
  VaultProviderWireRequest,
  vaultProviderWireResponseKey,
  type VaultProviderFreshness,
  type VaultProviderOperations,
} from "@opengeni/contracts";
import {
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import {
  VAULT_PROVIDER_ERROR_CODES,
  VaultProviderError,
  createFetchRemoteVaultTransport,
  createProviderCallBudget,
  createRemoteVaultProvider,
  listProviderItems,
  RemoteVaultTransportError,
  type RemoteVaultHttpRequest,
  type RemoteVaultTransport,
  type VaultProviderContext,
} from "../src/index";

const SECRET = "s".repeat(40);
const CONNECTION = "6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const AUTHORITY = {
  accountId: "acct_1",
  workspaceId: "ws_1",
  subjectId: "user_1",
  connectionWorkspaceId: "ws_owner",
  sessionId: "sess_1",
};
const WRITE_OPS: VaultProviderOperations = {
  createItemTypes: ["login", "note", "file", "passkey"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "trash",
  deleteItem: false,
  restoreItem: true,
  readFiles: true,
  writeFiles: true,
  createTotp: true,
  updateTotp: true,
  createVault: true,
  restoreFieldHistory: true,
};
const CURRENT = {
  state: "current" as const,
  sourceSyncedAt: "2026-10-15T11:59:00.000Z",
  source: "live" as const,
  errorCode: null,
  retryAt: null,
};

type Handler = (request: VaultProviderWireRequest) => unknown;

/** A minimal signed receiver: tests the adapter without the SDK helper. */
function fakeReceiver(
  handler: Handler,
  options: {
    tamper?: (body: string) => string;
    sign?: "response" | "request" | "none";
    status?: number;
    echo?: (request: VaultProviderWireRequest) => Partial<{ requestId: string; op: string }>;
  } = {},
) {
  const seen: { request: VaultProviderWireRequest; raw: RemoteVaultHttpRequest }[] = [];
  const transport: RemoteVaultTransport = {
    async post(raw) {
      const valid = await verifyOpenGeniSignature({
        secret: SECRET,
        body: raw.body,
        signature: raw.headers[OPENGENI_SIGNATURE_HEADER],
        nowSeconds: Math.floor(NOW / 1000),
      });
      expect(valid).toBe(true);
      const request = VaultProviderWireRequest.parse(JSON.parse(raw.body));
      seen.push({ request, raw });
      const outcome = handler(request) as Record<string, unknown>;
      const envelope = {
        version: "opengeni.vault.v1",
        type: "response",
        requestId: request.requestId,
        op: request.operation.op,
        freshness: null,
        ...outcome,
        ...options.echo?.(request),
      };
      const body = JSON.stringify(envelope);
      const key = options.sign === "request" ? SECRET : vaultProviderWireResponseKey(SECRET);
      const headers = new Headers({ "content-type": "application/json" });
      if (options.sign !== "none") {
        headers.set(
          VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
          await signOpenGeniPayload(key, body, Math.floor(NOW / 1000)),
        );
      }
      // Tampering happens in transit, after the receiver signed.
      return { status: options.status ?? 200, headers, body: options.tamper?.(body) ?? body };
    },
  };
  return { transport, seen };
}

const ok = (result: unknown, freshness: unknown = null) => ({ ok: true, result, freshness });
const err = (code: string, retryAfterMs: number | null = null) => ({
  ok: false,
  error: { code, retryAfterMs },
});

function ctx(
  extra: { [K in keyof VaultProviderContext]?: VaultProviderContext[K] | undefined } = {},
): VaultProviderContext & {
  freshness: VaultProviderFreshness[];
  budget: ReturnType<typeof createProviderCallBudget>;
} {
  const freshness: VaultProviderFreshness[] = [];
  return {
    connectionId: CONNECTION,
    budget: createProviderCallBudget(100),
    authority: AUTHORITY,
    onFreshness: (value: VaultProviderFreshness) => freshness.push(value),
    freshness,
    ...extra,
  } as never;
}

function provider(transport: RemoteVaultTransport, extra: Record<string, unknown> = {}) {
  return createRemoteVaultProvider({
    provider: "external",
    endpoint: "https://vault.example.com/opengeni",
    signingSecret: SECRET,
    transport,
    now: () => NOW,
    ...extra,
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof VaultProviderError ? error.code : `other:${String(error)}`;
  }
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  externalItemId: id,
  name: `Item ${id}`,
  type: "login",
  websites: ["https://example.com"],
  fields: [
    { externalFieldId: "username", name: "username", kind: "text" },
    { externalFieldId: "password", name: "password", kind: "concealed" },
  ],
  version: "v1",
  updatedAt: "2026-10-15T11:00:00.000Z",
  ...extra,
});

const describeResult = (operations: VaultProviderOperations = WRITE_OPS) => ({
  accountId: "bridge-account-1",
  accountName: "Ops vault",
  operations,
  capabilities: { totp: true, files: false },
  inventoryScope: "connection",
});

describe("remote vault provider requests", () => {
  test("error codes stay in parity with the provider port", () => {
    expect([...VAULT_PROVIDER_WIRE_ERROR_CODES]).toEqual([...VAULT_PROVIDER_ERROR_CODES]);
  });

  test("signs the exact body with the trusted authority tuple and consumes budget", async () => {
    const { transport, seen } = fakeReceiver(() => ok(describeResult()));
    const remote = provider(transport);
    const context = ctx();
    const result = await remote.validate(context);
    expect(result.accountId).toBe("bridge-account-1");
    expect(result.accountName).toBe("Ops vault");
    expect(context.budget.used()).toBe(1);
    const { request, raw } = seen[0]!;
    expect(raw.url).toBe("https://vault.example.com/opengeni");
    expect(raw.maxResponseBytes).toBe(4 * 1024 * 1024);
    expect(raw.timeoutMs).toBe(15_000);
    expect(request.version).toBe("opengeni.vault.v1");
    expect(request.connectionId).toBe(CONNECTION);
    expect(request.authority).toEqual(AUTHORITY);
    expect(request.operation).toEqual({ op: "describe" });
  });

  test("v1 clamps operations it cannot express and capabilities follow describe", async () => {
    const { transport } = fakeReceiver(() => ok(describeResult()));
    const remote = provider(transport);
    expect(remote.capabilities().write).toBe(false);
    const { operations } = await remote.validate(ctx());
    expect(operations.createItemTypes).toEqual(["login", "note"]);
    expect(operations.createVault).toBe(false);
    expect(operations.writeFiles).toBe(false);
    expect(operations.restoreItem).toBe(false);
    expect(operations.restoreFieldHistory).toBe(false);
    // Described capabilities say files are not readable.
    expect(operations.readFiles).toBe(false);
    const capabilities = remote.capabilities();
    expect(capabilities.write).toBe(true);
    expect(capabilities.createVault).toBe(false);
    expect(capabilities.passkeys).toBe(false);
    expect(capabilities.operations?.archiveKind).toBe("trash");
  });

  test("refuses before sending without authority, with a mismatched connection or a bad endpoint", async () => {
    const { transport, seen } = fakeReceiver(() => ok(describeResult()));
    const remote = provider(transport, { connectionId: CONNECTION });
    expect(await errorCode(remote.validate(ctx({ authority: undefined })))).toBe(
      "provider_permission_denied",
    );
    expect(
      await errorCode(
        remote.validate(ctx({ connectionId: "00000000-0000-4000-8000-000000000001" })),
      ),
    ).toBe("provider_permission_denied");
    expect(await errorCode(provider(transport).validate(ctx({ connectionId: null })))).toBe(
      "provider_unavailable",
    );
    expect(seen).toHaveLength(0);
    for (const endpoint of [
      "http://vault.example.com",
      "https://user:pass@vault.example.com",
      "https://vault.example.com/#x",
      "ftp://vault.example.com",
      "not a url",
    ]) {
      expect(() => provider(transport, { endpoint })).toThrow(VaultProviderError);
    }
    expect(() =>
      provider(transport, { endpoint: "http://127.0.0.1:9", allowInsecureHttp: true }),
    ).not.toThrow();
    expect(() => provider(transport, { signingSecret: "short" })).toThrow(VaultProviderError);
  });

  test("unverifiable responses are unavailable for reads and unknown outcomes for writes", async () => {
    const writeItem = {
      name: "Deploy key",
      type: "note" as const,
      websites: [],
      fields: [{ name: "note", kind: "text" as const, value: "hello" }],
    };
    const cases = [
      { sign: "none" as const },
      { sign: "request" as const },
      { tamper: (body: string) => `${body} ` },
      { tamper: (body: string) => body.replace("Ops vault", "Evil vault") },
      { echo: () => ({ requestId: "00000000-0000-4000-8000-000000000009" }) },
      { echo: () => ({ op: "list_vaults" }) },
      { status: 500 },
    ];
    for (const options of cases) {
      const read = fakeReceiver(() => ok(describeResult()), options);
      expect(await errorCode(provider(read.transport).validate(ctx()))).toBe(
        "provider_unavailable",
      );
      const write = fakeReceiver(
        () => ok({ item: item("new", { name: "Ops vault", type: "note", fields: [] }) }),
        options,
      );
      const remote = provider(write.transport, { operations: WRITE_OPS });
      expect(await errorCode(remote.writeItem(ctx(), "v1", writeItem))).toBe(
        "provider_outcome_unknown",
      );
    }
  });

  test("unsigned auth and rate-limit statuses map to safe codes for reads only", async () => {
    const denied = fakeReceiver(() => ({}), { status: 401, sign: "none" });
    expect(await errorCode(provider(denied.transport).validate(ctx()))).toBe(
      "provider_auth_invalid",
    );
    const limited: RemoteVaultTransport = {
      async post() {
        return { status: 429, headers: new Headers({ "retry-after": "7" }), body: "" };
      },
    };
    let error: unknown;
    try {
      await provider(limited).validate(ctx());
    } catch (caught) {
      error = caught;
    }
    expect((error as VaultProviderError).code).toBe("provider_rate_limited");
    expect((error as VaultProviderError).retryAfterMs).toBe(7_000);
    expect(
      await errorCode(
        provider(limited, { operations: WRITE_OPS }).archiveItem(ctx(), "vault", "item"),
      ),
    ).toBe("provider_outcome_unknown");
  });

  test("transport failures: reads unavailable, writes unknown unless nothing was sent", async () => {
    const failing = (sent: boolean): RemoteVaultTransport => ({
      async post() {
        throw new RemoteVaultTransportError("network", sent);
      },
    });
    expect(await errorCode(provider(failing(true)).validate(ctx()))).toBe("provider_unavailable");
    const remote = provider(failing(true), { operations: WRITE_OPS });
    expect(await errorCode(remote.archiveItem(ctx(), "v", "i"))).toBe("provider_outcome_unknown");
    const unsent = provider(failing(false), { operations: WRITE_OPS });
    expect(await errorCode(unsent.archiveItem(ctx(), "v", "i"))).toBe("provider_unavailable");
    const oversized: RemoteVaultTransport = {
      async post() {
        return { status: 200, headers: new Headers(), body: "x".repeat(4 * 1024 * 1024 + 1) };
      },
    };
    expect(await errorCode(provider(oversized).validate(ctx()))).toBe("provider_unavailable");
  });

  test("receiver errors become safe provider errors with retry time and freshness", async () => {
    const freshness = { ...CURRENT, state: "unavailable", errorCode: "provider_locked" };
    const { transport } = fakeReceiver(() => ({
      ...err("provider_locked", 1_500),
      freshness,
    }));
    const context = ctx();
    let error: unknown;
    try {
      await provider(transport).readFields(context, "v", "i", ["password"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VaultProviderError);
    expect((error as VaultProviderError).code).toBe("provider_locked");
    expect((error as VaultProviderError).retryAfterMs).toBe(1_500);
    expect((error as VaultProviderError).message).toContain("locked");
    expect(context.freshness[0]).toMatchObject({
      state: "unavailable",
      errorCode: "provider_locked",
      lastCheckedAt: new Date(NOW).toISOString(),
    });
  });
});

describe("remote vault inventory", () => {
  test("pages vault and item inventories with snapshots and reports freshness once per page", async () => {
    const items = Array.from({ length: 150 }, (_, index) => item(`item-${index}`));
    const { transport, seen } = fakeReceiver((request) => {
      const operation = request.operation;
      if (operation.op !== "list_items") return err("provider_unavailable");
      const start = operation.page.cursor ? Number(operation.page.cursor) : 0;
      const slice = items.slice(start, start + operation.page.limit);
      const next = start + slice.length;
      return ok(
        {
          items: slice,
          nextCursor: next < items.length ? String(next) : null,
          snapshot: "snap-1",
        },
        CURRENT,
      );
    });
    const remote = provider(transport);
    const context = ctx({ forceRefresh: true, cacheEpoch: "epoch-7" });
    const listed = await listProviderItems(remote, context, "vault-1");
    expect(listed.map((entry) => entry.externalItemId)).toEqual(items.map((i) => i.externalItemId));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.request.operation).toMatchObject({
      op: "list_items",
      externalVaultId: "vault-1",
      page: { limit: 100 },
      forceRefresh: true,
      cacheEpoch: "epoch-7",
    });
    expect(seen[1]!.request.operation).toMatchObject({
      page: { limit: 100, cursor: "100", snapshot: "snap-1" },
    });
    expect(context.freshness).toHaveLength(2);
    // Compatibility method uses the same bounded collector.
    const compat = ctx();
    expect(await remote.listItems(compat, "vault-1")).toHaveLength(150);
    expect(compat.freshness).toHaveLength(2);
  });

  test("stale, looping, duplicate or oversized inventories are incomplete, never truncated", async () => {
    const scenarios: Record<string, Handler> = {
      stale: () =>
        ok({ items: [item("a")], nextCursor: null, snapshot: "s" }, { ...CURRENT, state: "stale" }),
      loop: () => ok({ items: [item(crypto.randomUUID())], nextCursor: "same", snapshot: "s" }),
      duplicate: (request) =>
        ok({
          items: [item("a")],
          nextCursor:
            request.operation.op === "list_items" && request.operation.page.cursor ? null : "2",
          snapshot: "s",
        }),
      snapshotChange: (request) =>
        ok({
          items: [item(crypto.randomUUID())],
          nextCursor:
            request.operation.op === "list_items" && request.operation.page.cursor ? null : "2",
          snapshot: crypto.randomUUID(),
        }),
    };
    for (const [name, handler] of Object.entries(scenarios)) {
      const { transport } = fakeReceiver(handler);
      expect(`${name}:${await errorCode(provider(transport).listItems(ctx(), "v"))}`).toBe(
        `${name}:provider_inventory_incomplete`,
      );
    }
    const oversizedPage = fakeReceiver(() =>
      ok({ items: [item("a"), item("b")], nextCursor: null, snapshot: null }),
    );
    expect(
      await errorCode(provider(oversizedPage.transport).listItemPage(ctx(), "v", { limit: 1 })),
    ).toBe("provider_inventory_incomplete");
  });

  test("metadata with values or unknown fields is rejected outright", async () => {
    const leaky = fakeReceiver(() =>
      ok({
        items: [
          item("a", {
            fields: [
              { externalFieldId: "p", name: "password", kind: "concealed", value: "hunter2" },
            ],
          }),
        ],
        nextCursor: null,
        snapshot: null,
      }),
    );
    expect(await errorCode(provider(leaky.transport).listItemPage(ctx(), "v", { limit: 10 }))).toBe(
      "provider_unavailable",
    );
    const vaultOps = fakeReceiver(() =>
      ok({
        items: [
          {
            externalVaultId: "personal",
            name: "My vault",
            contentVersion: null,
            itemCount: 3,
            writeAccess: "read_write",
            operations: WRITE_OPS,
          },
        ],
        nextCursor: null,
        snapshot: null,
      }),
    );
    const page = await provider(vaultOps.transport).listVaultPage(ctx(), { limit: 10 });
    expect(page.items[0]!.operations?.createVault).toBe(false);
    expect(page.items[0]!.operations?.writeFiles).toBe(false);
  });
});

describe("remote vault values", () => {
  test("returns exactly the requested fields as secret material", async () => {
    const { transport, seen } = fakeReceiver(() =>
      ok({
        fields: [
          { externalFieldId: "totp", value: { type: "totp", value: "JBSWY3DPEHPK3PXP" } },
          { externalFieldId: "password", value: { type: "text", value: "hunter2" } },
          { externalFieldId: "file", value: { type: "bytes", base64: btoa("abc") } },
        ],
      }),
    );
    const values = await provider(transport).readFields(ctx(), "v", "i", [
      "password",
      "totp",
      "file",
    ]);
    expect(values.map((value) => value.externalFieldId)).toEqual(["password", "totp", "file"]);
    expect(values[0]!.material).toEqual({ type: "text", value: "hunter2" });
    expect(values[1]!.material.type).toBe("totp");
    expect(values[2]!.material).toEqual({ type: "bytes", value: new TextEncoder().encode("abc") });
    expect(seen[0]!.request.operation).toMatchObject({
      op: "read_fields",
      externalFieldIds: ["password", "totp", "file"],
      forceRefresh: false,
      cacheEpoch: null,
    });
  });

  test("refuses unrequested, missing, malformed or duplicate values", async () => {
    const responses = [
      [{ externalFieldId: "other", value: { type: "text", value: "x" } }],
      [],
      [{ externalFieldId: "password", value: { type: "totp", value: "not base32!" } }],
      [
        { externalFieldId: "password", value: { type: "text", value: "x" } },
        { externalFieldId: "password", value: { type: "text", value: "y" } },
      ],
    ];
    for (const fields of responses) {
      const { transport } = fakeReceiver(() => ok({ fields }));
      expect(await errorCode(provider(transport).readFields(ctx(), "v", "i", ["password"]))).toBe(
        "provider_unavailable",
      );
    }
    expect(
      await provider(fakeReceiver(() => ok({})).transport).readFields(ctx(), "v", "i", []),
    ).toEqual([]);
  });
});

describe("remote vault mutations", () => {
  const write = {
    externalItemId: "item-1",
    expectedVersion: "v1",
    name: "Deploy",
    type: "login" as const,
    websites: ["https://example.com"],
    fields: [
      { externalFieldId: "password", name: "password", kind: "concealed" as const, value: "new" },
      { externalFieldId: "old", name: "old", kind: "text" as const, remove: true as const },
    ],
  };

  test("read-only by default: writes are refused locally without a request", async () => {
    const { transport, seen } = fakeReceiver(() => ok({ item: item("item-1") }));
    const remote = provider(transport);
    expect(await errorCode(remote.writeItem(ctx(), "v", write))).toBe("provider_permission_denied");
    expect(await errorCode(remote.archiveItem(ctx(), "v", "item-1"))).toBe(
      "provider_permission_denied",
    );
    const readOnlyVault = provider(transport, {
      operations: { ...WRITE_OPS, updateItem: false },
    });
    expect(await errorCode(readOnlyVault.writeItem(ctx(), "v", write))).toBe(
      "provider_permission_denied",
    );
    expect(
      await errorCode(
        provider(transport, { operations: WRITE_OPS }).writeItem(ctx(), "v", {
          ...write,
          fields: [{ name: "file", kind: "file", value: "x" }],
        }),
      ),
    ).toBe("provider_permission_denied");
    expect(seen).toHaveLength(0);
  });

  test("sends one signed write with the caller idempotency key and never retries", async () => {
    let calls = 0;
    const { transport, seen } = fakeReceiver(() => {
      calls += 1;
      return ok({ item: item("item-1", { version: "v2" }) }, CURRENT);
    });
    const remote = provider(transport, { operations: WRITE_OPS });
    const context = ctx({ idempotencyKey: "op-123" });
    const saved = await remote.writeItem(context, "vault-1", write);
    expect(saved.version).toBe("v2");
    expect(calls).toBe(1);
    expect(context.budget.used()).toBe(1);
    expect(seen[0]!.request.operation).toEqual({
      op: "write_item",
      externalVaultId: "vault-1",
      idempotencyKey: "op-123",
      item: write,
    });
    expect(context.freshness).toHaveLength(1);

    const failing: RemoteVaultTransport = {
      async post() {
        calls += 1;
        throw new Error("socket hang up");
      },
    };
    calls = 0;
    expect(
      await errorCode(provider(failing, { operations: WRITE_OPS }).writeItem(ctx(), "v", write)),
    ).toBe("provider_outcome_unknown");
    expect(calls).toBe(1);
  });

  test("a confirmed update naming another item is an unknown outcome", async () => {
    const { transport } = fakeReceiver(() => ok({ item: item("item-2") }));
    expect(
      await errorCode(provider(transport, { operations: WRITE_OPS }).writeItem(ctx(), "v", write)),
    ).toBe("provider_outcome_unknown");
  });

  test("refresh is an explicit admin call returning receiver freshness", async () => {
    const { transport, seen } = fakeReceiver(() => ok({ refreshed: true }, CURRENT));
    const context = ctx();
    const freshness = await provider(transport).refresh(context);
    expect(freshness).toEqual({ ...CURRENT, lastCheckedAt: new Date(NOW).toISOString() });
    expect(seen[0]!.request.operation).toEqual({ op: "refresh" });
    expect(context.budget.used()).toBe(1);
  });
});

describe("fetch transport adapter", () => {
  const request = (extra: Partial<RemoteVaultHttpRequest> = {}): RemoteVaultHttpRequest => ({
    url: "https://vault.example.com",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    timeoutMs: 1_000,
    maxResponseBytes: 10,
    ...extra,
  });

  test("refuses redirects and oversized bodies, and passes manual redirect mode", async () => {
    let init: Record<string, unknown> | undefined;
    const redirecting = createFetchRemoteVaultTransport(async (_url, given) => {
      init = given as never;
      return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    });
    const error = await redirecting.post(request()).catch((caught) => caught);
    expect(error).toBeInstanceOf(RemoteVaultTransportError);
    expect(error.failure).toBe("redirect");
    expect(init?.redirect).toBe("manual");

    const big = createFetchRemoteVaultTransport(async () => new Response("x".repeat(11)));
    expect((await big.post(request()).catch((caught) => caught)).failure).toBe("too_large");

    const small = createFetchRemoteVaultTransport(async () => new Response("0123456789"));
    expect((await small.post(request())).body).toBe("0123456789");
  });

  test("enforces one deadline", async () => {
    const slow = createFetchRemoteVaultTransport(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const started = Date.now();
    const error = await slow.post(request({ timeoutMs: 50 })).catch((caught) => caught);
    expect(error.failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
