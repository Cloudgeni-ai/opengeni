import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError, OpenGeniAllowanceExhaustedError, type ClientModel } from "@opengeni/sdk";
import { ChatComposer, MessageTimeline, ModelPolicyPicker, SessionChrome } from "@opengeni/react";
import { useComposer } from "../src/hooks/use-composer";
import { conversationTimeline } from "../src/conversation-timeline";
import type { UseTurnQueueResult } from "../src/hooks/use-turn-queue";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

// Browser-only fixture: production components and controller; synthetic admission responses.
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "credit";
const sessionId = crypto.randomUUID();
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const client = new MockOpenGeniClient();
let attempts = 0;
client.sendMessage = async () => {
  attempts += 1;
  const ErrorClass = mode === "allowance" ? OpenGeniAllowanceExhaustedError : OpenGeniApiError;
  throw new ErrorClass(
    mode === "transient" ? 429 : 402,
    JSON.stringify({
      error: {
        code:
          mode === "allowance"
            ? "allowance_exhausted"
            : mode === "transient"
              ? "rate_limited"
              : "payment_required",
        message:
          mode === "transient"
            ? "Too many requests. Please wait a moment and retry."
            : "Insufficient credits",
        ...(mode === "allowance" ? { details: { scope: "workspace", resetsAt: null } } : {}),
      },
    }),
    {
      code:
        mode === "allowance"
          ? "allowance_exhausted"
          : mode === "transient"
            ? "rate_limited"
            : "payment_required",
      displayMessage:
        mode === "transient"
          ? "Too many requests. Please wait a moment and retry."
          : "Insufficient credits",
      retryable: mode === "transient",
      outcomeUnknown: false,
    },
  );
};
const models: ClientModel[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6",
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
  },
  {
    id: "codex/gpt-5.6-sol",
    label: "GPT-5.6",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
  },
];
const queue: UseTurnQueueResult = {
  snapshot: null,
  queue: [],
  pendingInputs: [],
  pendingInputAttachment: null,
  activePersonalConnections: [],
  effectiveControl: null,
  stoppingPreviousAttempt: false,
  loading: false,
  error: null,
  refresh: async () => {},
  moveTurn: async () => true,
  editTurn: async () => null,
  steerTurn: async () => true,
  removeTurn: async () => true,
  pendingByTurn: {},
  mutationFor: () => null,
  mutating: false,
  mutationError: null,
  clearMutationError: () => {},
};

declare global {
  interface Window {
    sendErrorHarness?: { attempts: () => number; draft: () => string };
  }
}

function SendErrorHarness() {
  const initialized = useRef(false);
  const composer = useComposer(sessionId, {
    client,
    workspaceId: WORKSPACE_ID,
    draftPersistence: "disabled",
    initialPolicy: { model: models[0]!.id, reasoningEffort: "medium", latencyMode: "standard" },
    sendDestination: () => (params.has("queue") ? "queue" : "chat"),
  });
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      composer.setValue("Try again: show today's new users.");
      void composer.send();
    }
  }, [composer]);
  useEffect(() => {
    window.sendErrorHarness = { attempts: () => attempts, draft: () => composer.value };
    return () => {
      delete window.sendErrorHarness;
    };
  }, [composer.value]);
  return (
    <main
      className="flex h-full flex-col bg-og-bg text-og-fg"
      data-og-density="default"
      data-og-theme="light"
    >
      <header className="border-b border-og-border px-5 py-4 text-og-sm font-medium">
        Daily OpenGeni new users
      </header>
      <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 py-5">
        <MessageTimeline
          className="min-h-0 flex-1"
          status="idle"
          items={conversationTimeline(
            [
              {
                kind: "agent-message",
                id: "previous-response",
                turnId: "previous-turn",
                text: "End of update for today.",
                streaming: false,
                occurredAt: "2026-10-01T09:00:00.000Z",
              },
            ],
            queue,
            composer,
          )}
        />
        {params.has("queue") ? (
          <SessionChrome queue={queue} composer={composer} defaultActive="queue" />
        ) : null}
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
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SendErrorHarness />);
