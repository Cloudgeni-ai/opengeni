import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LightboxProvider,
  OpenGeniProvider,
  MessageTimeline,
  useFileAttachments,
  type ComposerState,
  type TimelineItem,
} from "@opengeni/react";
import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import { ConsoleComposer } from "../../src/components/Composer";
import {
  ModelPicker,
  SessionToolPicker,
  type SessionToolSelection,
} from "../../src/components/pickers";
import {
  SessionVariableSetPicker,
  type SessionVariableSetPickerSharedState,
} from "../../src/components/session/session-variable-set-picker";
import {
  FollowUpRepositoryPicker,
  FollowUpRepositoryMenuBody,
} from "../../src/components/follow-up-repository-picker";
import { ComposerMobilePlus } from "../../src/components/composer-mobile-plus";
import { Button } from "../../src/components/ui/button";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { RepositoryContextPickerProps } from "../../src/components/repository-picker";
import { PersonalResourceScopeChoice as BaselineAccess } from "virtual:personal-access-baseline";
import { ProposedAccess } from "./proposed-access";
import { fixtureClient } from "./context";
import "../../src/styles.css";

const models: ClientModel[] = [
  {
    id: "codex/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    shortLabel: "5.6 Sol",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
  },
];
const tools = [
  { id: "session_events" as const, name: "Session history" },
  { id: "sessions_list" as const, name: "Find sessions" },
];
const noop = () => {};
const asyncNoop = async () => {};
const repos: RepositoryContextPickerProps = {
  setupMode: "platform",
  configured: true,
  status: "bound",
  installUrl: null,
  linkUrl: null,
  installations: [],
  repositories: [],
  groups: [],
  selectedRepoIds: new Set(),
  selectedRepoRefs: {},
  selectedInstallationId: null,
  manualRepos: [],
  manualOpen: false,
  githubAppOpen: false,
  org: "",
  pending: false,
  repoBusy: false,
  githubAppBusy: false,
  onRefresh: asyncNoop,
  onToggleRepo: noop,
  onRefChange: noop,
  onManualOpenChange: noop,
  onManualAdd: noop,
  onManualUpdate: noop,
  onManualRemove: noop,
  onGitHubAppOpenChange: noop,
  onOrgChange: noop,
  onStartGitHubApp: noop,
  onDisconnectInstallation: asyncNoop,
};
const session = {
  id: "preview-session",
  workspaceId: "preview",
  variableSetId: "preview-setup",
  variableSetIds: ["preview-setup"],
};
const initialItems: TimelineItem[] = [
  {
    kind: "user-message",
    id: "example-user",
    text: "Can you continue working with my personal setup?",
    resources: [],
    tools: [],
    occurredAt: "2026-09-08T13:00:00Z",
  },
  {
    kind: "agent-message",
    id: "example-assistant",
    turnId: null,
    text: "Your personal setup is selected. Choose the access duration when you send your next message.\n\n*Example conversation for visual review; no live agent is connected.*",
    streaming: false,
    occurredAt: "2026-09-08T13:00:01Z",
  },
];

