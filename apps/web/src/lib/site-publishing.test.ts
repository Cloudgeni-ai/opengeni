import { describe, expect, test } from "bun:test";
import { DEFAULT_SITE_LIMITS, type SitePublication } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  availabilityMessage,
  domainFromHostname,
  draftFromPublication,
  formatLimitAmount,
  formatPlatformAmount,
  formatUsdMicros,
  labelProblemMessage,
  normalizeLabelInput,
  outsideUsageLine,
  parseLimitField,
  platformRefusal,
  publicationRequest,
  readinessTitle,
  sitePublicationLoadFromError,
  sitesClientConfig,
  suggestedLabel,
  viewAsVisitorUrl,
} from "./site-publishing";

const saved: SitePublication = {
  siteId: "44444444-4444-4444-8444-444444444444",
  workspaceId: "11111111-1111-4111-8111-111111111111",
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

const apiError = (status: number, code: string) =>
  new OpenGeniApiError(status, JSON.stringify({ error: { code, message: code } }), {
    mutation: false,
  });

describe("Site publishing helpers", () => {
  test("suggests a valid label from the title and validates with the contract", () => {
    expect(suggestedLabel("Team CRM", "4k9x")).toBe("team-crm-4k9x");
    expect(normalizeLabelInput("  Team CRM ")).toBe("team-crm");
    expect(labelProblemMessage("team-crm-4k9x")).toBeNull();
    expect(labelProblemMessage("ab")).toBe("Use 3 to 63 characters.");
    expect(labelProblemMessage("paypal-refund")).toBe("This name is not allowed.");
    expect(labelProblemMessage("admin")).toBe("This name is reserved.");
    expect(labelProblemMessage("-team")).toBe("Start and end with a letter or digit.");
  });

  test("says what the API decided about a label", () => {
    const base = { label: "x-site", hostname: null };
    expect(
      availabilityMessage({ ...base, available: true, problem: null, message: null }),
    ).toBeNull();
    expect(
      availabilityMessage({ ...base, available: false, problem: "taken", message: null }),
    ).toBe("Another Site uses this name.");
    expect(
      availabilityMessage({ ...base, available: false, problem: "held", message: "Held." }),
    ).toBe("Held.");
    expect(domainFromHostname("x-site.opengeni.site", "x-site")).toBe("opengeni.site");
    expect(domainFromHostname("other.opengeni.site", "x-site")).toBeNull();
  });

  test("reads publishing states from API errors", () => {
    expect(sitePublicationLoadFromError(apiError(503, "sites_publishing_disabled"))).toEqual({
      state: "unavailable",
    });
    expect(sitePublicationLoadFromError(apiError(404, "not_found"))).toEqual({ state: "none" });
    expect(sitePublicationLoadFromError(apiError(403, "forbidden"))).toEqual({
      state: "forbidden",
    });
    expect(sitePublicationLoadFromError(new Error("offline")).state).toBe("error");
  });

  test("a first publish sends every choice and turns the Site on", () => {
    const draft = draftFromPublication(null, "team-crm-4k9x");
    expect(publicationRequest(draft, null, { publish: true })).toEqual({
      label: "team-crm-4k9x",
      access: "members",
      agent: { enabled: false },
      noindex: true,
      status: "active",
    });
  });

  test("a change sends only what differs", () => {
    const draft = {
      ...draftFromPublication(saved, "unused"),
      access: "invited" as const,
      invitedEmails: ["ada@example.com"],
      agentEnabled: true,
      agentModel: "gpt-6",
    };
    expect(
      publicationRequest(draftFromPublication(saved, "unused"), saved, { publish: false }),
    ).toEqual({});
    expect(publicationRequest(draft, saved, { publish: false })).toEqual({
      access: "invited",
      invitedEmails: ["ada@example.com"],
      agent: { enabled: true, model: "gpt-6" },
    });
    expect(
      publicationRequest(
        draftFromPublication({ ...saved, status: "unpublished" }, "x"),
        {
          ...saved,
          status: "unpublished",
        },
        { publish: true },
      ),
    ).toEqual({ status: "active" });
  });

  test("outside limits start at $10 a month with no per-person limit", () => {
    const draft = draftFromPublication({ ...saved, access: "public" }, "x");
    expect(draft).toMatchObject({
      outsideAgent: true,
      siteLimit: "10",
      sitePeriod: "month",
      personLimitOn: false,
    });
    // Unchanged defaults send no limits.
    expect(publicationRequest(draft, { ...saved, access: "public" }, { publish: false })).toEqual(
      {},
    );
  });

  test("changed outside limits are saved as overrides on the Site's profile, by admins only", () => {
    const invited = { ...saved, access: "invited" as const };
    const draft = {
      ...draftFromPublication(invited, "x"),
      siteLimit: "25",
      sitePeriod: "day" as const,
      personLimitOn: true,
      personLimit: "1",
      personPeriod: "day" as const,
    };
    expect(publicationRequest(draft, invited, { publish: false })).toEqual({
      limitProfile: {
        // The profile keeps its kind; only the limit fields change.
        kind: "standard",
        overrides: {
          agentsEnabled: true,
          agentMicrosPerSitePerMonth: null,
          agentMicrosPerSitePerDay: 25_000_000,
          agentMicrosPerVisitorPerDay: 1_000_000,
          agentMicrosPerVisitorPerMonth: null,
        },
      },
    });
    expect(publicationRequest(draft, invited, { publish: false, canChangeLimits: false })).toEqual(
      {},
    );
    // Other custom values are kept; turning the outside agent off is a limit change too.
    const custom = {
      ...invited,
      limitProfile: { kind: "custom" as const, overrides: { requestsPerMinutePerVisitor: 60 } },
    };
    expect(
      publicationRequest({ ...draftFromPublication(custom, "x"), outsideAgent: false }, custom, {
        publish: false,
      }).limitProfile?.overrides,
    ).toMatchObject({ requestsPerMinutePerVisitor: 60, agentsEnabled: false });
    // A credits profile stays credits: its multiplied guards are not lost.
    const credits = {
      ...invited,
      limitProfile: { kind: "credits" as const, overrides: null },
    };
    expect(
      publicationRequest({ ...draftFromPublication(credits, "x"), siteLimit: "40" }, credits, {
        publish: false,
      }).limitProfile,
    ).toMatchObject({ kind: "credits", overrides: { agentMicrosPerSitePerMonth: 40_000_000 } });
    // Members-only Sites have no outside limits to send.
    expect(
      publicationRequest({ ...draftFromPublication(saved, "x"), siteLimit: "3" }, saved, {
        publish: false,
      }),
    ).toEqual({});
  });

  test("the usage line follows the Site limit's period", () => {
    const usage = {
      agentMicrosThisMonth: 1_200_000,
      agentMicrosToday: 400_000,
      conversationsToday: 3,
    };
    expect(outsideUsageLine({ ...saved, usage })).toBe("$1.20 of $10 used this month");
    expect(
      outsideUsageLine({
        ...saved,
        usage,
        effectiveLimits: {
          ...saved.effectiveLimits,
          agentMicrosPerSitePerMonth: null,
          agentMicrosPerSitePerDay: 2_000_000,
        },
      }),
    ).toBe("$0.40 of $2 used today");
    expect(
      outsideUsageLine({
        ...saved,
        usage,
        effectiveLimits: { ...saved.effectiveLimits, agentMicrosPerSitePerMonth: null },
      }),
    ).toBe("$1.20 used this month");
    expect(formatLimitAmount(10_000_000)).toBe("$10");
    expect(formatUsdMicros(430_000)).toBe("$0.43");
  });

  test("dollar fields parse to micro-USD and empty to no limit", () => {
    expect(parseLimitField("0.05", true)).toBe(50_000);
    expect(parseLimitField("$2", true)).toBe(2_000_000);
    expect(parseLimitField("", true)).toBeNull();
    expect(parseLimitField("ten", true)).toBeUndefined();
  });

  test("readiness, view as visitor, platform amounts and refusals in words", () => {
    const warning = {
      code: "site_data_guest_write" as const,
      message: "Visitors can't add votes.",
      suggestion: "Let guests append to votes.",
      fix: null,
    };
    expect(readinessTitle([warning, warning], "public")).toBe(
      "2 things won't work for public visitors",
    );
    expect(readinessTitle([warning], "invited")).toBe("1 thing won't work for invited people");
    expect(viewAsVisitorUrl({ ...saved, access: "public" })).toBe(
      "https://team-crm-4k9x.sites.example.test/?og_view_as=public",
    );
    expect(viewAsVisitorUrl({ ...saved, access: "invited" })).toBe(
      "https://team-crm-4k9x.sites.example.test/?og_view_as=invited",
    );
    expect(viewAsVisitorUrl(saved)).toBeNull();
    expect(formatPlatformAmount("requests", 1_234_567)).toBe("1.2M");
    expect(formatPlatformAmount("storage_bytes", 1_400_000_000)).toBe("1.4 GB");
    const refusal = (status: number, code: string, detail: string) =>
      new OpenGeniApiError(
        status,
        JSON.stringify({ error: { code, message: code, details: { code: detail } } }),
        { mutation: true },
      );
    expect(
      platformRefusal(refusal(402, "payment_required", "site_platform_quota_exhausted"))?.title,
    ).toBe("Sites allowance used up");
    expect(
      platformRefusal(refusal(503, "limit_exceeded", "site_platform_brake_engaged"))?.title,
    ).toBe("Publishing is paused");
    expect(platformRefusal(apiError(500, "internal"))).toBeNull();
  });

  test("forced noindex wins over the saved choice and reads deployment facts safely", () => {
    expect(draftFromPublication({ ...saved, noindex: false }, "x", true).noindex).toBe(true);
    expect(sitesClientConfig({ sites: { forceNoindex: true } })).toEqual({ forceNoindex: true });
    expect(sitesClientConfig({})).toEqual({});
    expect(sitesClientConfig(null)).toEqual({});
  });
});
