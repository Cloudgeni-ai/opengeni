import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AccessGrant,
  BrowserPasskeyCredential,
  type BrowserPasskeyEvent,
  type BrowserPasskeySyncRequest,
  type BrowserPasskeySyncResponse,
  parseSecretReference,
  parseTotpInput,
  referenceKey,
  totpCodeSync,
} from "@opengeni/contracts";
// F1 stub resolver; apps/api gains the @opengeni/vaults dependency with F2.
import { createStaticSecretResolver } from "../../../packages/vaults/src/testing/static-resolver";
import { ApiHttpError } from "../src/http/api-error";
import {
  attemptSecretPrincipal,
  collectStringsDeep,
  type InteractionPasskeyStore,
  type InteractionSecretsPort,
  resetPasskeySessionCacheForTests,
  releaseBrowserPasskeys,
  resolveInteractionSecretValues,
  syncBrowserPasskeys,
} from "../src/interaction-secrets";

const PASSWORD = "Fake-Login-Totp-Password-2";
const SEED = "JBSWY3DPEHPK3PXP";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const BROWSER = "44444444-4444-4444-8444-444444444444";

const agentGrant: AccessGrant = {
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  subjectId: "worker:first-party-mcp",
  permissions: [],
  principalKind: "agent_attempt",
  metadata: {
    sessionId: SESSION,
    turnId: "55555555-5555-4555-8555-555555555555",
    attemptId: "66666666-6666-4666-8666-666666666666",
    executionGeneration: 3,
  },
};
const humanGrant: AccessGrant = {
  accountId: ACCOUNT,
  workspaceId: WORKSPACE,
  subjectId: "user:alice",
  permissions: [],
  principalKind: "human_session",
};

function port(
  values: Record<string, string>,
  options: {
    enabled?: boolean;
    passkeys?: InteractionPasskeyStore | null;
    now?: () => number;
    sleeps?: number[];
  } = {},
): InteractionSecretsPort & { principals: unknown[] } {
  const principals: unknown[] = [];
  let clockMs = options.now?.() ?? Date.parse("2026-10-12T20:00:10.000Z");
  return {
    principals,
    async resolverFor(principal) {
      principals.push(principal);
      return createStaticSecretResolver(values, {
        principal,
        ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      });
    },
    passkeys: options.passkeys ?? null,
    clock: {
      now: () => clockMs,
      sleep: async (ms) => {
        options.sleeps?.push(ms);
        clockMs += ms;
      },
    },
  };
}

const use = { surface: "browser" as const, toolName: "browser_act", operationId: "op" };

async function httpError(promise: Promise<unknown>): Promise<ApiHttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiHttpError) return error;
    throw error;
  }
  throw new Error("expected an ApiHttpError");
}

describe("attemptSecretPrincipal", () => {
  test("takes the attempt principal from the grant metadata", () => {
    expect(attemptSecretPrincipal(agentGrant)).toEqual({
      kind: "attempt",
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      turnId: "55555555-5555-4555-8555-555555555555",
      attemptId: "66666666-6666-4666-8666-666666666666",
      executionGeneration: 3,
    });
  });

  test("human, service and incomplete agent grants have none", () => {
    expect(attemptSecretPrincipal(humanGrant)).toBeNull();
    expect(attemptSecretPrincipal({ ...humanGrant, principalKind: "service" })).toBeNull();
    expect(attemptSecretPrincipal({ ...agentGrant, metadata: { sessionId: SESSION } })).toBeNull();
  });
});