function Review() {
  const [variant, setVariant] = useState<"current" | "proposed">("current");
  const [theme, setTheme] = useState("light");
  const [value, setValue] = useState("Keep going and let me know what you find.");
  const [mode, setMode] = useState<"once" | "session">("once");
  const [ongoing, setOngoing] = useState(false);
  const [notice, setNotice] = useState("");
  const [model, setModel] = useState(models[0]!.id);
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [latency, setLatency] = useState<LatencyMode>("standard");
  const [selection, setSelection] = useState<SessionToolSelection>({
    mcpServerIds: new Set(),
    firstPartyToolIds: new Set(tools.map((tool) => tool.id)),
  });
  const [shared, setShared] = useState<SessionVariableSetPickerSharedState>({
    saving: false,
    committedSelection: null,
  });
  const [items, setItems] = useState<TimelineItem[]>(initialItems);
  const attachments = useFileAttachments({ client: fixtureClient, workspaceId: "preview" });
  const submit = async () => {
    if (!value.trim()) return false;
    if (mode === "session") setOngoing(true);
    setNotice(
      mode === "session"
        ? "Preview: sent · Ongoing access enabled"
        : "Preview: sent · Existing ongoing access unchanged",
    );
    setItems((previous) => [
      ...previous,
      {
        kind: "user-message",
        id: `preview-${previous.length}`,
        text: value,
        occurredAt: new Date().toISOString(),
        resources: [],
        tools: [],
      },
    ]);
    setValue("");
    setMode("once");
    return true;
  };
  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => !!value.trim(),
    send: submit,
    steer: submit,
    sending: false,
    canSend: !!value.trim(),
    pause: asyncNoop,
    pausing: false,
    resume: asyncNoop,
    resumeScope: asyncNoop,
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    applyDraft: noop,
    reloadDraft: asyncNoop,
    resolveDraftConflict: asyncNoop,
    restoredResources: [],
    removeRestoredResource: noop,
    error: null,
    clearError: noop,
  };
  const variableProps = {
    session,
    canControl: false,
    canAttach: false,
    canUse: true,
    canList: true,
    sharedState: shared,
    setSharedState: setShared,
    onReloadSession: asyncNoop,
  };
  const changeVariant = (next: "current" | "proposed") => {
    setVariant(next);
    setMode("once");
    setOngoing(false);
    setNotice("");
    setItems(initialItems);
    setValue("Keep going and let me know what you find.");
  };
  return (
    <main className="og-root flex h-dvh min-h-0 flex-col bg-bg text-fg" data-og-theme={theme}>
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Production-component review · Not approved</p>
          <p className="text-2xs text-fg-subtle">
            Source baseline 380bba5 · Fixture data, no live backend
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={variant === "current" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={variant === "current"}
            onClick={() => changeVariant("current")}
          >
            Current source
          </Button>
          <Button
            variant={variant === "proposed" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={variant === "proposed"}
            onClick={() => changeVariant("proposed")}
          >
            Proposed change
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = theme === "light" ? "dark" : "light";
              setTheme(next);
              document.documentElement.setAttribute("data-og-theme", next);
            }}
          >
            Theme
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 sm:px-6">
        <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
          {items.length > 0 ? (
            <MessageTimeline items={items} status="idle" />
          ) : (
            <div className="flex flex-1 items-center justify-center py-8">
              <div className="max-w-md text-center">
                <p className="text-sm font-medium">The real session composer</p>
                <p className="mt-2 text-xs leading-5 text-fg-muted">
                  ConsoleComposer, ChatComposer, model picker, tools, repositories and Variable Sets
                  are imported unchanged from the app. Switch views to compare only the
                  personal-access change.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-4 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          {variant === "current" && (
            <div data-baseline-access className="mt-2 space-y-2">
              <BaselineAccess mode={mode} onModeChange={setMode} />
            </div>
          )}
          <ConsoleComposer
            workspaceId="preview"
            composer={composer}
            attachments={attachments}
            fileUploadsEnabled
            placeholder="Send a follow-up…"
            controlsLeading={
              <>
                <ComposerMobilePlus
                  fileUploadsEnabled
                  servers={[]}
                  firstPartyTools={tools}
                  selection={selection}
                  onToolSelectionChange={setSelection}
                  repositories={{
                    selectedCount: 0,
                    panel: <FollowUpRepositoryMenuBody {...repos} />,
                  }}
                />
                <SessionVariableSetPicker
                  {...variableProps}
                  compact
                  triggerClassName="console-composer-compact-control sm:hidden"
                />
              </>
            }
            controls={
              <div className="@container/model-controls flex min-w-0 flex-1 flex-wrap items-center gap-1.5 max-sm:flex-nowrap">
                <ModelPicker
                  models={models}
                  model={model}
                  effort={effort}
                  latencyMode={latency}
                  menuSide="top"
                  onModelChange={setModel}
                  onEffortChange={setEffort}
                  onLatencyModeChange={setLatency}
                />
                <SessionToolPicker
                  menuSide="top"
                  servers={[]}
                  firstPartyTools={tools}
                  selection={selection}
                  onChange={setSelection}
                  triggerClassName="console-composer-wide-control max-sm:hidden"
                />
                <FollowUpRepositoryPicker
                  {...repos}
                  triggerClassName="console-composer-wide-control max-sm:hidden"
                />
                <SessionVariableSetPicker
                  {...variableProps}
                  triggerClassName="console-composer-wide-control max-sm:hidden"
                />
                {variant === "proposed" && (
                  <ProposedAccess mode={mode} setMode={setMode} ongoing={ongoing} />
                )}
              </div>
            }
          />
          {notice && (
            <p role="status" className="mt-2 text-xs text-status-success">
              {notice}
            </p>
          )}
          <p className="mt-3 text-2xs leading-4 text-fg-subtle">
            Preview boundary: real components and app CSS; simulated send, example
            model/tools/resources. Uploads and resource writes are blocked. Voice is unavailable in
            this fixture. The full navigation shell and live session lifecycle are not mounted.
          </p>
        </div>
      </div>
    </main>
  );
}
document.documentElement.setAttribute("data-og-theme", "light");
createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={fixtureClient} workspaceId="preview">
    <TooltipProvider>
      <LightboxProvider>
        <Review />
      </LightboxProvider>
    </TooltipProvider>
  </OpenGeniProvider>,
);
