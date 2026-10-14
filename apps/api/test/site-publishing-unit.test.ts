import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FREE_SITE_LIMITS,
  SITE_GATEWAY_SIGNATURE_HEADER,
  SITE_GATEWAY_TIMESTAMP_HEADER,
  UNLIMITED_SITE_FLOOD_BRAKES,
  type SiteHostMapRecord,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createSiteContentScanner, siteHtmlUrls } from "../src/site-publishing/content-scanner";
import { createSiteEdgeSync } from "../src/site-publishing/edge-sync";
import {
  signSiteGatewayRequest,
  verifySiteGatewayRequest,
} from "../src/site-publishing/gateway-signature";
import { effectiveSiteLimits, freeSiteLimits } from "../src/site-publishing/limits";
import {
  effectiveSiteAccess,
  signedInSiteViewerKind,
  siteGuestsAllowed,
} from "../src/site-publishing/viewer";

const CURRENT = "c".repeat(40);
const PREVIOUS = "p".repeat(40);
const PATH = "/v1/site-runtime/site/config";

function verify(
  headers: Record<string, string>,
  overrides: Partial<Parameters<typeof verifySiteGatewayRequest>[0]> = {},
) {
  return verifySiteGatewayRequest({
    method: "POST",
    pathWithQuery: PATH,
    headers: new Headers(headers),
    body: new TextEncoder().encode('{"a":1}'),
    secrets: [CURRENT, PREVIOUS],
    ...overrides,
  });
}

function signed(
  secret = CURRENT,
  extra: Partial<Parameters<typeof signSiteGatewayRequest>[0]> = {},
) {
  return signSiteGatewayRequest({
    secret,
    method: "POST",
    pathWithQuery: PATH,
    host: "demo-1a2b.sites.example.test",
    body: '{"a":1}',
    visitor: "visitor-abcdefghijklmnop",
    clientIp: "203.0.113.9",
    ...extra,
  });
}

