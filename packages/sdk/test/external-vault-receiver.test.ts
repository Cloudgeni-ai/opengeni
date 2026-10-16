import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SIGNATURE_HEADER,
  signOpenGeniPayload,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import {
  ExternalVaultReceiverError,
  VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER,
  createExternalVaultReceiver,
  createInMemoryExternalVaultReceiverStore,
  safeExternalVaultName,
  uniqueExternalVaultFieldName,
  vaultProviderWireResponseKey,
  type ExternalVaultReceiverHandlers,
  type ExternalVaultReceiverOptions,
  type VaultProviderWireOperation,
} from "../src/external-vault-receiver";

const SECRET = "receiver-secret-".padEnd(40, "x");
const OLD_SECRET = "previous-secret-".padEnd(40, "y");
const CONNECTION = "6f1c3c1e-2b1a-4c55-9d1e-0a0b0c0d0e0f";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const AUTHORITY = {
  accountId: "acct_1",
  workspaceId: "ws_1",
  subjectId: "user_1",
  connectionWorkspaceId: "ws_owner",
};
const OPS = {
  createItemTypes: ["login", "note"],
  updateItem: true,
  removeField: true,
  archiveItem: true,
  archiveKind: "trash",
  deleteItem: false,
  restoreItem: false,
  readFiles: false,
  writeFiles: false,
  createTotp: true,
  updateTotp: true,
  createVault: false,
  restoreFieldHistory: false,
} as const;

const meta = (id: string) => ({
  externalItemId: id,
  name: `Item ${id}`,
  type: "login" as const,
  websites: [],
  fields: [{ externalFieldId: "password", name: "password", kind: "concealed" as const }],
  version: "1",
  updatedAt: null,
});

async function signedRequest(
  operation: VaultProviderWireOperation,
  extra: Record<string, unknown> = {},
  secret = SECRET,
) {
  const body = JSON.stringify({
    version: "opengeni.vault.v1",
    type: "request",
    requestId: crypto.randomUUID(),
    sentAt: new Date(NOW).toISOString(),
    provider: "external",
    connectionId: CONNECTION,
    authority: AUTHORITY,
    operation,
    ...extra,
  });
  return {
    body,
    headers: {
      [OPENGENI_SIGNATURE_HEADER]: await signOpenGeniPayload(secret, body, Math.floor(NOW / 1000)),
    },
  };
}

type Calls = { authorize: unknown[]; handlers: Record<string, unknown[]> };

type Handlers = ExternalVaultReceiverHandlers<{ tenant: string }, { userId: string }>;

function receiver(
  overrides: Partial<ExternalVaultReceiverOptions<{ tenant: string }, { userId: string }>> = {},
  handlerOverrides: Partial<Handlers> = {},
  omitHandlers: ReadonlyArray<"refresh" | "writeItem" | "archiveItem"> = [],
) {
  const calls: Calls = { authorize: [], handlers: {} };
  const record = (name: string, args: unknown[]) => {
    (calls.handlers[name] ??= []).push(args);
  };
  const store = createInMemoryExternalVaultReceiverStore({ now: () => NOW });
  const handlers: ExternalVaultReceiverHandlers<{ tenant: string }, { userId: string }> = {
    async describe(...args) {
      record("describe", args);
      return {
        result: {
          accountId: "host-account",
          accountName: "Host vaults",
          operations: { ...OPS, createItemTypes: ["login", "note"] },
          capabilities: { totp: true, files: false },
          inventoryScope: "connection",
        },
      };
    },
    async listVaults(...args) {
      record("listVaults", args);
      return { result: { items: [], nextCursor: null, snapshot: null } };
    },
    async listItems(...args) {
      record("listItems", args);
      return {
        result: {
          items: [
            {
              ...meta("a"),
              // Values and unknown keys must never leave the receiver.
              fields: [
                {
                  externalFieldId: "password",
                  name: "password",
                  kind: "concealed",
                  value: "hunter2",
                } as never,
              ],
              notes: "hunter2",
            } as never,
          ],
          nextCursor: null,
          snapshot: "s1",
        },
        freshness: {
          state: "current",
          sourceSyncedAt: new Date(NOW).toISOString(),
          source: "live",
          errorCode: null,
          retryAt: null,
        },
      };
    },
    async readFields(...args) {
      record("readFields", args);
      return {
        result: {
          fields: [{ externalFieldId: "password", value: { type: "text", value: "hunter2" } }],
        },
      };
    },
    async writeItem(...args) {
      record("writeItem", args);
      return { result: { item: meta("created") } };
    },
    async archiveItem(...args) {
      record("archiveItem", args);
      return { result: { archived: true } };
    },
    ...handlerOverrides,
  };
  for (const name of omitHandlers) delete handlers[name];
  const instance = createExternalVaultReceiver<{ tenant: string }, { userId: string }>({
    async resolveConnection(connectionId) {
      if (connectionId !== CONNECTION) return null;
      return {
        provider: "external",
        signingSecrets: [SECRET, OLD_SECRET],
        accountId: "acct_1",
        connectionWorkspaceId: "ws_owner",
        context: { tenant: "tenant-9" },
      };
    },
    async authorize(input) {
      calls.authorize.push(input);
      return input.authority.subjectId === "user_1" ? { userId: "host-user-1" } : null;
    },
    handlers,
    store,
    now: () => NOW,
    ...overrides,
  });
  return { instance, calls, store };
}

