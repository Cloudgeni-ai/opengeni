import { OpenGeniProvider } from "@opengeni/react";
import type {
  ModelAccountChoiceOption,
  ModelAccountUsageSnapshot,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
} from "@opengeni/sdk";
import { createRoot } from "react-dom/client";
import { fakeClient, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";
import { CodexAccountIndicator } from "../../../src/components/session/codex-account-indicator";
import { ModelAccountIndicator } from "../../../src/components/session/model-account-indicator";
import "../../../src/styles.css";

// The real session-header model-account control against a synthetic client.
// `?session=private` is the person's own private chat (their personal account
// can be chosen); `?session=shared` retains the current server refusal for a
// personal account. This fixture does not change backend eligibility.
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const privateChat = params.get("session") !== "shared";
const statuses = params.get("state") === "statuses";
const codexReference = params.get("provider") === "codex";
const neutralProvider = params.get("provider") === "xai" ? "xai" : "claude";
const brand = neutralProvider === "xai" ? "SuperGrok" : "Claude";
const usageState = params.get("usage");
const reading: ModelAccountUsageSnapshot = {
  observedAt: new Date(Date.now() - 120_000).toISOString(),
  source: "response_headers",
  windows: [
    {
      id: "five_hour",
      usedPercent: 36,
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: "ok",
    },
    {
      id: "seven_day",
      usedPercent: 62,
      resetsAt: new Date(Date.now() + 172_800_000).toISOString(),
      status: "ok",
    },
  ],
  exhaustedUntil: null,
  exhaustedKind: null,
};
if (usageState === "partial")
  reading.windows = [
    { id: "seven_day", usedPercent: null, resetsAt: null, status: "unknown" },
    { id: "overage", usedPercent: 125, resetsAt: null, status: "unknown" },
  ];
if (usageState === "stale") {
  reading.observedAt = "2020-01-01T09:00:00Z";
  reading.windows = [
    { id: "five_hour", usedPercent: 100, resetsAt: "2020-01-01T14:00:00Z", status: "exhausted" },
  ];
}
if (neutralProvider === "xai")
  reading.windows = [{ id: "billing", usedPercent: 42, resetsAt: null, status: "ok" }];

function option(
  connectionId: string,
  label: string,
  extra: Partial<ModelAccountChoiceOption> = {},
): ModelAccountChoiceOption {
  return {
    provider: neutralProvider,
    connectionId,
    label,
    accountEmail: `${connectionId}@example.test`,
    planType: "Max",
    status: "active",
    personal: false,
    source: "organization",
    allowedModelIds: null,
    choosable: true,
    refusal: null,
    ...extra,
  };
}

let state: SessionModelAccountChoiceResponse = {
  binding: {
    provider: neutralProvider,
    connectionId: params.get("state") === "redacted" ? null : "team-a",
    choice: params.get("state") === "redacted" ? "explicit" : "automatic",
  },
  accounts: [
    option(
      "team-a",
      `Acme ${brand} 1`,
      statuses
        ? {
            status: "needs_relogin",
            choosable: false,
            refusal: "inactive",
            usage: null,
          }
        : { usage: usageState === "missing" ? undefined : usageState === "null" ? null : reading },
    ),
    option("team-b", `Acme ${brand} 2`, {
      source: "workspace",
      planType: "Team",
      ...(statuses ? { status: "error", choosable: false, refusal: "inactive" as const } : {}),
    }),
    option("mine", `My ${brand}`, {
      personal: true,
      source: "personal",
      planType: "Pro",
      usage: null,
      ...(privateChat ? {} : { choosable: false, refusal: "personal_not_owner_work" as const }),
    }),
  ],
  personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn: false },
};
const receipts: unknown[] = [];
(window as unknown as { pickerReceipts: unknown[] }).pickerReceipts = receipts;

