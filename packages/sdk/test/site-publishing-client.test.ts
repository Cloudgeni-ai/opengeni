import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SITE_LIMITS,
  type SiteAbuseReport,
  type SitePlatformUsage,
  type SitePublication,
} from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import { OpenGeniApiError } from "../src/errors";

const WS = "11111111-1111-4111-8111-111111111111";
const SITE = "44444444-4444-4444-8444-444444444444";
const BASE = `https://api.example.test/v1/workspaces/${WS}/published-artifacts/${SITE}/publication`;

const publication: SitePublication = {
  siteId: SITE,
  workspaceId: WS,
  label: "team-crm-4k9x",
  hostname: "team-crm-4k9x.sites.example.test",
  url: "https://team-crm-4k9x.sites.example.test/",
  access: "members",
  status: "active",
  noindex: true,
  agent: { enabled: false, model: null, instructions: null, tools: null, guestTools: false },
  limitProfile: { kind: "standard", overrides: null },
  effectiveLimits: { ...DEFAULT_SITE_LIMITS },
  invitedEmails: [],
  moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  usage: { agentMicrosThisMonth: 0, agentMicrosToday: 0, conversationsToday: 0 },
  warnings: [],
  outsideAgentModel: null,
  createdAt: "2026-10-14T09:00:00.000Z",
  updatedAt: "2026-10-14T09:00:00.000Z",
};

type Seen = { url: string; method: string; body: unknown; authorization: string | null };

function fakeClient(respond: (seen: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    const text = init?.body ? String(init.body) : "";
    const entry: Seen = {
      url: request.url,
      method: request.method,
      body: text ? JSON.parse(text) : undefined,
      authorization: request.headers.get("authorization"),
    };
    seen.push(entry);
    const result = respond(entry);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test/",
    apiKey: "og_test_key",
    fetch: fakeFetch,
  });
  return { client, seen };
}

