import { describe, expect, test } from "bun:test";
import type { Database, SignupHeedeoEvaluationRecord } from "@opengeni/db";

import {
  evaluateHeedeoSignup,
  heedeoClientConfig,
  heedeoOAuthState,
  heedeoSignupAdmission,
  heedeoSignupRequestFrom,
  heedeoTokenFromOAuthState,
  recordHeedeoSignupAfterCreate,
  runWithHeedeoSignup,
  type HeedeoSettings,
} from "./heedeo-signup";

const settings: HeedeoSettings = {
  heedeoPublishableKey: "pk_test",
  heedeoSecretKey: "sk_test",
  heedeoApiUrl: "https://heedeo.example.test",
  heedeoScriptUrl: "https://heedeo.dev/i.js",
  heedeoTimeoutMs: 1_500,
};
const input = { token: "tok", email: "new@example.test", clientIp: "203.0.113.9", headers: {} };
const flaggedAnswer = {
  flagged: true,
  no_token: false,
  score: 150,
  suggested: "review",
  event_id: "evt_1",
  reasons: [{ code: "repeat_action", text: "free text never stored" }, { code: "many_identities" }],
  visitor: { id: "vis_1" },
};
const cleanAnswer = { ...flaggedAnswer, flagged: false, score: 0, suggested: "allow", reasons: [] };