describe("gateway signature", () => {
  test("accepts the current and the previous secret", () => {
    const current = verify(signed());
    expect(current).toEqual({
      ok: true,
      fields: {
        host: "demo-1a2b.sites.example.test",
        session: "",
        visitor: "visitor-abcdefghijklmnop",
        clientIp: "203.0.113.9",
        human: false,
      },
    });
    expect(verify(signed(PREVIOUS)).ok).toBe(true);
    expect(verify(signed(CURRENT, { human: true }))).toMatchObject({
      ok: true,
      fields: { human: true },
    });
  });

  test("refuses a missing, foreign, stale, or tampered signature", () => {
    expect(verify({})).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify(signed("x".repeat(40)))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(signed(CURRENT, { nowMs: Date.now() - 31_000 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    expect(verify(signed(CURRENT, { nowMs: Date.now() + 31_000 }))).toEqual({
      ok: false,
      reason: "skew",
    });
    // Body, path, method and viewer headers are all covered.
    expect(verify(signed(), { body: new TextEncoder().encode('{"a":2}') })).toMatchObject({
      reason: "bad_signature",
    });
    expect(verify(signed(), { pathWithQuery: `${PATH}?x=1` })).toMatchObject({
      reason: "bad_signature",
    });
    expect(verify(signed(), { method: "PUT" })).toMatchObject({ reason: "bad_signature" });
    expect(
      verify({ ...signed(), "x-opengeni-site-visitor": "another-visitor-abcdefgh" }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(
      verify({ ...signed(), "x-opengeni-site-host": "other.sites.example.test" }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(verify({ ...signed(), [SITE_GATEWAY_TIMESTAMP_HEADER]: "12ab" })).toMatchObject({
      reason: "bad_timestamp",
    });
    const header = signed()[SITE_GATEWAY_SIGNATURE_HEADER]!;
    expect(
      verify({ ...signed(), [SITE_GATEWAY_SIGNATURE_HEADER]: `${header.slice(0, -2)}AA` }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(verify(signed(), { secrets: [undefined, undefined] })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  test("refuses signed requests that also carry app credentials", () => {
    for (const name of ["authorization", "cookie", "x-api-key", "x-opengeni-external-actor"])
      expect(verify({ ...signed(), [name]: "x" })).toEqual({ ok: false, reason: "credentials" });
  });
});

describe("limits", () => {
  const settings = testSettings();

  test("the free profile is the strict platform default", () => {
    expect(freeSiteLimits(settings)).toEqual({ ...DEFAULT_FREE_SITE_LIMITS });
    expect(effectiveSiteLimits(settings, null, null)).toEqual({ ...DEFAULT_FREE_SITE_LIMITS });
  });

  test("the Site profile wins over the workspace default", () => {
    const site = effectiveSiteLimits(
      settings,
      { kind: "custom", overrides: { turnsPerConversation: 3, bogus: 1 } },
      { kind: "credits", overrides: null },
    );
    expect(site.turnsPerConversation).toBe(3);
    expect(site.requestsPerMinutePerVisitor).toBe(
      DEFAULT_FREE_SITE_LIMITS.requestsPerMinutePerVisitor,
    );
    const workspace = effectiveSiteLimits(settings, null, { kind: "credits", overrides: null });
    expect(workspace.agentMicrosPerSitePerMonth).toBe(
      DEFAULT_FREE_SITE_LIMITS.agentMicrosPerSitePerMonth! * settings.sitesCreditsLimitMultiplier,
    );
  });

  test("unlimited keeps the flood brakes and custom values cannot pass them", () => {
    const unlimited = effectiveSiteLimits(settings, { kind: "unlimited", overrides: null }, null);
    expect(unlimited.requestsPerMinutePerVisitor).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
    );
    expect(unlimited.agentMicrosPerConversation).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
    );
    expect(unlimited.agentMicrosPerSitePerMonth).toBeNull();
    const custom = effectiveSiteLimits(
      settings,
      {
        kind: "custom",
        overrides: { requestsPerMinutePerVisitor: null, agentMicrosPerConversation: 9e12 },
      },
      null,
    );
    expect(custom.requestsPerMinutePerVisitor).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.requestsPerMinutePerVisitor,
    );
    expect(custom.agentMicrosPerConversation).toBe(
      UNLIMITED_SITE_FLOOD_BRAKES.agentMicrosPerConversation,
    );
  });

  test("turning public agents off turns guest agents off everywhere", () => {
    const off = testSettings({ sitesPublicAgentsEnabled: false });
    expect(
      effectiveSiteLimits(off, { kind: "unlimited", overrides: null }, null).guestAgentsEnabled,
    ).toBe(false);
  });
});

describe("viewer access", () => {
  const open = { sitesPublicEnabled: true, sitesLoginOnly: false };
  test("members, invited people and anyone signed in", () => {
    const base = { member: false, email: "ada@example.com", invitedEmails: ["ada@example.com"] };
    expect(signedInSiteViewerKind({ ...base, access: "members" })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "members", member: true })).toBe("member");
    expect(signedInSiteViewerKind({ ...base, access: "invited" })).toBe("invited");
    expect(signedInSiteViewerKind({ ...base, access: "invited", email: null })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "invited", invitedEmails: [] })).toBeNull();
    expect(signedInSiteViewerKind({ ...base, access: "public", invitedEmails: [] })).toBe("user");
  });

  test("guests only on public Sites of deployments that allow them", () => {
    expect(siteGuestsAllowed("public", open)).toBe(true);
    expect(siteGuestsAllowed("invited", open)).toBe(false);
    expect(siteGuestsAllowed("public", { ...open, sitesLoginOnly: true })).toBe(false);
    expect(siteGuestsAllowed("public", { ...open, sitesPublicEnabled: false })).toBe(false);
    expect(effectiveSiteAccess("public", { ...open, sitesPublicEnabled: false })).toBe("members");
  });
});

describe("edge sync", () => {
  const record: SiteHostMapRecord = {
    v: 1,
    hostname: "demo-1a2b.sites.example.test",
    siteId: crypto.randomUUID(),
    status: "active",
    access: "public",
    versionId: crypto.randomUUID(),
    title: "Demo",
    noindex: true,
    generation: 5,
    updatedAt: new Date().toISOString(),
  };
  const cloudflare = {
    sitesCloudflareApiToken: "token",
    sitesCloudflareAccountId: "account",
    sitesCloudflareKvNamespaceId: "namespace",
    sitesCloudflareZoneId: "zone",
    sitesHostMapTtlSeconds: 300,
  };

  test("is a no-op without settings", async () => {
    const calls: string[] = [];
    const sync = createSiteEdgeSync(
      { ...cloudflare, sitesCloudflareApiToken: undefined, sitesCloudflareZoneId: undefined },
      { fetch: (async (url: string) => (calls.push(url), new Response(null))) as never },
    );
    expect(await sync.putHostRecord(record)).toBe("disabled");
    expect(await sync.purgeHost(record.hostname)).toBe("disabled");
    expect(calls).toEqual([]);
  });

  test("never replaces a newer generation, retries failures, and purges by host", async () => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    let stored: SiteHostMapRecord | null = { ...record, generation: 7 };
    let failures = 1;
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      if (method === "GET") {
        if (failures-- > 0) return new Response("busy", { status: 503 });
        return stored ? Response.json(stored) : new Response(null, { status: 404 });
      }
      if (method === "PUT") stored = JSON.parse(String(init.body));
      return new Response(null, { status: 200 });
    };
    const sync = createSiteEdgeSync(cloudflare, { fetch: fetchImpl as never, backoffMs: 0 });
    expect(await sync.putHostRecord(record)).toBe("skipped_newer");
    stored = null;
    expect(await sync.putHostRecord(record)).toBe("written");
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toContain("/accounts/account/storage/kv/namespaces/namespace/values/");
    expect(put.url).toContain(encodeURIComponent(`host:${record.hostname}`));
    expect(put.url).toContain("expiration_ttl=300");
    expect(JSON.parse(put.body!)).toEqual(record);
    expect(await sync.purgeHost(record.hostname)).toBe("purged");
    const purge = calls.at(-1)!;
    expect(purge.url).toContain("/zones/zone/purge_cache");
    expect(JSON.parse(purge.body!)).toEqual({ hosts: [record.hostname] });
  });
});

describe("content scanner", () => {
  test("is off without a Web Risk key and never calls out", async () => {
    const calls: string[] = [];
    const scanner = createSiteContentScanner(testSettings(), {
      fetch: (async (url: string) => (calls.push(url), new Response("{}"))) as never,
    });
    expect(scanner.name).toBe("none");
    expect(await scanner.scanHtml('<a href="https://evil.example/">x</a>')).toEqual({
      status: "none",
      findings: [],
    });
    expect(calls).toEqual([]);
  });

  test("Web Risk records flagged URLs found in the HTML", async () => {
    const scanner = createSiteContentScanner(testSettings({ sitesWebRiskApiKey: "key" }), {
      fetch: (async (url: string) =>
        Response.json(
          url.includes(encodeURIComponent("https://evil.example/"))
            ? { threat: { threatTypes: ["SOCIAL_ENGINEERING"] } }
            : {},
        )) as never,
    });
    const html = '<a href="https://evil.example/">x</a><img src="https://fine.example/a.png">';
    expect(siteHtmlUrls(html)).toEqual(["https://evil.example/", "https://fine.example/a.png"]);
    expect(await scanner.scanHtml(html)).toEqual({
      status: "flagged",
      findings: [{ url: "https://evil.example/", threatTypes: ["SOCIAL_ENGINEERING"] }],
    });
  });
});
