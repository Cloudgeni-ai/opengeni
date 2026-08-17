// Production SessionChrome + ChatComposer stack for the DEV harness.
import {
  ChatComposer,
  SessionChrome,
  type ComposerState,
  type UseGoalResult,
  type UseTurnQueueResult,
} from "@opengeni/react";
import type {
  ClientVoiceInputConfig,
  SessionGoal,
  SessionPendingInputPreview,
  SessionTurn,
} from "@opengeni/sdk";
import { useCallback, useMemo, useState } from "react";

import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import { ModelPicker, SessionToolPicker } from "@/components/pickers";
import { SubagentTree } from "@/components/session/subagents";
import {
  emptyAttachments,
  galleryTurn,
  galleryFirstPartyTools,
  galleryModelRows,
  galleryToolSelection,
  galleryToolServers,
  GALLERY_WORKSPACE_ID,
  type ChromeScenario,
} from "@/dev/composer-chrome-fixtures";
import type { IntelligenceEffort } from "@/lib/session-tools";

const VOICE_CAPABILITY: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

const fixtureClient = {
  async transcribeAudio(): Promise<{ text: string; languages: string[] }> {
    return { text: "", languages: [] };
  },
};

type HarnessQueueMutation = "move" | "edit" | "steer" | "delete";

function queueHarnessControls(): { delayMs: number; failMutation: HarnessQueueMutation | null } {
  if (typeof window === "undefined") return { delayMs: 0, failMutation: null };
  const params = new URLSearchParams(window.location.search);
  const requestedDelay = Number(params.get("queueDelayMs") ?? "0");
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(0, Math.min(10_000, requestedDelay))
    : 0;
  const requestedFailure = params.get("queueFail");
  const failMutation =
    requestedFailure === "move" ||
    requestedFailure === "edit" ||
    requestedFailure === "steer" ||
    requestedFailure === "delete"
      ? requestedFailure
      : null;
  return { delayMs, failMutation };
}

function queueHarnessCount(): number | null {
  if (typeof window === "undefined") return null;
  const requested = Number(new URLSearchParams(window.location.search).get("queueCount"));
  return Number.isSafeInteger(requested) && requested >= 1 && requested <= 10_000
    ? requested
    : null;
}

function queueHarnessDefaultActive(
  fallback: ChromeScenario["defaultActive"],
): ChromeScenario["defaultActive"] {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get("queueOpen") === "0" ? null : fallback;
}

function queueHarnessReadOnly(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("queueReadOnly") === "1";
}

/** Local mutable queue/inbox so harness hover actions visibly update. */
function useHarnessLiveQueue(seed: UseTurnQueueResult): {
  queue: UseTurnQueueResult;
  dismissIncoming: (inputId: string) => void;
} {
  const [turns, setTurns] = useState<SessionTurn[]>(seed.queue);
  const [inputs, setInputs] = useState<SessionPendingInputPreview[]>(seed.pendingInputs);
  const [pendingByTurn, setPendingByTurn] = useState<Record<string, HarnessQueueMutation>>({});
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const controls = useMemo(queueHarnessControls, []);
  const mutate = useCallback(
    async <Result,>(
      turnId: string,
      kind: HarnessQueueMutation,
      commit: () => Result,
      rejected: Result,
    ): Promise<Result> => {
      setPendingByTurn((current) => ({ ...current, [turnId]: kind }));
      setMutationError(null);
      try {
        if (controls.delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, controls.delayMs));
        }
        if (controls.failMutation === kind) {
          setMutationError(new Error(`Server rejected delayed ${kind} mutation`));
          return rejected;
        }
        return commit();
      } finally {
        setPendingByTurn((current) => {
          const next = { ...current };
          delete next[turnId];
          return next;
        });
      }
    },
    [controls],
  );

  const queue = useMemo<UseTurnQueueResult>(
    () => ({
      ...seed,
      queue: turns,
      pendingInputs: inputs,
      moveTurn: async (turnId, beforeTurnId) =>
        await mutate(
          turnId,
          "move",
          () => {
            setTurns((prev) => {
              const from = prev.findIndex((turn) => turn.id === turnId);
              if (from < 0) return prev;
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              if (!moved) return prev;
              if (beforeTurnId === null) {
                next.push(moved);
              } else {
                const to = next.findIndex((turn) => turn.id === beforeTurnId);
                if (to < 0) next.push(moved);
                else next.splice(to, 0, moved);
              }
              return next;
            });
            return true;
          },
          false,
        ),
      editTurn: async (turnId) =>
        await mutate(
          turnId,
          "edit",
          () => {
            const source = turns.find((turn) => turn.id === turnId);
            if (!source) return null;
            setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
            return {
              revision: 1,
              text: source.prompt,
              resources: source.resources,
              tools: source.tools,
              toolsProvided: true,
              model: source.model,
              reasoningEffort: source.reasoningEffort,
              latencyMode: source.latencyMode,
              sourceTurnId: source.id,
              sourceTurnVersion: source.version,
              updatedAt: new Date().toISOString(),
            };
          },
          null,
        ),
      steerTurn: async (turnId) =>
        await mutate(
          turnId,
          "steer",
          () => {
            setTurns((prev) => {
              const from = prev.findIndex((turn) => turn.id === turnId);
              if (from <= 0) return prev;
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              if (!moved) return prev;
              next.unshift({
                ...moved,
                metadata: { ...moved.metadata, delivery: "steer" },
              });
              return next;
            });
            return true;
          },
          false,
        ),
      removeTurn: async (turnId) =>
        await mutate(
          turnId,
          "delete",
          () => {
            setTurns((prev) => prev.filter((turn) => turn.id !== turnId));
            return true;
          },
          false,
        ),
      pendingByTurn,
      mutationFor: (turnId) => pendingByTurn[turnId] ?? null,
      mutating: Object.keys(pendingByTurn).length > 0,
      mutationError,
      clearMutationError: () => setMutationError(null),
      refresh: async () => setMutationError(null),
    }),
    [inputs, mutate, mutationError, pendingByTurn, seed, turns],
  );

  return {
    queue,
    dismissIncoming: (inputId) => {
      setInputs((prev) => prev.filter((input) => input.id !== inputId));
    },
  };
}