type Call = { url: string; init: RequestInit };
function fetcher(...responses: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? new Response(null, { status: 500 });
    if (next instanceof Error) throw next;
    return typeof next === "function" ? await next() : next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("Heedeo client", () => {
  test("sends one documented signup event and reads the verdict's codes only", async () => {
    const { fn, calls } = fetcher(Response.json(flaggedAnswer));
    const result = await evaluateHeedeoSignup(
      settings,
      { ...input, oauth: { provider: "github", emailVerified: true } },
      fn,
    );
    expect(result).toMatchObject({
      outcome: "evaluated",
      httpStatus: 200,
      flagged: true,
      noToken: false,
      score: 150,
      band: "review",
      evaluationId: "evt_1",
      visitorId: "vis_1",
      reasonCodes: ["repeat_action", "many_identities"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://heedeo.example.test/v1/evaluations");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test");
    expect(headers["heedeo-version"]).toBe("2026-11-08");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      action: "signup",
      token: "tok",
      email: "new@example.test",
      client_ip: "203.0.113.9",
      evidence: { oauth: { provider: "github", email_verified: true } },
    });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  test("omits a missing token and email", async () => {
    const { fn, calls } = fetcher(Response.json(cleanAnswer));
    await evaluateHeedeoSignup(
      settings,
      { ...input, token: null, email: null, clientIp: null },
      fn,
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("client_ip");
    expect(body).not.toHaveProperty("evidence");
  });

  test("retries a 5xx once with the same request id, then fails open", async () => {
    const retried = fetcher(new Response(null, { status: 503 }), Response.json(cleanAnswer));
    expect(await evaluateHeedeoSignup(settings, input, retried.fn)).toMatchObject({
      outcome: "evaluated",
      flagged: false,
    });
    expect(retried.calls).toHaveLength(2);
    expect(JSON.parse(String(retried.calls[0]!.init.body)).request_id).toBe(
      JSON.parse(String(retried.calls[1]!.init.body)).request_id,
    );
    const down = fetcher(new Response(null, { status: 500 }), new Response(null, { status: 502 }));
    expect(await evaluateHeedeoSignup(settings, input, down.fn)).toMatchObject({
      outcome: "error",
      errorCode: "api_error",
      httpStatus: 502,
      flagged: null,
    });
    expect(down.calls).toHaveLength(2);
  });

  test("never retries a 4xx and names key and rate-limit failures", async () => {
    for (const [status, code] of [
      [400, "api_error"],
      [401, "invalid_key"],
      [403, "invalid_key"],
      [429, "rate_limited"],
    ] as const) {
      const { fn, calls } = fetcher(new Response("{}", { status }));
      expect(await evaluateHeedeoSignup(settings, input, fn)).toMatchObject({
        outcome: "error",
        errorCode: code,
        httpStatus: status,
      });
      expect(calls).toHaveLength(1);
    }
  });

  test("a malformed answer, a network error and a timeout fail open", async () => {
    expect(
      await evaluateHeedeoSignup(settings, input, fetcher(new Response("not json")).fn),
    ).toMatchObject({ outcome: "error", errorCode: "malformed_response" });
    expect(
      await evaluateHeedeoSignup(settings, input, fetcher(Response.json({ score: 1 })).fn),
    ).toMatchObject({ outcome: "error", errorCode: "malformed_response" });
    expect(
      await evaluateHeedeoSignup(settings, input, fetcher(new TypeError("fetch failed")).fn),
    ).toMatchObject({ outcome: "error", errorCode: "network_error" });
    const hanging = (async (_url: string, init: RequestInit) =>
      await new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const started = Date.now();
    expect(
      await evaluateHeedeoSignup({ ...settings, heedeoTimeoutMs: 100 }, input, hanging),
    ).toMatchObject({ outcome: "error", errorCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("request, OAuth state and client config", () => {
  test("forwards Heedeo's header subset and the trusted address, never cookies or authorization", () => {
    const request = new Request("https://app.example.test/v1/auth/sign-up/email?x=1", {
      method: "POST",
      headers: {
        "user-agent": "browser",
        "accept-language": "nb",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "x-forwarded-for": "198.51.100.1",
        "x-opengeni-trusted-client-address": "203.0.113.9",
      },
    });
    const result = heedeoSignupRequestFrom(request, "  token  ");
    expect(result.token).toBe("token");
    expect(result.clientIp).toBe("203.0.113.9");
    expect(result.headers).toMatchObject({
      host: "app.example.test",
      ":method": "POST",
      ":path": "/v1/auth/sign-up/email",
      "user-agent": "browser",
      "accept-language": "nb",
    });
    expect(JSON.stringify(result.headers)).not.toContain("secret");
    expect(result.headers).not.toHaveProperty("x-forwarded-for");
    expect(heedeoSignupRequestFrom(request, 42).token).toBeNull();
    expect(heedeoSignupRequestFrom(request, "x".repeat(5_000)).token).toBeNull();
  });

  test("a social start's token rides OAuth state for its provider until it expires", () => {
    const now = 1_000_000;
    const state = JSON.stringify({ opengeniHeedeo: heedeoOAuthState("google", "tok", now) });
    expect(heedeoTokenFromOAuthState(state, "google", now + 1_000)).toBe("tok");
    expect(heedeoTokenFromOAuthState(state, "github", now + 1_000)).toBeNull();
    expect(heedeoTokenFromOAuthState(state, "google", now + 300_001)).toBeNull();
    expect(heedeoTokenFromOAuthState("not json", "google", now)).toBeNull();
    expect(heedeoTokenFromOAuthState(JSON.stringify({}), "google", now)).toBeNull();
    expect(heedeoOAuthState("google", undefined, now)).toBeUndefined();
  });

  test("the browser gets the script only when the mode is on and both keys are set", () => {
    expect(heedeoClientConfig(settings, "shadow")).toEqual({
      publishableKey: "pk_test",
      scriptUrl: "https://heedeo.dev/i.js",
    });
    expect(heedeoClientConfig(settings, "off")).toBeUndefined();
    expect(
      heedeoClientConfig({ ...settings, heedeoSecretKey: undefined }, "enforce"),
    ).toBeUndefined();
    expect(JSON.stringify(heedeoClientConfig(settings, "enforce"))).not.toContain("sk_test");
  });
});

describe("user-create admission", () => {
  const db = {} as Database;
  function harness(mode: "off" | "shadow" | "enforce", fetch: typeof globalThis.fetch) {
    const records: SignupHeedeoEvaluationRecord[] = [];
    const record = async (_db: Database, value: SignupHeedeoEvaluationRecord) => {
      records.push(value);
    };
    const admit = (providerId = "credential", overrides: Partial<HeedeoSettings> = {}) =>
      heedeoSignupAdmission({
        settings: { ...settings, ...overrides },
        db,
        user: { email: "new@example.test", emailVerified: false },
        providerId,
        fetcher: fetch,
        readMode: async () => mode,
        record,
      });
    return { records, admit, record };
  }
  const attempt = { token: "tok", clientIp: "203.0.113.9", headers: {} };

  test("off sends and records nothing", async () => {
    const { fn, calls } = fetcher(Response.json(flaggedAnswer));
    const { records, admit, record } = harness("off", fn);
    await runWithHeedeoSignup(attempt, async () => {
      expect(await admit()).toBe("allow");
      await recordHeedeoSignupAfterCreate(db, "user-1", undefined, record);
    });
    expect(calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  test("shadow never refuses, even when flagged, and records the verdict against the new user", async () => {
    const { fn } = fetcher(Response.json(flaggedAnswer));
    const { records, admit, record } = harness("shadow", fn);
    await runWithHeedeoSignup(attempt, async () => {
      expect(await admit("google")).toBe("allow");
      expect(records).toHaveLength(0);
      await recordHeedeoSignupAfterCreate(db, "user-1", undefined, record);
      // Once per signup.
      await recordHeedeoSignupAfterCreate(db, "user-1", undefined, record);
    });
    expect(records).toEqual([
      expect.objectContaining({
        userId: "user-1",
        signupMethod: "google",
        mode: "shadow",
        outcome: "evaluated",
        tokenPresent: true,
        flagged: true,
        band: "review",
        reasonCodes: ["repeat_action", "many_identities"],
      }),
    ]);
  });

  test("enforce refuses a flagged signup and records it without a user", async () => {
    const { fn } = fetcher(Response.json(flaggedAnswer));
    const { records, admit } = harness("enforce", fn);
    await runWithHeedeoSignup(attempt, async () => {
      expect(await admit("passkey")).toBe("refuse");
    });
    expect(records).toEqual([
      expect.objectContaining({ userId: null, outcome: "refused", signupMethod: "passkey" }),
    ]);
  });

  test("enforce lets a clean signup through", async () => {
    const { fn } = fetcher(Response.json(cleanAnswer));
    const { admit } = harness("enforce", fn);
    expect(await runWithHeedeoSignup(attempt, admit)).toBe("allow");
  });

  test("a forced Heedeo failure lets the signup through in enforce and records the error", async () => {
    for (const failure of [
      new TypeError("fetch failed"),
      new Response(null, { status: 401 }),
      new Response(null, { status: 429 }),
      new Response("<html>", { status: 200 }),
    ]) {
      const { fn } = fetcher(failure, failure instanceof Response ? failure.clone() : failure);
      const { records, admit, record } = harness("enforce", fn);
      await runWithHeedeoSignup(attempt, async () => {
        expect(await admit()).toBe("allow");
        await recordHeedeoSignupAfterCreate(db, "user-2", undefined, record);
      });
      expect(records).toEqual([
        expect.objectContaining({ userId: "user-2", outcome: "error", flagged: null }),
      ]);
    }
    // Even a failing verdict write and a failing mode read never stop a signup.
    const { fn } = fetcher(Response.json(flaggedAnswer));
    const failing = await heedeoSignupAdmission({
      settings,
      db,
      user: { email: "new@example.test" },
      providerId: "credential",
      fetcher: fn,
      readMode: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(failing).toBe("allow");
    const shadowWriteFails = await runWithHeedeoSignup(attempt, async () => {
      const result = await heedeoSignupAdmission({
        settings,
        db,
        user: { email: "new@example.test" },
        providerId: "credential",
        fetcher: fn,
        readMode: async () => "shadow",
      });
      await recordHeedeoSignupAfterCreate(db, "user-3", undefined, async () => {
        throw new Error("insert failed");
      });
      return result;
    });
    expect(shadowWriteFails).toBe("allow");
  });

  test("missing keys skip the call and record skipped", async () => {
    const { fn, calls } = fetcher(Response.json(flaggedAnswer));
    const { records, admit, record } = harness("enforce", fn);
    await runWithHeedeoSignup(attempt, async () => {
      expect(await admit("credential", { heedeoSecretKey: undefined })).toBe("allow");
      await recordHeedeoSignupAfterCreate(db, "user-4", undefined, record);
    });
    expect(calls).toHaveLength(0);
    expect(records).toEqual([
      expect.objectContaining({ userId: "user-4", outcome: "skipped", errorCode: "missing_keys" }),
    ]);
  });

  test("a passkey placeholder address is never sent", async () => {
    const { fn, calls } = fetcher(Response.json(cleanAnswer));
    await runWithHeedeoSignup(attempt, () =>
      heedeoSignupAdmission({
        settings,
        db,
        user: { email: "passkey-user@passkey.invalid", emailVerified: true },
        providerId: "passkey",
        fetcher: fn,
        readMode: async () => "shadow",
        record: async () => undefined,
      }),
    );
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty("email");
  });
});
