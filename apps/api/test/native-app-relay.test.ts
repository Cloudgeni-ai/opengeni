import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing/settings";
import { apiRequestBindingsForTransportPeer } from "../src/http/request-source";
import { TokenBucket } from "../src/routes/enrollments";
import { nativeAppRelayLimiters, registerNativeAppAuthRoutes } from "../src/routes/native-app-auth";
import {
  createNativeAppRelays,
  NATIVE_APP_RELAY_MAX_ATTEMPTS,
  NATIVE_APP_RELAY_TTL_MS,
  normalizeConfirmationCode,
  type NativeAppRelayStore,
} from "../src/routes/native-app-relay";

// The sign-in relay for apps that can't receive a redirect (Excel on desktop
// Office). Storage is the same single-use verification rows Better Auth keeps;
// this in-memory store takes a row atomically, as consumeVerificationValue does.

function memoryStore(): NativeAppRelayStore & {
  rows: Map<string, { value: string; expiresAt: Date }>;
} {
  const rows = new Map<string, { value: string; expiresAt: Date }>();
  return {
    rows,
    find: async (identifier) => rows.get(identifier) ?? null,
    consume: async (identifier) => {
      const row = rows.get(identifier) ?? null;
      rows.delete(identifier);
      return row;
    },
    create: async ({ identifier, value, expiresAt }) => {
      rows.set(identifier, { value, expiresAt });
    },
    update: async (identifier, { value }) => {
      const row = rows.get(identifier);
      if (row) rows.set(identifier, { ...row, value });
    },
  };
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const ORIGIN = "https://app.opengeni.test";
const CALLBACK = `${ORIGIN}/office/auth-callback.html`;

function relaysAt(start = 1_000_000) {
  const clock = { now: start };
  const store = memoryStore();
  const relays = createNativeAppRelays(store, () => clock.now);
  const minted: string[] = [];
  const mint = async () => {
    const code = `code-${minted.length + 1}`;
    minted.push(code);
    return code;
  };
  return { clock, store, relays, minted, mint };
}

async function newRelay(relays: ReturnType<typeof createNativeAppRelays>, challenge: string) {
  return await relays.create({
    codeChallenge: challenge,
    redirectUri: CALLBACK,
    platform: "office",
    deviceName: "Excel",
  });
}

describe("native app sign-in relay", () => {
  test("hands the approved code out once, only to the verifier, and is then gone", async () => {
    const { relays, mint, minted } = relaysAt();
    const { verifier, challenge } = pkce();
    const relay = await newRelay(relays, challenge);
    expect(relay.relayId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(relay.confirmationCode).toMatch(/^[A-Z0-9]{6}$/u);

    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "pending" });
    expect(await relays.approve(relay.relayId, relay.confirmationCode.toLowerCase(), mint)).toEqual(
      {
        status: "approved",
      },
    );
    expect(await relays.poll(relay.relayId, verifier)).toEqual({
      status: "approved",
      code: "code-1",
    });
    // Single use: neither the poll nor the approval can be replayed.
    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "gone" });
    expect(await relays.approve(relay.relayId, relay.confirmationCode, mint)).toEqual({
      status: "gone",
    });
    expect(minted).toEqual(["code-1"]);
  });

  test("concurrent approvals mint one code", async () => {
    const { relays, mint, minted } = relaysAt();
    const relay = await newRelay(relays, pkce().challenge);
    const results = await Promise.all([
      relays.approve(relay.relayId, relay.confirmationCode, mint),
      relays.approve(relay.relayId, relay.confirmationCode, mint),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["approved", "gone"]);
    expect(minted).toHaveLength(1);
  });

  test("expires: no approval or poll after its lifetime", async () => {
    const { relays, mint, minted, clock } = relaysAt();
    const { verifier, challenge } = pkce();
    const relay = await newRelay(relays, challenge);
    expect(relay.expiresAt.getTime()).toBe(clock.now + NATIVE_APP_RELAY_TTL_MS);
    clock.now += NATIVE_APP_RELAY_TTL_MS;
    expect(await relays.approve(relay.relayId, relay.confirmationCode, mint)).toEqual({
      status: "gone",
    });
    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "gone" });
    expect(minted).toEqual([]);
  });

  test("an approved code expires with its relay", async () => {
    const { relays, mint, clock } = relaysAt();
    const { verifier, challenge } = pkce();
    const relay = await newRelay(relays, challenge);
    await relays.approve(relay.relayId, relay.confirmationCode, mint);
    clock.now += NATIVE_APP_RELAY_TTL_MS + 1;
    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "gone" });
  });

  test("a wrong verifier learns nothing and doesn't use up the code", async () => {
    const { relays, mint } = relaysAt();
    const { verifier, challenge } = pkce();
    const relay = await newRelay(relays, challenge);
    const stranger = pkce().verifier;
    expect(await relays.poll(relay.relayId, stranger)).toEqual({ status: "gone" });
    await relays.approve(relay.relayId, relay.confirmationCode, mint);
    expect(await relays.poll(relay.relayId, stranger)).toEqual({ status: "gone" });
    expect(await relays.poll(relay.relayId, verifier)).toEqual({
      status: "approved",
      code: "code-1",
    });
  });

  test("a mismatched confirmation code mints nothing, and repeated mismatches refuse the relay", async () => {
    const { relays, mint, minted } = relaysAt();
    const { verifier, challenge } = pkce();
    const relay = await newRelay(relays, challenge);
    const wrong = relay.confirmationCode === "AAAAAA" ? "BBBBBB" : "AAAAAA";
    expect(await relays.approve(relay.relayId, wrong, mint)).toEqual({
      status: "mismatch",
      attemptsLeft: NATIVE_APP_RELAY_MAX_ATTEMPTS - 1,
    });
    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "pending" });
    for (let attempt = 2; attempt < NATIVE_APP_RELAY_MAX_ATTEMPTS; attempt += 1) {
      expect((await relays.approve(relay.relayId, wrong, mint)).status).toBe("mismatch");
    }
    expect(await relays.approve(relay.relayId, wrong, mint)).toEqual({ status: "gone" });
    // Refused for good: even the right code no longer approves it.
    expect(await relays.approve(relay.relayId, relay.confirmationCode, mint)).toEqual({
      status: "gone",
    });
    expect(await relays.poll(relay.relayId, verifier)).toEqual({ status: "refused" });
    expect(minted).toEqual([]);
  });

  test("an unknown relay id is gone", async () => {
    const { relays, mint } = relaysAt();
    const id = randomBytes(32).toString("base64url");
    expect(await relays.approve(id, "ABCDEF", mint)).toEqual({ status: "gone" });
    expect(await relays.poll(id, pkce().verifier)).toEqual({ status: "gone" });
  });

  test("keys the relay by a hash of its id", async () => {
    const { relays, store, mint } = relaysAt();
    const relay = await newRelay(relays, pkce().challenge);
    await relays.approve(relay.relayId, relay.confirmationCode, mint);
    const [identifier] = [...store.rows.keys()];
    expect(identifier).not.toContain(relay.relayId);
  });

  test("the typed code ignores case, spaces and dashes", () => {
    expect(normalizeConfirmationCode(" ab3-x7k ")).toBe("AB3X7K");
  });
});

