import {
  DEFAULT_SITE_LIMITS,
  SITE_PLATFORM_QUOTA_ERROR_CODE,
  type SitePlatformUsage,
  type SitePublishWarning,
  type SiteAbuseReport,
  type SiteHostnameAvailability,
  type SitePublication,
  type UpsertSitePublicationRequest,
} from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";

// Sample data for the Publish to web preview. The Site page, the Publish page
// and the sign-in page are the production components; only the client and the
// app context are fixtures. `?scenario=` picks the state.
export const workspaceId = "11111111-1111-4111-8111-111111111111";
export const siteId = "44444444-4444-4444-8444-444444444444";
export const scenario = new URLSearchParams(location.search).get("scenario") ?? "first";
const me = "fixture-owner";
const domain = "opengeni.site";
const now = Date.parse("2026-10-14T10:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const publication = (patch: Partial<SitePublication> = {}): SitePublication => ({
  siteId,
  workspaceId,
  label: "team-crm-4k9x",
  hostname: `team-crm-4k9x.${domain}`,
  url: `https://team-crm-4k9x.${domain}/`,
  access: "members",
  status: "active",
  noindex: true,
  agent: { enabled: false, model: null, instructions: null, tools: null, guestTools: false },
  limitProfile: { kind: "standard", overrides: null },
  effectiveLimits: { ...DEFAULT_SITE_LIMITS },
  invitedEmails: [],
  moderation: { openReports: 0, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  usage: { agentMicrosThisMonth: 1_200_000, agentMicrosToday: 180_000, conversationsToday: 12 },
  warnings: [],
  outsideAgentModel: null,
  createdAt: minutesAgo(60 * 24 * 3),
  updatedAt: minutesAgo(30),
  ...patch,
});

// Two workspace connections (sample ids) the Site's agent may use.
const agentWithTools = {
  enabled: true,
  model: "gpt-6",
  instructions: null,
  tools: ["linear", "github"],
  guestTools: false,
};

// What a public page that reads workspace tools and Site Data would be told.
const warnings: SitePublishWarning[] = [
  {
    code: "workspace_tools_members_only",
    message: "The page calls workspace tools (linear). Public visitors can't use them.",
    suggestion: "Show this part only to workspace members, or keep the data in Site Data.",
    fix: null,
  },
  {
    code: "site_data_guest_read",
    message: "The page reads the deals collection. Public visitors can't read it.",
    suggestion: "Let visitors read deals, or show it only to members.",
    fix: { kind: "site_data_guest_access", collection: "deals", guestAccess: "read" },
  },
];

const personLimits = {
  ...DEFAULT_SITE_LIMITS,
  agentMicrosPerVisitorPerDay: 500_000,
};

// Every scenario views as the Site's owner; all but one are also workspace admins.
const workspaceAdmin = scenario !== "agent-nonadmin";

const saved: Record<string, SitePublication | null> = {
  site: publication({
    access: "public",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
  }),
  first: null,
  taken: null,
  public: publication({
    access: "public",
    agent: { ...agentWithTools },
  }),
  "agent-nonadmin": publication({
    access: "public",
    agent: { ...agentWithTools },
  }),
  "public-person": publication({
    access: "public",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
    limitProfile: { kind: "custom", overrides: { agentMicrosPerVisitorPerDay: 500_000 } },
    effectiveLimits: personLimits,
  }),
  warnings: publication({
    access: "public",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
    warnings,
  }),
  codex: publication({
    access: "invited",
    invitedEmails: ["ada@analytical.example"],
    agent: {
      enabled: true,
      model: "codex/gpt-6-astra",
      instructions: null,
      tools: null,
      guestTools: false,
    },
    outsideAgentModel: "claude-opus-5-5",
    warnings: [
      {
        code: "agent_model_outside_fallback",
        message: "GPT-6 Astra runs on a ChatGPT plan. Invited people use Claude Opus 5.5 instead.",
        suggestion: "Pick a model paid with credits to use the same one for everyone.",
        fix: null,
      },
    ],
  }),
  quota: publication({
    access: "public",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
  }),
  members: publication({
    access: "members",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
  }),
  invited: publication({
    access: "invited",
    agent: { enabled: true, model: "gpt-6", instructions: null, tools: null, guestTools: false },
    invitedEmails: ["ada@analytical.example", "grace@compiler.example", "katherine@orbit.example"],
  }),
  moderation: publication({
    access: "public",
    moderation: { openReports: 2, suspendedAt: null, suspendedBy: null, suspendedReason: null },
  }),
  suspended: publication({
    access: "public",
    status: "suspended",
    moderation: {
      openReports: 0,
      suspendedAt: minutesAgo(18),
      suspendedBy: "owner",
      suspendedReason: "A visitor reported a fake sign-in form; checking it",
    },
  }),
  onlyme: null,
};