function useHarnessLiveGoal(seed: UseGoalResult): UseGoalResult {
  const [goal, setGoal] = useState<SessionGoal | null>(seed.goal);
  return useMemo(
    () => ({
      ...seed,
      goal,
      isActive: goal?.status === "active",
      isPaused: goal?.status === "paused",
      isCompleted: goal?.status === "completed",
      pause: async () => {
        if (!goal || goal.status !== "active") return goal;
        const next: SessionGoal = {
          ...goal,
          status: "paused",
          pausedReason: "Paused from the gallery",
          continuation: {
            state: "inactive",
            reason: "goal_inactive",
            wakeRevision: goal.continuation?.wakeRevision ?? 0,
            observedRevision: goal.continuation?.observedRevision ?? 0,
            nextAttemptAt: null,
            lastError: null,
          },
        };
        setGoal(next);
        return next;
      },
      resume: async () => {
        if (!goal || goal.status !== "paused") return goal;
        const next: SessionGoal = {
          ...goal,
          status: "active",
          pausedReason: null,
          continuation: {
            state: "scheduled",
            reason: "wake_pending",
            wakeRevision: (goal.continuation?.wakeRevision ?? 0) + 1,
            observedRevision: goal.continuation?.observedRevision ?? 0,
            nextAttemptAt: new Date().toISOString(),
            lastError: null,
          },
        };
        setGoal(next);
        return next;
      },
      clearGoal: async () => {
        setGoal(null);
      },
      deleteGoal: async () => {
        setGoal(null);
      },
    }),
    [goal, seed],
  );
}

