import { describe, expect, test } from "bun:test";
import { DEFAULT_FREE_SITE_LIMITS, type SitePublication } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";

import {
  availabilityMessage,
  domainFromHostname,
  draftFromPublication,
  formatUsdMicros,
  knownLimits,
  labelProblemMessage,
  limitSummary,
  normalizeLabelInput,
  parseLimitField,
  publicationRequest,
  sitePublicationLoadFromError,
  sitesClientConfig,
  suggestedLabel,
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
  agent: { enabled: false, model: null, instructions: null, tools: null },
  limitProfile: { kind: "free", overrides: null },
  effectiveLimits: { ...DEFAULT_FREE_SITE_LIMITS },
  invitedEmails: [],
  moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  usage: { agentMicrosThisMonth: 0, conversationsToday: 0 },
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
      limitProfile: { kind: "free", overrides: null },
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

  test("custom limits parse dollars to micro-USD and empty to no limit", () => {
    expect(parseLimitField("0.05", true)).toBe(50_000);
    expect(parseLimitField("$2", true)).toBe(2_000_000);
    expect(parseLimitField("", true)).toBeNull();
    expect(parseLimitField("12", false)).toBe(12);
    expect(parseLimitField("1.5", false)).toBeUndefined();
    expect(parseLimitField("ten", false)).toBeUndefined();
    const draft = {
      ...draftFromPublication(saved, "x"),
      profile: "custom" as const,
    };
    draft.custom = { ...draft.custom, turnsPerConversation: "5", agentMicrosPerSitePerMonth: "" };
    expect(publicationRequest(draft, saved, { publish: false }).limitProfile).toEqual({
      kind: "custom",
      overrides: {
        conversationsPerVisitorPerDay: 10,
        turnsPerConversation: 5,
        agentMicrosPerConversation: 20_000,
        agentMicrosPerVisitorPerDay: 200_000,
        agentMicrosPerSitePerMonth: null,
      },
    });
  });

  test("shows the key numbers of a profile", () => {
    expect(limitSummary(knownLimits("free", null, {})!)).toEqual([
      { label: "Conversations", value: "10 per visitor a day" },
      { label: "Messages", value: "20 per conversation" },
      {
        label: "Agent spend",
        value: "$0.02 per conversation, $0.20 per visitor a day, $2.00 per month",
      },
    ]);
    expect(knownLimits("credits", null, {})).toBeNull();
    expect(
      knownLimits("credits", { ...saved, limitProfile: { kind: "credits", overrides: null } }, {}),
    ).toEqual(saved.effectiveLimits);
    expect(knownLimits("unlimited", null, {})!.agentMicrosPerSitePerMonth).toBeNull();
    expect(formatUsdMicros(430_000)).toBe("$0.43");
  });

  test("forced noindex wins over the saved choice and reads deployment facts safely", () => {
    expect(draftFromPublication({ ...saved, noindex: false }, "x", true).noindex).toBe(true);
    expect(sitesClientConfig({ sites: { forceNoindex: true } })).toEqual({ forceNoindex: true });
    expect(sitesClientConfig({})).toEqual({});
    expect(sitesClientConfig(null)).toEqual({});
  });
});
