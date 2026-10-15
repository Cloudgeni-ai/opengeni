/**
 * Integration: the built Worker runs in workerd (Miniflare) against a fake
 * site-runtime API on a local port. The fake API verifies every gateway
 * signature independently (test/helpers.ts) and records what it received.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SITE_GATEWAY_HOST_HEADER,
  SITE_GATEWAY_HUMAN_HEADER,
  SITE_GATEWAY_SESSION_HEADER,
  SITE_GATEWAY_VISITOR_HEADER,
  SITE_RUNTIME_API_PREFIX,
  siteHostMapKey,
  type SiteHostMapRecord,
} from "@opengeni/contracts";
import { Miniflare } from "miniflare";
import { TEST_SECRET, verifyGatewaySignature } from "./helpers";

/** The fake API listens on an ephemeral port unless one is configured. */
const API_PORT = Number(process.env.SITE_GATEWAY_TEST_API_PORT ?? 0);
const DOMAIN = "sites.test";
const VERSION = "11111111-1111-4111-8111-111111111111";
const OLD_VERSION = "22222222-2222-4222-8222-222222222222";
const SESSION = "site-session-token-0123456789abcdefghijklmnop";
const NO_ACCESS_SESSION = "site-session-token-noaccess-0123456789abcdef";
const CODE = "one-time-code-0123456789abcdef";
const RATE_LIMIT = 20;

type Received = {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
  verified: boolean;
};

