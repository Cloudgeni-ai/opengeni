import { describe, expect, test } from "bun:test";
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexModels,
  fetchCodexRateLimitResetCredits,
  fetchCodexUsage,
  parseCodexRateLimitResetConsumeResponse,
  parseCodexRateLimitResetCreditsDetails,
  parseCodexRateLimitResetCreditsSummary,
} from "../src";

const auth = {
  accessToken: "server-only-token",
  chatgptAccountId: "acct_123",
  isFedramp: false,
  clientVersion: "0.144.1",
};

const detailedFixture = {
  credits: [
    {
      id: "credit-known",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-06-17T00:00:00Z",
      expires_at: "2026-07-17T00:00:00Z",
      title: "Full reset (Weekly + 5 hr)",
      description: "Ready to redeem",
      ignored_provider_field: "tolerant reader",
    },
    {
      id: "credit-future",
      reset_type: "future_scope",
      status: "future_status",
      granted_at: "2026-06-18T00:00:00Z",
      expires_at: null,
    },
  ],
  available_count: 3,
  total_earned_count: 5,
};

describe("Codex v0.144.6 reset-credit schemas", () => {
  test("parses detail rows, preserves nulls, and maps unknown enums fail-closed", () => {
    expect(parseCodexRateLimitResetCreditsDetails(detailedFixture)).toEqual({
      availableCount: 3,
      credits: [
        {
          id: "credit-known",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1781654400,
          expiresAt: 1784246400,
          title: "Full reset (Weekly + 5 hr)",
          description: "Ready to redeem",
        },
        {
          id: "credit-future",
          resetType: "unknown",
          status: "unknown",
          grantedAt: 1781740800,
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    });
  });

  test("rejects malformed timestamps/counts instead of guessing", () => {
    expect(
      parseCodexRateLimitResetCreditsDetails({
        credits: [{ ...detailedFixture.credits[0], granted_at: "yesterday" }],
        available_count: 1,
      }),
    ).toBeNull();
    expect(
      parseCodexRateLimitResetCreditsDetails({
        credits: [],
        available_count: -1,
      }),
    ).toBeNull();
  });

  test("distinguishes absent summary from an authoritative count of zero", () => {
    expect(
      parseCodexRateLimitResetCreditsSummary({
        rate_limit_reset_credits: { available_count: 0 },
      }),
    ).toEqual({ availableCount: 0, credits: null });
    expect(parseCodexRateLimitResetCreditsSummary({ plan_type: "plus" })).toBeNull();
  });

  test("keeps an empty detail list distinct from count-only and preserves a capped count", () => {
    expect(
      parseCodexRateLimitResetCreditsDetails({
        credits: [],
        available_count: 0,
      }),
    ).toEqual({ availableCount: 0, credits: [] });
    const capped = parseCodexRateLimitResetCreditsDetails(detailedFixture);
    expect(capped?.availableCount).toBe(3);
    expect(capped?.credits).toHaveLength(2);
  });

  test.each(["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const)(
    "accepts exact consume outcome %s",
    (code) => {
      const expected = {
        reset: "reset",
        nothing_to_reset: "nothingToReset",
        no_credit: "noCredit",
        already_redeemed: "alreadyRedeemed",
      } as const;
      expect(parseCodexRateLimitResetConsumeResponse({ code, windows_reset: 2 })).toEqual({
        outcome: expected[code],
      });
    },
  );

  test("rejects an unknown fifth consume outcome", () => {
    expect(parseCodexRateLimitResetConsumeResponse({ code: "maybe_reset" })).toBeNull();
  });
});

describe("Codex v0.144.6 reset-credit server calls", () => {
  test("GET uses the exact detailed endpoint and server-only subscription headers", async () => {
    let capture: { url?: string; init?: RequestInit | undefined } = {};
    const result = await fetchCodexRateLimitResetCredits(auth, async (input, init) => {
      capture = { url: String(input), init };
      return new Response(JSON.stringify(detailedFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(capture.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    expect(capture.init?.method).toBe("GET");
    const headers = new Headers(capture.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer server-only-token");
    expect(headers.get("chatgpt-account-id")).toBe("acct_123");
    expect(headers.get("version")).toBe("0.144.1");
    expect(result.ok).toBe(true);
  });

  test("POST sends redeem_request_id + credit_id and accepts only the four outcomes", async () => {
    let capture: { url?: string; init?: RequestInit | undefined } = {};
    const result = await consumeCodexRateLimitResetCredit(
      auth,
      { idempotencyKey: "logical-attempt-1", creditId: "credit-known" },
      async (input, init) => {
        capture = { url: String(input), init };
        return new Response(JSON.stringify({ code: "already_redeemed", windows_reset: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(capture.url).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    );
    expect(capture.init?.method).toBe("POST");
    expect(JSON.parse(String(capture.init?.body))).toEqual({
      redeem_request_id: "logical-attempt-1",
      credit_id: "credit-known",
    });
    expect(result).toEqual({
      ok: true,
      status: 200,
      result: { outcome: "alreadyRedeemed" },
    });
  });

  test("rejects empty logical keys and credit IDs before any provider call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("{}");
    };
    expect(
      await consumeCodexRateLimitResetCredit(
        auth,
        { idempotencyKey: "", creditId: "credit-known" },
        fetchImpl,
      ),
    ).toEqual({ ok: false, status: 0, reason: "invalid_request" });
    expect(
      await consumeCodexRateLimitResetCredit(
        auth,
        { idempotencyKey: "logical-attempt", creditId: "" },
        fetchImpl,
      ),
    ).toEqual({ ok: false, status: 0, reason: "invalid_request" });
    expect(calls).toBe(0);
  });

  test("HTTP and malformed responses return typed failures without exposing bodies", async () => {
    expect(
      await fetchCodexRateLimitResetCredits(
        auth,
        async () => new Response('{"private":"body"}', { status: 503 }),
      ),
    ).toEqual({ ok: false, status: 503, reason: "http_error" });
    expect(
      await consumeCodexRateLimitResetCredit(
        auth,
        { idempotencyKey: "x" },
        async () => new Response('{"code":"future_outcome"}', { status: 200 }),
      ),
    ).toEqual({ ok: false, status: 200, reason: "invalid_response" });
  });

  test("network failures and the v0.144.6 five-second detail timeout are typed", async () => {
    expect(
      await fetchCodexRateLimitResetCredits(auth, async () => {
        throw new Error("offline");
      }),
    ).toEqual({ ok: false, status: 0, reason: "network_error" });

    const waitsForAbort = (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    expect(await fetchCodexRateLimitResetCredits(auth, waitsForAbort, 1)).toEqual({
      ok: false,
      status: 0,
      reason: "timeout",
    });
  });

  test("complete-operation deadlines bound ignored signals and body reads", async () => {
    const neverFetches = async () => await new Promise<Response>(() => undefined);
    expect(await fetchCodexRateLimitResetCredits(auth, neverFetches, 5)).toEqual({
      ok: false,
      status: 0,
      reason: "timeout",
    });
    expect(
      await consumeCodexRateLimitResetCredit(
        auth,
        { idempotencyKey: "bounded-consume", creditId: "credit-known" },
        neverFetches,
        5,
      ),
    ).toEqual({ ok: false, status: 0, reason: "timeout" });
    expect(await fetchCodexModels(auth, neverFetches, 5)).toEqual({
      ok: false,
      status: 0,
      slugs: [],
    });
    await expect(fetchCodexUsage(auth, neverFetches, 5)).rejects.toThrow(
      "Codex usage request timeout",
    );

    const bodyNeverSettles = async () => {
      const response = new Response("{}", { status: 200 });
      response.json = async () => await new Promise<never>(() => undefined);
      return response;
    };
    expect(await fetchCodexRateLimitResetCredits(auth, bodyNeverSettles, 5)).toEqual({
      ok: false,
      status: 0,
      reason: "timeout",
    });
  });
});
