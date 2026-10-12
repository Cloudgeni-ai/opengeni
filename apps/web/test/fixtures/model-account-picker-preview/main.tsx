import { OpenGeniProvider } from "@opengeni/react";
import type {
  ModelAccountChoiceOption,
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

function option(
  connectionId: string,
  label: string,
  extra: Partial<ModelAccountChoiceOption> = {},
): ModelAccountChoiceOption {
  return {
    provider: "claude",
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
  binding: { provider: "claude", connectionId: "team-a", choice: "automatic" },
  accounts: [
    option(
      "team-a",
      "Acme Claude 1",
      statuses
        ? {
            status: "needs_relogin",
            choosable: false,
            refusal: "inactive",
          }
        : {},
    ),
    option("team-b", "Acme Claude 2", {
      source: "workspace",
      planType: "Team",
      ...(statuses ? { status: "error", choosable: false, refusal: "inactive" as const } : {}),
    }),
    option("mine", "My Claude", {
      personal: true,
      source: "personal",
      planType: "Pro",
      ...(privateChat ? {} : { choosable: false, refusal: "personal_not_owner_work" as const }),
    }),
  ],
  personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn: false },
};
const receipts: unknown[] = [];
(window as unknown as { pickerReceipts: unknown[] }).pickerReceipts = receipts;

// Quotas exist only in this Codex reference fixture, whose production adapter
// actually supplies them. The neutral fixture above has no quota fields.
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
  refreshCodexUsage: async () => ({
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
  }),
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
        provider: "claude",
        connectionId: request.connectionId ?? "team-a",
        choice: request.connectionId ? "explicit" : "automatic",
      },
    };
    return {
      changed: true,
      appliedTo: "next_turn" as const,
      provider: "claude",
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
          {codexReference ? "GPT-6 Astra" : "Claude Opus 5.5"}
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
            provider="claude"
            events={[]}
          />
        )}
      </header>
      <p className="fixed right-3 bottom-3 left-3 text-xs text-fg-subtle">
        Preview · Synthetic account data · Production components
      </p>
    </main>
  </OpenGeniProvider>,
);
