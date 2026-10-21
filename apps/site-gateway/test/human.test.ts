import { describe, expect, test } from "bun:test";
import { gatewayConfig, type GatewayEnv } from "../src/env";
import { parseCookies, readHuman } from "../src/cookies";
import { TURNSTILE_VERIFY_URL, handleHumanCheck } from "../src/human";
import type { SiteContext } from "../src/site-context";
import { TEST_SECRET } from "./helpers";

const HOST = "acme-docs.sites.test";

function context(
  env: Partial<GatewayEnv>,
  init: { body?: string; origin?: string; visitor?: string | null } = {},
): SiteContext {
  const config = gatewayConfig({
    SITES_DOMAIN: "sites.test",
    API_ORIGIN: "https://api.test",
    APP_ORIGIN: "https://app.test",
    GATEWAY_SECRET: TEST_SECRET,
    ...env,
  });
  const request = new Request(`https://${HOST}/_og/human`, {
    method: "POST",
    headers: { origin: init.origin ?? `https://${HOST}`, "content-type": "application/json" },
    body: init.body ?? JSON.stringify({ token: "turnstile-token" }),
  });
  return {
    request,
    url: new URL(request.url),
    env: {},
    config,
    ctx: { waitUntil() {} },
    hostname: HOST,
    siteOrigin: `https://${HOST}`,
    record: {
      v: 1,
      hostname: HOST,
      siteId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      access: "public",
      versionId: "11111111-1111-4111-8111-111111111111",
      title: "Docs",
      noindex: false,
      generation: 1,
      updatedAt: "2026-10-14T00:00:00.000Z",
    },
    cookies: new Map(),
    visitor: init.visitor === undefined ? "visitor-1" : init.visitor,
    session: null,
    clientIp: "203.0.113.5",
    noindex: false,
    hsts: true,
  };
}

const TURNSTILE = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET: "turnstile-secret" };

function siteverify(result: unknown, seen: FormData[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(TURNSTILE_VERIFY_URL);
    seen.push(init?.body as FormData);
    return Response.json(result);
  }) as typeof fetch;
}

describe("optional Turnstile human check", () => {
  test("is absent unless both Turnstile values are configured", async () => {
    const response = await handleHumanCheck(
      context({ TURNSTILE_SITE_KEY: "only-key" }),
      siteverify({ success: true }),
    );
    expect(response.status).toBe(404);
  });

  test("a passing token sets a short-lived human cookie bound to the visitor", async () => {
    const seen: FormData[] = [];
    const response = await handleHumanCheck(
      context(TURNSTILE),
      siteverify({ success: true, hostname: HOST }, seen),
    );
    expect(response.status).toBe(204);
    expect(seen[0]?.get("secret")).toBe("turnstile-secret");
    expect(seen[0]?.get("response")).toBe("turnstile-token");
    expect(seen[0]?.get("remoteip")).toBe("203.0.113.5");
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toStartWith("__Host-og_h=");
    expect(cookie).toContain("Max-Age=3600");
    const cookies = parseCookies(cookie.split(";")[0]!);
    expect(await readHuman(TEST_SECRET, cookies, HOST, "visitor-1")).toBe(true);
    expect(await readHuman(TEST_SECRET, cookies, HOST, "visitor-2")).toBe(false);
    expect(await readHuman(TEST_SECRET, cookies, "other-docs.sites.test", "visitor-1")).toBe(false);
  });

  test("failed, foreign-host, cross-origin and visitor-less checks are refused", async () => {
    expect(
      (await handleHumanCheck(context(TURNSTILE), siteverify({ success: false }))).status,
    ).toBe(403);
    expect(
      (
        await handleHumanCheck(
          context(TURNSTILE),
          siteverify({ success: true, hostname: "evil.test" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleHumanCheck(
          context(TURNSTILE, { origin: "https://evil.test" }),
          siteverify({ success: true }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleHumanCheck(context(TURNSTILE, { visitor: null }), siteverify({ success: true })))
        .status,
    ).toBe(400);
    expect(
      (await handleHumanCheck(context(TURNSTILE, { body: "{}" }), siteverify({ success: true })))
        .status,
    ).toBe(400);
  });
});