export function ScenarioStack({
  scenario,
  composer,
  /** Phone stage uses tighter padding to match the session dock. */
  variant = "gallery",
}: {
  scenario: ChromeScenario;
  composer: ComposerState;
  variant?: "gallery" | "phone";
}) {
  const [model, setModel] = useState("gpt-5.6-sol");
  const [effort, setEffort] = useState<IntelligenceEffort>("medium");
  const [toolSelection, setToolSelection] = useState(galleryToolSelection);
  const [composerValue, setComposerValue] = useState(composer.value);
  const attachments = useMemo(() => emptyAttachments(), []);
  const queueSeed = useMemo<UseTurnQueueResult>(() => {
    const count = queueHarnessCount();
    if (count === null) return scenario.queue;
    return {
      ...scenario.queue,
      queue: Array.from({ length: count }, (_, index) =>
        galleryTurn(
          index,
          `Queued performance prompt ${String(index + 1).padStart(5, "0")} ${"q".repeat(480)}`,
        ),
      ),
    };
  }, [scenario.queue]);
  const { queue, dismissIncoming } = useHarnessLiveQueue(queueSeed);
  const goal = useHarnessLiveGoal(scenario.goal);
  const agents = scenario.agentNodes;
  const liveComposer = useMemo<ComposerState>(
    () => ({
      ...composer,
      value: composerValue,
      setValue: setComposerValue,
      hasDraftContent: () => composerValue.length > 0,
      applyDraft: (draft) => {
        setComposerValue(draft.text);
        composer.applyDraft(draft);
      },
    }),
    [composer, composerValue],
  );

  const runningAgents = agents.filter(
    (node) => node.session.status === "running" && node.session.effectiveControl.state === "active",
  ).length;
  const pausedAgents = agents.filter(
    (node) => node.session.effectiveControl.state === "paused",
  ).length;

  const chrome = (
    <SessionChrome
      key={`${scenario.id}-${scenario.defaultActive ?? "none"}`}
      queue={queue}
      composer={liveComposer}
      goal={goal}
      sessionStatus={scenario.session.status}
      onDismissIncoming={dismissIncoming}
      readOnly={queueHarnessReadOnly()}
      defaultActive={queueHarnessDefaultActive(scenario.defaultActive)}
      agentsSignal={
        agents.length > 0
          ? {
              count: agents.length,
              detail:
                runningAgents > 0
                  ? `${runningAgents} running`
                  : pausedAgents > 0
                    ? `${pausedAgents} paused`
                    : "Idle",
              tone: runningAgents > 0 ? "running" : pausedAgents > 0 ? "waiting" : "neutral",
            }
          : undefined
      }
      agentsPanel={
        agents.length > 0 ? (
          <SubagentTree workspaceId={GALLERY_WORKSPACE_ID} nodes={agents} />
        ) : null
      }
    />
  );

  const composerBlock = (
    <ChatComposer
      composer={liveComposer}
      effectiveControl={scenario.session.effectiveControl}
      queuedAheadCount={queue.queue.length}
      placeholder="Send a follow-up…"
      attachments={attachments}
      attachButtonClassName="max-sm:hidden"
      transcription={{
        client: fixtureClient as never,
        workspaceId: GALLERY_WORKSPACE_ID,
        capability: VOICE_CAPABILITY,
        workspaceEnabled: true,
      }}
      controlsLeading={
        <ComposerMobilePlus
          fileUploadsEnabled
          servers={galleryToolServers}
          firstPartyTools={galleryFirstPartyTools}
          selection={toolSelection}
          onToolSelectionChange={setToolSelection}
        />
      }
      controlsStart={
        <div className="flex min-w-0 items-center gap-1.5 max-sm:min-w-0 max-sm:flex-nowrap">
          <ModelPicker
            rows={galleryModelRows}
            model={model}
            effort={effort}
            latencyMode="standard"
            menuSide="top"
            onModelChange={setModel}
            onEffortChange={setEffort}
            onLatencyModeChange={() => {}}
          />
          <SessionToolPicker
            servers={galleryToolServers}
            firstPartyTools={galleryFirstPartyTools}
            selection={toolSelection}
            menuSide="top"
            triggerClassName="max-sm:hidden"
            onChange={setToolSelection}
          />
        </div>
      }
    />
  );

  // Match `session.tsx`: SessionChrome card, then composer — same spacing in phone + gallery.
  const stack = (
    <>
      <div
        className={
          variant === "phone" ? "mb-2 w-full shrink-0 px-3" : "mb-2 w-full shrink-0 px-4 sm:px-6"
        }
      >
        <div className={variant === "phone" ? "w-full" : "mx-auto w-full max-w-3xl"}>{chrome}</div>
      </div>
      <div
        className={
          variant === "phone" ? "shrink-0 px-3 pb-3 pt-1" : "shrink-0 px-4 pb-4 pt-1 sm:px-6"
        }
      >
        <div className={variant === "phone" ? "w-full" : "mx-auto w-full max-w-3xl"}>
          {composerBlock}
        </div>
      </div>
    </>
  );

  if (variant === "phone") {
    return (
      <div className="shrink-0 bg-bg" data-scenario={scenario.id} data-session-chrome-stack="phone">
        {stack}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col justify-end rounded-xl border border-border bg-bg/40 pt-8"
      data-scenario={scenario.id}
      data-session-chrome-stack=""
    >
      {stack}
    </div>
  );
}
