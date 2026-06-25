import { describe, expect, test } from "bun:test";
import {
  Permission,
  RelayTokenPayload,
  type RelayTokenPayload as RelayTokenPayloadType,
  StreamTokenPayload,
  type StreamTokenPayload as StreamTokenPayloadType,
  signRelayToken,
  signStreamToken,
  verifyRelayToken,
  verifyStreamToken,
} from "../src/index";

const SECRET = "test-stream-token-secret";

// Valid v4 UUIDs (version nibble 4, variant nibble 8/9/a/b) — Zod v4 enforces the
// RFC 4122 version+variant bits, so all-1s/2s placeholders are rejected.
const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "44444444-4444-4444-8444-444444444444";

function payload(overrides: Partial<StreamTokenPayloadType> = {}): StreamTokenPayloadType {
  return StreamTokenPayload.parse({
    workspaceId: WORKSPACE_A,
    sessionId: "22222222-2222-4222-8222-222222222222",
    viewerId: "33333333-3333-4333-8333-333333333333",
    leaseEpoch: 7,
    mode: "view",
    port: 6080,
    exp: Math.floor(Date.now() / 1000) + 120,
    ...overrides,
  });
}

describe("StreamTokenPayload sign/verify", () => {
  test("mint -> verify round-trip recovers the exact claims", async () => {
    const claims = payload();
    const token = await signStreamToken(SECRET, claims);
    // Reuses the delegated-token HMAC envelope family but with the ogs_ prefix
    // (NOT ogd_) — the distinct prefix is what keeps the two token planes from
    // being confused at the verify boundary.
    expect(token.startsWith("ogs_")).toBe(true);
    const verified = await verifyStreamToken(SECRET, token);
    expect(verified).toEqual(claims);
  });

  test("verify rejects a token signed with a different secret (bad signature)", async () => {
    const token = await signStreamToken(SECRET, payload());
    expect(await verifyStreamToken("a-different-secret", token)).toBeNull();
  });

  test("verify rejects a tampered payload (signature no longer matches)", async () => {
    const token = await signStreamToken(SECRET, payload());
    const [encoded, signature] = token.slice("ogs_".length).split(".");
    // Flip the workspaceId inside the payload but keep the original signature.
    const tamperedClaims = payload({ workspaceId: WORKSPACE_B });
    const tamperedEncoded = Buffer.from(JSON.stringify(tamperedClaims), "utf8").toString("base64url");
    expect(tamperedEncoded).not.toBe(encoded);
    const tamperedToken = `ogs_${tamperedEncoded}.${signature}`;
    expect(await verifyStreamToken(SECRET, tamperedToken)).toBeNull();
  });

  test("verify rejects an expired token", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signStreamToken(SECRET, payload({ exp: nowSeconds - 1 }));
    // exp < now -> null. (And it still verifies fine BEFORE expiry.)
    expect(await verifyStreamToken(SECRET, token, nowSeconds)).toBeNull();
    expect(await verifyStreamToken(SECRET, token, nowSeconds - 5)).not.toBeNull();
  });

  test("verify rejects a delegated (ogd_) token and other malformed input", async () => {
    expect(await verifyStreamToken(SECRET, "ogd_abc.def")).toBeNull();
    expect(await verifyStreamToken(SECRET, "not-a-token")).toBeNull();
    expect(await verifyStreamToken(SECRET, "ogs_no-dot")).toBeNull();
    expect(await verifyStreamToken(SECRET, "ogs_.sig")).toBeNull();
  });

  test("the wrong-workspace assertion is the caller's job: verify alone does NOT scope to a workspace", async () => {
    // verifyStreamToken proves authenticity + freshness only. A token minted for
    // workspace A verifies as a valid token; rejecting it on a workspace-B route
    // is the caller comparing claims.workspaceId against the route param. This
    // test pins that contract so the route-level check is never assumed-away.
    const aWorkspace = WORKSPACE_A;
    const bWorkspace = WORKSPACE_B;
    const token = await signStreamToken(SECRET, payload({ workspaceId: aWorkspace }));
    const verified = await verifyStreamToken(SECRET, token);
    expect(verified).not.toBeNull();
    expect(verified?.workspaceId).toBe(aWorkspace);
    // The caller's scope check: claims.workspaceId !== routeWorkspaceId -> reject.
    expect(verified?.workspaceId === bWorkspace).toBe(false);
  });
});

function relayPayload(overrides: Partial<RelayTokenPayloadType> = {}): RelayTokenPayloadType {
  return RelayTokenPayload.parse({
    workspaceId: WORKSPACE_A,
    agentId: "55555555-5555-4555-8555-555555555555",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

describe("RelayTokenPayload sign/verify (the agent producer token, M8b)", () => {
  test("mint -> verify round-trip recovers the exact claims with the ogr_ prefix", async () => {
    const claims = relayPayload();
    const token = await signRelayToken(SECRET, claims);
    // The `ogr_` prefix keeps the producer token distinct from the viewer's `ogs_`
    // token and the `ogd_`/`oge_` planes at the verify boundary.
    expect(token.startsWith("ogr_")).toBe(true);
    expect(await verifyRelayToken(SECRET, token)).toEqual(claims);
  });

  test("the ogr_ and ogs_ planes do NOT cross-verify (prefix discipline)", async () => {
    const relayToken = await signRelayToken(SECRET, relayPayload());
    const streamToken = await signStreamToken(SECRET, payload());
    // A producer token is not a valid viewer token and vice-versa.
    expect(await verifyStreamToken(SECRET, relayToken)).toBeNull();
    expect(await verifyRelayToken(SECRET, streamToken)).toBeNull();
  });

  test("verify rejects a wrong secret + an expired relay token", async () => {
    const token = await signRelayToken(SECRET, relayPayload());
    expect(await verifyRelayToken("other-secret", token)).toBeNull();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await signRelayToken(SECRET, relayPayload({ exp: nowSeconds - 1 }));
    expect(await verifyRelayToken(SECRET, expired, nowSeconds)).toBeNull();
  });
});

describe("sandbox-surfacing permissions", () => {
  test("stream:* + files:write + terminal:attach are in the Permission enum", () => {
    for (const perm of ["stream:view", "stream:control", "stream:acknowledge", "files:write", "terminal:attach"] as const) {
      expect(Permission.options).toContain(perm);
    }
  });

  test("stream:view is a real, distinct permission (NOT an alias of sessions:read)", () => {
    expect(Permission.options).toContain("stream:view");
    expect(Permission.options).toContain("sessions:read");
    expect("stream:view").not.toBe("sessions:read");
  });
});
