import { describe, expect, test } from "bun:test";
import {
  STREAM_TOKEN_DEFAULT_TTL_SECONDS,
  mintStreamToken,
  negotiateCapabilities,
  verifyStreamToken,
} from "../src/sandbox";

const SECRET = "leaf-stream-token-secret";

// Valid v4 UUIDs (Zod v4 enforces the RFC 4122 version+variant bits).
const baseInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  viewerId: "33333333-3333-4333-8333-333333333333",
  leaseEpoch: 3,
};

describe("@opengeni/runtime/sandbox stream-token mint/verify", () => {
  test("mint -> verify round-trip with the default claims (view/6080/120s)", async () => {
    const nowSeconds = 1_000_000;
    const token = await mintStreamToken(SECRET, { ...baseInput, nowSeconds });
    expect(token.startsWith("ogs_")).toBe(true);
    const verified = await verifyStreamToken(SECRET, token, nowSeconds);
    expect(verified).not.toBeNull();
    expect(verified?.mode).toBe("view");
    expect(verified?.port).toBe(6080);
    expect(verified?.leaseEpoch).toBe(3);
    expect(verified?.exp).toBe(nowSeconds + STREAM_TOKEN_DEFAULT_TTL_SECONDS);
  });

  test("verify rejects after the TTL elapses", async () => {
    const nowSeconds = 2_000_000;
    const token = await mintStreamToken(SECRET, { ...baseInput, ttlSeconds: 30, nowSeconds });
    expect(await verifyStreamToken(SECRET, token, nowSeconds + 29)).not.toBeNull();
    expect(await verifyStreamToken(SECRET, token, nowSeconds + 31)).toBeNull();
  });

  test("verify rejects a wrong-secret token (the in-box edge can't be forged)", async () => {
    const token = await mintStreamToken(SECRET, baseInput);
    expect(await verifyStreamToken("other-secret", token)).toBeNull();
  });
});

describe("negotiateCapabilities — desktop graceful degrade (I8/OD-8)", () => {
  // Modal is desktop-capable; when desktop is enabled + warm it normally
  // advertises a vnc-ws transport. The graceful-degrade flag forces transport
  // null when no stream-token secret is resolvable, instead of crashing.
  const warmDesktopCtx = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    backend: "modal" as const,
    os: "linux" as const,
    liveness: "warm" as const,
    leaseEpoch: 1,
    desktopEnabled: true,
  };

  test("secret available -> desktop transport is the provider's vnc-ws", () => {
    const caps = negotiateCapabilities({ ...warmDesktopCtx, streamTokenSecretAvailable: true });
    expect(caps.DesktopStream.transport).toBe("vnc-ws");
    expect(caps.DesktopStream.reason).toBeNull();
  });

  test("secret ABSENT -> graceful degrade: transport null + a typed reason, NOT a throw", () => {
    // The whole point of I8: this returns a value, it does not crash.
    const caps = negotiateCapabilities({ ...warmDesktopCtx, streamTokenSecretAvailable: false });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("disabled_by_policy");
    // The rest of the negotiated doc is still coherent (headless/Channel-A survive).
    expect(caps.FileSystem.available).toBe(true);
  });

  test("unthreaded flag defaults to available (headless/test callers unaffected)", () => {
    const caps = negotiateCapabilities(warmDesktopCtx);
    expect(caps.DesktopStream.transport).toBe("vnc-ws");
  });
});

describe("negotiateCapabilities — the minted pixel cell folds in ONLY behind the gates (P4.2)", () => {
  const minted = {
    url: "wss://box.modal.host/",
    token: "ogs_fake.signature",
    expiresAt: "2026-06-20T00:02:00.000Z",
    resolution: [1280, 800] as [number, number],
  };
  const warmAcked = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    backend: "modal" as const,
    os: "linux" as const,
    liveness: "warm" as const,
    leaseEpoch: 4,
    desktopEnabled: true,
    streamTokenSecretAvailable: true,
    desktopAcknowledged: true,
  };

  test("desktop available + acknowledged -> the live url/token/expiresAt/resolution are handed out", () => {
    const caps = negotiateCapabilities({ ...warmAcked, desktopStream: minted });
    expect(caps.DesktopStream.transport).toBe("vnc-ws");
    expect(caps.DesktopStream.url).toBe(minted.url);
    expect(caps.DesktopStream.token).toBe(minted.token);
    expect(caps.DesktopStream.expiresAt).toBe(minted.expiresAt);
    expect(caps.DesktopStream.resolution).toEqual([1280, 800]);
    expect(caps.DesktopStream.acknowledged).toBe(true);
  });

  test("NOT acknowledged -> the minted cell is DROPPED (no live url leaks before consent)", () => {
    const caps = negotiateCapabilities({ ...warmAcked, desktopAcknowledged: false, desktopStream: minted });
    expect(caps.DesktopStream.url).toBeNull();
    expect(caps.DesktopStream.token).toBeNull();
    expect(caps.DesktopStream.expiresAt).toBeNull();
    expect(caps.DesktopStream.acknowledged).toBe(false);
  });

  test("cold lease -> transport null + lease_cold; a minted cell would never be passed but is dropped if it were", () => {
    const caps = negotiateCapabilities({ ...warmAcked, liveness: "cold", desktopStream: minted });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("lease_cold");
    expect(caps.DesktopStream.url).toBeNull();
  });

  test("degraded (no secret) -> the minted cell is dropped (transport null)", () => {
    const caps = negotiateCapabilities({ ...warmAcked, streamTokenSecretAvailable: false, desktopStream: minted });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.url).toBeNull();
  });
});
