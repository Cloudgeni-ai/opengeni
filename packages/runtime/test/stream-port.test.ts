import { describe, expect, test } from "bun:test";
import {
  buildStreamUrl,
  exposeStreamPort,
  StreamPortUnavailableError,
  verifyStreamToken,
  type ExposedPortEndpoint,
} from "../src/sandbox";

// P4.2 — the pixel DATA PLANE leaf. exposeStreamPort resolves the provider's
// scoped tunnel for port 6080, assembles the direct-to-provider WS URL (the token
// is NOT a query param), and mints the scoped stream token that verifyStreamToken
// accepts. buildStreamUrl mirrors urlForExposedPort (tls scheme, IPv6 brackets,
// provider-query preservation) without the agent-loop barrel.

const SECRET = "p42-stream-port-secret";
const baseInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  viewerId: "33333333-3333-4333-8333-333333333333",
  leaseEpoch: 7,
  streamTokenSecret: SECRET,
};

// A fake session whose resolveExposedPort returns a fixed endpoint (the shape
// every real provider session returns — modal/e2b/daytona/blaxel/runloop).
function fakeSession(endpoint: ExposedPortEndpoint | (() => Promise<ExposedPortEndpoint>)) {
  return {
    resolveExposedPort: async (port: number): Promise<ExposedPortEndpoint> => {
      expect(port).toBe(6080);
      return typeof endpoint === "function" ? await endpoint() : endpoint;
    },
  };
}

describe("buildStreamUrl — provider URL assembly (urlForExposedPort parity)", () => {
  test("Modal raw TLS tunnel -> wss://host:port/ (no provider query)", () => {
    const url = buildStreamUrl({ host: "abc.modal.host", port: 443, tls: true, query: "" });
    // port 443 is the wss default -> elided.
    expect(url).toBe("wss://abc.modal.host/");
  });

  test("non-default port is kept; ws when tls=false", () => {
    expect(buildStreamUrl({ host: "h", port: 6080, tls: false })).toBe("ws://h:6080/");
    expect(buildStreamUrl({ host: "h", port: 6080, tls: true })).toBe("wss://h:6080/");
  });

  test("Blaxel/Daytona provider token query is PRESERVED (it is the provider scope)", () => {
    const url = buildStreamUrl({ host: "h.blaxel.dev", port: 443, tls: true, query: "bl_preview_token=abc123" });
    expect(url).toBe("wss://h.blaxel.dev/?bl_preview_token=abc123");
  });

  test("a bare IPv6 host is bracketed (urlForExposedPort parity)", () => {
    const url = buildStreamUrl({ host: "2001:db8::1", port: 6080, tls: true });
    expect(url).toBe("wss://[2001:db8::1]:6080/");
  });

  test("a malformed endpoint (no host/port) throws StreamPortUnavailableError", () => {
    expect(() => buildStreamUrl({ host: "", port: 6080 } as ExposedPortEndpoint)).toThrow(StreamPortUnavailableError);
    expect(() => buildStreamUrl({ host: "h" } as unknown as ExposedPortEndpoint)).toThrow(StreamPortUnavailableError);
  });
});

describe("exposeStreamPort — coherent {url,token,expiresAt} + the token verifies", () => {
  test("resolves the 6080 tunnel, mints a token verifyStreamToken accepts, NOT a URL query param", async () => {
    const nowSeconds = 1_700_000_000;
    const session = fakeSession({ host: "box-7.modal.host", port: 443, tls: true, query: "" });
    const result = await exposeStreamPort(session, { ...baseInput, nowSeconds, ttlSeconds: 120 });

    // The provider-direct URL — the OpenGeni token is NOT appended.
    expect(result.url).toBe("wss://box-7.modal.host/");
    expect(result.url).not.toContain("token=");
    expect(result.transport).toBe("vnc-ws");
    expect(result.client).toBe("novnc");
    expect(result.leaseEpoch).toBe(7);
    expect(result.resolution).toEqual([1280, 800]);

    // The scoped token verifies + carries the fence claims.
    expect(result.token.startsWith("ogs_")).toBe(true);
    const claims = await verifyStreamToken(SECRET, result.token, nowSeconds);
    expect(claims).not.toBeNull();
    expect(claims?.workspaceId).toBe(baseInput.workspaceId);
    expect(claims?.sessionId).toBe(baseInput.sessionId);
    expect(claims?.viewerId).toBe(baseInput.viewerId);
    expect(claims?.leaseEpoch).toBe(7);
    expect(claims?.port).toBe(6080);
    expect(claims?.mode).toBe("view");

    // expiresAt is now+ttl, ISO.
    expect(result.expiresAt).toBe(new Date((nowSeconds + 120) * 1000).toISOString());
    // The token expires with the same TTL.
    expect(claims?.exp).toBe(nowSeconds + 120);
  });

  test("the minted token is fenced to the epoch (a different epoch token does not share claims)", async () => {
    const a = await exposeStreamPort(fakeSession({ host: "h", port: 443, tls: true }), { ...baseInput, leaseEpoch: 1 });
    const b = await exposeStreamPort(fakeSession({ host: "h", port: 443, tls: true }), { ...baseInput, leaseEpoch: 2 });
    const ca = await verifyStreamToken(SECRET, a.token);
    const cb = await verifyStreamToken(SECRET, b.token);
    expect(ca?.leaseEpoch).toBe(1);
    expect(cb?.leaseEpoch).toBe(2);
  });

  test("a session with no resolveExposedPort throws StreamPortUnavailableError (caller degrades to transport:null)", async () => {
    await expect(exposeStreamPort({}, baseInput)).rejects.toBeInstanceOf(StreamPortUnavailableError);
  });

  test("a provider tunnel-resolution failure surfaces as StreamPortUnavailableError", async () => {
    const session = fakeSession(async () => {
      throw new Error("modal tunnels() timed out");
    });
    await expect(exposeStreamPort(session, baseInput)).rejects.toBeInstanceOf(StreamPortUnavailableError);
  });

  test("a custom resolution is echoed back", async () => {
    const result = await exposeStreamPort(fakeSession({ host: "h", port: 443, tls: true }), {
      ...baseInput,
      resolution: [1920, 1080],
    });
    expect(result.resolution).toEqual([1920, 1080]);
  });
});
