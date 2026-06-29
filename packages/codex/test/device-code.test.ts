import { describe, expect, test } from "bun:test";
import {
  type CodexFetch,
  CodexDeviceError,
  exchangeDeviceCode,
  pollDeviceCode,
  startDeviceCode,
} from "../src";

type Call = { input: string | URL; init?: RequestInit | undefined };

function recorder(handler: (call: Call) => Response): { fetchImpl: CodexFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: CodexFetch = async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("startDeviceCode", () => {
  test("POSTs JSON {client_id} to deviceauth/usercode and parses a string interval", async () => {
    const { fetchImpl, calls } = recorder(() => json({ device_auth_id: "dev_1", user_code: "WXYZ-1234", interval: "5" }));
    const start = await startDeviceCode(fetchImpl);
    expect(String(calls[0]?.input)).toContain("/api/accounts/deviceauth/usercode");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    expect(start).toEqual({ deviceAuthId: "dev_1", userCode: "WXYZ-1234", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 5 });
  });

  test("404 -> CodexDeviceError(not enabled)", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 404 }));
    await expect(startDeviceCode(fetchImpl)).rejects.toBeInstanceOf(CodexDeviceError);
  });

  test("clamps a missing/zero interval to a safe minimum (no 0-delay poll loop)", async () => {
    for (const interval of [0, "0", undefined, "bad", -3]) {
      const { fetchImpl } = recorder(() => json({ device_auth_id: "d", user_code: "u", interval }));
      expect((await startDeviceCode(fetchImpl)).intervalSeconds).toBe(5);
    }
  });
});

describe("pollDeviceCode", () => {
  test("403 and 404 -> pending", async () => {
    for (const status of [403, 404]) {
      const { fetchImpl } = recorder(() => new Response("", { status }));
      expect(await pollDeviceCode({ deviceAuthId: "d", userCode: "u" }, fetchImpl)).toEqual({ status: "pending" });
    }
  });

  test("200 -> authorized with PKCE pair", async () => {
    const { fetchImpl } = recorder(() => json({ authorization_code: "ac_1", code_verifier: "ver_1" }));
    expect(await pollDeviceCode({ deviceAuthId: "d", userCode: "u" }, fetchImpl)).toEqual({ status: "authorized", authorizationCode: "ac_1", codeVerifier: "ver_1" });
  });

  test("other status -> throws", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 500 }));
    await expect(pollDeviceCode({ deviceAuthId: "d", userCode: "u" }, fetchImpl)).rejects.toBeInstanceOf(CodexDeviceError);
  });
});

describe("exchangeDeviceCode", () => {
  test("form-encodes grant_type=authorization_code with redirect_uri and returns tokens", async () => {
    const { fetchImpl, calls } = recorder(() => json({ id_token: "id", access_token: "ac", refresh_token: "rf" }));
    const tokens = await exchangeDeviceCode({ authorizationCode: "ac_1", codeVerifier: "ver_1" }, fetchImpl);
    expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(calls[0]?.init?.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("ac_1");
    expect(form.get("code_verifier")).toBe("ver_1");
    expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(tokens).toEqual({ idToken: "id", accessToken: "ac", refreshToken: "rf" });
  });
});
