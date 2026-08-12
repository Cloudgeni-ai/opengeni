import { describe, expect, test } from "bun:test";

import {
  fetchXaiVerifiedIdentity,
  pollXaiDeviceCode,
  refreshXaiToken,
  requestXaiDeviceCode,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPES,
  XaiSubscriptionReloginRequired,
  xaiAccessTokenExpiry,
  type XaiFetch,
} from "../src";

type Call = { input: string | URL | Request; init?: RequestInit };

function recorder(handler: (call: Call) => Response): { fetch: XaiFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const call = { input, ...(init ? { init } : {}) };
      calls.push(call);
      return handler(call);
    },
  };
}

describe("xAI OAuth device flow", () => {
  test("starts RFC 8628 flow with the public client and complete scope set", async () => {
    const { fetch, calls } = recorder(() =>
      Response.json({
        device_code: "device-1",
        user_code: "ABCD-1234",
        verification_uri: "https://x.ai/device",
        verification_uri_complete: "https://x.ai/device?user_code=ABCD-1234",
        expires_in: 600,
        interval: 5,
      }),
    );
    const result = await requestXaiDeviceCode({ fetch });
    expect(result).toEqual({
      deviceCode: "device-1",
      userCode: "ABCD-1234",
      verificationUri: "https://x.ai/device",
      verificationUriComplete: "https://x.ai/device?user_code=ABCD-1234",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(form.get("scope")).toBe(XAI_OAUTH_SCOPES.join(" "));
    expect(form.get("referrer")).toBe("opengeni");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("normalizes pending and slow_down without hiding the required interval", async () => {
    const pending = await pollXaiDeviceCode(
      { deviceCode: "device", intervalSeconds: 5 },
      { fetch: async () => Response.json({ error: "authorization_pending" }, { status: 400 }) },
    );
    expect(pending).toEqual({ status: "pending", intervalSeconds: 5 });

    let captured: RequestInit | undefined;
    const slow = await pollXaiDeviceCode(
      { deviceCode: "device", intervalSeconds: 5 },
      {
        fetch: async (_input, init) => {
          captured = init;
          return Response.json({ error: "slow_down" }, { status: 400 });
        },
      },
    );
    expect(slow).toEqual({ status: "slow_down", intervalSeconds: 10 });
    const form = new URLSearchParams(String(captured?.body));
    expect(form.get("grant_type")).toBe(XAI_DEVICE_CODE_GRANT_TYPE);
    expect(form.get("device_code")).toBe("device");
  });

  test("requires a refresh token on initial authorization", async () => {
    await expect(
      pollXaiDeviceCode(
        { deviceCode: "device", intervalSeconds: 5 },
        { fetch: async () => Response.json({ access_token: "access", expires_in: 3600 }) },
      ),
    ).rejects.toThrow("refresh_token");
  });
});

describe("xAI refresh and identity", () => {
  test("uses form-encoded rotating refresh and preserves the old refresh when omitted", async () => {
    let captured: RequestInit | undefined;
    const result = await refreshXaiToken("refresh-old", {
      fetch: async (_input, init) => {
        captured = init;
        return Response.json({ access_token: "access-new", expires_in: 7200 });
      },
    });
    const form = new URLSearchParams(String(captured?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-old");
    expect(result.refreshToken).toBe("refresh-old");
    expect(result.expiresInSeconds).toBe(7200);
  });

  test("invalid_grant requires reconnect", async () => {
    await expect(
      refreshXaiToken("dead", {
        fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      }),
    ).rejects.toBeInstanceOf(XaiSubscriptionReloginRequired);
  });

  test("verifies account identity through the provider userinfo endpoint", async () => {
    let authorization: string | null = null;
    const identity = await fetchXaiVerifiedIdentity("access", {
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({
          sub: "user-123",
          email: "jane@example.com",
          email_verified: true,
          name: "Jane",
        });
      },
    });
    expect(String(authorization)).toBe("Bearer access");
    expect(identity).toEqual({
      subject: "user-123",
      email: "jane@example.com",
      emailVerified: true,
      name: "Jane",
    });
  });

  test("decodes access-token exp only for refresh scheduling", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url");
    expect(xaiAccessTokenExpiry(`header.${payload}.sig`)?.getTime()).toBe(1_900_000_000_000);
    expect(xaiAccessTokenExpiry("opaque")).toBeNull();
  });
});