function record(label: string, overrides: Partial<SiteHostMapRecord> = {}): SiteHostMapRecord {
  return {
    v: 1,
    hostname: `${label}.${DOMAIN}`,
    siteId: "33333333-3333-4333-8333-333333333333",
    status: "active",
    access: "public",
    versionId: VERSION,
    title: `Site ${label}`,
    noindex: false,
    generation: 1,
    updatedAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}

const RECORDS = new Map<string, SiteHostMapRecord>(
  [
    record("pub"),
    record("cache", { siteId: "44444444-4444-4444-8444-444444444444" }),
    record("team", { access: "members", siteId: "55555555-5555-4555-8555-555555555555" }),
    record("gone", { status: "suspended" }),
    record("off", { status: "unpublished", versionId: null }),
    record("hidden", { noindex: true }),
    record("limit"),
    record("counted", { siteId: "66666666-6666-4666-8666-666666666666" }),
  ].map((entry) => [entry.hostname, entry]),
);

const viewer = {
  kind: "member" as const,
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  signedIn: true,
};

const received: Received[] = [];
let htmlFetches = 0;
let pendingChallenge = "";
/** The fake API's "View as visitor" state for SESSION (one session in these tests). */
let previewAs: "invited" | "public" | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let mf: Miniflare | null = null;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

async function fakeApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = new Uint8Array(await request.arrayBuffer());
  const verified = verifyGatewaySignature(TEST_SECRET, request, body);
  const entry: Received = {
    method: request.method,
    path: url.pathname,
    search: url.search,
    headers: request.headers,
    body: new TextDecoder().decode(body),
    verified,
  };
  received.push(entry);
  if (!verified) return json({ error: { code: "bad_signature" } }, { status: 401 });
  if (!url.pathname.startsWith(SITE_RUNTIME_API_PREFIX)) return new Response(null, { status: 404 });
  const suffix = url.pathname.slice(SITE_RUNTIME_API_PREFIX.length);
  const host = request.headers.get(SITE_GATEWAY_HOST_HEADER) ?? "";
  const session = request.headers.get(SITE_GATEWAY_SESSION_HEADER) ?? "";
  if (suffix === "/platform/requests") {
    if (host !== DOMAIN) return json({ error: { code: "invalid" } }, { status: 400 });
    const report = JSON.parse(entry.body) as { hosts: { requests: number }[] };
    return json({ counted: report.hosts.reduce((sum, item) => sum + item.requests, 0) });
  }
  const site = RECORDS.get(host);
  if (suffix === "/host") return site ? json(site) : new Response(null, { status: 404 });
  if (!site) return new Response(null, { status: 404 });
  if (suffix === "/auth/view-as") {
    if (session !== SESSION)
      return json({ error: { code: "site_view_as_members_only" } }, { status: 403 });
    previewAs = (JSON.parse(entry.body) as { viewAs: typeof previewAs }).viewAs;
    return json({ viewAs: previewAs });
  }
  if (suffix === "/site/config") {
    if (site.access !== "public" && session === NO_ACCESS_SESSION)
      return json({ error: { code: "forbidden" } }, { status: 403 });
    if (site.access !== "public" && session !== SESSION)
      return json({ error: { code: "site_sign_in_required" } }, { status: 401 });
    const previewing = session === SESSION ? previewAs : null;
    // A preview as a public visitor on a members Site is refused like a guest.
    if (previewing === "public" && site.access !== "public")
      return json({ error: { code: "forbidden" } }, { status: 403 });
    return json({
      siteId: site.siteId,
      title: site.title,
      hostname: site.hostname,
      versionId: site.versionId,
      access: site.access,
      viewer:
        session === SESSION && !previewing
          ? viewer
          : {
              ...viewer,
              kind: previewing === "invited" ? "invited" : "guest",
              signedIn: !!previewing,
            },
      agent: { enabled: true, model: null },
      siteData: false,
      noindex: site.noindex,
      abuseEmail: null,
      capabilities: { viewAs: previewing },
    });
  }
  if (suffix.startsWith("/versions/")) {
    htmlFetches += 1;
    if (suffix !== `/versions/${VERSION}/html` && suffix !== `/versions/${OLD_VERSION}/html`)
      return new Response(null, { status: 404 });
    return new Response(
      "<!doctype html><html><head><title>Hello</title></head><body><h1>Hello Site</h1></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (suffix === "/auth/exchange") {
    const exchange = JSON.parse(entry.body) as {
      code: string;
      codeVerifier: string;
      redirectUri: string;
    };
    const challenge = createHash("sha256").update(exchange.codeVerifier).digest("base64url");
    if (
      exchange.code !== CODE ||
      challenge !== pendingChallenge ||
      exchange.redirectUri !== `https://${host}/_og/auth/callback`
    )
      return json({ error: { code: "invalid_code" } }, { status: 400 });
    return json({
      sessionToken: SESSION,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      viewer,
    });
  }
  if (suffix === "/auth/logout") return new Response(null, { status: 204 });
  if (suffix === "/sessions" && request.method === "GET")
    return json(
      { sessions: [] },
      { headers: { "set-cookie": "evil=1; Path=/", "x-internal-secret": "leak" } },
    );
  if (suffix === "/sessions/abc/events/stream") {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
        controller.enqueue(new TextEncoder().encode("data: two\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  if (suffix === "/tools/catalog") return json({ tools: [{ path: "demo.echo" }] });
  if (suffix === "/site/reports") return new Response(null, { status: 202 });
  return json({ error: { code: "not_found" } }, { status: 404 });
}

type TestKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

/** Miniflare types bindings with workers-types, which this package does not load. */
async function hostMap(): Promise<TestKv> {
  return (await mf!.getKVNamespace("HOST_MAP")) as unknown as TestKv;
}

/** What a browser sends when the shell's iframe loads Site HTML. */
const FRAME = { "sec-fetch-dest": "iframe" };

function siteUrl(label: string, path: string): string {
  return `https://${label}.${DOMAIN}${path}`;
}

async function get(
  label: string,
  path: string,
  init: { headers?: Record<string, string>; method?: string; body?: string } = {},
) {
  return await dispatch(siteUrl(label, path), init);
}

/**
 * Miniflare restores the dispatched URL from `MF-Original-URL`; its own copy
 * of that header does not survive under Bun's fetch, so set it explicitly.
 */
async function dispatch(
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string } = {},
) {
  return await mf!.dispatchFetch(url, {
    redirect: "manual",
    ...init,
    headers: { ...init.headers, "MF-Original-URL": url },
  });
}

function setCookies(response: { headers: { getSetCookie(): string[] } }): string[] {
  return response.headers.getSetCookie();
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

/** API calls made for Site requests (background platform reports excluded). */
function siteCalls(): number {
  return received.filter((entry) => !entry.path.endsWith("/platform/requests")).length;
}

function lastTo(suffix: string): Received | undefined {
  return [...received]
    .reverse()
    .find((entry) => entry.path === `${SITE_RUNTIME_API_PREFIX}${suffix}`);
}

async function shutdown(): Promise<void> {
  await mf?.dispose();
  mf = null;
  server?.stop(true);
  server = null;
}

async function startWorker(): Promise<void> {
  // Miniflare reads the module when it starts, so the build never outlives startup.
  const buildDir = mkdtempSync(join(tmpdir(), "site-gateway-test-"));
  try {
    await startWorkerFrom(buildDir);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

async function startWorkerFrom(buildDir: string): Promise<void> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
    outdir: buildDir,
    target: "browser",
    format: "esm",
    naming: "worker.js",
  });
  if (!build.success) throw new AggregateError(build.logs, "Worker build failed");
  mf = new Miniflare({
    modules: true,
    scriptPath: join(buildDir, "worker.js"),
    modulesRoot: buildDir,
    compatibilityDate: "2026-07-01",
    bindings: {
      SITES_DOMAIN: DOMAIN,
      API_ORIGIN: `http://127.0.0.1:${server!.port}`,
      APP_ORIGIN: "https://app.test",
      GATEWAY_SECRET: TEST_SECRET,
      ENVIRONMENT: "production",
      PLATFORM_REPORT_INTERVAL_SECONDS: "1",
    },
    kvNamespaces: ["HOST_MAP"],
    ratelimits: {
      RATE_LIMITER: { namespace_id: "1001", simple: { limit: RATE_LIMIT, period: 60 } },
    },
  });
  await mf.ready;
}

beforeAll(async () => {
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: API_PORT, fetch: fakeApi });
    await startWorker();
    const kv = await hostMap();
    // Only in KV: proves the gateway reads KV before asking the API.
    await kv.put(siteHostMapKey(`kvonly.${DOMAIN}`), JSON.stringify(record("kvonly")));
  } catch (error) {
    await shutdown();
    throw error;
  }
}, 60_000);

