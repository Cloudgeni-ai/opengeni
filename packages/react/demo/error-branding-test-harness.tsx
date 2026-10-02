import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  OpenGeniApiError,
  OpenGeniAllowanceExhaustedError,
  OpenGeniSetupError,
} from "@opengeni/sdk";
import {
  OpenGeniProvider,
  OpenGeniChat,
  ChatComposer,
  MessageTimeline,
  conversationTimeline,
  useComposer,
} from "@opengeni/react";
import { MockOpenGeniClient } from "./mock";
import "@opengeni/react/compiled.css";

// Local fixture only: shipped components and styles, synthetic SDK failures, no API calls.
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") ?? "api";
const client = new MockOpenGeniClient();
const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
client.listSessionPage = async () => ({ sessions: [], pinned: [], nextCursor: null });

function failure(): Error {
  if (mode === "setup") return new OpenGeniSetupError(new OpenGeniApiError(409, ""));
  if (mode === "allowance")
    return new OpenGeniAllowanceExhaustedError(
      429,
      JSON.stringify({
        error: {
          code: "allowance_exhausted",
          message: "OpenGeni allowance exhausted",
          details: { scope: "member", resetsAt: null },
        },
      }),
    );
  if (mode === "unknown")
    return new OpenGeniApiError(0, "", {
      code: "network_error",
      retryable: true,
      outcomeUnknown: true,
      correlationId: "acme-preview",
      displayMessage: "OpenGeni could not confirm delivery",
    });
  if (mode === "transport") return new TypeError("OpenGeni network diagnostic");
  return new OpenGeniApiError(
    403,
    JSON.stringify({
      error: {
        code: "permission_denied",
        message: "OpenGeni denied this request",
        requestId: "acme-preview",
      },
    }),
  );
}
client.sendMessage = async () => {
  throw failure();
};

function ComposerPreview() {
  const started = useRef(false);
  const composer = useComposer(sessionId, {
    draftPersistence: "disabled",
    initialPolicy: { model: "host-default", reasoningEffort: "medium", latencyMode: "standard" },
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    composer.setValue("Summarize my account activity.");
    void composer.send();
  }, [composer]);
  return (
    <section className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col py-5">
      <MessageTimeline
        className="min-h-0 flex-1"
        items={conversationTimeline([], { queue: [], snapshot: null }, composer)}
      />
      <ChatComposer composer={composer} placeholder="Ask ACME Assistant…" />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider
    client={client}
    workspaceId={workspaceId}
    formatError={
      params.has("custom") ? (_error, message) => `ACME Assistant: ${message}` : undefined
    }
  >
    <main
      className="og-root flex h-full flex-col bg-og-bg text-og-fg"
      data-og-theme={params.get("theme") === "dark" ? undefined : "light"}
      data-og-density="default"
      data-error-preview=""
    >
      <header className="border-b border-og-border px-5 py-4 text-og-sm font-medium">
        ACME Assistant
      </header>
      {params.has("composer") ? (
        <ComposerPreview />
      ) : (
        <OpenGeniChat
          className="min-h-0 flex-1"
          labels={{ heading: "Your conversations", newChatPlaceholder: "Ask ACME Assistant…" }}
          createSession={async () => {
            throw failure();
          }}
        />
      )}
    </main>
  </OpenGeniProvider>,
);
