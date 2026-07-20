import type { SessionTurn } from "@opengeni/sdk";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueueSurface, type ComposerState, type UseTurnQueueResult } from "../src/index";
import {
  QUEUE_BOUNDARY_CLUSTERS,
  queueBoundaryPrompt,
  queueFallbackPrompt,
  queueHarnessError,
  queueHarnessPrompt,
  queueVisibilityProbePrompt,
  type QueueBoundaryCluster,
  type QueueBoundaryEdge,
  type QueueBoundaryMaximum,
  type QueueFallbackKind,
  type QueueHarnessErrorShape,
  type QueueVisibilityProbeKind,
} from "./queue-fixtures";
import "../../../apps/web/src/styles.css";
import "./queue-harness.css";

declare global {
  interface Window {
    __OPE9_PROMPT__: string;
    __ope9AppendQueuePrompt?: () => void;
    __ope9SetQueueLoading?: (loading: boolean) => void;
  }
}

const params = new URLSearchParams(window.location.search);
const initialCount = Math.min(100, Math.max(1, Number(params.get("count") ?? "1") || 1));
const theme = params.get("theme") === "light" ? "light" : "dark";
const readOnly = params.get("readOnly") === "1";
const boundaryMaximum = parseBoundaryMaximum(params.get("boundaryMax"));
const boundaryEdge = parseBoundaryEdge(params.get("boundaryEdge"));
const boundaryCluster = parseBoundaryCluster(params.get("boundaryCluster"));
const fallbackKind = parseFallbackKind(params.get("fallback"));
const visibilityProbeKind = parseVisibilityProbeKind(params.get("visibility"));
const errorSource = parseErrorSource(params.get("error"));
const errorShape = parseErrorShape(params.get("errorShape"));
const initialErrorMessage = errorSource ? queueHarnessError(errorShape) : null;

if (theme === "light") {
  document.documentElement.dataset.ogTheme = "light";
} else {
  delete document.documentElement.dataset.ogTheme;
}