async function json(response: { body: string }) {
  return JSON.parse(response.body);
}

describe("external vault receiver authentication", () => {
  test("unsigned, mis-signed, unknown, stale and oversized requests get unsigned refusals", async () => {
    const { instance, calls } = receiver();
    const good = await signedRequest({ op: "describe" });
    const cases = [
      { body: good.body, headers: {} },
      { body: good.body, headers: { [OPENGENI_SIGNATURE_HEADER]: "t=1,v1=00" } },
      { body: `${good.body} `, headers: good.headers },
      await signedRequest({ op: "describe" }, { connectionId: crypto.randomUUID() }),
      await signedRequest({ op: "describe" }, {}, "wrong-secret".padEnd(40, "z")),
      await signedRequest({ op: "describe" }, { sentAt: new Date(NOW - 3_600_000).toISOString() }),
    ];
    for (const request of cases) {
      const response = await instance.handle(request);
      expect(response.status).toBe(401);
      expect(response.headers[VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER]).toBeUndefined();
      expect(await json(response)).toEqual({ error: "unauthorized" });
    }
    const huge = await instance.handle({ body: "x".repeat(4 * 1024 * 1024 + 1), headers: {} });
    expect(huge.status).toBe(413);
    expect(calls.authorize).toHaveLength(0);
    expect(calls.handlers).toEqual({});
  });

  test("signs responses with the derived response key of the secret that verified", async () => {
    const { instance } = receiver();
    for (const secret of [SECRET, OLD_SECRET]) {
      const request = await signedRequest({ op: "describe" }, {}, secret);
      const response = await instance.handle(request);
      expect(response.status).toBe(200);
      const signature = response.headers[VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER];
      const verify = (key: string) =>
        verifyOpenGeniSignature({
          secret: key,
          body: response.body,
          signature,
          nowSeconds: Math.floor(NOW / 1000),
        });
      expect(await verify(vaultProviderWireResponseKey(secret))).toBe(true);
      // Never valid as a request signature.
      expect(await verify(secret)).toBe(false);
      const body = await json(response);
      expect(body).toMatchObject({
        ok: true,
        op: "describe",
        requestId: JSON.parse(request.body).requestId,
      });
    }
  });

  test("replayed request ids are refused even with a valid signature", async () => {
    const { instance, calls } = receiver();
    const request = await signedRequest({ op: "describe" });
    expect((await instance.handle(request)).status).toBe(200);
    expect((await instance.handle(request)).status).toBe(409);
    expect(calls.handlers.describe).toHaveLength(1);
  });
});

describe("external vault receiver authorization", () => {
  test("native bindings and the host mapping are checked on every operation", async () => {
    const { instance, calls } = receiver();
    const denied = [
      await signedRequest({ op: "describe" }, { provider: "bitwarden" }),
      await signedRequest({ op: "describe" }, { authority: { ...AUTHORITY, accountId: "acct_2" } }),
      await signedRequest(
        { op: "describe" },
        { authority: { ...AUTHORITY, connectionWorkspaceId: "other" } },
      ),
      await signedRequest({ op: "describe" }, { authority: { ...AUTHORITY, subjectId: "user_2" } }),
    ];
    for (const request of denied) {
      const response = await instance.handle(request);
      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({
        ok: false,
        error: { code: "provider_permission_denied", retryAfterMs: null },
      });
    }
    expect(calls.handlers).toEqual({});
    // Only the last case reached the host mapping (bindings fail first).
    expect(calls.authorize).toHaveLength(1);
    const read = await signedRequest({
      op: "read_fields",
      externalVaultId: "v",
      externalItemId: "i",
      externalFieldIds: ["password"],
      forceRefresh: false,
      cacheEpoch: null,
    });
    expect((await json(await instance.handle(read))).ok).toBe(true);
    expect(calls.authorize.at(-1)).toMatchObject({
      connectionId: CONNECTION,
      connection: { tenant: "tenant-9" },
      authority: AUTHORITY,
      operation: { op: "read_fields", externalVaultId: "v", externalItemId: "i" },
    });
    const [readCtx] = calls.handlers.readFields![0] as [Record<string, unknown>];
    expect(readCtx.principal).toEqual({ userId: "host-user-1" });
  });

  test("inventory handlers get the connection scope, not the acting principal", async () => {
    const { instance, calls } = receiver();
    const response = await instance.handle(
      await signedRequest({
        op: "list_items",
        externalVaultId: "v",
        page: { limit: 10 },
        forceRefresh: true,
        cacheEpoch: "e1",
      }),
    );
    const [ctx, input] = calls.handlers.listItems![0] as [Record<string, unknown>, unknown];
    expect(ctx).not.toHaveProperty("principal");
    expect(ctx.connection).toEqual({ tenant: "tenant-9" });
    expect(input).toEqual({
      externalVaultId: "v",
      page: { limit: 10 },
      forceRefresh: true,
      cacheEpoch: "e1",
    });
    // Metadata projection strips values and unknown keys before signing.
    expect(response.body).not.toContain("hunter2");
    const body = await json(response);
    expect(body.result.items[0].fields[0]).toEqual({
      externalFieldId: "password",
      name: "password",
      kind: "concealed",
    });
    expect(body.freshness.state).toBe("current");
  });
});

