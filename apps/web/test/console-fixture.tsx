// Opengeni Console in a browser: the production Console pages and frame with
// an in-memory client and sample data. `?path=` picks the page (default
// `/console`); nothing reaches a server.
import type { SessionEvent } from "@opengeni/sdk";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { Toaster } from "@opengeni/react/app/components/toaster";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";

import { parseConsoleSearch, parseConsoleSessionsSearch } from "../src/lib/console-route";
import { ConsoleApiKeysRoute, ConsoleNewApiKeyRoute } from "../src/routes/console/api-keys";
import {
  ConsoleAgentsRoute,
  ConsoleMembersRoute,
  ConsoleUsageRoute,
} from "../src/routes/console/organization-pages";
import { ConsoleOverviewRoute } from "../src/routes/console/overview";
import { ConsoleSessionRoute } from "../src/routes/console/session-detail";
import { ConsoleSessionsRoute } from "../src/routes/console/sessions";
import { ConsoleSettingsRoute } from "../src/routes/console/settings";
import { ConsoleShellRoute } from "../src/routes/console/shell";
import { ConsoleWorkspacesRoute } from "../src/routes/console/workspaces";
import "../src/styles.css";

const ORG = "0b9f0f4e-6c1a-4d6e-9d55-6a1f3c1e0001";
const ME = "user:mira";
const KEY_PROD = "4a1d2c3b-0000-4000-8000-00000000a001";
const KEY_STAGING = "4a1d2c3b-0000-4000-8000-00000000a002";
const KEY_EXPORT = "4a1d2c3b-0000-4000-8000-00000000a003";
const now = Date.parse("2026-11-12T15:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const dollars = (value: number) => Math.round(value * 1_000_000);

const workspaces = [
  ["c0de0000-0000-4000-8000-000000000001", "Nordvik Salmon", "managed", KEY_PROD, 214, 61.4, 6],
  ["c0de0000-0000-4000-8000-000000000002", "Hav Farms", "managed", KEY_PROD, 138, 38.92, 22],
  ["c0de0000-0000-4000-8000-000000000003", "Fjordlaks Group", "managed", KEY_PROD, 97, 27.15, 75],
  ["c0de0000-0000-4000-8000-000000000004", "Kontali staging", "managed", KEY_STAGING, 41, 6.3, 300],
  ["c0de0000-0000-4000-8000-000000000005", "Market analysis", "team", null, 64, 19.84, 48],
  ["c0de0000-0000-4000-8000-000000000006", "Product team", "team", null, 23, 7.12, 1440],
] as const;
const workspaceRows = workspaces.map(([id, name, kind, key, sessions, spend, minutes]) => ({
  id,
  name,
  kind,
  managedSource: kind === "managed" ? ("api_key" as const) : null,
  createdByApiKeyId: key,
  externalSource: kind === "managed" ? "kontali" : null,
  externalId: kind === "managed" ? `cust_${name.toLowerCase().replace(/\W+/gu, "_")}` : null,
  createdAt: "2026-09-02T08:00:00.000Z",
  spendMicros: dollars(spend),
  sessions,
  lastActivityAt: ago(minutes),
}));
const workspaceName = (id: string) => workspaceRows.find((row) => row.id === id)?.name ?? "";

const sessionSeeds: [string, string, string | null, string, number, number, number, number][] = [
  [workspaces[0][0], "Refund for a double charge", "anna.berg@nordvik.no", "idle", 1, 0, 4, 0.31],
  [workspaces[1][0], "Sea lice treatment costs Q3", "ops-7731", "running", 0, 0, 2, 0.12],
  [
    workspaces[0][0],
    "Export volumes to Japan in October",
    "lars.n@nordvik.no",
    "idle",
    2,
    0,
    6,
    0.58,
  ],
  [workspaces[2][0], "Compare harvest weights 2025 vs 2026", "analyst-04", "idle", 0, 1, 3, 0.22],
  [workspaces[1][0], "Why did the spot price drop last week?", null, "failed", 0, 1, 1, 0.04],
  [workspaces[2][0], "Biomass forecast for Region 3", "planning-12", "idle", 1, 0, 5, 0.47],
  [
    workspaces[0][0],
    "Feed conversion ratio by site",
    "anna.berg@nordvik.no",
    "idle",
    0,
    0,
    2,
    0.09,
  ],
  [workspaces[3][0], "Test: smolt release schedule", "qa-bot", "idle", 0, 0, 1, 0.02],
];
const sessions = sessionSeeds.map(
  ([workspaceId, title, externalId, status, positive, negative, turns, cost], index) => ({
    id: `5e550000-0000-4000-8000-00000000000${index + 1}`,
    workspaceId,
    workspaceName: workspaceName(workspaceId),
    title,
    firstMessage: title,
    visibility: "private" as const,
    endUser: {
      subjectId: externalId ? `external_user:kontali:${externalId}` : "external_user:7f3c9a12e4b6",
      externalId,
      source: externalId ? "kontali" : null,
    },
    status,
    feedback: { positive, negative },
    turns,
    costMicros: dollars(cost),
    createdAt: ago(index * 47 + 30),
    updatedAt: ago(index * 47 + 4),
  }),
);

let sequence = 0;
function event(type: string, payload: unknown, second: number): SessionEvent {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    workspaceId: sessions[0]!.workspaceId,
    sessionId: sessions[0]!.id,
    sequence,
    type: type as SessionEvent["type"],
    payload,
    occurredAt: new Date(now - 30 * 60_000 + second * 1000).toISOString(),
    turnId: "7e000000-0000-4000-8000-000000000001",
  } as SessionEvent;
}
const transcript: SessionEvent[] = [
  event(
    "user.message",
    { text: "I was charged twice for March. Can I get one of them refunded?" },
    0,
  ),
  event(
    "agent.toolCall.created",
    { id: "call-1", name: "get_invoices", arguments: { customer: "nordvik", month: "2026-03" } },
    2,
  ),
  event(
    "agent.toolCall.output",
    { id: "call-1", output: "2 invoices: INV-3301 NOK 4,900.00, INV-3302 NOK 4,900.00" },
    3,
  ),
  event(
    "agent.message.completed",
    {
      text: "I can see two charges of **NOK 4,900.00** on March 3 (INV-3301 and INV-3302). I can refund INV-3302 to the card on file.",
    },
    6,
  ),
  event("user.message", { text: "Yes please." }, 40),
  event(
    "agent.toolCall.created",
    { id: "call-2", name: "issue_refund", arguments: { invoice: "INV-3302" } },
    42,
  ),
  event(
    "agent.toolCall.output",
    { id: "call-2", output: "Refund RF-118 created: NOK 4,900.00" },
    44,
  ),
  event(
    "agent.message.completed",
    {
      text: "Done. Refund RF-118 for NOK 4,900.00 is on its way and should show on the card within a few banking days.",
    },
    46,
  ),
  event("turn.completed", {}, 46),
];

