import { describe, expect, test } from "bun:test";
import {
  type CodexFetch,
  accessTokenExpiry,
  CodexRefreshTransient,
  CodexReloginRequired,
  parseIdToken,
  refreshCodexToken,
} from "../src";

function makeJwt(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(payload)}.sig`;
}

function fetchReturning(status: number, body: unknown): CodexFetch {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

describe("refreshCodexToken", () => {
  test("POSTs JSON refresh_token grant and returns only present fields", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl: CodexFetch = async (_input, init) => {
      captured = init;
      return new Response(JSON.stringify({ access_token: "new_ac" }), { status: 200 });
    };
    const result = await refreshCodexToken("rf_1", fetchImpl);
    expect(captured?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(captured?.body as string)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", grant_type: "refresh_token", refresh_token: "rf_1" });
    expect(result).toEqual({ idToken: undefined, accessToken: "new_ac", refreshToken: undefined });
  });

  test.each(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"])(
    "%s -> CodexReloginRequired",
    async (code) => {
      await expect(refreshCodexToken("rf", fetchReturning(400, { error: { code } }))).rejects.toBeInstanceOf(CodexReloginRequired);
    },
  );

  test("bare 401 -> CodexReloginRequired", async () => {
    await expect(refreshCodexToken("rf", fetchReturning(401, { error: "unauthorized" }))).rejects.toBeInstanceOf(CodexReloginRequired);
  });

  test("OAuth invalid_grant (string error body, 400) -> CodexReloginRequired", async () => {
    await expect(refreshCodexToken("rf", fetchReturning(400, { error: "invalid_grant" }))).rejects.toBeInstanceOf(CodexReloginRequired);
  });

  test("nested error.type permanent code -> CodexReloginRequired", async () => {
    await expect(refreshCodexToken("rf", fetchReturning(400, { error: { type: "refresh_token_expired" } }))).rejects.toBeInstanceOf(CodexReloginRequired);
  });

  test("other non-2xx -> CodexRefreshTransient", async () => {
    await expect(refreshCodexToken("rf", fetchReturning(503, "overloaded"))).rejects.toBeInstanceOf(CodexRefreshTransient);
  });
});

describe("parseIdToken", () => {
  test("extracts chatgpt_account_id / plan_type / fedramp from the auth claim", () => {
    const jwt = makeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_1", chatgpt_plan_type: "pro", chatgpt_account_is_fedramp: true },
    });
    expect(parseIdToken(jwt)).toEqual({ chatgptAccountId: "acct_1", planType: "pro", isFedramp: true });
  });

  test("missing claim -> nulls and isFedramp false", () => {
    expect(parseIdToken(makeJwt({}))).toEqual({ chatgptAccountId: null, planType: null, isFedramp: false });
  });
});

describe("accessTokenExpiry", () => {
  test("returns exp*1000 as a Date", () => {
    const exp = 1_900_000_000;
    expect(accessTokenExpiry(makeJwt({ exp }))?.getTime()).toBe(exp * 1000);
  });

  test("null on unparseable token", () => {
    expect(accessTokenExpiry("not-a-jwt")).toBeNull();
  });
});
