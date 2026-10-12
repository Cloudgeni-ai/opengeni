import { OpenGeniProvider } from "@opengeni/react";
import type {
  ModelAccountChoiceOption,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
} from "@opengeni/sdk";
import { createRoot } from "react-dom/client";
import { fakeClient, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";
import { ModelAccountIndicator } from "../../../src/components/session/model-account-indicator";
import "../../../src/styles.css";

// The real session-header model-account control against a synthetic client.
// `?session=private` is the person's own private chat (their personal account
// can be chosen); `?session=shared` retains the current server refusal for a
// personal account. This fixture does not change backend eligibility.
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const privateChat = params.get("session") !== "shared";

function option(
  connectionId: string,
  label: string,
  extra: Partial<ModelAccountChoiceOption> = {},
): ModelAccountChoiceOption {
  return {
    provider: "claude",
    connectionId,
    label,
    accountEmail: null,
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
    option("team-a", "Acme Claude 1"),
    option("team-b", "Acme Claude 2", { source: "workspace", planType: "Team" }),
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

const client = Object.assign(fakeClient({}), {
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
        <span className="text-2xs text-fg-subtle">Claude Opus 5.5</span>
        <ModelAccountIndicator
          workspaceId={WORKSPACE_ID}
          sessionId="preview-session"
          organizationId="acme"
          provider="claude"
          events={[]}
        />
      </header>
    </main>
  </OpenGeniProvider>,
);