const days = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(now - (29 - index) * 86_400_000).toISOString().slice(0, 10);
  const weekday = new Date(date).getUTCDay();
  const base = weekday === 0 || weekday === 6 ? 1.6 : 5.2;
  return { date, spendMicros: dollars(base + ((index * 37) % 11) * 0.42) };
});
const totalMicros = days.reduce((sum, day) => sum + day.spendMicros, 0);

const apiKeys = [
  [KEY_PROD, "Production server", "og_live_7Hq2", "full", ago(3), null, 3, 127.47],
  [KEY_STAGING, "Staging server", "og_live_c91K", "full", ago(280), null, 1, 6.3],
  [
    KEY_EXPORT,
    "Analytics export",
    "og_live_Zp04",
    "read",
    ago(4300),
    "2027-02-01T00:00:00.000Z",
    0,
    0,
  ],
] as const;

let reviewLevel: "full" | "metadata" | "off" = "full";
const client = {
  async getConsoleSummary(_org: string, { range = "30d" }: { range?: string } = {}) {
    const byDay = range === "7d" ? days.slice(-7) : days;
    return {
      organizationId: ORG,
      range,
      since: ago(30 * 1440),
      until: ago(0),
      reviewLevel,
      spend: {
        totalMicros,
        managedMicros: Math.round(totalMicros * 0.79),
        teamMicros: Math.round(totalMicros * 0.19),
        otherMicros: Math.round(totalMicros * 0.02),
        byDay,
        byModel: [
          ["gpt-5.5", 0.58, 3120],
          ["claude-opus-5.5", 0.27, 940],
          ["gpt-5.5-mini", 0.11, 5210],
          ["gemini-3-flash", 0.04, 1880],
        ].map(([model, share, calls]) => ({
          model: model as string,
          spendMicros: Math.round(totalMicros * (share as number)),
          calls: calls as number,
          inputTokens: (calls as number) * 2400,
          outputTokens: (calls as number) * 310,
          cachedTokens: (calls as number) * 1500,
        })),
      },
      workspaces: { managed: 4, team: 2 },
      managedSessions: 490,
      endUsers: 132,
      countsTruncated: false,
    };
  },
  async listConsoleWorkspaces(_org: string, { kind = "all" }: { kind?: string } = {}) {
    return {
      range: "30d",
      since: ago(30 * 1440),
      until: ago(0),
      workspaces: workspaceRows.filter((row) => kind === "all" || row.kind === kind),
    };
  },
  async updateConsoleWorkspace(_org: string, id: string, request: { kind: "managed" | "team" }) {
    const row = workspaceRows.find((candidate) => candidate.id === id)!;
    Object.assign(row, { kind: request.kind });
    return row;
  },
  async listConsoleSessions(_org: string, query: { workspaceId?: string; q?: string } = {}) {
    const q = query.q?.toLowerCase();
    return {
      reviewLevel,
      sessions: sessions
        .filter((row) => !query.workspaceId || row.workspaceId === query.workspaceId)
        .filter((row) => !q || row.title.toLowerCase().includes(q))
        .map((row) => (reviewLevel === "full" ? row : { ...row, title: null, firstMessage: null })),
      nextCursor: null,
    };
  },
  async getConsoleSession(_org: string, _workspaceId: string, sessionId: string) {
    const session = sessions.find((row) => row.id === sessionId) ?? sessions[0]!;
    return {
      reviewLevel,
      session,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      durationMs: 46_000,
      tokens: { input: 18_420, output: 1_204, cached: 11_900, total: 19_624 },
      modelCalls: 4,
      models: ["gpt-5.5"],
      toolCalls: 2,
      feedback: [
        {
          sentiment: "positive",
          comment: "Quick and correct, thanks!",
          turnId: null,
          createdAt: ago(20),
        },
      ],
      auditEventId: "a0d10000-0000-4000-8000-000000000001",
    };
  },
  async listConsoleSessionEvents() {
    return { events: transcript, hasMore: false, nextAfter: null };
  },
  async getConsoleSettings() {
    return { organizationId: ORG, reviewLevel, updatedAt: ago(9000), updatedBySubjectId: ME };
  },
  async updateConsoleSettings(_org: string, request: { reviewLevel: typeof reviewLevel }) {
    reviewLevel = request.reviewLevel;
    return { organizationId: ORG, reviewLevel, updatedAt: ago(0), updatedBySubjectId: ME };
  },
  async listConsoleAuditLog() {
    return {
      events: [
        ["session.transcript_viewed", "Mira Holt", 0, 0, {}, 12],
        ["session.transcript_viewed", "Jonas Berg", 1, 3, {}, 95],
        ["workspace.kind_changed", "Mira Holt", 3, null, { from: "team", to: "managed" }, 1600],
        [
          "settings.review_level_changed",
          "Sara Lind",
          null,
          null,
          { from: "metadata", to: "full" },
          9000,
        ],
        ["session.metadata_viewed", "Jonas Berg", 2, 5, {}, 12000],
      ].map(([action, actorLabel, workspaceIndex, sessionIndex, detail, minutes], index) => {
        const workspace = workspaceIndex === null ? null : workspaceRows[workspaceIndex as number]!;
        return {
          id: `a0d10000-0000-4000-8000-00000000000${index + 1}`,
          action,
          actorSubjectId: `user:${String(actorLabel).split(" ")[0]!.toLowerCase()}`,
          actorLabel,
          workspaceId: workspace?.id ?? null,
          workspaceName: workspace?.name ?? null,
          sessionId: sessionIndex === null ? null : sessions[sessionIndex as number]!.id,
          detail,
          createdAt: ago(minutes as number),
        };
      }),
      nextCursor: null,
    };
  },
  async getConsoleApiKeyUsage() {
    return {
      range: "30d",
      since: ago(30 * 1440),
      until: ago(0),
      apiKeys: apiKeys.map(([apiKeyId, , , , , , managedWorkspaces, spend], index) => ({
        apiKeyId,
        createdBySubjectId: index === 2 ? "user:jonas" : ME,
        managedWorkspaces,
        spendMicros: dollars(spend),
      })),
    };
  },
  async listOrganizationApiKeys() {
    return apiKeys.map(([id, name, prefix, access, lastUsedAt, expiresAt]) => ({
      id,
      accountId: ORG,
      workspaceId: null,
      name,
      description: null,
      prefix,
      permissions: [],
      access,
      expiresAt,
      revokedAt: null,
      lastUsedAt,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    }));
  },
  async createOrganizationApiKey(_org: string, request: { name: string; access: string }) {
    return {
      apiKey: {
        id: "4a1d2c3b-0000-4000-8000-00000000a004",
        name: request.name,
        prefix: "og_live_Rt8m",
      },
      token: "og_live_Rt8m_5kQ1vXw9Hc2LbN7eYfA3uJ6pZs0dTg4",
    };
  },
  async deleteOrganizationApiKey() {},
  // An older setup's key, made in a team workspace, with the same name as the live one.
  async listApiKeys(workspaceId: string) {
    if (workspaceId !== workspaceRows[4]!.id) return [];
    return [
      {
        id: "4a1d2c3b-0000-4000-8000-00000000a009",
        accountId: ORG,
        workspaceId,
        name: "Production server",
        description: null,
        prefix: "og_live_k2Ld",
        permissions: [],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: "2026-04-02T10:00:00.000Z",
        createdAt: "2026-02-01T08:00:00.000Z",
        updatedAt: "2026-02-01T08:00:00.000Z",
      },
    ];
  },
  async deleteApiKey() {},
  async listOrganizationAdministrationMembers() {
    return {
      members: [
        ["user:mira", "Mira Holt", "mira@kontali.com", "owner"],
        ["user:jonas", "Jonas Berg", "jonas@kontali.com", "admin"],
        ["user:sara", "Sara Lind", "sara@kontali.com", "member"],
        ["external_user:kontali:anna", "anna.berg@nordvik.no", null, "member"],
        ["external_user:kontali:ops-7731", "ops-7731", null, "member"],
      ].map(([subjectId, name, email, role], index) => ({
        id: `3e3b0000-0000-4000-8000-00000000000${index + 1}`,
        organizationId: ORG,
        subjectId,
        name,
        email,
        role,
        status: "active",
        authorizationRevision: 1,
        sharedWorkspaceAccess: [],
        revokedAt: null,
        createdAt: "2026-08-01T08:00:00.000Z",
        updatedAt: "2026-08-01T08:00:00.000Z",
      })),
    };
  },
};