function makeTurn(index: number): SessionTurn {
  const suffix = String(index + 1).padStart(12, "0");
  const prompt =
    index === 0 && boundaryMaximum && boundaryEdge && boundaryCluster
      ? queueBoundaryPrompt(boundaryMaximum, boundaryEdge, boundaryCluster)
      : index === 0 && fallbackKind
        ? queueFallbackPrompt(fallbackKind)
        : index === 0 && visibilityProbeKind
          ? queueVisibilityProbePrompt(visibilityProbeKind)
          : queueHarnessPrompt(index);
  return {
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-${suffix}`,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    triggerEventId: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-${suffix}`,
    temporalWorkflowId: "ope-9-queue-browser-harness",
    status: "queued",
    source: "user",
    position: index + 1,
    prompt,
    resources: [{ kind: "file", fileId: `fixture-file-${index + 1}` }],
    tools: [],
    model: "gpt-5.3-codex",
    reasoningEffort: "high",
    sandboxBackend: "modal",
    sandboxOs: null,
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}

function parseBoundaryMaximum(value: string | null): QueueBoundaryMaximum | null {
  if (value === "180") return 180;
  if (value === "360") return 360;
  return null;
}

function parseBoundaryEdge(value: string | null): QueueBoundaryEdge | null {
  return value === "head" || value === "tail" ? value : null;
}

function parseBoundaryCluster(value: string | null): QueueBoundaryCluster | null {
  return value && Object.hasOwn(QUEUE_BOUNDARY_CLUSTERS, value)
    ? (value as QueueBoundaryCluster)
    : null;
}

function parseFallbackKind(value: string | null): QueueFallbackKind | null {
  return value === "whitespace" || value === "combining" || value === "zwj" ? value : null;
}

function parseVisibilityProbeKind(value: string | null): QueueVisibilityProbeKind | null {
  switch (value) {
    case "short-zwj":
    case "variation-selector":
    case "word-joiner":
    case "bidi-controls":
    case "tag-characters":
    case "controls":
    case "mixed-visible":
      return value;
    default:
      return null;
  }
}

type QueueHarnessErrorSource = "queue" | "mutation";

function parseErrorSource(value: string | null): QueueHarnessErrorSource | null {
  return value === "queue" || value === "mutation" ? value : null;
}

function parseErrorShape(value: string | null): QueueHarnessErrorShape {
  return value === "multiline" ? "multiline" : "unbroken";
}

const composer: ComposerState & { hasDraftContent: () => boolean } = {
  value: "",
  setValue: () => {},
  hasDraftContent: () => false,
  send: async () => true,
  steer: async () => true,
  sending: false,
  canSend: false,
  pause: async () => {},
  pausing: false,
  resume: async () => {},
  resumeScope: async () => {},
  resuming: false,
  draft: null,
  draftRevision: 0,
  draftLoading: false,
  draftSaving: false,
  draftConflict: null,
  applyDraft: () => {},
  reloadDraft: async () => {},
  resolveDraftConflict: async () => {},
  restoredResources: [],
  removeRestoredResource: () => {},
  error: null,
  clearError: () => {},
};

function QueueHarness() {
  const [turns, setTurns] = useState(() =>
    Array.from({ length: initialCount }, (_, index) => makeTurn(index)),
  );
  const [loading, setLoading] = useState(params.get("loading") === "1");
  const [queueError, setQueueError] = useState<Error | null>(() =>
    errorSource === "queue" && initialErrorMessage ? new Error(initialErrorMessage) : null,
  );
  const [mutationError, setMutationError] = useState<Error | null>(() =>
    errorSource === "mutation" && initialErrorMessage ? new Error(initialErrorMessage) : null,
  );
  const [refreshCount, setRefreshCount] = useState(0);
  const [clearMutationErrorCount, setClearMutationErrorCount] = useState(0);

  useEffect(() => {
    window.__OPE9_PROMPT__ = turns[0]?.prompt ?? "";
    window.__ope9AppendQueuePrompt = () =>
      setTurns((current) => [...current, makeTurn(current.length)]);
    window.__ope9SetQueueLoading = setLoading;
    return () => {
      delete window.__ope9AppendQueuePrompt;
      delete window.__ope9SetQueueLoading;
    };
  }, [turns]);

  const queue = useMemo<UseTurnQueueResult>(
    () => ({
      snapshot: null,
      queue: turns,
      effectiveControl: null,
      stoppingPreviousAttempt: false,
      loading,
      error: queueError,
      refresh: async () => {
        setRefreshCount((current) => current + 1);
        setQueueError(null);
      },
      moveTurn: async () => true,
      editTurn: async () => null,
      steerTurn: async () => true,
      removeTurn: async () => true,
      pendingByTurn: {},
      mutationFor: () => null,
      mutating: false,
      mutationError,
      clearMutationError: () => {
        setClearMutationErrorCount((current) => current + 1);
        setMutationError(null);
      },
    }),
    [loading, mutationError, queueError, turns],
  );

  return (
    <main
      className="og-root flex min-h-dvh items-center justify-center bg-bg p-4 text-fg max-sm:p-0"
      data-og-theme={theme === "light" ? "light" : undefined}
      data-queue-harness
      data-theme={theme}
      data-refresh-count={refreshCount}
      data-clear-mutation-error-count={clearMutationErrorCount}
    >
      <section
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg max-sm:h-dvh max-sm:rounded-none max-sm:border-0"
        data-queue-harness-frame
        aria-label="Session queue presentation fixture"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div>
            <h1 className="text-xs font-semibold">Queued prompt presentation</h1>
            <p className="text-2xs text-fg-subtle">Deterministic OPE-9 browser fixture</p>
          </div>
          <span className="rounded-md border border-border px-2 py-1 text-2xs text-fg-muted">
            {theme} · {readOnly ? "read-only" : "interactive"}
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden bg-surface-2/20 p-4">
          <div className="mx-auto flex h-full max-w-3xl flex-col justify-end rounded-lg border border-border/70 bg-bg/30">
            <div className="min-h-0 flex-1 p-4 text-xs text-fg-subtle">
              <p>Session timeline remains independently scrollable above the queue.</p>
            </div>
            {readOnly ? (
              <QueueSurface queue={queue} readOnly />
            ) : (
              <QueueSurface queue={queue} composer={composer} />
            )}
            <div className="mx-4 mb-4 min-h-20 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-fg-muted">
              Message the agent…
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<QueueHarness />);