afterAll(shutdown);

describe("site gateway in workerd", () => {
  test("public guest page load: shell, visitor cookie and strict headers", async () => {
    const response = await get("pub", "/some/page?x=1");
    expect(response.status).toBe(200);
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/u.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toContain("unsafe-inline");
    for (const directive of [
      "frame-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ])
      expect(csp).toContain(directive);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`src="/_og/v/${VERSION}"`);
    expect(html).toContain('href="/_og/report"');
    const sandbox = /sandbox="([^"]+)"/u.exec(html)?.[1] ?? "";
    expect(sandbox.split(" ").sort()).toEqual(
      [
        "allow-downloads",
        "allow-forms",
        "allow-modals",
        "allow-popups",
        "allow-popups-to-escape-sandbox",
        "allow-scripts",
      ].sort(),
    );
    expect(html).not.toContain("allow-same-origin");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("x-robots-tag")).toBeNull();
    const visitor = setCookies(response).find((cookie) => cookie.startsWith("__Host-og_v="));
    expect(visitor).toBeDefined();
    expect(visitor).toMatch(/^__Host-og_v=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/u);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      expect(visitor).toContain(attribute);
    // A returning visitor keeps the id.
    const again = await get("pub", "/", { headers: { cookie: cookiePair(visitor!) } });
    expect(again.status).toBe(200);
    expect(setCookies(again).some((cookie) => cookie.startsWith("__Host-og_v="))).toBe(false);
  });

  test("host lookup falls back to the signed API and writes the record back to KV", async () => {
    const kv = await hostMap();
    let stored: string | null = null;
    for (let attempt = 0; attempt < 20 && stored === null; attempt += 1) {
      stored = await kv.get(siteHostMapKey(`pub.${DOMAIN}`));
      if (stored === null) await Bun.sleep(50);
    }
    expect(JSON.parse(stored!).siteId).toBe(record("pub").siteId);
    expect(lastTo("/host")?.verified).toBe(true);
    const before = received.filter((entry) => entry.path.endsWith("/host")).length;
    const kvOnly = await get("kvonly", "/");
    expect(kvOnly.status).toBe(200);
    expect(received.filter((entry) => entry.path.endsWith("/host")).length).toBe(before);
  });

  test("hosts outside the Sites domain and unknown hosts get a 404", async () => {
    const outside = await dispatch("https://example.com/");
    expect(outside.status).toBe(404);
    await outside.text();
    const unknown = await get("nobody", "/");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain("nobody");
    const unpublished = await get("off", "/");
    expect(unpublished.status).toBe(404);
    await unpublished.text();
  });

  test("a suspended Site gets the takedown page with the abuse contact", async () => {
    const response = await get("gone", "/anything");
    expect(response.status).toBe(410);
    const html = await response.text();
    expect(html).toContain(`abuse@${DOMAIN}`);
    expect(html).not.toContain("<script");
    expect(lastTo("/versions")).toBeUndefined();
  });

  test("members Sites redirect to sign-in, then the callback exchanges the code", async () => {
    const redirect = await get("team", "/reports?q=1");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      `/_og/auth/login?return=${encodeURIComponent("/reports?q=1")}`,
    );
    const visitor = cookiePair(
      setCookies(redirect).find((cookie) => cookie.startsWith("__Host-og_v="))!,
    );

    const login = await get("team", redirect.headers.get("location")!, {
      headers: { cookie: visitor },
    });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location")!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://app.test/site-auth/authorize");
    expect(authorize.searchParams.get("host")).toBe(`team.${DOMAIN}`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `https://team.${DOMAIN}/_og/auth/callback`,
    );
    expect(authorize.searchParams.get("return")).toBe("/reports?q=1");
    const state = authorize.searchParams.get("state")!;
    pendingChallenge = authorize.searchParams.get("code_challenge")!;
    const loginCookie = setCookies(login).find((cookie) => cookie.startsWith("__Host-og_login="))!;
    expect(loginCookie).toContain("Max-Age=600");
    expect(loginCookie).toContain("HttpOnly");

    // A forged state is refused without calling the API.
    const forged = await get(
      "team",
      `/_og/auth/callback?code=${CODE}&state=forged-state-xxxxxxxx`,
      {
        headers: { cookie: `${visitor}; ${cookiePair(loginCookie)}` },
      },
    );
    expect(forged.status).toBe(400);
    await forged.text();
    expect(lastTo("/auth/exchange")).toBeUndefined();

    const callback = await get("team", `/_og/auth/callback?code=${CODE}&state=${state}`, {
      headers: { cookie: `${visitor}; ${cookiePair(loginCookie)}` },
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`https://team.${DOMAIN}/reports?q=1`);
    const cookies = setCookies(callback);
    const session = cookies.find((cookie) => cookie.startsWith("__Host-og_session="))!;
    expect(cookiePair(session)).toBe(`__Host-og_session=${SESSION}`);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      expect(session).toContain(attribute);
    const maxAge = Number(/Max-Age=(\d+)/u.exec(session)?.[1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(cookies.some((cookie) => /^__Host-og_login=;.*Max-Age=0/u.test(cookie))).toBe(true);
    expect(lastTo("/auth/exchange")?.verified).toBe(true);

    const shell = await get("team", "/reports?q=1", {
      headers: { cookie: `${visitor}; __Host-og_session=${SESSION}` },
    });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('"signedIn":true');
    expect(lastTo("/site/config")?.headers.get(SITE_GATEWAY_SESSION_HEADER)).toBe(SESSION);

    // Members HTML is private and only after the access check.
    const frame = await get("team", `/_og/v/${VERSION}`, {
      headers: { ...FRAME, cookie: `${visitor}; __Host-og_session=${SESSION}` },
    });
    expect(frame.status).toBe(200);
    expect(frame.headers.get("cache-control")).toBe("private, no-cache");
    await frame.text();
    const anonymousFrame = await get("team", `/_og/v/${VERSION}`, { headers: FRAME });
    expect(anonymousFrame.status).toBe(401);
    expect(await anonymousFrame.text()).not.toContain("Hello Site");

    // GET only asks; a link or an image can't sign anyone out.
    const logoutCalls = received.filter((entry) => entry.path.endsWith("/auth/logout")).length;
    const confirm = await get("team", "/_og/auth/logout?return=%2Freports", {
      headers: { cookie: `${visitor}; __Host-og_session=${SESSION}` },
    });
    expect(confirm.status).toBe(200);
    expect(setCookies(confirm)).toEqual([]);
    expect(await confirm.text()).toContain(
      '<form method="post" action="/_og/auth/logout?return=%2Freports">',
    );
    expect(received.filter((entry) => entry.path.endsWith("/auth/logout")).length).toBe(
      logoutCalls,
    );
    const crossSiteLogout = await get("team", "/_og/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.test", cookie: `__Host-og_session=${SESSION}` },
    });
    expect(crossSiteLogout.status).toBe(403);
    await crossSiteLogout.text();
    const logout = await get("team", "/_og/auth/logout?return=%2Freports", {
      method: "POST",
      headers: {
        origin: `https://team.${DOMAIN}`,
        cookie: `${visitor}; __Host-og_session=${SESSION}`,
      },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("location")).toBe(`https://team.${DOMAIN}/reports`);
    expect(
      setCookies(logout).some((cookie) => /^__Host-og_session=;.*Max-Age=0/u.test(cookie)),
    ).toBe(true);
    expect(lastTo("/auth/logout")?.headers.get(SITE_GATEWAY_SESSION_HEADER)).toBe(SESSION);
  });

  test("a signed-in viewer without access gets 403, not the Site", async () => {
    const response = await get("team", "/", {
      headers: { cookie: `__Host-og_session=${NO_ACCESS_SESSION}` },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("/_og/v/");
  });

  test("version HTML loads only in the frame, revalidates with an ETag and is edge-cached", async () => {
    const before = htmlFetches;
    // A request that says it is a top-level navigation or a fetch goes back to the shell.
    for (const dest of ["document", "empty"]) {
      const direct = await get("cache", `/_og/v/${VERSION}`, {
        headers: { "sec-fetch-dest": dest },
      });
      expect(direct.status).toBe(302);
      expect(direct.headers.get("location")).toBe("/");
      expect(await direct.text()).toBe("");
    }
    expect(htmlFetches).toBe(before);

    const first = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-opengeni-site-cache")).toBe("MISS");
    const html = await first.text();
    expect(html).toContain("Hello Site");
    expect(html).toContain("__opengeniSiteBridgeBootstrapV2");
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toBe("Sec-Fetch-Dest");
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/u);
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(first.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    let second = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    for (
      let attempt = 0;
      attempt < 20 && second.headers.get("x-opengeni-site-cache") !== "HIT";
      attempt += 1
    ) {
      await second.text();
      await Bun.sleep(50);
      second = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    }
    expect(second.headers.get("x-opengeni-site-cache")).toBe("HIT");
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe(html);
    const settled = htmlFetches;
    const revalidated = await get("cache", `/_og/v/${VERSION}`, {
      headers: { ...FRAME, "if-none-match": etag },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(htmlFetches).toBe(settled);
    const bad = await get("cache", "/_og/v/not-a-version", { headers: FRAME });
    expect(bad.status).toBe(404);
    await bad.text();
    expect(htmlFetches).toBe(settled);
  });

  test("a new host-map generation bypasses cached HTML, and a takedown applies at once", async () => {
    const kv = await hostMap();
    const key = siteHostMapKey(`cache.${DOMAIN}`);
    const cached = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    expect(cached.headers.get("x-opengeni-site-cache")).toBe("HIT");
    await cached.text();
    const base = record("cache", { siteId: "44444444-4444-4444-8444-444444444444" });
    await kv.put(key, JSON.stringify({ ...base, generation: 2 }));
    const fresh = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-opengeni-site-cache")).toBe("MISS");
    await fresh.text();
    await kv.put(key, JSON.stringify({ ...base, status: "suspended", generation: 3 }));
    const gone = await get("cache", `/_og/v/${VERSION}`, { headers: FRAME });
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("Hello Site");
  });

  test("browsers that send no Fetch Metadata still get the sandboxed Site HTML", async () => {
    const response = await get("pub", `/_og/v/${VERSION}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await response.text()).toContain("Hello Site");
  });

  test("IPv6 clients share one budget per /64", async () => {
    let limited = 0;
    for (let index = 0; index < RATE_LIMIT + 5; index += 1) {
      const response = await get("limit", "/_og/api/site/config", {
        headers: {
          origin: `https://limit.${DOMAIN}`,
          "cf-connecting-ip": `2001:db8:77:1::${(index + 1).toString(16)}`,
        },
      });
      if (response.status === 429) limited += 1;
      await response.text();
    }
    expect(limited).toBeGreaterThan(0);
    const otherPrefix = await get("limit", "/_og/api/site/config", {
      headers: { origin: `https://limit.${DOMAIN}`, "cf-connecting-ip": "2001:db8:77:2::1" },
    });
    expect(otherPrefix.status).toBe(200);
    await otherPrefix.text();
  });

  test("a trailing-dot host redirects to the canonical host", async () => {
    const response = await dispatch(`https://pub.${DOMAIN}./reports?x=1`);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://pub.${DOMAIN}/reports?x=1`);
    await response.text();
  });

  test("noindex Sites send X-Robots-Tag and a disallow-all robots.txt", async () => {
    const page = await get("hidden", "/");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    expect(await page.text()).toContain('<meta name="robots" content="noindex">');
    const robots = await get("hidden", "/robots.txt");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
    const indexed = await get("pub", "/robots.txt");
    expect(await indexed.text()).toBe("User-agent: *\nDisallow: /_og/\n");
  });

  test("allowed operations are signed and forwarded without cookies or credentials", async () => {
    const shell = await get("pub", "/");
    await shell.text();
    const visitorCookie = cookiePair(
      setCookies(shell).find((cookie) => cookie.startsWith("__Host-og_v="))!,
    );
    const visitorId = visitorCookie.slice("__Host-og_v=".length).split(".")[0]!;
    const response = await get("pub", "/_og/api/sessions?limit=5", {
      headers: {
        origin: `https://pub.${DOMAIN}`,
        cookie: `${visitorCookie}; __Host-og_session=${SESSION}; other=1`,
        authorization: "Bearer og_live_secret",
        "x-forwarded-for": "10.0.0.1",
        "cf-connecting-ip": "203.0.113.7",
        accept: "application/json",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-internal-secret")).toBeNull();
    const upstream = lastTo("/sessions")!;
    expect(upstream.verified).toBe(true);
    expect(upstream.search).toBe("?limit=5");
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("x-forwarded-for")).toBeNull();
    expect(upstream.headers.get(SITE_GATEWAY_HOST_HEADER)).toBe(`pub.${DOMAIN}`);
    expect(upstream.headers.get(SITE_GATEWAY_VISITOR_HEADER)).toBe(visitorId);
    expect(upstream.headers.get(SITE_GATEWAY_SESSION_HEADER)).toBe(SESSION);
    expect(upstream.headers.get(SITE_GATEWAY_HUMAN_HEADER) ?? "").toBe("");

    const tools = await get("pub", "/_og/api/tools/catalog", {
      method: "POST",
      body: "{}",
      headers: { origin: `https://pub.${DOMAIN}`, "content-type": "application/json" },
    });
    expect(tools.status).toBe(200);
    expect(await tools.json()).toEqual({ tools: [{ path: "demo.echo" }] });
    expect(lastTo("/tools/catalog")?.verified).toBe(true);
  });

  test("SSE responses stream through", async () => {
    const response = await get("pub", "/_og/api/sessions/abc/events/stream", {
      headers: { origin: `https://pub.${DOMAIN}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
  });

  test("disallowed operations and cross-origin calls are refused before forwarding", async () => {
    const count = siteCalls();
    for (const [method, path] of [
      ["GET", "/_og/api/secrets"],
      ["DELETE", "/_og/api/sessions"],
      ["GET", "/_og/api/sessions/%2e%2e/secrets"],
      ["POST", "/_og/api/tools/admin"],
      ["GET", "/_og/api/tools/catalog"],
    ] as const) {
      const response = await get("pub", path, {
        method,
        headers: { origin: `https://pub.${DOMAIN}` },
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "site_operation_not_allowed",
      );
    }
    for (const origin of ["null", "https://evil.test", `https://team.${DOMAIN}`]) {
      const response = await get("pub", "/_og/api/sessions", { headers: { origin } });
      expect(response.status).toBe(403);
      await response.text();
    }
    const noProof = await get("pub", "/_og/api/sessions");
    expect(noProof.status).toBe(403);
    await noProof.text();
    const membersAnonymous = await get("team", "/_og/api/sessions", {
      headers: { origin: `https://team.${DOMAIN}` },
    });
    expect(membersAnonymous.status).toBe(401);
    await membersAnonymous.text();
    expect(siteCalls()).toBe(count);
  });

  test("the rate-limit binding answers 429, and fresh visitor cookies don't reset it", async () => {
    // Every request carries a different, valid visitor cookie from the same IP.
    const visitors: string[] = [];
    for (let index = 0; index < RATE_LIMIT + 5; index += 1) {
      const shell = await get("limit", "/");
      await shell.text();
      visitors.push(
        cookiePair(setCookies(shell).find((cookie) => cookie.startsWith("__Host-og_v="))!),
      );
    }
    expect(new Set(visitors).size).toBe(visitors.length);
    let limited = 0;
    for (const visitor of visitors) {
      const response = await get("limit", "/_og/api/site/config", {
        headers: {
          origin: `https://limit.${DOMAIN}`,
          "cf-connecting-ip": "198.51.100.9",
          cookie: visitor,
        },
      });
      if (response.status === 429) {
        limited += 1;
        expect(response.headers.get("retry-after")).toBe("60");
      }
      await response.text();
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("the report form posts a signed abuse report with a CSRF token", async () => {
    const form = await get("pub", "/_og/report");
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).not.toContain("<script");
    const token = /name="token" value="([^"]+)"/u.exec(html)?.[1];
    expect(token).toBeTruthy();
    const visitor = cookiePair(
      setCookies(form).find((cookie) => cookie.startsWith("__Host-og_v="))!,
    );
    const body = new URLSearchParams({
      token: token!,
      category: "phishing",
      message: "Asks for passwords",
      contactEmail: "",
    }).toString();
    const headers = {
      cookie: visitor,
      "content-type": "application/x-www-form-urlencoded",
    };
    const crossSite = await get("pub", "/_og/report", {
      method: "POST",
      body,
      headers: { ...headers, origin: "https://evil.test" },
    });
    expect(crossSite.status).toBe(403);
    await crossSite.text();
    const badToken = await get("pub", "/_og/report", {
      method: "POST",
      body: body.replace(/token=[^&]+/u, "token=forged"),
      headers: { ...headers, origin: `https://pub.${DOMAIN}` },
    });
    expect(await badToken.text()).toContain("expired");
    expect(lastTo("/site/reports")).toBeUndefined();
    const sent = await get("pub", "/_og/report", {
      method: "POST",
      body,
      headers: { ...headers, origin: `https://pub.${DOMAIN}` },
    });
    expect(sent.status).toBe(200);
    const sentPage = await sent.text();
    expect(sentPage).toContain("Report sent");
    expect(sentPage).toContain(
      "sent to the Site&#39;s owners and to the abuse team of this service",
    );
    expect(sentPage).toContain(`mailto:abuse@${DOMAIN}`);
    const upstream = lastTo("/site/reports")!;
    expect(upstream.verified).toBe(true);
    expect(JSON.parse(upstream.body)).toEqual({
      category: "phishing",
      message: "Asks for passwords",
      contactEmail: null,
    });
  });

  test("the human check is off without Turnstile configuration", async () => {
    const response = await get("pub", "/_og/human", {
      method: "POST",
      body: "{}",
      headers: { origin: `https://pub.${DOMAIN}` },
    });
    expect(response.status).toBe(404);
    await response.text();
  });

  test("view as visitor: members start and end a preview; nobody else can", async () => {
    const session = `__Host-og_session=${SESSION}`;
    try {
      // Without a site session the viewer signs in first; the parameter survives.
      const anonymous = await get("pub", "/page?og_view_as=public");
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get("location")).toBe(
        `/_og/auth/login?return=${encodeURIComponent("/page?og_view_as=public")}`,
      );

      // An unknown value is dropped without asking the API.
      const calls = siteCalls();
      const bogus = await get("pub", "/page?og_view_as=admin&x=1", {
        headers: { cookie: session },
      });
      expect(bogus.status).toBe(302);
      expect(bogus.headers.get("location")).toBe("/page?x=1");
      expect(siteCalls()).toBe(calls);

      // A member starts the preview: signed with the session, then the same page without the parameter.
      const start = await get("pub", "/page?x=1&og_view_as=public", {
        headers: { cookie: session },
      });
      expect(start.status).toBe(302);
      expect(start.headers.get("location")).toBe("/page?x=1");
      const call = lastTo("/auth/view-as")!;
      expect(call.verified).toBe(true);
      expect(call.headers.get(SITE_GATEWAY_SESSION_HEADER)).toBe(SESSION);
      expect(JSON.parse(call.body)).toEqual({ viewAs: "public" });
      const viewCookie = setCookies(start).find((cookie) => cookie.startsWith("__Host-og_view="))!;
      expect(cookiePair(viewCookie)).toBe("__Host-og_view=public");
      for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
        expect(viewCookie).toContain(attribute);

      // The shell shows the preview with a way out, and the viewer as the API sees it.
      const shell = await get("pub", "/page?x=1", {
        headers: { cookie: `${session}; ${cookiePair(viewCookie)}` },
      });
      expect(shell.status).toBe(200);
      const html = await shell.text();
      expect(html).toContain("Viewing as a public visitor");
      expect(html).toContain('href="/page?x=1&amp;og_view_as=off">Exit preview</a>');
      expect(html).toContain('"kind":"guest"');

      // A members Site previewed as a public visitor is refused, with Exit preview.
      const team = await get("team", "/", {
        headers: { cookie: `${session}; ${cookiePair(viewCookie)}` },
      });
      expect(team.status).toBe(403);
      const teamHtml = await team.text();
      expect(teamHtml).toContain("Exit preview");
      expect(teamHtml).not.toContain("/_og/v/");

      // Exit: the API is told, the cookie is cleared, and the banner is gone.
      const exit = await get("pub", "/page?x=1&og_view_as=off", {
        headers: { cookie: `${session}; ${cookiePair(viewCookie)}` },
      });
      expect(exit.status).toBe(302);
      expect(exit.headers.get("location")).toBe("/page?x=1");
      expect(JSON.parse(lastTo("/auth/view-as")!.body)).toEqual({ viewAs: null });
      expect(setCookies(exit).some((cookie) => /^__Host-og_view=;.*Max-Age=0/u.test(cookie))).toBe(
        true,
      );
      const after = await get("pub", "/page?x=1", { headers: { cookie: session } });
      expect(await after.text()).not.toContain("Viewing as");

      // A stale preview cookie (the preview ended elsewhere) is cleared, with no banner.
      const stale = await get("pub", "/", {
        headers: { cookie: `${session}; __Host-og_view=invited` },
      });
      expect(stale.status).toBe(200);
      expect(await stale.text()).not.toContain("Viewing as");
      expect(setCookies(stale).some((cookie) => /^__Host-og_view=;.*Max-Age=0/u.test(cookie))).toBe(
        true,
      );

      // Someone the API does not treat as a member gets a 403 page, not a preview.
      const outsider = await get("pub", "/?og_view_as=public", {
        headers: { cookie: `__Host-og_session=${NO_ACCESS_SESSION}` },
      });
      expect(outsider.status).toBe(403);
      expect(await outsider.text()).toContain("Preview not available");
      expect(setCookies(outsider).some((cookie) => cookie.startsWith("__Host-og_view="))).toBe(
        false,
      );
    } finally {
      previewAs = null;
    }
  });

  test("served requests are counted and reported in signed batches on the Sites apex", async () => {
    const reportsBefore = received.filter((entry) =>
      entry.path.endsWith("/platform/requests"),
    ).length;
    for (let index = 0; index < 3; index += 1) {
      const response = await get("counted", "/robots.txt");
      await response.text();
    }
    const reported = async (): Promise<Received[]> =>
      received
        .filter((entry) => entry.path.endsWith("/platform/requests"))
        .slice(reportsBefore)
        .filter((entry) => entry.body.includes(`counted.${DOMAIN}`));
    const deadline = Date.now() + 8_000;
    while ((await reported()).length === 0 && Date.now() < deadline) await Bun.sleep(100);
    const reports = await reported();
    expect(reports.length).toBeGreaterThan(0);
    let counted = 0;
    for (const report of reports) {
      expect(report.verified).toBe(true);
      expect(report.method).toBe("POST");
      expect(report.headers.get(SITE_GATEWAY_HOST_HEADER)).toBe(DOMAIN);
      expect(report.headers.get(SITE_GATEWAY_SESSION_HEADER)).toBeNull();
      const body = JSON.parse(report.body) as {
        v: number;
        reportId: string;
        hosts: { host: string; requests: number }[];
      };
      expect(body.v).toBe(1);
      expect(body.reportId).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
      counted += body.hosts.find((item) => item.host === `counted.${DOMAIN}`)?.requests ?? 0;
    }
    expect(counted).toBe(3);
  });
});