describe("resolveInteractionSecretValues", () => {
  test("agent references resolve to a side map keyed by referenceKey", async () => {
    const secrets = port({ "Fake TOTP/password": PASSWORD });
    const values = await resolveInteractionSecretValues({
      port: secrets,
      grant: agentGrant,
      texts: ["{{secret:Fake TOTP/password}}", "plain"],
      use,
    });
    expect(values).toEqual({
      [referenceKey(parseSecretReference("{{secret:Fake TOTP/password}}"))]: PASSWORD,
    });
    expect(secrets.principals).toEqual([attemptSecretPrincipal(agentGrant)]);
  });

  test("human callers' text is never resolved", async () => {
    const secrets = port({ "Fake TOTP/password": PASSWORD });
    expect(
      await resolveInteractionSecretValues({
        port: secrets,
        grant: humanGrant,
        texts: ["{{secret:Fake TOTP/password}}"],
        use,
      }),
    ).toBeUndefined();
    expect(secrets.principals).toEqual([]);
  });

  test("text without a marker, a missing port or secrets switched off pass through literally", async () => {
    expect(
      await resolveInteractionSecretValues({
        port: port({}),
        grant: agentGrant,
        texts: ["hello"],
        use,
      }),
    ).toBeUndefined();
    expect(
      await resolveInteractionSecretValues({
        port: null,
        grant: agentGrant,
        texts: ["{{secret:X}}"],
        use,
      }),
    ).toBeUndefined();
    expect(
      await resolveInteractionSecretValues({
        port: port({ X: "v" }, { enabled: false }),
        grant: agentGrant,
        texts: ["{{secret:X}}"],
        use,
      }),
    ).toBeUndefined();
  });

  test("an escaped reference yields an empty map so the controller unescapes it", async () => {
    expect(
      await resolveInteractionSecretValues({
        port: port({}),
        grant: agentGrant,
        texts: ["\\{{secret:X}}"],
        use,
      }),
    ).toEqual({});
  });

  test("TOTP codes are computed at dispatch and wait out a closing window", async () => {
    // 20:00:58.5 leaves 1.5 s in the window: the code is taken from the next one.
    const at = Date.parse("2026-10-12T20:00:58.500Z");
    const sleeps: number[] = [];
    const values = await resolveInteractionSecretValues({
      port: port({ "Fake TOTP": SEED }, { now: () => at, sleeps }),
      grant: agentGrant,
      texts: ["{{secret:Fake TOTP/otp}}"],
      use,
    });
    expect(sleeps.length).toBe(1);
    const code = totpCodeSync(parseTotpInput(SEED), at + sleeps[0]!);
    expect(values).toEqual({
      [referenceKey(parseSecretReference("{{secret:Fake TOTP/otp}}"))]: code,
    });
    expect(code).not.toBe(totpCodeSync(parseTotpInput(SEED), at));
  });

  test("failures stop before dispatch with a model-ready payload and no values", async () => {
    const missing = await httpError(
      resolveInteractionSecretValues({
        port: port({ "Fake TOTP/password": PASSWORD }),
        grant: agentGrant,
        texts: ["{{secret:Fake TOTP/password}} {{secret:Unknown Site/password}}"],
        use,
      }),
    );
    expect(missing.status).toBe(422);
    expect(missing.code).toBe("validation_failed");
    const details = missing.details as {
      reason: string;
      secretReference: { error: string; failures: Array<{ code: string }>; askCard: unknown };
    };
    expect(details.reason).toBe("secret_reference_error");
    expect(details.secretReference.error).toBe("secret_reference_error");
    expect(details.secretReference.failures.map((failure) => failure.code)).toEqual(["not_found"]);
    expect(details.secretReference.askCard).not.toBeNull();
    expect(JSON.stringify({ message: missing.message, details })).not.toContain(PASSWORD);

    const invalid = await httpError(
      resolveInteractionSecretValues({
        port: port({}),
        grant: agentGrant,
        texts: ["{{secret:}}"],
        use,
      }),
    );
    expect(
      (invalid.details as { secretReference: { failures: Array<{ code: string }> } })
        .secretReference.failures[0]!.code,
    ).toBe("invalid_reference");

    const file = await httpError(
      resolveInteractionSecretValues({
        port: port({ Key: "x" }),
        grant: agentGrant,
        texts: ["{{secretfile:Key}}"],
        use,
      }),
    );
    expect(
      (file.details as { secretReference: { failures: Array<{ code: string }> } }).secretReference
        .failures[0]!.code,
    ).toBe("secretfile_not_allowed");
  });

  test("native desktop arguments are scanned deeply", () => {
    expect(collectStringsDeep({ text: "a", nested: [{ b: "c" }, 1, null] })).toEqual(["a", "c"]);
  });

  test("a controller guard refuses before any reference is used", async () => {
    const reference = "{".repeat(2) + "secret:Email code/password}}";
    const base = port({ "Email code/password": "424242" });
    const resolved: string[] = [];
    const spied: InteractionSecretsPort = {
      ...base,
      async resolverFor(principal) {
        const resolver = await base.resolverFor(principal);
        if (!resolver) return resolver;
        return {
          ...resolver,
          enabled: resolver.enabled,
          resolve: async (references, context) => {
            resolved.push(...references.map((entry) => entry.raw));
            return await resolver.resolve(references, context);
          },
        };
      },
    };
    const refusal = new ApiHttpError(422, {
      code: "validation_failed",
      message: "controller cannot accept secret values",
    });
    let guardCalls = 0;
    const guard = async () => {
      guardCalls += 1;
      throw refusal;
    };
    const refused = await httpError(
      resolveInteractionSecretValues({
        port: spied,
        grant: agentGrant,
        texts: [reference],
        use,
        beforeResolve: guard,
      }),
    );
    expect(refused).toBe(refusal);
    expect(guardCalls).toBe(1);
    expect(resolved).toEqual([]);

    // Literal text and human callers never consult the controller.
    for (const call of [
      { grant: agentGrant, texts: ["no reference here"] },
      { grant: humanGrant, texts: [reference] },
    ]) {
      expect(
        await resolveInteractionSecretValues({ port: spied, use, beforeResolve: guard, ...call }),
      ).toBeUndefined();
    }
    expect(guardCalls).toBe(1);

    // A guard that accepts lets resolution proceed as before.
    const values = await resolveInteractionSecretValues({
      port: spied,
      grant: agentGrant,
      texts: [reference],
      use,
      beforeResolve: async () => undefined,
    });
    expect(Object.values(values ?? {})).toEqual(["424242"]);
  });
});