// The neutral fixture uses the landed API snapshot shape. All readings in both
// fixtures are synthetic, not live provider measurements.
const usageWindow = (remaining: number) => ({
  used: 100 - remaining,
  limit: 100,
  percent: 100 - remaining,
  remaining,
  resetAt: null,
  resetAfterSeconds: null,
  limitWindowSeconds: null,
});
const codexAccounts = [
  {
    id: "codex-a",
    label: "Acme Codex 1",
    status: "active" as const,
    plan: "Pro",
    allocatorEnabled: true,
    fiveHour: usageWindow(64),
    weekly: usageWindow(38),
  },
  {
    id: "codex-b",
    label: "Acme Codex 2",
    status: "active" as const,
    plan: "Pro",
    allocatorEnabled: true,
    fiveHour: usageWindow(5),
    weekly: usageWindow(72),
  },
  {
    id: "codex-c",
    label: "Backup",
    status: "needs_relogin" as const,
    plan: "Pro",
    allocatorEnabled: true,
  },
];

const client = Object.assign(fakeClient({}), {
  listSessionCodexAccounts: async () => ({
    accounts: codexAccounts,
    currentAccount: codexAccounts[0],
    currentSelection: { credentialId: "codex-a", waiting: false },
    pinnedAccountId: null,
    lastAccountId: "codex-a",
    activeAccountId: "codex-a",
    settings: { rotationEnabled: true, rotationStrategy: "sharded", activeCredentialId: "codex-a" },
  }),
  refreshCodexUsage: async () => {
    if (!codexReference) throw new Error("Neutral picker invoked a legacy refresh");
    return {
      usage: Object.fromEntries(
        codexAccounts.map((account) => [
          account.id,
          {
            status: account.status === "active" ? "ok" : "no-data",
            usage:
              account.status === "active"
                ? {
                    status: "ok",
                    planType: account.plan,
                    fiveHour: account.fiveHour,
                    weekly: account.weekly,
                    limitReached: false,
                    fetchedAt: "2026-10-12T09:00:00Z",
                  }
                : null,
          },
        ]),
      ),
    };
  },
  pinSessionCodexAccount: async (_workspaceId: string, _sessionId: string, id: string) => {
    receipts.push({ choose: id });
    return { pinned: id, appliedTo: "next_turn" };
  },
  getSessionModelAccount: async () => state,
  setSessionModelAccount: async (
    _workspaceId: string,
    _sessionId: string,
    request: SetSessionModelAccountChoiceRequest,
  ) => {
    receipts.push({ choose: request.connectionId });
    if (
      request.connectionId !== null &&
      !state.accounts.some(
        (account) => account.connectionId === request.connectionId && account.choosable,
      )
    ) {
      throw new Error("This account cannot serve this chat");
    }
    state = {
      ...state,
      binding: {
        provider: neutralProvider,
        connectionId: request.connectionId ?? "team-a",
        choice: request.connectionId ? "explicit" : "automatic",
      },
    };
    return {
      changed: true,
      appliedTo: "next_turn" as const,
      provider: neutralProvider,
      connectionId: request.connectionId,
      choice: request.connectionId ? ("explicit" as const) : ("automatic" as const),
    };
  },
  updateModelAccountPreferences: async () => {
    receipts.push({ unexpectedFallbackAction: true });
    throw new Error("The account picker must not change fallback preferences");
  },
});

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
    <main className="min-h-screen bg-bg text-fg">
      <header className="flex h-11 items-center gap-2 border-b border-border px-3">
        <span className="truncate text-sm font-medium">Quarterly planning notes</span>
        <span className="text-2xs text-fg-subtle">
          {codexReference
            ? "GPT-6 Astra"
            : neutralProvider === "xai"
              ? "SuperGrok"
              : "Claude Opus 5.5"}
        </span>
        {codexReference ? (
          <CodexAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="preview-session"
            model="codex/gpt-6-astra"
            events={[]}
          />
        ) : (
          <ModelAccountIndicator
            workspaceId={WORKSPACE_ID}
            sessionId="preview-session"
            organizationId="acme"
            provider={neutralProvider}
            events={[]}
          />
        )}
      </header>
      <p className="fixed right-3 bottom-3 left-3 text-xs text-fg-subtle">
        Preview · Synthetic stored snapshots · Production UI/API contract · No live provider probe
      </p>
    </main>
  </OpenGeniProvider>,
);
