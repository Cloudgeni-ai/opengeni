import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import { apiRequestBindingsForTransportPeer } from "../src/http/request-source";
import { TokenBucket, registerEnrollmentRoutes } from "../src/routes/enrollments";

describe("enrollment rate-limit source and bounded state", () => {
  function enrollmentApp(trustedProxyHops: number): Hono {
    const app = new Hono();
    registerEnrollmentRoutes(app, {
      settings: testSettings({
        sandboxSelfhostedEnabled: true,
        apiTrustedProxyHops: trustedProxyHops,
      }),
      db: {} as never,
    } as never);
    return app;
  }

  function startRequest(app: Hono, peer: string, forwardedFor: string, realIp: string) {
    return app.request(
      "/v1/enrollments/device/start",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
          "x-real-ip": realIp,
        },
        body: "{malformed json",
      },
      apiRequestBindingsForTransportPeer(peer),
    );
  }

  test("repeated requests from one direct peer stay in one bucket despite spoofed headers", async () => {
    const app = enrollmentApp(0);
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        startRequest(app, "10.0.0.10", `203.0.113.${index + 1}`, `198.51.100.${index + 1}`),
      ),
    );

    expect(responses.filter((response) => response.status === 400)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  test("trusted proxy requests share the selected client bucket when callers prepend values", async () => {
    const app = enrollmentApp(2);
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        startRequest(
          app,
          "10.0.0.10",
          `${index % 2 === 0 ? "203.0.113.7" : "192.0.2.99"}, 198.51.100.42, 192.0.2.12`,
          `198.51.100.${index + 1}`,
        ),
      ),
    );

    expect(responses.filter((response) => response.status === 400)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  test("sustained unique sources stay within the storage cap and cannot evict a depleted bucket", () => {
    const limiter = new TokenBucket({ capacity: 1, refillPerSecond: 0 });

    for (let index = 0; index < 20_000; index += 1) {
      expect(limiter.take(`source-${index}`, 0)).toBe(index < 10_000);
    }

    expect(limiter.bucketCount).toBe(10_000);
    expect(limiter.take("source-0", 0)).toBe(false);
    expect(limiter.bucketCount).toBe(10_000);
  });
});