describe("syncBrowserPasskeys", () => {
  const stored: BrowserPasskeyCredential = {
    itemId: "77777777-7777-4777-8777-777777777777",
    rpId: "localhost",
    credentialId: "Y3JlZC0x",
    userHandle: "dXNlcg==",
    userName: "alice",
    userDisplayName: null,
    privateKey: "cHJpdmF0ZQ==",
    signCount: 4,
  };

  beforeEach(() => resetPasskeySessionCacheForTests());

  function fakeStore() {
    const calls: string[] = [];
    const items: BrowserPasskeyCredential[] = [stored];
    const store: InteractionPasskeyStore = {
      async lease(_principal, holder, ttl) {
        calls.push(`lease:${holder}:${ttl}`);
        return items.map((item) => ({ ...item }));
      },
      async saveRegistered(_principal, input) {
        calls.push(`save:${input.credential.rpId}:${input.origin}`);
        const itemId = "88888888-8888-4888-8888-888888888888";
        items.push({ ...input.credential, itemId });
        return { itemId };
      },
      async updateSignCount(_principal, itemId, signCount) {
        calls.push(`count:${itemId}:${signCount}`);
      },
      async release(holder) {
        calls.push(`release:${holder}`);
      },
    };
    return { store, calls };
  }

  function fakeClient(pending: BrowserPasskeyEvent[]) {
    const requests: BrowserPasskeySyncRequest[] = [];
    return {
      requests,
      async passkeySync(request: BrowserPasskeySyncRequest): Promise<BrowserPasskeySyncResponse> {
        requests.push(structuredClone(request));
        for (const id of request.acknowledgeEventIds) {
          const index = pending.findIndex((event) => event.eventId === id);
          if (index >= 0) pending.splice(index, 1);
        }
        return {
          browserSessionId: BROWSER,
          controllerGeneration: "controller-1",
          authenticators: 1,
          events: [...pending],
        };
      },
    };
  }

  test("device-bound hosted credentials keep the legacy shape without a probe", async () => {
    const { store } = fakeStore();
    store.lease = async () => [{ ...stored, backupEligibility: false, backupState: false }];
    const client = fakeClient([]);
    await syncBrowserPasskeys({
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client,
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]!.credentials).toEqual([stored]);
  });

  for (const supportsBackupFlags of [false, true]) {
    test(`negotiates backup flags without breaking legacy sync (${supportsBackupFlags})`, async () => {
      const legacyCredential = BrowserPasskeyCredential.omit({
        backupEligibility: true,
        backupState: true,
      }).strict();
      const credentials = [
        stored,
        { ...stored, credentialId: "ZmFsc2U=", backupEligibility: false, backupState: false },
        { ...stored, credentialId: "dHJ1ZQ==", backupEligibility: true, backupState: true },
      ];
      // Reproduce the previous rollout regression against the old strict shape.
      expect(legacyCredential.safeParse(credentials[1]).success).toBe(false);
      const { store } = fakeStore();
      store.lease = async () => credentials;
      const client = fakeClient([]);
      const sync = client.passkeySync.bind(client);
      client.passkeySync = async (request) => {
        if (!supportsBackupFlags) {
          for (const credential of request.credentials ?? []) {
            expect(legacyCredential.safeParse(credential).success).toBe(true);
          }
        }
        return {
          ...(await sync(request)),
          ...(supportsBackupFlags ? { supportsBackupFlags: true as const } : {}),
        };
      };
      const input = {
        port: { ...port({}), passkeys: store },
        grant: agentGrant,
        browserSessionId: BROWSER,
        controllerGeneration: "controller-1",
        client,
        refresh: true,
      };
      expect(await syncBrowserPasskeys(input)).toEqual({ saved: 0, asserted: 0 });
      expect(client.requests.map((request) => request.credentials?.length ?? null)).toEqual([
        null,
        3,
      ]);
      const sent = client.requests[1]!.credentials!;
      expect(sent[1]).not.toHaveProperty("backupEligibility");
      expect(sent[1]).not.toHaveProperty("backupState");
      expect(sent[2]).toEqual({
        ...stored,
        credentialId: "dHJ1ZQ==",
        ...(supportsBackupFlags ? { backupEligibility: true, backupState: true } : {}),
      });
      await syncBrowserPasskeys(input);
      expect(client.requests).toHaveLength(3); // cached negotiation survives lease refresh
      await syncBrowserPasskeys({
        ...input,
        grant: {
          ...agentGrant,
          metadata: { ...agentGrant.metadata, attemptId: "77777777-7777-4777-8777-777777777778" },
        },
      });
      expect(client.requests).toHaveLength(4); // and a new attempt, without sharing its lease
      expect(client.requests[3]!.credentials).toEqual(sent);
      await syncBrowserPasskeys({ ...input, controllerGeneration: "controller-2" });
      expect(client.requests).toHaveLength(6);
      expect(client.requests[4]!.credentials).toBeNull();
      await releaseBrowserPasskeys(input.port, BROWSER);
      await syncBrowserPasskeys(input);
      expect(client.requests).toHaveLength(8);
      expect(client.requests[6]!.credentials).toBeNull();
      expect(credentials[2]!.backupEligibility).toBe(true); // never alter vault material
    });
  }

  test("a pending assertion crosses attempts without a destructive capability probe", async () => {
    const { store, calls } = fakeStore();
    store.lease = async () => [{ ...stored, backupEligibility: true, backupState: true }];
    const pending: BrowserPasskeyEvent[] = [];
    const client = fakeClient(pending);
    const sync = client.passkeySync.bind(client);
    client.passkeySync = async (request) => ({
      ...(await sync(request)),
      supportsBackupFlags: true,
    });
    const input = {
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client,
    };
    await syncBrowserPasskeys(input);
    pending.push({
      type: "asserted",
      eventId: "99999999-9999-4999-8999-999999999992",
      occurredAt: "2026-10-29T08:00:00.000Z",
      targetId: "target-1",
      rpId: stored.rpId,
      credentialId: stored.credentialId,
      itemId: stored.itemId,
      signCount: 9,
    });
    const next = {
      ...agentGrant,
      metadata: { ...agentGrant.metadata, attemptId: "77777777-7777-4777-8777-777777777779" },
    };
    expect(await syncBrowserPasskeys({ ...input, grant: next })).toEqual({ saved: 0, asserted: 1 });
    expect(client.requests.map((request) => request.credentials?.length ?? null)).toEqual([
      null,
      1,
      1,
      null,
    ]);
    expect(client.requests[2]!.credentials![0]!.signCount).toBe(4); // stale vault is reconciled by browserd
    expect(calls).toContain(`count:${stored.itemId}:9`);
    expect(pending).toEqual([]);
  });

  test("a failed load after discovery has not cleared the browser's existing credentials", async () => {
    const { store } = fakeStore();
    store.lease = async () => [{ ...stored, backupEligibility: true, backupState: true }];
    let loaded = [{ ...stored, signCount: 9 }];
    let calls = 0;
    const result = await syncBrowserPasskeys({
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client: {
        async passkeySync(request) {
          if (++calls === 2) throw new Error("synthetic load failure before dispatch");
          if (request.credentials !== null) loaded = request.credentials;
          return {
            browserSessionId: BROWSER,
            controllerGeneration: "controller-1",
            authenticators: 1,
            events: [],
            supportsBackupFlags: true,
          };
        },
      },
    });
    expect(result).toBeNull();
    expect(loaded).toEqual([{ ...stored, signCount: 9 }]);
  });

  test("loads leased passkeys, saves registrations and writes sign counts back", async () => {
    const { store, calls } = fakeStore();
    const registered: BrowserPasskeyEvent = {
      type: "registered",
      eventId: "99999999-9999-4999-8999-999999999991",
      occurredAt: "2026-10-12T20:00:00.000Z",
      targetId: "target-1",
      origin: "http://localhost:47420",
      credential: {
        rpId: "localhost",
        credentialId: "bmV3LWNyZWQ=",
        userHandle: "bmV3",
        userName: "new-user",
        userDisplayName: null,
        privateKey: "cHJpdmF0ZTI=",
        signCount: 0,
      },
    };
    const assertedNew: BrowserPasskeyEvent = {
      type: "asserted",
      eventId: "99999999-9999-4999-8999-999999999992",
      occurredAt: "2026-10-12T20:00:01.000Z",
      targetId: "target-1",
      rpId: "localhost",
      credentialId: "bmV3LWNyZWQ=",
      itemId: null,
      signCount: 1,
    };
    const assertedStored: BrowserPasskeyEvent = {
      type: "asserted",
      eventId: "99999999-9999-4999-8999-999999999993",
      occurredAt: "2026-10-12T20:00:02.000Z",
      targetId: "target-2",
      rpId: "localhost",
      credentialId: stored.credentialId,
      itemId: stored.itemId,
      signCount: 5,
    };
    const client = fakeClient([registered, assertedNew, assertedStored]);
    let now = 1_000_000;
    const result = await syncBrowserPasskeys({
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client,
      now: () => now,
    });
    expect(result).toEqual({ saved: 1, asserted: 2 });
    expect(calls).toEqual([
      `lease:${BROWSER}:600`,
      "save:localhost:http://localhost:47420",
      "count:88888888-8888-4888-8888-888888888888:1",
      `count:${stored.itemId}:5`,
      `lease:${BROWSER}:600`,
    ]);
    expect(client.requests[0]!.credentials).toEqual([stored]);
    expect(client.requests[1]!.acknowledgeEventIds).toEqual([
      registered.eventId,
      assertedNew.eventId,
      assertedStored.eventId,
    ]);
    // The refreshed set carries the new item so later assertions write back.
    expect(client.requests[1]!.credentials?.map((credential) => credential.itemId)).toEqual([
      stored.itemId,
      "88888888-8888-4888-8888-888888888888",
    ]);

    // Within a minute the lease is reused (credentials null keeps the set).
    now += 30_000;
    await syncBrowserPasskeys({
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client,
      now: () => now,
    });
    expect(client.requests.at(-1)!.credentials).toBeNull();
    now += 60_000;
    await syncBrowserPasskeys({
      port: { ...port({}), passkeys: store },
      grant: agentGrant,
      browserSessionId: BROWSER,
      controllerGeneration: "controller-1",
      client,
      now: () => now,
    });
    expect(client.requests.at(-1)!.credentials).not.toBeNull();
  });

  test("a refresh before an action leases again even within the renewal minute", async () => {
    const { store, calls } = fakeStore();
    const client = fakeClient([]);
    const now = 2_000_000;
    const sync = (refresh?: boolean) =>
      syncBrowserPasskeys({
        port: { ...port({}), passkeys: store },
        grant: agentGrant,
        browserSessionId: `${BROWSER}-refresh`,
        controllerGeneration: "controller-1",
        client,
        now: () => now,
        ...(refresh === undefined ? {} : { refresh }),
      });
    await sync();
    await sync(false);
    expect(client.requests.at(-1)!.credentials).toBeNull();
    // Another browser may have taken the lease over; this one takes it back
    // and reloads the current credentials before acting.
    await sync(true);
    expect(client.requests.at(-1)!.credentials).toEqual([stored]);
    expect(calls.filter((call) => call.startsWith("lease:"))).toHaveLength(2);
  });

  test("syncs for one browser run in call order, so a write-back need not be awaited", async () => {
    const { store, calls } = fakeStore();
    const assertion: BrowserPasskeyEvent = {
      type: "asserted",
      eventId: "99999999-9999-4999-8999-999999999994",
      occurredAt: "2026-10-12T20:00:03.000Z",
      targetId: "target-1",
      rpId: "localhost",
      credentialId: stored.credentialId,
      itemId: stored.itemId,
      signCount: 7,
    };
    const pending = [assertion];
    const client = fakeClient(pending);
    const order: string[] = [];
    const slow = {
      async passkeySync(request: BrowserPasskeySyncRequest) {
        order.push(`start:${request.credentials === null ? "keep" : "load"}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const response = await client.passkeySync(request);
        order.push("end");
        return response;
      },
    };
    const sync = (refresh: boolean) =>
      syncBrowserPasskeys({
        port: { ...port({}), passkeys: store },
        grant: agentGrant,
        browserSessionId: `${BROWSER}-ordered`,
        controllerGeneration: "controller-1",
        client: slow,
        now: () => 3_000_000,
        refresh,
      });
    // The write-back after one action is left running; the next action's
    // takeover starts immediately but waits for it.
    const writeBack = sync(false);
    const takeover = sync(true);
    expect(await takeover).toEqual({ saved: 0, asserted: 0 });
    expect(await writeBack).toEqual({ saved: 0, asserted: 1 });
    // The assertion was written back once, by the first sync only.
    expect(calls.filter((call) => call.startsWith("count:"))).toEqual([`count:${stored.itemId}:7`]);
    expect(order.slice(0, 4)).toEqual(["start:load", "end", "start:keep", "end"]);
    expect(pending).toEqual([]);
  });

  test("humans never load passkeys and old controllers are skipped quietly", async () => {
    const { store, calls } = fakeStore();
    expect(
      await syncBrowserPasskeys({
        port: { ...port({}), passkeys: store },
        grant: humanGrant,
        browserSessionId: BROWSER,
        controllerGeneration: "controller-1",
        client: fakeClient([]),
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
    let syncs = 0;
    const old = {
      async passkeySync(): Promise<BrowserPasskeySyncResponse> {
        syncs += 1;
        throw Object.assign(new Error("not found"), { status: 404 });
      },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await syncBrowserPasskeys({
          port: { ...port({}), passkeys: store },
          grant: agentGrant,
          browserSessionId: BROWSER,
          controllerGeneration: "controller-1",
          client: old,
        }),
      ).toBeNull();
    }
    expect(syncs).toBe(1);
    expect(calls).toEqual([`lease:${BROWSER}:600`, `release:${BROWSER}`]);
  });
});
