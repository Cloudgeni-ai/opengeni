import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getSettings, landingOriginEntries } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";

import { createApp } from "../src/app";
import {
  DISPLAY_IDENTITY_PATH,
  registerManagedAuthSessionSetRoutes,
} from "../src/routes/managed-auth-session-sets";

const LANDING = "https://www.opengeni.test";
const OTHER = "https://evil.example";
const APP_ORIGIN = "https://app.opengeni.test";

const signedInBody = {
  session: { id: "session-id", userId: "user-id", ipAddress: "203.0.113.9", token: "secret" },
  user: {
    id: "user-id",
    email: "person@example.com",
    name: "Ada Lovelace",
    image: "https://images.example/ada.png",
    emailVerified: true,
  },
};

function legacyRouteApp(handler: (request: Request) => Promise<Response>) {
  const app = new Hono();
  registerManagedAuthSessionSetRoutes(app, {
    settings: { managedAuthSessionSetMode: "legacy" },
    managedAuth: {
      // Better Auth answers by path; anything but get-session is its 404.
      handler: async (request: Request) =>
        new URL(request.url).pathname === "/v1/auth/get-session"
          ? await handler(request)
          : new Response(null, { status: 404 }),
    },
    db: {},
  } as never);
  return app;
}

describe("GET /v1/auth/display-identity", () => {
  test("signed out reads as signedIn false", async () => {
    const app = legacyRouteApp(async () => Response.json(null));
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("signed in exposes only the display name and image", async () => {
    let seenCookie: string | null = null;
    const app = legacyRouteApp(async (request) => {
      seenCookie = request.headers.get("cookie");
      const response = Response.json(signedInBody);
      response.headers.append("set-cookie", "session=refreshed; Path=/; HttpOnly");
      return response;
    });
    const response = await app.request(DISPLAY_IDENTITY_PATH, {
      headers: { cookie: "session=abc" },
    });
    expect(seenCookie as string | null).toBe("session=abc");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      signedIn: true,
      name: "Ada Lovelace",
      image: "https://images.example/ada.png",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // A session refresh from the read still reaches the browser.
    expect(response.headers.getSetCookie()).toEqual(["session=refreshed; Path=/; HttpOnly"]);
  });

  test("drops a non-https image and a blank name", async () => {
    const app = legacyRouteApp(async () =>
      Response.json({
        ...signedInBody,
        user: { ...signedInBody.user, name: "  ", image: "javascript:alert(1)" },
      }),
    );
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(await response.json()).toEqual({ signedIn: true, name: null, image: null });
  });

  test("an account the deployment refuses reads as signed out", async () => {
    const app = new Hono();
    registerManagedAuthSessionSetRoutes(app, {
      settings: { managedAuthSessionSetMode: "legacy", allowedUserEmails: ["staff@example.com"] },
      managedAuth: {
        $context: Promise.resolve({ authCookies: { sessionToken: { name: "session" } } }),
        api: {
          getSession: async () => {
            const { HTTPException } = await import("hono/http-exception");
            throw new HTTPException(403, { message: "Account is not permitted" });
          },
        },
        handler: async () => {
          throw new Error("must not bypass admission");
        },
      },
      db: { execute: async () => [{ valid: true }] },
    } as never);
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
  });

  function sessionSetApp(mode: "dual" | "broker", ambient: unknown) {
    const app = new Hono();
    registerManagedAuthSessionSetRoutes(app, {
      settings: {
        managedAuthSessionSetMode: mode,
        productAccessMode: "managed",
        betterAuthSecret: "test-signing-secret-test-signing-secret",
      },
      managedAuth: {},
      managedAuthSessionAdapter: {
        resolveAmbientSession: async () => ambient,
        createLegacySelectedSessionCookies: async () => ["legacy_selected=; Path=/; Max-Age=0"],
      },
      db: { execute: async () => [{ result: null }] },
    } as never);
    return app;
  }

  test("dual mode resolves the ambient session like get-session", async () => {
    const app = sessionSetApp("dual", signedInBody);
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(await response.json()).toEqual({
      signedIn: true,
      name: "Ada Lovelace",
      image: "https://images.example/ada.png",
    });
    expect(response.headers.get("x-opengeni-actor-epoch")).toBeNull();
  });

  test("broker mode without a session set reads as signed out", async () => {
    const app = sessionSetApp("broker", signedInBody);
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(await response.json()).toEqual({ signedIn: false });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(["legacy_selected=; Path=/; Max-Age=0"]);
  });

  test("no managed authentication reads as signed out", async () => {
    const app = new Hono();
    registerManagedAuthSessionSetRoutes(app, {
      settings: { managedAuthSessionSetMode: "legacy" },
      managedAuth: null,
    } as never);
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(await response.json()).toEqual({ signedIn: false });
  });

  test("an unexpected failure is not reported as signed out", async () => {
    const app = legacyRouteApp(async () => {
      throw new Error("database down");
    });
    const response = await app.request(DISPLAY_IDENTITY_PATH);
    expect(response.status).toBe(500);
  });
});

function expectVaryOriginOnce(response: Response) {
  const tokens = (response.headers.get("vary") ?? "").split(",").map((token) => token.trim());
  expect(tokens.filter((token) => token.toLowerCase() === "origin")).toHaveLength(1);
}

function fullApp(landingOrigins: string | undefined) {
  const settings = testSettings({
    authRequired: true,
    productAccessMode: "configured",
    accessKey: "display-identity-test-key",
    corsAllowOriginRegex: "https://app[.]opengeni[.]test",
    landingOrigins,
  });
  const observability = createObservability(settings, { component: "api" });
  observability.info = () => undefined;
  observability.warn = () => undefined;
  observability.error = () => undefined;
  return createApp({
    settings,
    observability,
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
}

describe("display-identity CORS", () => {
  const app = fullApp(`${LANDING}, https://opengeni.test`);

  test("a configured landing origin gets credentialed CORS", async () => {
    const response = await app.request(DISPLAY_IDENTITY_PATH, { headers: { origin: LANDING } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: false });
    expect(response.headers.get("access-control-allow-origin")).toBe(LANDING);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expectVaryOriginOnce(response);
  });

  test("the landing preflight allows GET only", async () => {
    const response = await app.request(DISPLAY_IDENTITY_PATH, {
      method: "OPTIONS",
      headers: { origin: LANDING, "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(LANDING);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET");
  });

  test("other origins never get credentialed CORS on this path", async () => {
    const response = await app.request(DISPLAY_IDENTITY_PATH, { headers: { origin: OTHER } });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expectVaryOriginOnce(response);
  });

  test("the app's own credentialed origins keep their CORS here", async () => {
    const response = await app.request(DISPLAY_IDENTITY_PATH, {
      headers: { origin: APP_ORIGIN },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expectVaryOriginOnce(response);
  });

  test("a landing origin gets nothing extra on any other API path", async () => {
    for (const path of ["/healthz", "/v1/auth/get-session", "/v1/workspaces"]) {
      for (const method of ["GET", "OPTIONS"]) {
        const response = await app.request(path, {
          method,
          headers: { origin: LANDING, "access-control-request-method": "GET" },
        });
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      }
    }
  });

  test("an empty setting disables the landing grant", async () => {
    const disabled = fullApp(undefined);
    const response = await disabled.request(DISPLAY_IDENTITY_PATH, {
      headers: { origin: LANDING },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("OPENGENI_LANDING_ORIGINS", () => {
  test("parses exact origins", () => {
    expect(landingOriginEntries(" https://opengeni.ai, https://www.opengeni.ai ")).toEqual([
      "https://opengeni.ai",
      "https://www.opengeni.ai",
    ]);
    expect(landingOriginEntries(undefined)).toEqual([]);
    expect(getSettings({ OPENGENI_LANDING_ORIGINS: "https://opengeni.ai" }).landingOrigins).toBe(
      "https://opengeni.ai",
    );
  });

  for (const value of ["https://*.opengeni.ai", "https://opengeni.ai/path", "opengeni.ai", "*"]) {
    test(`rejects ${value}`, () => {
      expect(() => getSettings({ OPENGENI_LANDING_ORIGINS: value })).toThrow(
        "OPENGENI_LANDING_ORIGINS",
      );
    });
  }
});
