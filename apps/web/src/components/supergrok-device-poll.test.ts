import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { pollSuperGrokDeviceLogin } from "./supergrok-device-poll";

describe("SuperGrok device polling", () => {
  test("backs off after retryable API errors and continues to connection", async () => {
    let now = 0;
    const delays: number[] = [];
    const responses = [
      new OpenGeniApiError(502, "", { retryable: true, mutation: true }),
      { status: "pending" as const, intervalSeconds: 5 },
      {
        status: "connected" as const,
        accountId: "account-1",
        scope: "workspace" as const,
        isActive: true,
      },
    ];
    const result = await pollSuperGrokDeviceLogin({
      initialIntervalSeconds: 5,
      expiresAtMs: 60_000,
      signal: new AbortController().signal,
      now: () => now,
      wait: async (delayMs) => {
        delays.push(delayMs);
        now += delayMs;
        return true;
      },
      poll: async () => {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response!;
      },
    });

    expect(result).toEqual({
      status: "connected",
      accountId: "account-1",
      scope: "workspace",
      isActive: true,
    });
    expect(delays).toEqual([5_000, 10_000, 5_000]);
  });

  test("surfaces non-retryable API errors", async () => {
    const error = new OpenGeniApiError(403, JSON.stringify({ message: "forbidden" }), {
      mutation: true,
    });
    await expect(
      pollSuperGrokDeviceLogin({
        initialIntervalSeconds: 1,
        expiresAtMs: 60_000,
        signal: new AbortController().signal,
        now: () => 0,
        wait: async () => true,
        poll: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  test("stops at the provider deadline without another poll", async () => {
    let now = 0;
    let polls = 0;
    const result = await pollSuperGrokDeviceLogin({
      initialIntervalSeconds: 5,
      expiresAtMs: 2_000,
      signal: new AbortController().signal,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
        return true;
      },
      poll: async () => {
        polls += 1;
        return { status: "pending", intervalSeconds: 5 };
      },
    });

    expect(result).toEqual({ status: "expired" });
    expect(polls).toBe(0);
  });
});
