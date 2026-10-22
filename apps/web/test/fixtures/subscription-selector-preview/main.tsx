import { OpenGeniProvider, ModelPolicyPicker, projectPickerRows } from "@opengeni/react";
import { t } from "@opengeni/react/app/lib/console-text";
import { SessionHeader } from "@opengeni/react/app/components/rail/session-header";
import type { Session } from "@opengeni/react/app/types";
import type { ReasoningEffort } from "@opengeni/sdk";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { fakeClient, WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";
import "../../../src/styles.css";
import { SessionShellAppContext } from "../../session-shell-app-context";
import {
  catalog,
  codexAccounts,
  codexLiveUsage,
  connectionId,
  MODEL,
  modelAccountChoice,
  type PreviewProvider,
} from "./data";
import { AccountSlot, SESSION_ID } from "./slot";

// `?provider=codex|claude` picks the session's subscription. `?open=account`
// opens the header account menu; `?open=model` opens the composer picker.
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const provider: PreviewProvider = params.get("provider") === "codex" ? "codex" : "claude";
const billingClass = provider === "codex" ? "codex_subscription" : "claude_subscription";
const accounts = codexAccounts();

const client = Object.assign(fakeClient({}), {
  listSessionCodexAccounts: async () => ({
    accounts,
    currentAccount: accounts[0]!,
    currentSelection: { credentialId: accounts[0]!.id, waiting: false },
    pinnedAccountId: null,
    lastAccountId: accounts[0]!.id,
    activeAccountId: accounts[0]!.id,
    settings: {
      rotationEnabled: true,
      rotationStrategy: "sharded" as const,
      activeCredentialId: accounts[0]!.id,
    },
  }),
  refreshCodexUsage: async () => ({ usage: codexLiveUsage() }),
  pinSessionCodexAccount: async () => ({ pinned: null, appliedTo: "next_turn" as const }),
  getSessionModelAccount: async () => modelAccountChoice(),
  setSessionModelAccount: async () => ({
    changed: true,
    appliedTo: "next_turn" as const,
    provider,
    connectionId: connectionId(provider, "a"),
    choice: "automatic" as const,
  }),
});

const session = {
  id: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  title: "Quarterly planning notes",
  titleSource: null,
  initialMessage: "Summarize the quarterly plan.",
  parentSessionId: null,
  model: MODEL[provider].id,
  reasoningEffort: "high",
  latencyMode: "standard",
  metadata: {},
  status: "idle",
  pinned: false,
  effectiveControl: {
    state: "active",
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
  },
} as Session;

const rows = projectPickerRows(t, catalog);

function Composer() {
  const [model, setModel] = useState(MODEL[provider].id);
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  return (
    <ModelPolicyPicker
      rows={rows}
      model={model}
      effort={effort}
      latencyMode="standard"
      defaultOpen={params.get("open") === "model"}
      onModelChange={setModel}
      onEffortChange={setEffort}
      onLatencyModeChange={() => undefined}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
    <SessionShellAppContext>
      <main className="min-h-screen bg-bg text-fg" data-provider={provider}>
        <SessionHeader
          session={session}
          ancestors={[]}
          connectionState="live"
          status="idle"
          keyAuthRequired={false}
          onForgetAccessKey={() => undefined}
          inspectorOpen={false}
          onToggleInspector={() => undefined}
          onRename={async () => null}
          onPin={async () => null}
          billingClass={billingClass}
          modelLabel={MODEL[provider].label}
          accountSlot={<AccountSlot provider={provider} />}
        />
        <div className="mx-auto mt-24 flex max-w-3xl items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-2 shadow-sm">
          <span className="flex-1 text-sm text-fg-subtle">Ask anything</span>
          <Composer />
        </div>
        <p className="fixed right-3 bottom-3 left-3 text-xs text-fg-subtle" data-preview-caption>
          Preview · production header, account control and model picker · synthetic accounts and
          usage
        </p>
      </main>
    </SessionShellAppContext>
  </OpenGeniProvider>,
);
