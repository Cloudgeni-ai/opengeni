import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ChatComposer, MessageTimeline, ModelPolicyPicker, useComposer } from "@opengeni/react";
import type { ClientModel, Session } from "@opengeni/sdk";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "../../../packages/react/test/fake-client";
import { FailedSessionBanner } from "../src/components/session/failed-session-banner";
import { ModelRecoveryNotice } from "../src/components/session/model-recovery-notice";
import { Button } from "../src/components/ui/button";
import { currentModelRecovery } from "../src/lib/model-recovery";
import "../src/styles.css";

// Production components/styles; synthetic provider evidence and retry receipt only.
const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const scenario = params.get("state") ?? "recovering";
const models: ClientModel[] = [
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    cost: "credits",
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    cost: "credits",
  },
];
const client = fakeClient({});
const failed = scenario !== "recovering" && scenario !== "unavailable";
const code =
  scenario === "quota" || scenario === "daily"
    ? "provider_quota_exhausted"
    : "provider_rate_limited";

function Preview() {
  const [status, setStatus] = useState<Session["status"]>(failed ? "failed" : "recovering");
  const [paused, setPaused] = useState(false);
  const composer = useComposer(SESSION_ID, {
    client,
    workspaceId: WORKSPACE_ID,
    draftPersistence: "disabled",
    initialPolicy: { model: models[0]!.id, reasoningEffort: "medium", latencyMode: "standard" },
  });
  const [recoveryTime] = useState(() => new Date().toISOString());
  const recovery = currentModelRecovery(
    {
      id: SESSION_ID,
      status,
      activeTurnId: "turn",
      effectiveControl: { state: paused ? "paused" : "active" } as Session["effectiveControl"],
    },
    [
      {
        id: "recovery-event",
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        turnId: "turn",
        sequence: 1,
        type: "turn.recovery.requested",
        occurredAt: recoveryTime,
        payload: {
          reason: scenario === "unavailable" ? "provider_unavailable" : "provider_rate_limited",
          continueDelayMs: 60_000,
        },
      },
    ],
  );
  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-fg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-xs text-fg-muted">
        <span>Preview · Sample provider responses · Not production</span>
        <Button size="sm" variant="ghost" onClick={() => setPaused(!paused)}>
          {paused ? "Unpause preview" : "Pause preview"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setStatus("running")}>
          Resume preview
        </Button>
      </header>
      <div className="mx-auto w-full max-w-3xl px-4 py-5 text-sm font-medium">
        Plan a product launch
      </div>
      <MessageTimeline
        className="min-h-0 flex-1"
        status={status}
        items={[
          {
            kind: "user-message",
            id: "user-message",
            text: "Help me plan a product launch.",
            resources: [],
            tools: [],
            occurredAt: recoveryTime,
          },
        ]}
        trailingState={
          status === "failed" ? (
            <FailedSessionBanner
              failure={{
                reason: "Synthetic provider failure",
                recordedDetail:
                  scenario === "quota"
                    ? "429 insufficient_quota"
                    : scenario === "daily"
                      ? "429 free-models-per-day"
                      : "429 Too Many Requests",
                failureCode: code,
                ...(scenario === "quota"
                  ? { quotaScope: "quota" }
                  : scenario === "daily"
                    ? { quotaScope: "daily" }
                    : {}),
                failureEventId: "fixture-failure",
                failedAt: recoveryTime,
                consecutiveRecoveryCount: null,
              }}
              creditExhausted={scenario === "credits"}
              canChooseModel
              modelChanged={composer.policy?.model !== models[0]!.id}
              actions={{
                failureId: "fixture-failure",
                onRetry: async () => {
                  setStatus("running");
                  return true;
                },
                retryBlocker: paused ? "paused" : composer.hasDraftContent() ? "draft" : null,
              }}
            />
          ) : null
        }
      />
      {recovery ? <ModelRecoveryNotice recovery={recovery} /> : null}
      <div className="mx-auto w-full max-w-3xl px-4 pb-6">
        <ChatComposer
          composer={composer}
          placeholder="Send a follow-up…"
          controlsStart={
            <ModelPolicyPicker
              models={models}
              model={composer.policy?.model ?? models[0]!.id}
              effort={composer.policy?.reasoningEffort ?? "medium"}
              latencyMode={composer.policy?.latencyMode ?? "standard"}
              onModelChange={composer.setModel}
              onEffortChange={composer.setReasoningEffort}
              onLatencyModeChange={composer.setLatencyMode}
            />
          }
        />
      </div>
    </main>
  );
}
const root = createRootRoute({ component: Preview });
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