describe("external vault receiver outputs", () => {
  const read = (ids: string[]) =>
    signedRequest({
      op: "read_fields",
      externalVaultId: "v",
      externalItemId: "i",
      externalFieldIds: ids,
      forceRefresh: false,
      cacheEpoch: null,
    });

  test("reads return only requested fields; missing fields are not found", async () => {
    const { instance } = receiver();
    const extra = await json(await instance.handle(await read(["username"])));
    expect(extra).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
    expect(JSON.stringify(extra)).not.toContain("hunter2");
    const missing = receiver(
      {},
      {
        async readFields() {
          return { result: { fields: [] } };
        },
      },
    );
    expect(await json(await missing.instance.handle(await read(["password"])))).toMatchObject({
      ok: false,
      error: { code: "provider_not_found" },
    });
  });

  test("handler errors are safe codes; thrown text and unknown errors never leak", async () => {
    const freshness = {
      state: "unavailable" as const,
      sourceSyncedAt: null,
      source: "cache" as const,
      errorCode: "provider_locked" as const,
      retryAt: null,
    };
    const errors: unknown[] = [];
    const { instance } = receiver(
      { onError: (event) => errors.push(event) },
      {
        async readFields() {
          throw new ExternalVaultReceiverError("provider_locked", {
            retryAfterMs: 2_000,
            freshness,
            message: "vault locked for alice@example.com",
          });
        },
        async listVaults() {
          throw new Error("db password=hunter2");
        },
      },
    );
    const locked = await instance.handle(await read(["password"]));
    expect(locked.body).not.toContain("alice");
    expect(await json(locked)).toMatchObject({
      ok: false,
      error: { code: "provider_locked", retryAfterMs: 2_000 },
      freshness,
    });
    const crashed = await instance.handle(
      await signedRequest({
        op: "list_vaults",
        page: { limit: 5 },
        forceRefresh: false,
        cacheEpoch: null,
      }),
    );
    expect(crashed.body).not.toContain("hunter2");
    expect((await json(crashed)).error.code).toBe("provider_unavailable");
    expect(errors).toHaveLength(1);

    const malformed = receiver(
      {},
      {
        async readFields() {
          throw new ExternalVaultReceiverError("provider_locked", {
            freshness: { ...freshness, state: "secret: hunter2" } as never,
          });
        },
      },
    );
    const dropped = await malformed.instance.handle(await read(["password"]));
    expect(dropped.body).not.toContain("hunter2");
    expect(await json(dropped)).toMatchObject({ ok: false, freshness: null });
  });

  test("pages larger than requested are refused", async () => {
    const { instance } = receiver(
      {},
      {
        async listItems() {
          return { result: { items: [meta("a"), meta("b")], nextCursor: null, snapshot: null } };
        },
      },
    );
    const response = await instance.handle(
      await signedRequest({
        op: "list_items",
        externalVaultId: "v",
        page: { limit: 1 },
        forceRefresh: false,
        cacheEpoch: null,
      }),
    );
    expect((await json(response)).error.code).toBe("provider_unavailable");
  });
});

