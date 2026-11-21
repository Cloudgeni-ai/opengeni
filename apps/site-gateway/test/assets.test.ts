import { afterEach, describe, expect, test } from "bun:test";
import { siteHostMapKey, type SiteHostMapRecord } from "@opengeni/contracts";
import worker, { gatewayRoute, type GatewayEnv } from "../src/index";
import { TEST_SECRET, verifyGatewayHeaders } from "./helpers";

const HOST = "split.sites.test";
const SITE = "33333333-3333-4333-8333-333333333333";
const VERSION = "11111111-1111-4111-8111-111111111111";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

function env(status: SiteHostMapRecord["status"] = "active"): GatewayEnv {
  const record: SiteHostMapRecord = {
    v: 1,
    hostname: HOST,
    siteId: SITE,
    status,
    access: "members",
    versionId: VERSION,
    title: "Split",
    noindex: false,
    generation: 1,
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
  return {
    SITES_DOMAIN: "sites.test",
    API_ORIGIN: "https://api.test",
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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function upstream(respond: (request: Request) => Response): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (!request.url.startsWith("https://api.test/v1/site-runtime/")) return new Response(null);
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
  return seen;
}

const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  worker.fetch(new Request(`https://${HOST}${path}`, { method, headers }), env(), {
    waitUntil: () => undefined,
  });

describe("app files", () => {
  test("are fetched from the API, signed, and cached for a year", async () => {
    const seen = upstream(
      () =>
        new Response("export const a = 1;", {
          headers: { ETag: `"${"a".repeat(64)}"`, "Content-Type": "text/html" },
        }),
    );
    const response = await get(`/_og/a/${VERSION}/${TOKEN}/assets/page-1.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export const a = 1;");
    // The gateway's own type from the extension, never the upstream's.
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(new URL(call.url).pathname).toBe(
      `/v1/site-runtime/assets/${VERSION}/${TOKEN}/assets/page-1.js`,
    );
    expect(verifyGatewayHeaders(TEST_SECRET, call)).toBe(true);
    expect(gatewayRoute(`/_og/a/${VERSION}/${TOKEN}/a.js`)).toBe("asset");
  });

  test("malformed addresses and other methods never reach the API", async () => {
    const seen = upstream(() => new Response("x"));
    for (const path of [
      `/_og/a/${VERSION}/${TOKEN}/index.html`,
      `/_og/a/${VERSION}/short/a.js`,
      `/_og/a/not-a-version/${TOKEN}/a.js`,
      `/_og/a/${VERSION}/${TOKEN}/run.sh`,
    ])
      expect((await get(path)).status).toBe(404);
    expect((await get(`/_og/a/${VERSION}/${TOKEN}/a.js`, {}, "POST")).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test("an unknown file is a plain 404", async () => {
    upstream(() => new Response("{}", { status: 404 }));
    const response = await get(`/_og/a/${VERSION}/${TOKEN}/assets/missing.js`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a taken-down app serves no files", async () => {
    const seen = upstream(() => new Response("x"));
    const response = await worker.fetch(
      new Request(`https://${HOST}/_og/a/${VERSION}/${TOKEN}/a.js`),
      env("suspended"),
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(410);
    expect(seen).toHaveLength(0);
  });
});