const reports: SiteAbuseReport[] = [
  {
    id: "55555555-5555-4555-8555-555555555555",
    siteId,
    hostname: `team-crm-4k9x.${domain}`,
    category: "phishing",
    message: "The contact form asks for my bank password.",
    contactEmail: "visitor@example.com",
    status: "open",
    createdAt: minutesAgo(42),
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    siteId,
    hostname: `team-crm-4k9x.${domain}`,
    category: "spam",
    message: "",
    contactEmail: null,
    status: "open",
    createdAt: minutesAgo(60 * 5),
  },
];

export const fixtureActivity = {
  puts: [] as UpsertSitePublicationRequest[],
  takedowns: [] as string[],
};
Object.assign(window, { sitePublishingFixture: fixtureActivity });

const notFound = () =>
  new OpenGeniApiError(
    404,
    JSON.stringify({ error: { code: "not_found", message: "Not found" } }),
    {
      mutation: false,
    },
  );

const version = { id: "88888888-8888-4888-8888-888888888888", revision: 4, requestedTools: [] };
let current = saved[scenario] ?? null;

const model = (
  id: string,
  label: string,
  provider: string,
  providerLabel: string,
  cost: "paid" | "subscription" = "paid",
) => ({
  id,
  label,
  provider,
  providerLabel,
  api: "responses",
  capabilities: { reasoning: { efforts: ["medium"], defaultEffort: "medium" }, latencyModes: [] },
  cost,
  credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
  policyAllowed: true,
  availability: { status: "available", selectable: true, reason: null, checkedAt: null },
});

const meter = (
  name: SitePlatformUsage["meters"][number]["meter"],
  used: number,
  allowance: number,
  priceMicros: number,
  priceUnit: number,
) => ({ meter: name, used, peak: used, allowance, priceMicros, priceUnit, estimatedMicros: 0 });

export const platformUsage: SitePlatformUsage = {
  workspaceId,
  periodStart: "2026-10-01",
  billingMode: scenario === "usage-credits" ? "credits" : "usage_only",
  meters: [
    meter("requests", 412_380, 1_000_000, 600_000, 1_000_000),
    meter("sql_rows_read", 8_600_000, 10_000_000, 2_000, 1_000_000),
    meter("sql_rows_written", 23_400, 100_000, 2_000_000, 1_000_000),
    meter("storage_bytes", 310_000_000, 1_000_000_000, 400_000, 1_000_000_000),
  ],
  estimatedMicros: 312_000,
  chargedMicros: scenario === "usage-credits" ? 140_000 : 0,
  shadowMicros: 0,
  brake: {
    engaged: scenario === "usage-brake",
    engagedAt: scenario === "usage-brake" ? minutesAgo(20) : null,
  },
};

