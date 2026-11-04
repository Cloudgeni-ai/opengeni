import { describe, expect, test } from "bun:test";
import { siteHostMapKey, type SiteHostMapRecord } from "@opengeni/contracts";
import worker, { unexpectedErrorResponse, type GatewayEnv } from "../src/index";
import { SITE_DB_INTERNAL_PREFIX } from "../src/site-db";
import { TEST_SECRET } from "./helpers";

const HOST = "pub.sites.test";

function env(): GatewayEnv {
  const record: SiteHostMapRecord = {
    v: 1,
    hostname: HOST,
    siteId: "33333333-3333-4333-8333-333333333333",
    status: "active",
    access: "public",
    versionId: "11111111-1111-4111-8111-111111111111",
    title: "Pub",
    noindex: false,
    generation: 1,
    updatedAt: "2026-10-14T00:00:00.000Z",
  };
  return {
    SITES_DOMAIN: "sites.test",
    // Nothing listens here; background usage reports fail quietly.
    API_ORIGIN: "http://127.0.0.1:9",
    APP_ORIGIN: "https://app.test",
    GATEWAY_SECRET: TEST_SECRET,
    ENVIRONMENT: "production",
    PLATFORM_REPORT_INTERVAL_SECONDS: "25",
    HOST_MAP: {
      get: async (key: string) => (key === siteHostMapKey(HOST) ? JSON.stringify(record) : null),
      put: async () => undefined,
    },
  } as GatewayEnv;
}

/** A request whose cookie header throws when read: a stand-in for any bug past host lookup. */
function brokenRequest(path: string, dest: string | null): Request {
  return {
    url: `https://${HOST}${path}`,
    method: "GET",
    headers: {
      get(name: string) {
        if (name === "cookie") throw new TypeError("boom");
        if (name === "sec-fetch-dest") return dest;
        return null;
      },
    },
  } as unknown as Request;
}

describe("unexpected gateway errors", () => {
  test("render a plain Opengeni page instead of Cloudflare's Worker error", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const response = await worker.fetch(brokenRequest("/", "document"), env(), {
        waitUntil: () => undefined,
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain("<h1>Something went wrong</h1>");
      expect(html).not.toContain("boom");
      expect(errors).toHaveLength(1);

      // Inside the Site's frame the page may be framed by its shell.
      const framed = await worker.fetch(
        brokenRequest("/_og/v/11111111-1111-4111-8111-111111111111", "iframe"),
        env(),
        { waitUntil: () => undefined },
      );
      expect(framed.status).toBe(500);
      expect(framed.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(framed.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    } finally {
      console.error = original;
    }
  });

  test("Site API calls and the internal Site database route get a JSON error", async () => {
    for (const path of ["/_og/api/sessions", `${SITE_DB_INTERNAL_PREFIX}/query`]) {
      const response = unexpectedErrorResponse(new Request(`https://${HOST}${path}`), env());
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({
        error: { status: 500, code: "site_gateway_error", retryable: true },
      });
    }
  });
});