describe("external vault receiver mutations", () => {
  const write = (idempotencyKey: string, name = "Deploy") =>
    signedRequest({
      op: "write_item",
      externalVaultId: "v",
      idempotencyKey,
      item: {
        name,
        type: "login",
        websites: [],
        fields: [{ name: "password", kind: "concealed", value: "s3cret" }],
      },
    });

  test("one key applies once; repeats replay the result; a different operation conflicts", async () => {
    const { instance, calls } = receiver();
    const first = await json(await instance.handle(await write("k1")));
    expect(first).toMatchObject({ ok: true, result: { item: { externalItemId: "created" } } });
    const again = await json(await instance.handle(await write("k1")));
    expect(again).toMatchObject({ ok: true, result: { item: { externalItemId: "created" } } });
    expect(calls.handlers.writeItem).toHaveLength(1);
    const changed = await json(await instance.handle(await write("k1", "Other")));
    expect(changed.error.code).toBe("provider_conflict");
    expect(calls.handlers.writeItem).toHaveLength(1);
    const [, input] = calls.handlers.writeItem![0] as [unknown, Record<string, unknown>];
    expect(input.idempotencyKey).toBe("k1");
  });

  test("the same key from another subject is a different operation", async () => {
    const { instance } = receiver({
      async authorize() {
        return { userId: "u" };
      },
    });
    const request = await write("k2");
    expect((await json(await instance.handle(request))).ok).toBe(true);
    const otherSubject = await signedRequest(JSON.parse(request.body).operation, {
      authority: { ...AUTHORITY, subjectId: "user_9" },
    });
    expect((await json(await instance.handle(otherSubject))).error.code).toBe("provider_conflict");
  });

  test("uncertain handler failures stay pending; definite failures release the key", async () => {
    let attempts = 0;
    const { instance } = receiver(
      {},
      {
        async writeItem() {
          attempts += 1;
          throw new Error("upstream timeout after send");
        },
        async archiveItem() {
          attempts += 1;
          throw new ExternalVaultReceiverError("provider_conflict");
        },
      },
    );
    expect((await json(await instance.handle(await write("k3")))).error.code).toBe(
      "provider_outcome_unknown",
    );
    expect((await json(await instance.handle(await write("k3")))).error.code).toBe(
      "provider_outcome_unknown",
    );
    expect(attempts).toBe(1);
    const archive = () =>
      signedRequest({
        op: "archive_item",
        externalVaultId: "v",
        externalItemId: "i",
        idempotencyKey: "k4",
      });
    expect((await json(await instance.handle(await archive()))).error.code).toBe(
      "provider_conflict",
    );
    expect((await json(await instance.handle(await archive()))).error.code).toBe(
      "provider_conflict",
    );
    expect(attempts).toBe(3);
  });

  test("read-only receivers refuse writes; mismatched update ids are unknown outcomes", async () => {
    const readOnly = receiver({}, {}, ["writeItem", "archiveItem"]);
    expect((await json(await readOnly.instance.handle(await write("k5")))).error.code).toBe(
      "provider_permission_denied",
    );
    const wrongId = receiver();
    const update = await signedRequest({
      op: "write_item",
      externalVaultId: "v",
      idempotencyKey: "k6",
      item: {
        externalItemId: "existing",
        expectedVersion: "1",
        name: "Deploy",
        type: "login",
        websites: [],
        fields: [],
      },
    });
    expect((await json(await wrongId.instance.handle(update))).error.code).toBe(
      "provider_outcome_unknown",
    );
  });
});

describe("external vault receiver fetch adapter and helpers", () => {
  test("POST only with bounded bodies", async () => {
    const { instance } = receiver();
    expect((await instance.fetch(new Request("https://host/vault"))).status).toBe(405);
    const tooBig = new Request("https://host/vault", {
      method: "POST",
      headers: { "content-length": String(5 * 1024 * 1024) },
      body: "{}",
    });
    expect((await instance.fetch(tooBig)).status).toBe(413);
    const request = await signedRequest({ op: "describe" });
    const response = await instance.fetch(
      new Request("https://host/vault", {
        method: "POST",
        headers: request.headers,
        body: request.body,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get(VAULT_PROVIDER_WIRE_RESPONSE_SIGNATURE_HEADER)).toBeTruthy();
  });

  test("name helpers produce valid unique secret names", () => {
    expect(safeExternalVaultName("  a/b{c}#d\\e\u0001 ")).toBe("a-b-c--d-e-");
    expect(safeExternalVaultName("", "Fallback")).toBe("Fallback");
    expect(safeExternalVaultName("id:abc")).toBe("id-abc");
    expect([...safeExternalVaultName("x".repeat(500))]).toHaveLength(120);
    const taken = new Set<string>();
    expect(uniqueExternalVaultFieldName("Password", taken)).toBe("Password");
    expect(uniqueExternalVaultFieldName("password", taken)).toBe("password (2)");
    expect(uniqueExternalVaultFieldName("OTP", taken)).toBe("otp-code");
  });
});