describe("published Site management client", () => {
  test("reads, publishes, changes and unpublishes a Site at its publication route", async () => {
    const { client, seen } = fakeClient(() => ({ body: publication }));
    expect(await client.getSitePublication(WS, SITE)).toEqual(publication);
    await client.updateSitePublication(WS, SITE, {
      label: "team-crm-4k9x",
      access: "invited",
      invitedEmails: ["ada@example.com"],
      agent: { enabled: true, model: "gpt-6" },
      limitProfile: { kind: "credits", overrides: null },
      status: "active",
    });
    await client.unpublishSite(WS, SITE);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${BASE}`,
      `PUT ${BASE}`,
      `DELETE ${BASE}`,
    ]);
    expect(seen[1]!.body).toEqual({
      label: "team-crm-4k9x",
      access: "invited",
      invitedEmails: ["ada@example.com"],
      agent: { enabled: true, model: "gpt-6" },
      limitProfile: { kind: "credits", overrides: null },
      status: "active",
    });
    expect(seen.every((entry) => entry.authorization === "Bearer og_test_key")).toBe(true);
  });

  test("checks a hostname label with the label path-encoded", async () => {
    const { client, seen } = fakeClient(() => ({
      body: {
        label: "login",
        hostname: null,
        available: false,
        problem: "reserved",
        message: "This name is reserved.",
      },
    }));
    const availability = await client.checkSiteHostname(WS, "a/b");
    expect(availability.problem).toBe("reserved");
    expect(seen[0]!.url).toBe(`https://api.example.test/v1/workspaces/${WS}/site-hostnames/a%2Fb`);
  });

  test("takes a Site down with a reason and restores it", async () => {
    const { client, seen } = fakeClient(() => ({ body: publication }));
    await client.takeDownSite(WS, SITE, { reason: "Phishing report confirmed" });
    await client.restoreSite(WS, SITE);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${BASE}/takedown`,
      `POST ${BASE}/restore`,
    ]);
    expect(seen[0]!.body).toEqual({ reason: "Phishing report confirmed" });
  });

  test("lists and closes abuse reports", async () => {
    const report: SiteAbuseReport = {
      id: "55555555-5555-4555-8555-555555555555",
      siteId: SITE,
      hostname: publication.hostname,
      category: "phishing",
      message: "Asks for a bank password",
      contactEmail: null,
      status: "open",
      createdAt: "2026-10-14T09:30:00.000Z",
    };
    const { client, seen } = fakeClient(({ method }) => ({
      body: method === "GET" ? { reports: [report] } : { ...report, status: "dismissed" },
    }));
    expect((await client.listSiteAbuseReports(WS, SITE)).reports).toEqual([report]);
    const closed = await client.updateSiteAbuseReport(WS, SITE, report.id, {
      status: "dismissed",
    });
    expect(closed.status).toBe("dismissed");
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${BASE}/reports`,
      `PATCH ${BASE}/reports/${report.id}`,
    ]);
    expect(seen[1]!.body).toEqual({ status: "dismissed" });
  });

  test("reads and changes the workspace limit profile", async () => {
    const { client, seen } = fakeClient(({ body }) => ({
      body: body ?? { kind: "standard", overrides: null },
    }));
    expect(await client.getSiteLimitProfile(WS)).toEqual({ kind: "standard", overrides: null });
    const profile = { kind: "custom" as const, overrides: { turnsPerConversation: 5 } };
    expect(await client.updateSiteLimitProfile(WS, profile)).toEqual(profile);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET https://api.example.test/v1/workspaces/${WS}/site-limit-profile`,
      `PUT https://api.example.test/v1/workspaces/${WS}/site-limit-profile`,
    ]);
  });

  test("applies a readiness fix and reads platform usage", async () => {
    const usage: SitePlatformUsage = {
      workspaceId: WS,
      periodStart: "2026-10-01",
      billingMode: "usage_only",
      meters: [
        {
          meter: "requests",
          used: 1200,
          peak: 1200,
          allowance: 1_000_000,
          priceMicros: 600_000,
          priceUnit: 1_000_000,
          estimatedMicros: 720,
        },
      ],
      estimatedMicros: 720,
      chargedMicros: 0,
      shadowMicros: 0,
      brake: { engaged: false, engagedAt: null },
    };
    const { client, seen } = fakeClient(({ method }) => ({
      body: method === "POST" ? publication : usage,
    }));
    const fix = {
      kind: "site_data_guest_access" as const,
      collection: "votes",
      guestAccess: "append" as const,
    };
    expect(await client.applySitePublicationFix(WS, SITE, fix)).toEqual(publication);
    expect(await client.getSitePlatformUsage(WS)).toEqual(usage);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${BASE}/fixes`,
      `GET https://api.example.test/v1/workspaces/${WS}/site-platform-usage`,
    ]);
    expect(seen[0]!.body).toEqual(fix);
  });

  test("authorizes a Site viewer and returns the redirect", async () => {
    const request = {
      host: "team-crm-4k9x.sites.example.test",
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256" as const,
      redirectUri: "https://team-crm-4k9x.sites.example.test/_og/auth/callback",
    };
    const response = {
      redirectTo: `${request.redirectUri}?code=one-time&state=${request.state}`,
      site: { title: "Team CRM", hostname: request.host },
    };
    const { client, seen } = fakeClient(() => ({ body: response }));
    expect(await client.authorizeSiteViewer(request)).toEqual(response);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("https://api.example.test/v1/site-auth/authorize");
    expect(seen[0]!.body).toEqual(request);
  });

  test("surfaces the API's error codes", async () => {
    const { client } = fakeClient(({ method }) =>
      method === "PUT"
        ? {
            status: 409,
            body: {
              error: { code: "site_hostname_taken", message: "This name is already taken." },
            },
          }
        : {
            status: 503,
            body: {
              error: {
                code: "sites_publishing_disabled",
                message: "Publishing Sites is not set up here.",
              },
            },
          },
    );
    const taken = await client
      .updateSitePublication(WS, SITE, { label: "taken-name" })
      .catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(OpenGeniApiError);
    expect((taken as OpenGeniApiError).status).toBe(409);
    expect((taken as OpenGeniApiError).code).toBe("site_hostname_taken");
    const disabled = await client.getSitePublication(WS, SITE).catch((error: unknown) => error);
    expect((disabled as OpenGeniApiError).code).toBe("sites_publishing_disabled");
  });
});