describe("relay routes", () => {
  function routes(limiters = nativeAppRelayLimiters()) {
    const app = new Hono();
    const store = memoryStore();
    registerNativeAppAuthRoutes(
      app,
      {
        settings: testSettings({ publicBaseUrl: ORIGIN, productAccessMode: "managed" }),
        managedAuth: {},
      } as never,
      { relayLimiters: limiters, relayStore: store },
    );
    const post = (path: string, body: unknown, peer = "203.0.113.7") =>
      app.request(
        `/v1/native-app/${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        apiRequestBindingsForTransportPeer(peer),
      );
    return { post, store };
  }

  const relayBody = (challenge: string, redirectUri = CALLBACK) => ({
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    platform: "office",
    deviceName: "Excel",
  });

  test("creates a relay for the deployment's own add-in callback and polls it", async () => {
    const { post } = routes();
    const { verifier, challenge } = pkce();
    const created = await post("relays", relayBody(challenge));
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const relay = (await created.json()) as { relayId: string; confirmationCode: string };
    const poll = await post("relays/poll", { relayId: relay.relayId, codeVerifier: verifier });
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  test("refuses a callback on another address", async () => {
    const { post } = routes();
    const created = await post(
      "relays",
      relayBody(pkce().challenge, "https://evil.test/office/auth-callback.html"),
    );
    expect(created.status).toBe(400);
  });

  test("rate-limits creating and polling relays per source", async () => {
    const { post } = routes({
      create: new TokenBucket({ capacity: 2, refillPerSecond: 0.0001 }),
      poll: new TokenBucket({ capacity: 3, refillPerSecond: 0.0001 }),
      approve: new TokenBucket({ capacity: 1, refillPerSecond: 0.0001 }),
    });
    const { verifier, challenge } = pkce();
    expect((await post("relays", relayBody(challenge))).status).toBe(200);
    expect((await post("relays", relayBody(challenge))).status).toBe(200);
    expect((await post("relays", relayBody(challenge))).status).toBe(429);
    // Another source has its own budget.
    expect((await post("relays", relayBody(challenge), "198.51.100.9")).status).toBe(200);

    const relayId = randomBytes(32).toString("base64url");
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await post("relays/poll", { relayId, codeVerifier: verifier })).status).toBe(200);
    }
    expect((await post("relays/poll", { relayId, codeVerifier: verifier })).status).toBe(429);

    // Approval is limited before it even looks at the browser session.
    await post("relays/approve", { relayId, confirmationCode: "ABCDEF" });
    expect((await post("relays/approve", { relayId, confirmationCode: "ABCDEF" })).status).toBe(
      429,
    );
  });
});