const context = {
  client,
  workspaces: workspaceRows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: "shared",
    accountId: ORG,
  })),
  accessContext: {
    subjectId: ME,
    subjectLabel: "Mira Holt",
    defaultAccountId: ORG,
    workspaceGrants: [],
    accountGrants: [
      { accountId: ORG, subjectId: ME, role: "owner", metadata: { accountName: "Kontali" } },
    ],
  },
  authSession: { user: { name: "Mira Holt", email: "mira@kontali.com" } },
  clientConfig: { auth: { mode: "managedSession" }, documentationUrl: "https://docs.opengeni.ai" },
  managedSelfContext: null,
} as unknown as AppContextValue;

const rootRoute = createRootRoute({ component: Outlet });
const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "console",
  validateSearch: parseConsoleSearch,
  component: ConsoleShellRoute,
});
const child = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => consoleRoute, path, component });
const routeTree = rootRoute.addChildren([
  consoleRoute.addChildren([
    child("/", ConsoleOverviewRoute),
    createRoute({
      getParentRoute: () => consoleRoute,
      path: "sessions",
      validateSearch: parseConsoleSessionsSearch,
      component: ConsoleSessionsRoute,
    }),
    child("sessions/$workspaceId/$sessionId", ConsoleSessionRoute),
    child("workspaces", ConsoleWorkspacesRoute),
    child("api-keys", ConsoleApiKeysRoute),
    child("api-keys/new", ConsoleNewApiKeyRoute),
    child("agents", ConsoleAgentsRoute),
    child("members", ConsoleMembersRoute),
    child("usage", ConsoleUsageRoute),
    child("settings", ConsoleSettingsRoute),
  ]),
]);
const initialPath = new URLSearchParams(location.search).get("path") ?? "/console";
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [initialPath] }),
});

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppContext.Provider value={context}>
      <RouterProvider router={router} />
      <Toaster />
    </AppContext.Provider>
  </TooltipProvider>,
);
