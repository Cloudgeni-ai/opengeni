import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  MANAGED_AUTH_CLIENT_IP_HEADER,
  createManagedAuth,
  requestWithManagedAuthClientAddress,
  resolveManagedAuthClientAddress,
} from "../src/auth/managed-auth";
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

  test("uses the client address appended by the trusted proxy, not caller-prepended values", async () => {
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

describe("managed auth rate-limit source binding", () => {
  const settings = testSettings({
    productAccessMode: "managed",
    publicBaseUrl: "http://127.0.0.1:3000",
    betterAuthSecret: "request-source-test-better-auth-secret",
  });
  const managedAuth = createManagedAuth(settings, {} as never, {
    sender: "test",
    idempotency: { scope: "test", retentionSeconds: 0 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  });

  test("the deployed better-auth config reads only the app-stamped header", () => {
    expect(managedAuth?.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      MANAGED_AUTH_CLIENT_IP_HEADER,
    ]);
    // A caller-stamped header is never consulted on a bare request.
    const forged = new Request("http://localhost/v1/auth/sign-in/email", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(resolveManagedAuthClientAddress(forged, managedAuth!.options)).not.toBe("203.0.113.7");
  });

  test("the stamp overwrites a caller-supplied client-ip header", () => {
    const stamped = requestWithManagedAuthClientAddress(
      new Request("http://localhost/v1/auth/sign-in/email", {
        headers: { [MANAGED_AUTH_CLIENT_IP_HEADER]: "203.0.113.7" },
      }),
      "10.0.0.10",
    );
    expect(stamped.headers.get(MANAGED_AUTH_CLIENT_IP_HEADER)).toBe("10.0.0.10");
  });

  function mountedAuthApp(options: { trustedProxyHops: number; mode: "legacy" | "dual" }) {
    const resolved: (string | null)[] = [];
    const app = createApp({
      settings: testSettings({
        productAccessMode: "managed",
        apiTrustedProxyHops: options.trustedProxyHops,
        managedAuthSessionSetMode: options.mode,
        publicBaseUrl: "http://127.0.0.1:3000",
        betterAuthSecret: "request-source-test-better-auth-secret",
      }),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: {
        handler: async (request: Request) => {
          resolved.push(resolveManagedAuthClientAddress(request, managedAuth!.options));
          // Reads the buffered body so a broken request reconstruction hangs
          // here instead of passing silently.
          await request.text();
          return Response.json({ ok: true });
        },
        api: {},
      } as never,
      managedAuthSessionAdapter: {} as never,
    });
    return { app, resolved };
  }

  function signInRequest(
    app: ReturnType<typeof createApp>,
    peer: string,
    headers: Record<string, string>,
  ) {
    return app.request(
      "/v1/auth/sign-in/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "u@example.test", password: "password1234" }),
      },
      apiRequestBindingsForTransportPeer(peer),
    );
  }

  test("a spoofed x-forwarded-for cannot move the rate-limit key (legacy mount)", async () => {
    const { app, resolved } = mountedAuthApp({ trustedProxyHops: 0, mode: "legacy" });
    for (const forged of ["203.0.113.7", "192.0.2.99", "203.0.113.7, 10.0.0.10"]) {
      const response = await signInRequest(app, "10.0.0.10", {
        "x-forwarded-for": forged,
        "x-real-ip": "198.51.100.8",
        [MANAGED_AUTH_CLIENT_IP_HEADER]: forged,
      });
      expect(response.status).toBe(200);
    }
    expect(resolved).toEqual(["10.0.0.10", "10.0.0.10", "10.0.0.10"]);
  });

  test("the dual-mode provider request is stamped the same way", async () => {
    const { app, resolved } = mountedAuthApp({ trustedProxyHops: 0, mode: "dual" });
    const response = await signInRequest(app, "10.0.0.10", {
      "x-forwarded-for": "203.0.113.7",
      [MANAGED_AUTH_CLIENT_IP_HEADER]: "203.0.113.7",
    });
    expect(response.status).toBe(200);
    expect(resolved).toEqual(["10.0.0.10"]);
  });

  test("trusted proxy hops resolve the proxy-appended client, not prepended values", async () => {
    const { app, resolved } = mountedAuthApp({ trustedProxyHops: 1, mode: "legacy" });
    for (const forged of ["203.0.113.7", "192.0.2.99"]) {
      const response = await signInRequest(app, "10.0.0.10", {
        "x-forwarded-for": `${forged}, 198.51.100.42`,
      });
      expect(response.status).toBe(200);
    }
    expect(resolved).toEqual(["198.51.100.42", "198.51.100.42"]);
  });
});
