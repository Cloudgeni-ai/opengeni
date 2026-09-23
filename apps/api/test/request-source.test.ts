import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import {
  apiRequestBindingsForTransportPeer,
  trustedRequestSourceAddress,
} from "../src/http/request-source";
import { TokenBucket, registerEnrollmentRoutes } from "../src/routes/enrollments";
import {
  PublicSetupRateLimiter,
  registerManagedOnboardingRoutes,
} from "../src/routes/managed-onboarding";

describe("trusted request source address", () => {
  test("uses the server-owned peer and ignores forwarded headers by default", async () => {
    const app = new Hono();
    app.get("/source", (context) => context.text(trustedRequestSourceAddress(context, 0)));

    const response = await app.request(
      "/source",
      {
        headers: {
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "198.51.100.8",
        },
      },
      apiRequestBindingsForTransportPeer("10.0.0.10"),
    );

    expect(await response.text()).toBe("10.0.0.10");
  });

  test("selects from the trusted side so prepended caller values cannot rotate the source", async () => {
    const app = new Hono();
    app.get("/source", (context) => context.text(trustedRequestSourceAddress(context, 1)));

    const request = async (forwardedFor: string) =>
      app.request(
        "/source",
        { headers: { "x-forwarded-for": forwardedFor, "x-real-ip": "192.0.2.9" } },
        apiRequestBindingsForTransportPeer("10.0.0.10"),
      );

    expect(await (await request("203.0.113.7, 198.51.100.42")).text()).toBe("198.51.100.42");
    expect(await (await request("192.0.2.99, 198.51.100.42")).text()).toBe("198.51.100.42");
  });

  test("selects the configured proxy hop from the right across multiple trusted hops", async () => {
    const app = new Hono();
    app.get("/source", (context) => context.text(trustedRequestSourceAddress(context, 2)));

    const request = async (forwardedFor: string) =>
      app.request(
        "/source",
        { headers: { "x-forwarded-for": forwardedFor } },
        apiRequestBindingsForTransportPeer("10.0.0.10"),
      );

    expect(await (await request("203.0.113.7, 198.51.100.42, 192.0.2.12")).text()).toBe(
      "198.51.100.42",
    );
    expect(await (await request("192.0.2.99, 203.0.113.7, 198.51.100.42, 192.0.2.12")).text()).toBe(
      "198.51.100.42",
    );
  });

  test("falls back to the transport peer when the trusted chain is missing, short, or malformed", async () => {
    const app = new Hono();
    app.get("/source", (context) => context.text(trustedRequestSourceAddress(context, 2)));

    const request = async (forwardedFor?: string) =>
      app.request(
        "/source",
        { headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} },
        apiRequestBindingsForTransportPeer("10.0.0.10"),
      );

    expect(await (await request()).text()).toBe("10.0.0.10");
    expect(await (await request("203.0.113.7")).text()).toBe("10.0.0.10");
    expect(await (await request("203.0.113.7, not-an-ip, 198.51.100.42")).text()).toBe("10.0.0.10");
    expect(await (await request("203.0.113.7,,198.51.100.42")).text()).toBe("10.0.0.10");
  });

  test("managed setup rate limits cannot be split by spoofed forwarding headers", async () => {
    const app = new Hono();
    registerManagedOnboardingRoutes(
      app,
      {
        settings: testSettings({ productAccessMode: "managed", apiTrustedProxyHops: 0 }),
        db: {} as never,
        managedAuth: {} as never,
      } as never,
      {
        accountSetupLimiter: new PublicSetupRateLimiter({
          globalCapacity: 10,
          globalRefillPerSecond: 0,
          clientCapacity: 1,
          clientRefillPerSecond: 0,
          now: () => 0,
        }),
      },
    );

    const request = (forwardedFor: string, realIp: string) =>
      app.request("/v1/auth/organization-setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": forwardedFor,
          "x-real-ip": realIp,
        },
        body: "{malformed json",
      });

    expect((await request("203.0.113.7", "198.51.100.8")).status).toBe(422);
    expect((await request("192.0.2.99", "192.0.2.100")).status).toBe(429);
  });
});

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
