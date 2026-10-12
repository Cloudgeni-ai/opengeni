// The SuperGrok adapter on the shared subscription core (design 5.3,
// SuperGrok track X1a): codec, refresh and relogin classification against a
// scripted OAuth upstream. No network: the global fetch is denied for the
// whole file and every upstream call goes to the scripted fetch.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { refreshXaiToken, XaiSubscriptionReloginRequired } from "@opengeni/xai-subscription";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  decodeSubscriptionCoreXaiCredential,
  encodeSubscriptionCoreXaiCredential,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
  subscriptionCoreXaiProvider,
} from "../src/subscription-core-xai-adapter";
import { buildSubscriptionCoreXaiTokenResolver } from "../src/subscription-core-xai";
import type { Database } from "../src/database";
import * as turnsModule from "../src/subscription-core/turns";
import type { Settings } from "@opengeni/config";

const realFetch = globalThis.fetch;
const denied: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    denied.push(String(input instanceof Request ? input.url : input));
    throw new Error("network access is denied in this suite");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(denied).toEqual([]);
});

function jwt(expSeconds: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds, sub: "subject-1" })}.sig`;
}

/** A scripted OAuth token endpoint; each call consumes the next reply. */
function scriptedTokenEndpoint(replies: Array<() => Response | Promise<Response>>) {
  const bodies: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = replies.shift();
    if (!next) throw new Error("unexpected token call");
    return await next();
  };
  return {
    bodies,
    refresh: (refreshToken: string) =>
      refreshXaiToken(refreshToken, { fetch, tokenUrl: "https://auth.invalid/oauth2/token" }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("SuperGrok adapter", () => {
  test("is not registered on the core before its cutover", () => {
    expect(subscriptionCoreProviderIds()).not.toContain("xai");
    expect(SUBSCRIPTION_CORE_XAI.adapter.provider).toBe("xai");
    expect(SUBSCRIPTION_CORE_XAI.settings.primaryColumn).toBe("xai_primary_connection_id");
    expect(SUBSCRIPTION_CORE_XAI.adapter.credential.format(null as never)).toBe(
      SUBSCRIPTION_CORE_XAI_CREDENTIAL_FORMAT,
    );
  });

  test("declares the one-hour prompt-cache cut-off placement honours (D-30)", () => {
    expect(SUBSCRIPTION_CORE_XAI.adapter.cacheFacts).toEqual({
      kind: "measured_idle_cutoff",
      cutoffMs: 60 * 60 * 1000,
    });
  });

  test("round-trips the legacy v1 plaintext and drops unused legacy fields", () => {
    const plaintext = JSON.stringify({
      version: 1,
      accessToken: "access",
      refreshToken: "refresh",
      sessionToken: "unused",
      cookie: "unused",
    });
    const decoded = decodeSubscriptionCoreXaiCredential(plaintext);
    expect(decoded).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(JSON.parse(encodeSubscriptionCoreXaiCredential(decoded))).toEqual({
      version: 1,
      accessToken: "access",
      refreshToken: "refresh",
    });
    expect(
      decodeSubscriptionCoreXaiCredential(JSON.stringify({ version: 1, accessToken: "a" })),
    ).toEqual({ accessToken: "a", refreshToken: null });
  });

  test.each([
    "not json secret-value",
    JSON.stringify({ version: 2, accessToken: "a" }),
    JSON.stringify({ version: 1, accessToken: "" }),
    JSON.stringify({ version: 1, refreshToken: "r" }),
    JSON.stringify({ version: 1, accessToken: "a", refreshToken: 7 }),
    "null",
  ])("rejects malformed plaintext %# with a fixed text that never echoes it", (plaintext) => {
    let error: unknown;
    try {
      decodeSubscriptionCoreXaiCredential(plaintext);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret-value");
    expect((error as Error).cause).toBeUndefined();
  });

  test("refresh rotates through the scripted endpoint and keeps the refresh token when omitted", async () => {
    const exp = Math.floor(Date.now() / 1_000) + 3_600;
    const endpoint = scriptedTokenEndpoint([
      () => json(200, { access_token: jwt(exp), expires_in: 3_600 }),
      () => json(200, { access_token: "opaque", refresh_token: "rotated", expires_in: 120 }),
    ]);
    const adapter = subscriptionCoreXaiProvider({ refresh: endpoint.refresh }).adapter;
    const first = await adapter.refresh!.rotate({ accessToken: "old", refreshToken: "keep" });
    expect(first.credential).toEqual({ accessToken: jwt(exp), refreshToken: "keep" });
    expect(first.expiresAt).toEqual(new Date(exp * 1_000));
    expect(first.planType).toBeNull();
    const before = Date.now();
    const second = await adapter.refresh!.rotate({ accessToken: "old", refreshToken: "keep" });
    expect(second.credential).toEqual({ accessToken: "opaque", refreshToken: "rotated" });
    // An opaque token falls back to the endpoint's expires_in.
    expect(second.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(endpoint.bodies.every((body) => body.includes("refresh_token=keep"))).toBe(true);
  });

  test("a credential without a refresh token needs a new sign-in and calls nothing", async () => {
    const endpoint = scriptedTokenEndpoint([]);
    const adapter = subscriptionCoreXaiProvider({ refresh: endpoint.refresh }).adapter;
    const error = await adapter
      .refresh!.rotate({ accessToken: "a", refreshToken: null })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XaiSubscriptionReloginRequired);
    expect(adapter.refresh!.reloginMessage(error)).toContain("Reconnect");
    expect(endpoint.bodies).toEqual([]);
  });

  test("an invalid grant is a relogin; a server error or malformed reply is not", async () => {
    const endpoint = scriptedTokenEndpoint([
      () => json(400, { error: "invalid_grant" }),
      () => json(503, { error: "unavailable" }),
      () => json(200, { expires_in: 60 }),
      () => new Response("not json", { status: 200 }),
    ]);
    const adapter = subscriptionCoreXaiProvider({ refresh: endpoint.refresh }).adapter;
    const tokens = { accessToken: "a", refreshToken: "r" };
    const relogin = await adapter.refresh!.rotate(tokens).catch((caught: unknown) => caught);
    expect(adapter.refresh!.reloginMessage(relogin)).not.toBeNull();
    for (let index = 0; index < 3; index++) {
      const transient = await adapter.refresh!.rotate(tokens).catch((caught: unknown) => caught);
      expect(transient).toBeInstanceOf(Error);
      expect(adapter.refresh!.reloginMessage(transient)).toBeNull();
    }
  });

  test("an upstream that never answers is bounded by the transport's own deadline", async () => {
    const adapter = subscriptionCoreXaiProvider({
      refresh: (refreshToken) =>
        refreshXaiToken(refreshToken, {
          tokenUrl: "https://auth.invalid/oauth2/token",
          timeoutMs: 50,
          fetch: (_input, init) =>
            new Promise((_resolve, reject) =>
              init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
            ),
        }),
    }).adapter;
    const error = await adapter
      .refresh!.rotate({ accessToken: "a", refreshToken: "r" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(adapter.refresh!.reloginMessage(error)).toBeNull();
  });
});

describe("SuperGrok bearer resolver on the core", () => {
  const exp = Math.floor(Date.now() / 1_000) + 3_600;
  function resolverWith(loaded: Partial<turnsModule.SubscriptionCoreCredential>) {
    const reads: unknown[] = [];
    const runtime = spyOn(turnsModule, "subscriptionCoreTurns").mockReturnValue({
      loadSubscriptionCoreCredential: async (...args: unknown[]) => {
        reads.push(args.slice(2));
        return {
          kind: "loaded",
          credential: {
            connectionId: "connection-1",
            ownership: "shared",
            refreshGeneration: 7,
            credential: { accessToken: jwt(exp), refreshToken: "r" },
            providerAccountId: "subject-1",
            providerState: {},
            planType: null,
            expiresAt: new Date(exp * 1_000),
            lastRefreshAt: null,
            ...loaded,
          },
        };
      },
    } as never);
    const resolver = buildSubscriptionCoreXaiTokenResolver(
      {} as Database,
      {} as Settings,
      identity,
      { connectionId: `connection-${crypto.randomUUID()}`, holderId: "holder-1", generation: 1 },
    );
    return { resolver, reads, restore: () => runtime.mockRestore() };
  }
  const identity = {
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    sessionOwnerSubjectId: "user:owner",
    sessionOwnerMembershipId: null,
    initiatingHumanSubjectId: null,
    acceptedAuthorityV2: null,
  } as never;

  test("reads under the exact accepted turn and lease; userId is the provider account id", async () => {
    const { resolver, reads, restore } = resolverWith({});
    try {
      expect(await resolver.getToken()).toEqual({
        accessToken: jwt(exp),
        userId: "subject-1",
        credentialVersion: 7,
      });
      expect((reads[0] as unknown[])[0]).toBe(identity);
      expect((reads[0] as unknown[])[1]).toMatchObject({ holderId: "holder-1", generation: 1 });
    } finally {
      restore();
    }
  });

  test("a connection without a verified token identity needs a new sign-in", async () => {
    const { resolver, restore } = resolverWith({ providerAccountId: null });
    try {
      await expect(resolver.getToken()).rejects.toBeInstanceOf(XaiSubscriptionReloginRequired);
    } finally {
      restore();
    }
  });
});