export const client = {
  tools: { forWorkspace: () => ({ $catalog: async () => ({ entries: [] }) }) },
  async getWorkspaceArtifact(_workspaceId: string, id: string) {
    return {
      artifact: {
        id,
        accountId: "99999999-9999-4999-8999-999999999999",
        workspaceId,
        slug: "team-crm",
        title: "Team CRM",
        description: null,
        status: "active",
        visibility: scenario === "onlyme" ? "private" : "workspace",
        ownerSubjectId: me,
        currentVersion: version,
        createdAt: minutesAgo(60 * 24 * 9),
        updatedAt: minutesAgo(45),
      },
      versions: [{ ...version, createdAt: minutesAgo(45), sizeBytes: 48_210 }],
      events: [],
    };
  },
  async getSessionTenancyCreateCapabilities() {
    return { canCreatePrivate: true };
  },
  async listSessionPage() {
    return { pinned: [], sessions: [], nextCursor: null, filtersApplied: true };
  },
  async getWorkspaceArtifactHtml() {
    return `<!doctype html><html><body style="font:15px system-ui;margin:32px;color:#1f2328"><h1 style="margin:0 0 8px">Team CRM</h1><p style="color:#57606a">Sample Site content for the preview.</p><table style="border-collapse:collapse;margin-top:16px">${["Ada Lovelace", "Grace Hopper", "Katherine Johnson"].map((name) => `<tr><td style="padding:6px 16px 6px 0">${name}</td><td style="color:#57606a">Customer</td></tr>`).join("")}</table></body></html>`;
  },
  async getWorkspaceModelCatalog() {
    return {
      models: [
        model("gpt-6", "GPT-6", "openai", "OpenAI"),
        model("claude-opus-5-5", "Claude Opus 5.5", "anthropic", "Anthropic"),
        model("codex/gpt-6-astra", "GPT-6 Astra", "codex", "Codex", "subscription"),
      ],
      defaultSelection: { model: "gpt-6", reasoningEffort: "medium", source: "workspace" },
    };
  },
  async getSitePublication() {
    if (scenario === "unavailable")
      throw new OpenGeniApiError(
        503,
        JSON.stringify({
          error: { code: "sites_publishing_disabled", message: "Publishing Sites is not set up." },
        }),
        { mutation: false },
      );
    if (!current) throw notFound();
    return current;
  },
  async checkSiteHostname(_workspaceId: string, label: string): Promise<SiteHostnameAvailability> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (scenario === "taken" && label.startsWith("team-crm"))
      return {
        label,
        hostname: `${label}.${domain}`,
        available: false,
        problem: "taken",
        message: "Another Site uses this name. Try another.",
      };
    return { label, hostname: `${label}.${domain}`, available: true, problem: null, message: null };
  },
  async updateSitePublication(
    _workspaceId: string,
    _siteId: string,
    request: UpsertSitePublicationRequest,
  ) {
    fixtureActivity.puts.push(request);
    if (scenario === "quota")
      throw new OpenGeniApiError(
        402,
        JSON.stringify({
          error: {
            code: "payment_required",
            message: "This workspace has used this month's Sites allowance.",
            details: { code: SITE_PLATFORM_QUOTA_ERROR_CODE },
          },
        }),
        { mutation: true },
      );
    const base = current ?? publication({ status: "unpublished" });
    const label = request.label ?? base.label;
    current = {
      ...base,
      label,
      hostname: `${label}.${domain}`,
      url: `https://${label}.${domain}/`,
      access: request.access ?? base.access,
      status: request.status ?? base.status,
      noindex: request.noindex ?? base.noindex,
      agent: { ...base.agent, ...request.agent },
      limitProfile: request.limitProfile ?? base.limitProfile,
      invitedEmails: request.invitedEmails ?? base.invitedEmails,
      updatedAt: new Date().toISOString(),
    };
    return current;
  },
  async applySitePublicationFix() {
    current = { ...current!, warnings: current!.warnings.slice(0, 1) };
    return current;
  },
  async getSitePlatformUsage(): Promise<SitePlatformUsage> {
    return platformUsage;
  },
  async unpublishSite() {
    current = { ...current!, status: "unpublished", updatedAt: new Date().toISOString() };
    return current;
  },
  async takeDownSite(_workspaceId: string, _siteId: string, request: { reason: string }) {
    fixtureActivity.takedowns.push(request.reason);
    current = {
      ...current!,
      status: "suspended",
      moderation: {
        ...current!.moderation,
        suspendedAt: new Date().toISOString(),
        suspendedBy: "owner",
        suspendedReason: request.reason,
      },
      updatedAt: new Date().toISOString(),
    };
    return current;
  },
  async restoreSite() {
    current = { ...current!, status: "active", updatedAt: new Date().toISOString() };
    return current;
  },
  async listSiteAbuseReports() {
    return { reports: scenario === "moderation" ? reports : [] };
  },
  async updateSiteAbuseReport(
    _w: string,
    _s: string,
    reportId: string,
    request: { status: "dismissed" | "actioned" },
  ) {
    return { ...reports.find((report) => report.id === reportId)!, status: request.status };
  },
  async authorizeSiteViewer(request: { host: string; redirectUri: string; state: string }) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (scenario === "auth-denied")
      throw new OpenGeniApiError(
        403,
        JSON.stringify({ error: { code: "site_access_denied", message: "Access denied" } }),
        { mutation: true },
      );
    return {
      redirectTo: `${request.redirectUri}?code=sample-one-time-code&state=${request.state}`,
      site: { title: "Team CRM", hostname: request.host },
    };
  },
};

export function useAppContext() {
  return {
    client,
    accessKeyVersion: 0,
    busy: false,
    startSession: async () => null,
    clientConfig: { sites: { domain } },
    authSession: { user: { name: "Bendik", email: "bendik@cloudgeni.example" } },
    managedSelfContext: null,
    workspaces: [
      {
        id: workspaceId,
        accountId: "99999999-9999-4999-8999-999999999999",
        name: "Sales",
        kind: "shared",
      },
    ],
    accessContext: {
      subjectId: me,
      workspaceGrants: [
        {
          workspaceId,
          accountId: "99999999-9999-4999-8999-999999999999",
          subjectId: me,
          permissions: [
            "sessions:create",
            "sessions:read",
            "artifacts:read",
            "artifacts:publish",
            ...(workspaceAdmin ? ["workspace:admin"] : []),
          ],
        },
      ],
    },
  } as unknown as AppContextValue;
}
